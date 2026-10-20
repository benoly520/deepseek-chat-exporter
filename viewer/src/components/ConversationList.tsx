/**
 * 会话列表侧栏组件。
 */

import { resolve } from 'plain';
import { filteredConversations, currentId, selectConversation } from '../state';
import { formatRelativeTime } from '../utils/date-format';
import type { Conversation } from '../types';

/**
 * 单个会话条目。
 */
function ConvItem(props: { conv: Conversation }) {
  const conv = () => resolve(props.conv);
  const active = () => currentId() === conv().id;

  return (
    <div
      class={active() ? 'conv-item active' : 'conv-item'}
      onClick={() => selectConversation(conv().id)}
    >
      <div class="title">{conv().title || 'Untitled'}</div>
      <div class="meta">
        {conv().messages.length} 条消息 · {formatRelativeTime(conv().updated_at)}
      </div>
    </div>
  );
}

export function ConversationList() {
  const list = filteredConversations;

  return (
    <div class="sidebar">
      {list().length === 0 ? (
        <div class="conv-item">
          <div class="meta">没有匹配的会话</div>
        </div>
      ) : (
        list().map((c) => <ConvItem conv={c} />)
      )}
    </div>
  );
}
