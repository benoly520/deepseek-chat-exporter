/**
 * Fetch Hook —— 注入页面 MAIN world，拦截 DeepSeek API 调用。
 * 运行在页面上下文（而非扩展上下文）。
 */

(function() {
  'use strict';

  // 保存原始 fetch
  const originalFetch = window.fetch;
  // 记录最近捕获的 Authorization 头（DeepSeek 网页版使用 Bearer Token 认证）
  let lastAuthToken = '';

  /**
   * 拦截 fetch 调用，捕获目标 API 响应。
   */
  window.fetch = async function(...args) {
    const [input, init] = args;
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);

    // 提取 Authorization 头（Request 对象或 init.headers 均可能携带）
    const authHeader = readAuthHeader(input, init);
    if (authHeader && authHeader !== lastAuthToken) {
      lastAuthToken = authHeader;
      dispatchDataEvent('auth_token', authHeader);
    }

    const acceptHeader = readAcceptHeader(input, init);
    const shouldIntercept =
      url.includes('/api/chat_session/fetch_page') ||
      url.includes('/api/chat/history_messages') ||
      acceptHeader.includes('text/event-stream');

    if (!shouldIntercept) {
      // 非目标 API，走原始 fetch
      return originalFetch.apply(this, args);
    }

    try {
      const response = await originalFetch.apply(this, args);
      // 克隆响应以便在不消耗原始响应体的前提下读取
      const clonedResponse = response.clone();

      if (url.includes('/api/chat_session/fetch_page')) {
        handleSessionListResponse(clonedResponse);
      } else if (url.includes('/api/chat/history_messages')) {
        handleHistoryMessagesResponse(clonedResponse);
      } else if (acceptHeader.includes('text/event-stream')) {
        handleSSEResponse(clonedResponse);
      }

      // 返回原始响应，保证页面自身逻辑不受影响
      return response;
    } catch (error) {
      console.error('[DeepSeek Exporter] Fetch interception error:', error);
      return originalFetch.apply(this, args);
    }
  };

  /**
   * 从请求参数中读取 Accept 头（兼容 string / Headers / Request / 普通对象）。
   */
  function readAcceptHeader(input: unknown, init?: RequestInit): string {
    let headers: Headers | undefined;
    if (input instanceof Request) {
      headers = input.headers;
    }
    if (init?.headers) {
      headers = normalizeHeaders(init.headers);
    }
    return headers?.get('Accept') || headers?.get('accept') || '';
  }

  /**
   * 从请求参数中读取 Authorization 头。
   */
  function readAuthHeader(input: unknown, init?: RequestInit): string {
    let headers: Headers | undefined;
    if (input instanceof Request) {
      headers = input.headers;
    }
    if (init?.headers) {
      headers = normalizeHeaders(init.headers);
    }
    return headers?.get('Authorization') || headers?.get('authorization') || '';
  }

  /**
   * 将各类 headers 形态归一化为 Headers 实例。
   */
  function normalizeHeaders(value: HeadersInit): Headers | undefined {
    if (value instanceof Headers) return value;
    if (Array.isArray(value)) return new Headers(value as [string, string][]);
    if (typeof value === 'object') return new Headers(value as Record<string, string>);
    return undefined;
  }

  /**
   * 处理会话列表 API 响应。
   */
  async function handleSessionListResponse(response: Response) {
    try {
      const data = await response.json();
      dispatchDataEvent('session_list', data);
    } catch (error) {
      console.error('[DeepSeek Exporter] Failed to parse session list:', error);
    }
  }

  /**
   * 处理历史消息 API 响应。
   */
  async function handleHistoryMessagesResponse(response: Response) {
    try {
      const data = await response.json();
      dispatchDataEvent('history_messages', data);
    } catch (error) {
      console.error('[DeepSeek Exporter] Failed to parse history messages:', error);
    }
  }

  /**
   * 处理 SSE 流式响应，拼接完整的助手回复。
   */
  async function handleSSEResponse(response: Response) {
    try {
      if (!response.body) {
        console.warn('[DeepSeek Exporter] SSE response has no body');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembledContent = '';
      let assembledThinking = '';
      let model = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 只处理完整的行，未完成部分留在 buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
              // 流结束
              dispatchDataEvent('sse_complete', {
                content: assembledContent,
                thinking: assembledThinking,
                model,
              });
              return;
            }

            try {
              const parsed = JSON.parse(data);

              // 提取增量内容
              if (parsed.choices?.[0]?.delta) {
                const delta = parsed.choices[0].delta;

                if (delta.content) {
                  assembledContent += delta.content;
                }
                if (delta.thinking) {
                  assembledThinking += delta.thinking;
                }
              }

              // 提取模型名
              if (parsed.model) {
                model = parsed.model;
              }
            } catch (e) {
              // 跳过无法解析的行
            }
          }
        }
      }

      // 流未以 [DONE] 结束时也派发已拼装内容
      if (assembledContent || assembledThinking) {
        dispatchDataEvent('sse_complete', {
          content: assembledContent,
          thinking: assembledThinking,
          model,
        });
      }
    } catch (error) {
      console.error('[DeepSeek Exporter] Failed to process SSE stream:', error);
    }
  }

  /**
   * 通过 CustomEvent 将数据派发给 content script。
   */
  function dispatchDataEvent(type: string, data: unknown) {
    window.dispatchEvent(
      new CustomEvent('__ds_data__', {
        detail: { type, data },
      })
    );
  }

  // 通知 content script：hook 已安装
  window.dispatchEvent(new CustomEvent('__ds_hook_control__', {
    detail: { status: 'installed' }
  }));

  console.log('[DeepSeek Exporter] Fetch hook installed');
})();
