/**
 * Page Watcher —— 监听 chat.deepseek.com 的 SPA 路由变化。
 * 从 URL 中提取会话 ID 并通知扩展。
 */

/**
 * 从当前 URL 提取会话 ID。
 * DeepSeek 的会话 URL 形如 /a/chat/{session_id}，
 * session_id 是带连字符的 UUID（如 5a298e61-4fd4-455b-9aaf-7c6142d727a0），
 * 因此正则必须包含连字符，不能只匹配十六进制段。
 */
export function extractSessionId(): string | null {
  const match = window.location.pathname.match(/\/chat\/([0-9a-fA-F][0-9a-fA-F-]+)/);
  return match ? match[1] : null;
}

/**
 * 开始监听页面变化。
 */
export function startPageWatcher(onChange: (sessionId: string | null) => void): void {
  let lastSessionId = extractSessionId();

  // 通知初始状态
  onChange(lastSessionId);

  // 监听浏览器前进 / 后退
  window.addEventListener('popstate', () => {
    const newSessionId = extractSessionId();
    if (newSessionId !== lastSessionId) {
      lastSessionId = newSessionId;
      onChange(newSessionId);
    }
  });

  // MutationObserver 兜底：SPA 内部更新 DOM 但未走 pushState 时也能感知。
  // 注意 content script 在 document_start 注入时 document.body 尚不存在，
  // 因此必须观察 documentElement。
  const observer = new MutationObserver(() => {
    const newSessionId = extractSessionId();
    if (newSessionId !== lastSessionId) {
      lastSessionId = newSessionId;
      onChange(newSessionId);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // 拦截 pushState / replaceState 以捕获 SPA 路由跳转
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    const newSessionId = extractSessionId();
    if (newSessionId !== lastSessionId) {
      lastSessionId = newSessionId;
      onChange(newSessionId);
    }
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    const newSessionId = extractSessionId();
    if (newSessionId !== lastSessionId) {
      lastSessionId = newSessionId;
      onChange(newSessionId);
    }
  };
}
