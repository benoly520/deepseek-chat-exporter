/**
 * Background Service Worker。
 * 负责导出编排（单会话 / 批量 + 游标分页 + 限速）、消息路由与日志汇总。
 * 运行日志持久化到 chrome.storage.local，popup 可拉取 / 下载 / 清空。
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
import { createLocalLogger } from '../utils/logger';
import { LogStore } from '../utils/log-store';
import { extractMessages, extractSessions } from '../utils/api-extract';
import type { LogEntry } from '../utils/logger';

// 日志：SW 自身日志通过 sink 直写 logStore，同样持久化、可被 popup 拉取
const logger = createLocalLogger('sw', false, (entry: LogEntry) => logStore.add(entry));
// 日志仓库：汇总 content script 转发的日志并持久化
const logStore = new LogStore();
// 尽早开始恢复历史日志
logStore.init();

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
  // 记录消息来源类型（LOG_ENTRY 除外，避免自激循环）
  if (message.type !== 'LOG_ENTRY') {
    logger.debug('Message received', message.type);
  }

  if (message.type === 'LOG_ENTRY') {
    logStore.add(message.payload as LogEntry);
    sendResponse({ success: true });
  } else if (message.type === 'GET_LOGS') {
    logStore
      .getAll()
      .then((entries) => {
        // 合并 popup 本地日志（如日志器自带 entries）不在此处理，仅返回汇总日志
        sendResponse({ entries });
      })
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  } else if (message.type === 'CLEAR_LOGS') {
    logStore
      .clear()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  } else if (message.type === 'GET_STATUS') {
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
    logger.error('Failed to query tabs', String(error));
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
    logger.debug('GET_STATUS: no active DeepSeek tab');
    sendResponse({ ...idleStatus, swError: '未找到活跃的 DeepSeek 标签页' });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
    sendResponse(response ?? { ...idleStatus, swError: 'content script 空响应' });
  } catch (error) {
    // content script 未注入（页面尚未刷新过）等场景
    logger.warn('GET_STATUS: content script unreachable', String(error));
    sendResponse({ ...idleStatus, swError: `content script 不可达: ${String(error)}` });
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
    logger.error('Proxy fetch returned error', { url, error: result.error });
    throw new Error(result.error);
  }
  return result.data as T;
}

/**
 * 游标分页拉取全部会话列表。
 *
 * @param tabId 目标标签页
 * @param fetchPageUrl 页面实际调用的 fetch_page 端点（从捕获的 api_url 中取得，
 *                     可能带版本前缀；缺省时回退到硬编码地址）
 */
async function fetchAllSessions(
  tabId: number,
  fetchPageUrl?: string
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  let cursor = '';
  let page = 0;
  const MAX_PAGES = 100; // 防御性上限，避免异常响应导致死循环

  // 优先使用页面真实端点，避免硬编码 URL 与实际 API 版本不符（返回 HTML）
  const url = fetchPageUrl || `${API_BASE}/api/chat_session/fetch_page`;
  logger.info('fetchAllSessions start', { url });

  while (page < MAX_PAGES) {
    let data: SessionListResponse;
    try {
      data = await proxyFetch<SessionListResponse>(tabId, url, {
        cursor,
        limit: SESSION_PAGE_SIZE,
        order_by: 'updated_at',
        direction: 'DESC',
      });
    } catch (error) {
      logger.error('fetchAllSessions page failed', { page, cursor, error: String(error) });
      throw error;
    }

    // 容错提取会话列表（兼容多种响应结构）
    const structure: { keys: string } = { keys: '' };
    const extracted = extractSessions(data, structure);
    if (!extracted) {
      logger.error('fetchAllSessions 响应解析失败（结构不符）', structure.keys);
      throw new Error('会话列表响应结构无法解析');
    }

    const pageSessions = extracted.sessions;
    for (const s of pageSessions) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        sessions.push(s);
      }
    }

    const nextCursor = extracted.nextCursor;
    logger.info('fetchAllSessions page done', {
      page,
      got: pageSessions.length,
      total: sessions.length,
      nextCursor: nextCursor || '(empty)',
    });

    if (!nextCursor || pageSessions.length === 0) {
      break;
    }
    cursor = nextCursor;
    page++;

    // 翻页间限速，防止触发风控
    await sleep(300);
  }

  logger.info('fetchAllSessions finished', { total: sessions.length, pages: page + 1 });
  return sessions;
}

/**
 * 拉取指定会话的完整历史消息。
 *
 * @param tabId 目标标签页
 * @param sessionId 会话 ID
 * @param historyUrl 页面实际调用的 history_messages 端点（缺省时回退硬编码）
 */
async function fetchHistoryMessages(
  tabId: number,
  sessionId: string,
  historyUrl?: string
): Promise<RawMessage[] | null> {
  const url = historyUrl || `${API_BASE}/api/chat/history_messages`;
  try {
    const data = await proxyFetch<HistoryMessagesResponse>(tabId, url, {
      session_id: sessionId,
    });

    // 容错提取消息数组（兼容多种响应结构）
    const structure: { keys: string } = { keys: '' };
    const messages = extractMessages(data, structure);
    if (!messages) {
      logger.error('fetchHistoryMessages 响应解析失败（结构不符）', structure.keys);
      return null;
    }

    logger.debug('fetchHistoryMessages done', { sessionId, count: messages.length });
    return messages;
  } catch (error) {
    logger.error('fetchHistoryMessages failed', { sessionId, error: String(error) });
    return null;
  }
}

