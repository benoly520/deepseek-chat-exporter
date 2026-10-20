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
  CapturedApiRequest,
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
/** 批量导出详情：正在导出第几个会话（标题） */
let exportCurrent: { index: number; total: number; title: string } | null = null;

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
 * content script 提供连接/捕获信息；导出状态以 SW 为权威源覆盖
 * （否则 popup 轮询会用 content 的 exporting:false 把进度条覆盖消失）。
 */
async function getStatus(sendResponse: (response: StatusPayload) => void) {
  const idleStatus: StatusPayload = {
    connected: false,
    currentSessionId: null,
    capturedSessions: 0,
    capturedMessages: 0,
    exporting: exportInProgress,
    exportProgress,
    exportCurrent,
  };

  const tabId = await getActiveDeepSeekTabId();
  if (!tabId) {
    logger.debug('GET_STATUS: no active DeepSeek tab');
    sendResponse({ ...idleStatus, swError: '未找到活跃的 DeepSeek 标签页' });
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' });
    if (response) {
      // 合并：连接/捕获信息取 content，导出状态以 SW 为准
      sendResponse({
        ...response,
        exporting: exportInProgress,
        exportProgress,
        exportCurrent,
      });
    } else {
      sendResponse({ ...idleStatus, swError: 'content script 空响应' });
    }
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
 *
 * 重放策略：method / url / body 与页面真实请求保持一致（避免 405）。
 */
async function proxyRequest<T>(tabId: number, req: CapturedApiRequest): Promise<T> {
  const payload: FetchProxyPayload = {
    url: req.url,
    method: req.method,
    body: req.body,
  };
  const result = await sendToTab<{ data?: T; error?: string }>(tabId, {
    type: 'FETCH_PROXY',
    payload,
  });

  if (result?.error) {
    logger.error('Proxy request returned error', { url: req.url, method: req.method, error: result.error });
    throw new Error(result.error);
  }
  return result.data as T;
}

/**
 * 游标分页拉取全部会话列表。
 *
 * 代理策略：原样重放页面实际发出的请求（method/url/body 一致，避免 405）。
 * 若响应中能提取到游标字段则继续翻页，否则停在已捕获的第一页。
 *
 * @param tabId 目标标签页
 * @param fetchPageRequest 页面实际请求配置（缺省时回退硬编码 POST）
 */
async function fetchAllSessions(
  tabId: number,
  fetchPageRequest?: CapturedApiRequest
): Promise<SessionSummary[]> {
  const sessions: SessionSummary[] = [];
  const seen = new Set<string>();
  let page = 0;
  const MAX_PAGES = 100; // 防御性上限，避免异常响应导致死循环

  // 请求配置：优先重放页面真实请求
  let req: CapturedApiRequest = fetchPageRequest || {
    kind: 'fetchPage',
    url: `${API_BASE}/api/chat_session/fetch_page`,
    method: 'POST',
    body: JSON.stringify({ cursor: '', limit: SESSION_PAGE_SIZE, order_by: 'updated_at', direction: 'DESC' }),
  };
  logger.info('fetchAllSessions start', { url: req.url, method: req.method });

  while (page < MAX_PAGES) {
    let data: SessionListResponse;
    try {
      data = await proxyRequest<SessionListResponse>(tabId, req);
    } catch (error) {
      logger.error('fetchAllSessions page failed', { page, url: req.url, error: String(error) });
      throw error;
    }

    // 容错提取会话列表（兼容多种响应结构）
    const structure: { keys: string } = { keys: '' };
    const extracted = extractSessions(data, structure);
    if (!extracted) {
      logger.error('fetchAllSessions 响应解析失败（结构不符）', structure.keys);
      throw new Error('会话列表响应结构无法解析');
    }

    // 记录响应顶层结构，便于确认 v0 API 的游标字段名
    try {
      const dataKeys =
        typeof data === 'object' && data !== null
          ? `top=[${Object.keys(data)}] data=[${Object.keys((data as any).data || {})}]`
          : String(typeof data);
      logger.debug('fetch_page response structure', { page, ...{ keys: dataKeys } });
    } catch {
      // 结构日志失败不影响主流程
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

    // 无游标字段时停止（v0 API 游标字段名待日志确认后再适配翻页）
    if (!nextCursor || pageSessions.length === 0) {
      break;
    }

    // 用提取到的游标构造下一页请求：GET 请求拼到 query，POST 请求替换 body 中的 cursor
    if (req.method === 'GET') {
      const sep = req.url.includes('?') ? '&' : '?';
      req = { ...req, url: `${req.url}${sep}cursor=${encodeURIComponent(nextCursor)}` };
    } else {
      try {
        const bodyObj = req.body ? JSON.parse(req.body) : {};
        bodyObj.cursor = nextCursor;
        req = { ...req, body: JSON.stringify(bodyObj) };
      } catch {
        break;
      }
    }
    page++;

    // 翻页间限速，防止触发风控
    await sleep(300);
  }

  logger.info('fetchAllSessions finished', { total: sessions.length, pages: page + 1 });
  return sessions;
}

/**
 * 构造指定会话的历史消息请求：
 * 重放页面真实请求，但替换 chat_session_id 为目标会话，并去掉
 * cache_version / cache_reset_at（客户端缓存参数，会导致返回空消息）。
 */
function buildHistoryRequest(historyReq: CapturedApiRequest | undefined, sessionId: string): CapturedApiRequest {
  if (!historyReq) {
    // 无捕获请求时回退到已知端点（GET，参数在 query 上）
    return {
      kind: 'history',
      url: `${API_BASE}/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}`,
      method: 'GET',
    };
  }

  try {
    const u = new URL(historyReq.url, 'https://chat.deepseek.com');
    u.searchParams.set('chat_session_id', sessionId);
    u.searchParams.delete('cache_version');
    u.searchParams.delete('cache_reset_at');
    return {
      kind: 'history',
      url: u.pathname + u.search,
      method: historyReq.method,
      body: historyReq.body
        ? JSON.stringify({ ...JSON.parse(historyReq.body), chat_session_id: sessionId })
        : undefined,
    };
  } catch {
    return { kind: 'history', url: historyReq.url, method: historyReq.method, body: historyReq.body };
  }
}

/**
 * 拉取指定会话的完整历史消息。
 *
 * @param tabId 目标标签页
 * @param sessionId 会话 ID
 * @param historyRequest 页面实际请求配置（用于构造目标会话的请求）
 */
async function fetchHistoryMessages(
  tabId: number,
  sessionId: string,
  historyRequest?: CapturedApiRequest
): Promise<RawMessage[] | null> {
  const req = buildHistoryRequest(historyRequest, sessionId);
  try {
    const data = await proxyRequest<HistoryMessagesResponse>(tabId, req);

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
    logger.error('fetchHistoryMessages failed', { sessionId, url: req.url, error: String(error) });
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

    // 获取当前会话 ID 与已捕获的消息（含页面真实请求配置）
    const sessionData = await sendToTab<{
      sessionId: string;
      messages: RawMessage[];
      historyRequest?: CapturedApiRequest;
      fetchPageRequest?: CapturedApiRequest;
      error?: string;
    }>(tabId, { type: 'EXPORT_CURRENT' });

    if (sessionData.error) {
      sendResponse(sessionData);
      return;
    }

    const sessionId = sessionData.sessionId;

    // 优先通过代理拉取完整历史（重放页面请求），失败或为空时退回已捕获消息
    const proxied = await fetchHistoryMessages(tabId, sessionId, sessionData.historyRequest);
    const captured = sessionData.messages || [];
    const messages = proxied && proxied.length > 0 ? proxied : captured.length > 0 ? captured : proxied || [];
    logger.info('exportCurrent history ready', {
      sessionId,
      source: proxied && proxied.length > 0 ? 'proxy' : 'captured',
      count: messages.length,
    });

    // 拉取会话元数据（标题等），使用页面真实请求配置；失败时使用占位信息
    let sessionInfo: SessionSummary | null = null;
    try {
      const list = await fetchAllSessions(tabId, sessionData.fetchPageRequest);
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
      messages,
      (_msg, sample) => {
        logger.error('消息正文提取失败（消息结构样本）', sample);
      }
    );

    const exportData = buildExportJSON([conversation]);

    const filename = generateFilename(`deepseek-session-${sessionId.slice(0, 8)}`);
    await triggerDownload(exportData, filename, tabId);
    logger.info('exportCurrent download triggered', { filename });

    exportInProgress = false;
    exportProgress = 100;
    exportCurrent = null;
    sendResponse({ success: true, filename });
  } catch (error) {
    exportInProgress = false;
    exportProgress = 0;
    exportCurrent = null;
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

    // 获取页面真实请求配置 + 分页拉取全部会话
    const allSessionsData = await sendToTab<{
      sessions: SessionSummary[];
      fetchPageRequest?: CapturedApiRequest;
      historyRequest?: CapturedApiRequest;
    }>(tabId, { type: 'EXPORT_ALL' });

    const sessions = await fetchAllSessions(tabId, allSessionsData.fetchPageRequest);

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
      exportCurrent = { index: i + 1, total: totalSessions, title: session.title || 'Untitled' };

      // 向 popup 广播进度，无监听时忽略
      try {
        const result = chrome.runtime.sendMessage({
          type: 'EXPORT_PROGRESS',
          payload: { progress: exportProgress, current: i + 1, total: totalSessions, title: session.title || 'Untitled' },
        } as ExtensionMessage);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch (error) {
        // 忽略广播失败
      }

      try {
        const historyData = await fetchHistoryMessages(tabId, session.id, allSessionsData.historyRequest);

        if (historyData) {
          const conversation = buildConversation(session, historyData, (_msg, sample) => {
            logger.error('消息正文提取失败（消息结构样本）', { sessionId: session.id, sample });
          });
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
    exportCurrent = null;
    sendResponse({ success: true, filename, count: conversations.length });
  } catch (error) {
    exportInProgress = false;
    exportProgress = 0;
    exportCurrent = null;
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
