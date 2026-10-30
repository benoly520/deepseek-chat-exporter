/**
 * 会话列表侧栏组件。
 */

import { resolve } from 'plain';
import { filteredConversations, currentId, selectConversation } from '../state';
import { formatRelativeTime } from '../utils/date-format';
import { t } from '../i18n';
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
      <div class="title">{conv().title || t('list.untitled')}</div>
      <div class="meta">
        {t('list.meta', { n: conv().messages.length, time: formatRelativeTime(conv().updated_at) })}
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
          <div class="meta">{t('list.noMatch')}</div>
        </div>
      ) : (
        list().map((c) => <ConvItem conv={c} />)
      )}
    </div>
  );
}
