/**
 * Content Script 入口。
 * 负责：注入 fetch hook、监听捕获数据、按需代理 API 请求、响应 background 消息。
 * 所有运行日志通过 createLocalLogger 记录并转发给 service worker 汇总。
 */

import { startPageWatcher } from './page-watcher';
import { createLocalLogger } from '../utils/logger';
import { extractMessages, extractSessions } from '../utils/api-extract';
import type {
  ExtensionMessage,
  StatusPayload,
  SessionSummary,
  FetchProxyPayload,
  RawMessage,
} from '../types';

// 日志器：本地记录 + 转发 SW 汇总
const logger = createLocalLogger('content', true);

// 状态
let currentSessionId: string | null = null;
// 按 id 合并累积的会话列表（fetch_page 是分页接口，需跨页累积）
let capturedSessions: SessionSummary[] = [];
let capturedMessages: RawMessage[] = [];
let hookInstalled = false;
// 从页面请求中捕获的 Bearer Token，代理请求时附带
let authToken = '';
// 诊断用：最近捕获的 /api/ 请求 URL（最新在前，去重，最多 20 条）
let recentApiUrls: string[] = [];

/**
 * 初始化 content script。
 * 在 document_start 立即执行，确保 fetch hook 先于页面的首批 API 请求安装。
 */
