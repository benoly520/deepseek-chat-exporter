/**
 * Fetch Hook —— 注入页面 MAIN world，拦截 DeepSeek API 调用。
 * 运行在页面上下文（而非扩展上下文）。
 *
 * 同时覆盖 fetch 与 XMLHttpRequest（部分前端栈走 XHR），
 * URL 匹配采用"路径后缀"方式，兼容 /api/v0/... 等版本前缀。
 */

(function() {
  'use strict';

  // 保存原始实现
  const originalFetch = window.fetch;
  const XHR = XMLHttpRequest.prototype;
  const originalXhrOpen = XHR.open;
  const originalXhrSend = XHR.send;
  const originalXhrSetHeader = XHR.setRequestHeader;

  // 记录最近捕获的 Authorization 头（DeepSeek 网页版使用 Bearer Token 认证）
  let lastAuthToken = '';

  /**
   * 判断是否为目标 API（路径后缀匹配，兼容 /api/v0/... 等版本前缀）。
   */
  function isSessionListApi(url: string): boolean {
    return url.includes('chat_session/fetch_page');
  }

  function isHistoryApi(url: string): boolean {
    return url.includes('history_messages');
  }

  /**
   * 上报 API URL（诊断用：全部 /api/ 请求都会记录）。
   */
  function noteApiUrl(url: string) {
    if (!url.includes('/api/')) return;
    dispatchDataEvent('api_url', url);
  }

  /**
   * 捕获 /api/ 请求的完整配置（url / method / body）。
   * kind 分类：fetchPage / history 供导出重放；delete 供删除接口学习
   * （用户在页面手动删除会话时捕获真实删除请求，批量删除据此重放）。
   */
  function noteApiRequest(url: string, method: string, body?: string) {
    if (!url.includes('/api/')) return;
    let kind: 'fetchPage' | 'history' | 'delete' | 'other' = 'other';
    if (isSessionListApi(url)) {
      kind = 'fetchPage';
    } else if (isHistoryApi(url)) {
      kind = 'history';
    } else if (/chat_session\/delete|\/delete/i.test(url)) {
      kind = 'delete';
    } else {
      return; // 其他请求不捕获，避免噪音
    }
    dispatchDataEvent('api_request', {
      kind,
      url,
      method: method.toUpperCase(),
      body: typeof body === 'string' && body ? body : undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // fetch 拦截
  // ---------------------------------------------------------------------------

  /**
   * 拦截 fetch 调用，捕获目标 API 响应。
   */
  window.fetch = async function(...args) {
    const [input, init] = args;
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : String(input);
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const reqBody = typeof init?.body === 'string' ? init.body : undefined;

    noteApiUrl(url);
    noteApiRequest(url, method, reqBody);

    // 提取 Authorization 头（Request 对象或 init.headers 均可能携带）
    const authHeader = readHeader(input, init, 'authorization');
    if (authHeader && authHeader !== lastAuthToken) {
      lastAuthToken = authHeader;
      dispatchDataEvent('auth_token', authHeader);
    }

    const acceptHeader = readHeader(input, init, 'accept');
    const shouldIntercept =
      isSessionListApi(url) ||
      isHistoryApi(url) ||
      acceptHeader.includes('text/event-stream');

    if (!shouldIntercept) {
      // 非目标 API，走原始 fetch
      return originalFetch.apply(this, args);
    }

    try {
      const response = await originalFetch.apply(this, args);
      // 克隆响应以便在不消耗原始响应体的前提下读取
      const clonedResponse = response.clone();

      if (isSessionListApi(url)) {
        handleSessionListResponse(clonedResponse);
      } else if (isHistoryApi(url)) {
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
   * 从请求参数中读取指定请求头（兼容 string / Headers / Request / 普通对象）。
   */
  function readHeader(input: unknown, init: RequestInit | undefined, name: string): string {
    let headers: Headers | undefined;
    if (input instanceof Request) {
      headers = input.headers;
    }
    if (init?.headers) {
      headers = normalizeHeaders(init.headers);
    }
    return headers?.get(name) || '';
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

  // ---------------------------------------------------------------------------
  // XMLHttpRequest 拦截（兜底：部分前端栈不走 fetch）
  // ---------------------------------------------------------------------------

  XHR.open = function(this: XMLHttpRequest & { __dsUrl?: string; __dsMethod?: string }, ...args: any[]) {
    const url = args[1];
    this.__dsUrl = typeof url === 'string' ? url : String(url);
    this.__dsMethod = String(args[0] || 'GET');
    return (originalXhrOpen as any).apply(this, args);
  };

  XHR.setRequestHeader = function(this: XMLHttpRequest, name: string, value: string) {
    if (String(name).toLowerCase() === 'authorization' && value && value !== lastAuthToken) {
      lastAuthToken = value;
      dispatchDataEvent('auth_token', value);
    }
    return (originalXhrSetHeader as any).call(this, name, value);
  };

  XHR.send = function(this: XMLHttpRequest & { __dsUrl?: string; __dsMethod?: string }, ...sendArgs: any[]) {
    const url: string = this.__dsUrl || '';
    const method = this.__dsMethod || 'GET';
    const rawBody = sendArgs[0];
    const body = typeof rawBody === 'string' ? rawBody : undefined;
    noteApiUrl(url);
    noteApiRequest(url, method, body);

    if (isSessionListApi(url) || isHistoryApi(url)) {
      this.addEventListener('load', () => {
        try {
          // 优先用 responseURL（重定向后更准确）
          const finalUrl = this.responseURL || url;
          const contentType = this.getResponseHeader('content-type') || '';
          if (!contentType.includes('application/json')) return;

          const data = JSON.parse(this.responseText);
          if (isSessionListApi(finalUrl)) {
            dispatchDataEvent('session_list', data);
          } else if (isHistoryApi(finalUrl)) {
            dispatchDataEvent('history_messages', data);
          }
        } catch (error) {
          console.error('[DeepSeek Exporter] Failed to parse XHR response:', error);
        }
      });
    }

    return (originalXhrSend as any).apply(this, sendArgs);
  };

  // ---------------------------------------------------------------------------
  // 响应处理
  // ---------------------------------------------------------------------------

  /**
   * 处理会话列表 API 响应。
   */
  async function handleSessionListResponse(response: Response) {
    try {
      const data = await response.json();
      dispatchDataEvent('session_list', data);
    } catch (error) {
      // 上报响应片段，供 content script 记入诊断日志
      await reportParseError('session_list', response, error);
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
      await reportParseError('history_messages', response, error);
    }
  }

  /**
   * JSON 解析失败时上报错误与响应体片段（hook 自身无日志通道，借 CustomEvent 外传）。
   */
  async function reportParseError(kind: string, response: Response, error: unknown) {
    console.error('[DeepSeek Exporter] Failed to parse', kind, error);
    let snippet = '';
    try {
      snippet = (await response.text()).slice(0, 800);
    } catch {
      snippet = '(body unavailable)';
    }
    dispatchDataEvent('api_parse_error', {
      kind,
      status: response.status,
      error: String(error),
      snippet,
    });
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

  console.log('[DeepSeek Exporter] Fetch hook installed (fetch + XHR)');
})();
