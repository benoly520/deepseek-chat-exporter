/**
 * Content Script 入口。
 * 负责：注入 fetch hook、监听捕获数据、按需代理 API 请求、响应 background 消息。
 * 所有运行日志通过 createLocalLogger 记录并转发给 service worker 汇总。
 */

import { startPageWatcher } from './page-watcher';
import { createLocalLogger } from '../utils/logger';
import { describeError } from '../utils/error';
import { extractMessages, extractSessions } from '../utils/api-extract';
import type {
  ExtensionMessage,
  StatusPayload,
  SessionSummary,
  FetchProxyPayload,
  CapturedApiRequest,
  RawMessage,
} from '../types';

// 日志器：本地记录 + 转发 SW 汇总
const logger = createLocalLogger('content', true);

// DeepSeek 站点基地址：hook 捕获的相对路径按此解析
const API_BASE = 'https://chat.deepseek.com';

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
// 页面真实请求配置（method/url/body），SW 代理据此原样重放
// fetch_page 保留最近若干个（用户滚动列表时页面会带不同游标请求）
let capturedRequests: CapturedApiRequest[] = [];

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
    } else if (type === 'api_request') {
      // 记录页面真实请求配置（method/url/body），供 SW 代理重放
      const req = data as CapturedApiRequest;
      // 同 URL+method 去重，最新在前
      capturedRequests = [req, ...capturedRequests.filter(
        (r) => !(r.kind === req.kind && r.url === req.url && r.body === req.body)
      )].slice(0, 50);
      logger.info('API request captured', {
        kind: req.kind,
        method: req.method,
        url: req.url,
        hasBody: Boolean(req.body),
      });

      // 删除请求捕获：通知 SW 学习删除接口模板（批量删除据此重放）
      if (req.kind === 'delete') {
        notifyBackground({
          type: 'DELETE_REQUEST_CAPTURED',
          payload: req,
        });
      }
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
        // 首条消息完整 JSON（截断），用于确认真实字段结构
        firstSample: messages[0] ? JSON.stringify(messages[0]).slice(0, 1200) : '(empty)',
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
  const method = (payload.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (payload.body) {
    headers['Content-Type'] = 'application/json';
  }
  if (authToken) {
    headers['Authorization'] = authToken;
  }

  logger.info('Proxy request start', {
    url: payload.url,
    method,
    body: payload.body,
    withToken: Boolean(authToken),
  });

  const response = await fetch(payload.url, {
    method,
    headers,
    // 重放页面请求：GET 不带 body，POST 透传原始 body 字符串
    body: method === 'GET' || !payload.body ? undefined : String(payload.body),
    credentials: 'include',
  });

  if (!response.ok) {
    logger.error('Proxy fetch failed', {
      url: payload.url,
      status: response.status,
      statusText: response.statusText,
    });
    // 401/403：大概率未登录或登录已过期，直接给出可操作的提示
    if (response.status === 401 || response.status === 403) {
      throw new Error('未登录或登录已过期，请先登录 chat.deepseek.com 后重试');
    }
    throw new Error(`API ${response.status}: ${response.statusText}`);
  }

  // JSON 解析失败时记录响应片段（比如误打到了前端路由返回的 HTML）
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    logger.error('Proxy fetch 返回非 JSON 响应', {
      url: payload.url,
      contentType,
      hasToken: Boolean(authToken),
      bodySnippet: text.slice(0, 500),
    });
    // 已有 token 却拿到 SPA 文档：URL 命中的是前端路由兜底页（API 路径不存在），
    // 与登录态无关，必须报成端点问题，否则会误导用户去重新登录。
    if (authToken && /^\s*<(!doctype|html)/i.test(text)) {
      throw new Error(
        `API 端点不存在（${payload.url} 返回了页面 HTML 而非 JSON），` +
          '可能是 DeepSeek 接口路径已变更，请把弹窗里的运行日志反馈给扩展作者'
      );
    }
    // 无 token 且返回 HTML：大概率未登录（被重定向到登录页）
    if (!authToken) {
      throw new Error('未登录或登录已过期，请先登录 chat.deepseek.com 后重试');
    }
    throw new Error(`响应非 JSON（content-type: ${contentType}），URL 可能不正确`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    // content-type 已是 JSON 但正文解析失败（如截断 / 空体）
    logger.error('Proxy fetch JSON 解析失败', {
      url: payload.url,
      error: String(error),
    });
    throw error;
  }

  // v0 API 的业务错误也返回 HTTP 200（如 {"code":40003,"msg":"INVALID_TOKEN"}），
  // 必须在这里识别，否则会被当成“响应结构不符”误导排查
  assertBusinessOk(json, payload.url);
  logger.debug('Proxy fetch ok', payload.url);
  return json;
}

/**
 * 识别业务层错误码。v0 API 的错误包络形如 {code:40003,msg:"INVALID_TOKEN",data:null}，
 * 且 HTTP 状态仍为 200；只在同时具备 msg / data:null 特征时判定为错误，
 * 避免误把业务对象里的 code 字段当成错误码。
 * 认证类错误（未登录 / token 失效）转成可直接操作的提示。
 */
function assertBusinessOk(json: unknown, url: string): void {
  const envelope = json as { code?: unknown; msg?: unknown; data?: unknown } | null;
  if (typeof envelope !== 'object' || envelope === null) return;

  const code = Number(envelope.code);
  const hasMsg = typeof envelope.msg === 'string' && envelope.msg;
  const isEnvelopeShape = 'data' in envelope && 'msg' in envelope;
  if (!Number.isFinite(code) || code === 0 || !hasMsg || !isEnvelopeShape) {
    return; // 非错误包络，视为成功响应
  }

  const msg = String(envelope.msg);
  logger.error('Proxy fetch 业务错误', { url, code, msg });
  if (/token|unauth|login|auth/i.test(msg)) {
    throw new Error('未登录或登录已过期，请先登录 chat.deepseek.com 后重试');
  }
  throw new Error(`API 业务错误（code=${code}, msg=${msg}）`);
}

/**
 * 会话列表端点特征（与 fetch-hook 一致的"路径后缀"匹配，兼容任意版本前缀）。
 */
const FETCH_PAGE_MARK = 'chat_session/fetch_page';

/**
 * 构造兜底的 fetch_page 请求配置。
 * 页面侧列表组件挂载时必然请求一次 fetch_page，但 hook 是异步注入的，
 * 存在“请求早于 hook 安装”的竞态（侧栏未挂载时也不会请求），此时拿不到真实配置。
 * 这里按 v0 协议拼一条等价请求：
 * - GET + query 参数（页面侧真实调用就是 http.get，与它保持一致）；
 * - 首页不传 lte_cursor.updated_at（页面初始游标值为 null，序列化时省略）；
 * - count 缺省交给服务端默认页大小（捕获到的 URL 若带 count 会原样保留）。
 */
function buildFetchPageFallback(url: string): CapturedApiRequest {
  let pathname = url;
  let search = '';
  try {
    const u = new URL(url, API_BASE);
    pathname = u.pathname;
    // 剔除游标类参数，保留其余（如 count），由 SW 翻页时重新注入游标
    const params = new URLSearchParams(u.search);
    for (const key of Array.from(params.keys())) {
      if (key.includes('cursor')) params.delete(key);
    }
    search = params.toString() ? `?${params.toString()}` : '';
  } catch {
    pathname = url.split('?')[0];
  }
  return { kind: 'fetchPage', url: `${pathname}${search}`, method: 'GET' };
}

/**
 * 在捕获的请求配置中找出指定类型的最新一条。
 * fetch_page 缺失时，退回从已捕获的 /api/ URL 里自适应发现该端点
 * （端点路径若再变更，只要页面发起过一次请求即可自愈）。
 */
function findRequest(kind: 'fetchPage' | 'history'): CapturedApiRequest | undefined {
  const captured = capturedRequests.find((r) => r.kind === kind);
  if (captured || kind !== 'fetchPage') {
    return captured;
  }
  const hit = recentApiUrls.find((u) => u.includes(FETCH_PAGE_MARK));
  if (hit) {
    logger.info('从捕获 URL 中发现 fetch_page 端点（请求配置未捕获，使用兜底）', hit);
    return buildFetchPageFallback(hit);
  }
  return undefined;
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
      historyRequest: findRequest('history'),
      fetchPageRequest: findRequest('fetchPage'),
    });
  } else if (message.type === 'EXPORT_ALL') {
    logger.info('EXPORT_ALL requested', {
      capturedSessions: capturedSessions.length,
      fetchPageRequests: capturedRequests.filter((r) => r.kind === 'fetchPage').length,
    });
    sendResponse({
      sessions: capturedSessions,
      fetchPageRequest: findRequest('fetchPage'),
      historyRequest: findRequest('history'),
    });
  } else if (message.type === 'FETCH_PROXY') {
    proxyFetch(message.payload as FetchProxyPayload)
      .then((data) => sendResponse({ data }))
      .catch((error) => sendResponse({ error: describeError(error) }));
    // 异步响应，保持通道打开
  } else if (message.type === 'DOWNLOAD_BLOB') {
    const { filename, json } = message.payload as { filename: string; json: string };
    try {
      downloadBlob(filename, json);
      sendResponse({ success: true });
    } catch (error) {
      logger.error('Blob download failed', describeError(error));
      sendResponse({ error: describeError(error) });
    }
  }
}

// document_start 注入时立即初始化，确保 hook 赶在页面首批 API 请求前安装
init();