function init() {
  logger.info('Content script initializing', {
    url: location.href,
    readyState: document.readyState,
  });

  // 捕获页面内所有未处理异常（含 fetch hook 的错误），记入诊断日志
  setupGlobalErrorHandlers();

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
      logger.info('Fetch hook confirmed installed');
    }
  }) as EventListener);

  // 启动路由监听
  startPageWatcher((sessionId) => {
    currentSessionId = sessionId;
    logger.info('Page changed, session ID', sessionId);

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

  logger.info('Content script initialized');
}

// 未捕获异常的去重记录：相同 key 30 秒内只记一次，重复次数每满 10 次汇总一条
const errorDedupe = new Map<string, { count: number; last: number }>();

/**
 * 判断错误来源是否为扩展自身脚本（hook 注入页面 MAIN world，同属一个 window）。
 */
function isOwnScript(filename: string): boolean {
  return filename.includes('fetch-hook.js') || filename.includes('content/index.js');
}

/**
 * 全局错误处理：把 window 'error' 与 'unhandledrejection' 记入日志。
 * 这与 chrome://extensions 错误页看到的是同一类信息，可直接从日志导出排查。
 * 页面自身的错误也会被记录（标 ours=false），但做了去重降噪。
 */
function setupGlobalErrorHandlers() {
  window.addEventListener('error', (e) => {
    const filename = e.filename || '';
    const key = `error:${e.message}:${filename}:${e.lineno}`;
    reportDeduped(key, {
      msg: e.message,
      file: filename.split('/').pop() || '',
      line: e.lineno,
      col: e.colno,
      ours: isOwnScript(filename) || e.message.includes('DeepSeek Exporter'),
    }, `未捕获异常`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack || ''}` : String(e.reason);
    // 取 reason 的前 300 字符做去重 key（避免动态内容导致不去重）
    const key = `rejection:${reason.slice(0, 300)}`;
    reportDeduped(key, { reason: reason.slice(0, 1000) }, `未处理的 Promise rejection`);
  });
}

/**
 * 去重上报：相同错误短时间内只记录一次，重复次数每满 10 次汇总一条。
 */
function reportDeduped(key: string, detail: unknown, label: string) {
  const now = Date.now();
  const DEDUP_WINDOW = 30_000;

  const prev = errorDedupe.get(key);
  if (prev && now - prev.last < DEDUP_WINDOW) {
    prev.count++;
    prev.last = now;
    if (prev.count % 10 === 0) {
      logger.warn(`${label}（已重复 ${prev.count} 次）`, detail);
    }
    return;
  }

  errorDedupe.set(key, { count: 1, last: now });
  if (errorDedupe.size > 50) {
    // 防止 Map 无限增长
    const oldest = errorDedupe.keys().next().value;
    if (oldest) errorDedupe.delete(oldest);
  }
  logger.error(label, detail);
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
  script.onload = () => {
    script.remove();
    logger.debug('Fetch hook script loaded and removed from DOM');
  };
  script.onerror = () => {
    logger.error('Fetch hook script failed to load', script.src);
  };
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
 * 整体包裹 try-catch：任何解析异常都记录到日志，绝不让异常静默丢失计数。
 */
function handleCapturedData(type: string, data: unknown) {
  logger.debug('Captured data', type);

  try {
    if (type === 'auth_token') {
      authToken = String(data);
      logger.info('Auth token captured');
    } else if (type === 'api_url') {
      // 记录最近的 /api/ 请求 URL，供 popup 诊断展示与 SW 代理复用真实端点
      const url = String(data);
      logger.debug('API url', url);
      recentApiUrls = [url, ...recentApiUrls.filter((u) => u !== url)].slice(0, 20);
    } else if (type === 'api_parse_error') {
      // hook 层 JSON 解析失败（响应非 JSON），记录响应片段辅助诊断
      const info = data as { kind: string; status: number; error: string; snippet: string };
      logger.error(`hook 响应 JSON 解析失败（${info.kind}）`, {
        status: info.status,
        error: info.error,
        bodySnippet: info.snippet,
      });
    } else if (type === 'session_list') {
      const structure: { keys: string } = { keys: '' };
      const extracted = extractSessions(data, structure);

      if (!extracted) {
        logger.error('session_list 解析失败（结构不符）', structure.keys);
        return;
      }

      // 按 id 合并，跨页累积会话列表
      capturedSessions = mergeSessions(capturedSessions, extracted.sessions);
      logger.info('Session list captured', {
        matched: structure.keys,
        page: extracted.sessions.length,
        total: capturedSessions.length,
        nextCursor: extracted.nextCursor || '(empty)',
      });

      notifyBackground({
        type: 'SESSION_LIST',
        payload: data,
      });
    } else if (type === 'history_messages') {
      const structure: { keys: string } = { keys: '' };
      const messages = extractMessages(data, structure);

      if (!messages) {
        logger.error('history_messages 解析失败（结构不符）', structure.keys);
        return;
      }

      capturedMessages = messages;
      logger.info('History messages captured', {
        matched: structure.keys,
        count: capturedMessages.length,
        sampleRoles: messages.slice(0, 3).map((m) => m.role),
        firstKeys: messages[0] ? Object.keys(messages[0]).join(',') : '(empty)',
      });

      notifyBackground({
        type: 'HISTORY_MESSAGES',
        payload: data,
      });
    } else if (type === 'sse_complete') {
      const sse = data as { content?: string; thinking?: string; model?: string };
      logger.info('SSE stream completed', {
        contentLen: sse.content?.length || 0,
        thinkingLen: sse.thinking?.length || 0,
        model: sse.model || '',
      });

      notifyBackground({
        type: 'SSE_COMPLETE',
        payload: data,
      });
    }
  } catch (error) {
    logger.error(`处理捕获数据时异常（type=${type}）`, String(error));
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

  logger.info('Proxy fetch start', {
    url: payload.url,
    body: payload.body,
    withToken: Boolean(authToken),
  });

  const response = await fetch(payload.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload.body),
    credentials: 'include',
  });

  if (!response.ok) {
    logger.error('Proxy fetch failed', {
      url: payload.url,
      status: response.status,
      statusText: response.statusText,
    });
    throw new Error(`API ${response.status}: ${response.statusText}`);
  }

  // JSON 解析失败时记录响应片段（比如误打到了前端路由返回的 HTML）
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    logger.error('Proxy fetch 返回非 JSON 响应', {
      url: payload.url,
      contentType,
      bodySnippet: text.slice(0, 500),
    });
    throw new Error(`响应非 JSON（content-type: ${contentType}），URL 可能不正确`);
  }

  try {
    const json = await response.json();
    logger.debug('Proxy fetch ok', payload.url);
    return json;
  } catch (error) {
    const text = await response.text().catch(() => '(unavailable)');
    logger.error('Proxy fetch JSON 解析失败', {
      url: payload.url,
      error: String(error),
      bodySnippet: text.slice(0, 500),
    });
    throw error;
  }
}

/**
 * 从最近捕获的 API URL 中找出指定后缀的真实端点。
 * 页面实际调用的 URL 可能带版本前缀（如 /api/v0/...），
 * SW 代理请求必须使用真实 URL，不能自己拼。
 */
function findCapturedUrl(suffix: string): string | undefined {
  return recentApiUrls.find((u) => u.includes(suffix));
}

/**
 * 在页面上下文创建 Blob URL 并通过 <a download> 触发下载。
 * （MV3 SW 中没有 URL.createObjectURL，大文件由这里兜底下载）
 */
function downloadBlob(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 等下载任务接管 Blob URL 后再释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  logger.info('Blob download triggered', { filename, size: json.length });
}

/**
 * 处理来自 background / popup 的消息。
 */
function handleMessage(message: ExtensionMessage, sendResponse: (response?: any) => void) {
  logger.debug('handleMessage', message.type);

  if (message.type === 'GET_STATUS') {
    const status: StatusPayload = {
      connected: hookInstalled,
      currentSessionId,
      capturedSessions: capturedSessions.length,
      capturedMessages: capturedMessages.length,
      exporting: false,
      exportProgress: 0,
      recentApiUrls,
    };
    sendResponse(status);
  } else if (message.type === 'EXPORT_CURRENT') {
    // 返回当前会话与已捕获消息（完整历史由 background 通过代理请求补全）
    if (!currentSessionId) {
      logger.warn('EXPORT_CURRENT requested but no session id');
      sendResponse({ error: '未找到当前会话，请先打开一个对话' });
      return;
    }

    logger.info('EXPORT_CURRENT requested', {
      sessionId: currentSessionId,
      capturedCount: capturedMessages.length,
    });
    sendResponse({
      sessionId: currentSessionId,
      messages: capturedMessages,
      historyUrl: findCapturedUrl('history_messages'),
    });
  } else if (message.type === 'EXPORT_ALL') {
    logger.info('EXPORT_ALL requested', { capturedSessions: capturedSessions.length });
    sendResponse({
      sessions: capturedSessions,
      fetchPageUrl: findCapturedUrl('chat_session/fetch_page'),
      historyUrl: findCapturedUrl('history_messages'),
    });
  } else if (message.type === 'FETCH_PROXY') {
    proxyFetch(message.payload as FetchProxyPayload)
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: String(error) }));
    // 异步响应，保持通道打开
  } else if (message.type === 'DOWNLOAD_BLOB') {
    const { filename, json } = message.payload as { filename: string; json: string };
    try {
      downloadBlob(filename, json);
      sendResponse({ success: true });
    } catch (error) {
      logger.error('Blob download failed', String(error));
      sendResponse({ error: String(error) });
    }
  }
}

// document_start 注入时立即初始化，确保 hook 赶在页面首批 API 请求前安装
init();
