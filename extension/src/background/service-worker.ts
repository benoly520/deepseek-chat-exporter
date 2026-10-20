/**
 * Background Service Worker。
 * 负责导出编排（单会话 / 批量 + 游标分页 + 限速）与消息路由。
 */

import type {
  ExtensionMessage,
  StatusPayload,
  HistoryMessagesResponse,
  SessionListResponse,
  Conversation,
  RawMessage,
  SessionSummary,
  FetchProxyPayload,
} from '../types';
import { buildExportJSON, buildConversation } from '../utils/json-builder';
import { triggerDownload, generateFilename } from '../utils/downloader';

// 状态
let exportInProgress = false;
let exportProgress = 0;

/** DeepSeek API 基地址 */
const API_BASE = 'https://chat.deepseek.com';
/** 会话列表每页数量 */
const SESSION_PAGE_SIZE = 50;

/**
 * 处理来自 content script 与 popup 的消息。
 */
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === 'GET_STATUS') {
    getStatus(sendResponse);
    return true; // 异步响应
  } else if (message.type === 'EXPORT_CURRENT') {
    exportCurrentConversation(sendResponse);
    return true;
  } else if (message.type === 'EXPORT_ALL') {
    exportAllConversations(sendResponse);
    return true;
  } else if (
    message.type === 'SESSION_LIST' ||
    message.type === 'HISTORY_MESSAGES' ||
    message.type === 'SSE_COMPLETE' ||
    message.type === 'PAGE_CHANGED' ||
    message.type === 'AUTH_TOKEN'
  ) {
    // 捕获类消息仅记录，数据以 content script 为准
    console.log('[DeepSeek Exporter] Data captured:', message.type);
    sendResponse({ success: true });
  }

  return true;
});

/**
 * 获取当前活跃的 DeepSeek 标签页 ID。
 */
async function getActiveDeepSeekTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find((t) => t.url?.includes('chat.deepseek.com'));
    return tab?.id ?? null;
  } catch (error) {
    console.error('[DeepSeek Exporter] Failed to query tabs:', error);
    return null;
  }
}

/**
 * 获取当前状态。
 */
async function getStatus(sendResponse: (response: StatusPayload) => void) {
  const idleStatus: StatusPayload = {
    connected: false,
    currentSessionId: null,
    capturedSessions: 0,
    capturedMessages: 0,
    exporting: exportInProgress,
    exportProgress,
  };

  const tabId = await getActiveDeepSeekTabId();
  if (!tabId) {
    sendResponse(idleStatus);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
    sendResponse(response ?? idleStatus);
  } catch (error) {
    // content script 未注入（页面尚未刷新过）等场景
    sendResponse(idleStatus);
  }
}

/**
 * 向指定标签页的 content script 发消息。
 */
async function sendToTab<T = any>(tabId: number, message: ExtensionMessage): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

/**
 * 通过 content script 代理执行 DeepSeek API 请求。
 * service worker 直接 fetch 无法携带页面的 Bearer Token，
 * 由页面上下文的代理请求补全鉴权。
 */
async function proxyFetch<T>(tabId: number, url: string, body: unknown): Promise<T> {
  const payload: FetchProxyPayload = { url, body };
  const result = await sendToTab<{ data?: T; error?: string }>(tabId, {
    type: 'FETCH_PROXY',
    payload,
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  return result.data as T;
}

/**
 * 游标分页拉取全部会话列表。
 */
async function fetchAllSessions(tabId: number): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  let cursor = '';
  let page = 0;
  const MAX_PAGES = 100; // 防御性上限，避免异常响应导致死循环

  while (page < MAX_PAGES) {
    const data = await proxyFetch<SessionListResponse>(tabId, `${API_BASE}/api/chat_session/fetch_page`, {
      cursor,
      limit: SESSION_PAGE_SIZE,
      order_by: 'updated_at',
      direction: 'DESC',
    });

    const pageSessions = data?.data?.sessions || [];
    for (const s of pageSessions) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        sessions.push(s);
      }
    }

    const nextCursor = data?.data?.next_cursor || '';
    if (!nextCursor || pageSessions.length === 0) {
      break;
    }
    cursor = nextCursor;
    page++;

    // 翻页间限速，防止触发风控
    await sleep(300);
  }

  return sessions;
}

/**
 * 拉取指定会话的完整历史消息。
 */
