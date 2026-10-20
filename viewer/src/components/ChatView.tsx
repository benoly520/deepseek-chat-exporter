/**
 * 聊天主视图组件：消息气泡、思考过程折叠块、Markdown 渲染。
 */

import { signal, effect, resolve } from 'plain';
import { currentConversation, currentId } from '../state';
import { renderMarkdown } from '../utils/markdown';
import { formatDateTime, formatTime } from '../utils/date-format';
import type { Message } from '../types';

/**
 * 思考过程折叠块（默认折叠）。
 */
function ThinkingBlock(props: { text: string }) {
  const open = signal(false);
  const text = () => resolve(props.text);

  return (
    <div class="thinking">
      <button class="thinking-toggle" onClick={() => open.set(!open())}>
        {open() ? '▼' : '▶'} 思考过程（点击{open() ? '收起' : '展开'}）
      </button>
      <div class="thinking-body" hidden={!open()}>
        {text()}
      </div>
    </div>
  );
}

/**
 * Markdown 内容渲染（ref 逃逸口 + effect 更新 innerHTML）。
 */
function MarkdownContent(props: { content: string }) {
  const html = () => renderMarkdown(resolve(props.content));

  return (
    <div
      class="markdown-body"
      ref={(el) => {
        // 内容变化时同步 innerHTML；返回清理函数回收 effect
        const eff = effect(() => {
          // plain-ignore-next-line PLAIN_E1104
          el.innerHTML = html();
        });
        return () => eff.dispose();
      }}
    />
  );
}

/**
 * 单条消息气泡。
 */
function MessageBubble(props: { msg: Message }) {
  const msg = () => resolve(props.msg);
  const isUser = () => msg().role === 'user';
  const time = () => (isUser() ? formatTime(msg().created_at) : formatDateTime(msg().created_at));

  /**
   * 复制消息原文到剪贴板。
   */
  async function copyContent() {
    try {
      await navigator.clipboard.writeText(msg().content);
    } catch (error) {
      console.error('复制失败:', error);
    }
  }

  return (
    <div class={isUser() ? 'msg user' : 'msg assistant'}>
      <div class="bubble">
        {!isUser() && msg().thinking ? <ThinkingBlock text={msg().thinking || ''} /> : null}

        {isUser() ? (
          <div>{msg().content}</div>
        ) : (
          <MarkdownContent content={msg().content} />
        )}

        <div class="msg-time">{time()}</div>

        {!isUser() ? (
          <button class="copy-btn" onClick={copyContent}>
            复制原文
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ChatView() {
  const conv = currentConversation;

  return (
    <div class="chat">
      <div class="chat-title">{conv()?.title || '未选择会话'}</div>

      <div
        class="chat-scroll"
        ref={(el) => {
          // 切换会话时自动滚动到底部；返回清理函数回收 effect
          const eff = effect(() => {
            currentId();
            el.scrollTop = el.scrollHeight;
          });
          return () => eff.dispose();
        }}
      >
        {conv() === null ? (
          <div class="chat-empty">从左侧选择一个会话开始浏览</div>
        ) : (
          (conv()?.messages || []).map((m) => <MessageBubble msg={m} />)
        )}
      </div>
    </div>
  );
}
