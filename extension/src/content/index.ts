/**
 * Content Script 入口。
 * 负责：注入 fetch hook、监听捕获数据、按需代理 API 请求、响应 background 消息。
 */

import { startPageWatcher } from './page-watcher';
import type {
  ExtensionMessage,
  StatusPayload,
  SessionListResponse,
  HistoryMessagesResponse,
  SessionSummary,
  FetchProxyPayload,
} from '../types';

// 状态
let currentSessionId: string | null = null;
// 按 id 合并累积的会话列表（fetch_page 是分页接口，需跨页累积）
let capturedSessions: SessionSummary[] = [];
let capturedMessages: HistoryMessagesResponse['data']['messages'] = [];
let hookInstalled = false;
// 从页面请求中捕获的 Bearer Token，代理请求时附带
let authToken = '';

/**
 * 初始化 content script。
 * 在 document_start 立即执行，确保 fetch hook 先于页面的首批 API 请求安装。
 */
function init() {
  console.log('[DeepSeek Exporter] Content script initializing...');

  // 注入 fetch hook 到 MAIN world
  injectFetchHook();

  // 监听 hook 捕获的数据
  window.addEventListener('__ds_data__', ((event: CustomEvent) => {
    const { type, data } = event.detail;
    handleCapturedData(type, data);
  }) as EventListener);

  // 监听 hook 安装确认
  window.addEventListener('__ds_hook_control__', ((event: CustomEvent) => {
    if (event.detail.status === 'installed') {
      hookInstalled = true;
      console.log('[DeepSeek Exporter] Fetch hook confirmed installed');
    }
  }) as EventListener);

  // 启动路由监听
  startPageWatcher((sessionId) => {
    currentSessionId = sessionId;
    console.log('[DeepSeek Exporter] Page changed, session ID:', sessionId);

    notifyBackground({
      type: 'PAGE_CHANGED',
      payload: { sessionId },
    });
  });

  // 监听 background / popup 消息
  chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    handleMessage(message, sendResponse);
    return true; // 保持消息通道以支持异步响应
  });

  console.log('[DeepSeek Exporter] Content script initialized');
}

/**
 * 注入 fetch hook 脚本到 MAIN world。
 */
function injectFetchHook() {
  const script = document.createElement('script');
  // dist 中 hook 位于 content/fetch-hook.js，与 manifest 的
  // web_accessible_resources 声明一致
  script.src = chrome.runtime.getURL('content/fetch-hook.js');
  // esbuild 产物为 IIFE，用经典脚本注入即可
  (document.head || document.documentElement).appendChild(script);
  script.onload = () => script.remove();
}

/**
 * 向 background 发消息，失败时静默（如扩展刚重载、通道关闭）。
 */
function notifyBackground(message: ExtensionMessage) {
  try {
    const result = chrome.runtime.sendMessage(message);
    // MV3 中 sendMessage 返回 Promise，无监听时 reject
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch (error) {
    // 扩展上下文失效（重载 / 更新）时忽略
  }
}

/**
 * 处理 fetch hook 捕获的数据。
 */
function handleCapturedData(type: string, data: unknown) {
  console.log('[DeepSeek Exporter] Captured data:', type);

  if (type === 'auth_token') {
    authToken = String(data);
  } else if (type === 'session_list') {
    const sessionData = data as SessionListResponse;
    // 按 id 合并，跨页累积会话列表
    capturedSessions = mergeSessions(capturedSessions, sessionData.data.sessions);

    notifyBackground({
      type: 'SESSION_LIST',
      payload: sessionData,
    });
  } else if (type === 'history_messages') {
    const messageData = data as HistoryMessagesResponse;
    capturedMessages = messageData.data.messages;

    notifyBackground({
      type: 'HISTORY_MESSAGES',
      payload: messageData,
    });
  } else if (type === 'sse_complete') {
    notifyBackground({
      type: 'SSE_COMPLETE',
      payload: data,
    });
  }
}

/**
 * 按 id 合并会话列表，新数据覆盖旧数据。
 */
function mergeSessions(
  existing: SessionSummary[],
  incoming: SessionSummary[]
): SessionSummary[] {
  const map = new Map<string, SessionSummary>();
  for (const s of existing) map.set(s.id, s);
  for (const s of incoming) map.set(s.id, s);
  return Array.from(map.values());
}

/**
 * 在页面上下文代理执行 API 请求（service worker 无法携带页面的
 * Authorization Token，由这里代为请求并返回 JSON）。
 */
async function proxyFetch(payload: FetchProxyPayload): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = authToken;
  }

  const response = await fetch(payload.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload.body),
    credentials: 'include',
  });

  if (!response.ok) {
    throw new Error(`API ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

/**
 * 处理来自 background / popup 的消息。
 */
function handleMessage(message: ExtensionMessage, sendResponse: (response?: any) => void) {
  if (message.type === 'GET_STATUS') {
    const status: StatusPayload = {
      connected: hookInstalled,
      currentSessionId,
      capturedSessions: capturedSessions.length,
      capturedMessages: capturedMessages.length,
      exporting: false,
      exportProgress: 0,
    };
    sendResponse(status);
  } else if (message.type === 'EXPORT_CURRENT') {
    // 返回当前会话与已捕获消息（完整历史由 background 通过代理请求补全）
    if (!currentSessionId) {
      sendResponse({ error: '未找到当前会话，请先打开一个对话' });
      return;
    }

    sendResponse({
      sessionId: currentSessionId,
      messages: capturedMessages,
    });
  } else if (message.type === 'EXPORT_ALL') {
    sendResponse({
      sessions: capturedSessions,
    });
  } else if (message.type === 'FETCH_PROXY') {
    proxyFetch(message.payload as FetchProxyPayload)
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: String(error) }));
    // 异步响应，保持通道打开
  }
}

// document_start 注入时立即初始化，确保 hook 赶在页面首批 API 请求前安装
init();