async function fetchHistoryMessages(tabId: number, sessionId: string): Promise<RawMessage[] | null> {
  try {
    const data = await proxyFetch<HistoryMessagesResponse>(
      tabId,
      `${API_BASE}/api/chat/history_messages`,
      { session_id: sessionId }
    );
    return data?.data?.messages || null;
  } catch (error) {
    console.error('[DeepSeek Exporter] Failed to fetch history messages:', error);
    return null;
  }
}

/**
 * 导出当前会话。
 */
async function exportCurrentConversation(sendResponse: (response: any) => void) {
  const tabId = await getActiveDeepSeekTabId();
  if (!tabId) {
    sendResponse({ error: '未找到 DeepSeek 标签页，请先打开 chat.deepseek.com' });
    return;
  }

  try {
    exportInProgress = true;
    exportProgress = 0;

    // 获取当前会话 ID 与已捕获的消息
    const sessionData = await sendToTab<{
      sessionId: string;
      messages: RawMessage[];
      error?: string;
    }>(tabId, { type: 'EXPORT_CURRENT' });

    if (sessionData.error) {
      sendResponse(sessionData);
      return;
    }

    const sessionId = sessionData.sessionId;

    // 优先通过代理拉取完整历史，失败时退回已捕获消息
    const messages = (await fetchHistoryMessages(tabId, sessionId)) || sessionData.messages || [];

    // 拉取会话元数据（标题等），失败时使用占位信息
    let sessionInfo: SessionSummary | null = null;
    try {
      const list = await fetchAllSessions(tabId);
      sessionInfo = list.find((s) => s.id === sessionId) || null;
    } catch (error) {
      console.error('[DeepSeek Exporter] Failed to fetch session info:', error);
    }

    const conversation = buildConversation(
      sessionInfo || { id: sessionId, title: 'Exported Conversation' },
      messages
    );

    const exportData = buildExportJSON([conversation]);

    const filename = generateFilename(`deepseek-session-${sessionId.slice(0, 8)}`);
    await triggerDownload(exportData, filename);

    exportInProgress = false;
    exportProgress = 100;
    sendResponse({ success: true, filename });
  } catch (error) {
    exportInProgress = false;
    exportProgress = 0;
    sendResponse({ error: String(error) });
  }
}

/**
 * 批量导出全部会话（游标分页 + 限速）。
 */
async function exportAllConversations(sendResponse: (response: any) => void) {
  const tabId = await getActiveDeepSeekTabId();
  if (!tabId) {
    sendResponse({ error: '未找到 DeepSeek 标签页，请先打开 chat.deepseek.com' });
    return;
  }

  try {
    exportInProgress = true;
    exportProgress = 0;

    // 分页拉取全部会话
    const sessions = await fetchAllSessions(tabId);

    if (sessions.length === 0) {
      sendResponse({ error: '未找到会话，请先在 DeepSeek 页面浏览或刷新后重试' });
      return;
    }

    const conversations: Conversation[] = [];
    const totalSessions = sessions.length;

    // 逐个拉取历史消息并限速
    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];

      exportProgress = Math.round((i / totalSessions) * 100);

      // 向 popup 广播进度，无监听时忽略
      try {
        const result = chrome.runtime.sendMessage({
          type: 'EXPORT_PROGRESS',
          payload: { progress: exportProgress },
        } as ExtensionMessage);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch (error) {
        // 忽略广播失败
      }

      try {
        const historyData = await fetchHistoryMessages(tabId, session.id);

        if (historyData) {
          const conversation = buildConversation(session, historyData);
          conversations.push(conversation);
        }

        // 每 5 个请求暂停 800ms，防止触发风控
        if ((i + 1) % 5 === 0 && i < sessions.length - 1) {
          await sleep(800);
        }
      } catch (error) {
        console.error(`[DeepSeek Exporter] Failed to export session ${session.id}:`, error);
        // 单个会话失败不中断整体导出
      }
    }

    const exportData = buildExportJSON(conversations);

    const filename = generateFilename('deepseek-all-conversations');
    await triggerDownload(exportData, filename);

    exportInProgress = false;
    exportProgress = 100;
    sendResponse({ success: true, filename, count: conversations.length });
  } catch (error) {
    exportInProgress = false;
    exportProgress = 0;
    sendResponse({ error: String(error) });
  }
}

/**
 * 限速用 sleep。
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 扩展安装 / 更新时提示。
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log('[DeepSeek Exporter] Extension installed');
});