/**
 * 导出当前会话。
 */
async function exportCurrentConversation(sendResponse: (response: any) => void) {
  const tabId = await getActiveDeepSeekTabId();
  if (!tabId) {
    logger.warn('exportCurrent: no DeepSeek tab');
    sendResponse({ error: '未找到 DeepSeek 标签页，请先打开 chat.deepseek.com' });
    return;
  }

  try {
    exportInProgress = true;
    exportProgress = 0;
    logger.info('exportCurrent start', { tabId });

    // 获取当前会话 ID 与已捕获的消息（含页面真实 API 端点）
    const sessionData = await sendToTab<{
      sessionId: string;
      messages: RawMessage[];
      historyUrl?: string;
      error?: string;
    }>(tabId, { type: 'EXPORT_CURRENT' });

    if (sessionData.error) {
      sendResponse(sessionData);
      return;
    }

    const sessionId = sessionData.sessionId;

    // 优先通过代理拉取完整历史（用页面真实端点），失败时退回已捕获消息
    const messages =
      (await fetchHistoryMessages(tabId, sessionId, sessionData.historyUrl)) ||
      sessionData.messages ||
      [];
    logger.info('exportCurrent history ready', {
      sessionId,
      historyUrl: sessionData.historyUrl || '(hardcoded)',
      count: messages.length,
      fallbackToCaptured: sessionData.historyUrl ? undefined : true,
    });

    // 拉取会话元数据（标题等），失败时使用占位信息
    let sessionInfo: SessionSummary | null = null;
    try {
      const list = await fetchAllSessions(tabId, sessionData.historyUrl);
      sessionInfo = list.find((s) => s.id === sessionId) || null;
      logger.info('exportCurrent session info', {
        found: Boolean(sessionInfo),
        title: sessionInfo?.title || '',
      });
    } catch (error) {
      logger.error('exportCurrent fetch session info failed', String(error));
    }

    const conversation = buildConversation(
      sessionInfo || { id: sessionId, title: 'Exported Conversation' },
      messages
    );

    const exportData = buildExportJSON([conversation]);

    const filename = generateFilename(`deepseek-session-${sessionId.slice(0, 8)}`);
    await triggerDownload(exportData, filename, tabId);
    logger.info('exportCurrent download triggered', { filename });

    exportInProgress = false;
    exportProgress = 100;
    sendResponse({ success: true, filename });
  } catch (error) {
    exportInProgress = false;
    exportProgress = 0;
    logger.error('exportCurrent failed', String(error));
    sendResponse({ error: String(error) });
  }
}

/**
 * 批量导出全部会话（游标分页 + 限速）。
 */
async function exportAllConversations(sendResponse: (response: any) => void) {
  const tabId = await getActiveDeepSeekTabId();
  if (!tabId) {
    logger.warn('exportAll: no DeepSeek tab');
    sendResponse({ error: '未找到 DeepSeek 标签页，请先打开 chat.deepseek.com' });
    return;
  }

  try {
    exportInProgress = true;
    exportProgress = 0;
    logger.info('exportAll start', { tabId });

    // 获取页面真实 API 端点 + 分页拉取全部会话
    const allSessionsData = await sendToTab<{
      sessions: SessionSummary[];
      fetchPageUrl?: string;
      historyUrl?: string;
    }>(tabId, { type: 'EXPORT_ALL' });

    const sessions = await fetchAllSessions(tabId, allSessionsData.fetchPageUrl);

    if (sessions.length === 0) {
      logger.warn('exportAll: no sessions found');
      sendResponse({ error: '未找到会话，请先在 DeepSeek 页面浏览或刷新后重试' });
      return;
    }

    const conversations: Conversation[] = [];
    const totalSessions = sessions.length;
    const failed: string[] = [];

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
        const historyData = await fetchHistoryMessages(tabId, session.id, allSessionsData.historyUrl);

        if (historyData) {
          const conversation = buildConversation(session, historyData);
          conversations.push(conversation);
          logger.debug('exportAll session ok', {
            i,
            id: session.id,
            messages: historyData.length,
          });
        } else {
          failed.push(session.id);
          logger.warn('exportAll session empty history', { i, id: session.id });
        }

        // 每 5 个请求暂停 800ms，防止触发风控
        if ((i + 1) % 5 === 0 && i < sessions.length - 1) {
          await sleep(800);
        }
      } catch (error) {
        failed.push(session.id);
        logger.error('exportAll session failed', { i, id: session.id, error: String(error) });
        // 单个会话失败不中断整体导出
      }
    }

    const exportData = buildExportJSON(conversations);

    const filename = generateFilename('deepseek-all-conversations');
    await triggerDownload(exportData, filename, tabId);
    logger.info('exportAll download triggered', {
      filename,
      conversations: conversations.length,
      failed: failed.length,
    });

    exportInProgress = false;
    exportProgress = 100;
    sendResponse({ success: true, filename, count: conversations.length });
  } catch (error) {
    exportInProgress = false;
    exportProgress = 0;
    logger.error('exportAll failed', String(error));
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
chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Extension installed/updated', details.reason);
});

// SW 上下文的未处理 Promise rejection 记入日志
// （chrome://extensions 错误页里的 SW 崩溃大多源于此）
(self as any).addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const reason =
    e.reason instanceof Error
      ? `${e.reason.message}\n${e.reason.stack || ''}`
      : String(e.reason);
  logger.error('未处理的 Promise rejection', reason.slice(0, 1000));
});
