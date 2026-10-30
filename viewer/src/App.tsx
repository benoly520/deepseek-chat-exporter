/**
 * 应用根组件：文件加载页 / 主视图（侧栏 + 聊天区）切换。
 */

import './styles.css';
import { conversations, searchQuery, setSearch, stats, loadFiles } from './state';
import { FileLoader } from './components/FileLoader';
import { ConversationList } from './components/ConversationList';
import { ChatView } from './components/ChatView';
import { LangSwitch } from './components/LangSwitch';
import { t } from './i18n';
import { formatDateTime } from './utils/date-format';

/**
 * 主视图：顶栏 + 侧栏 + 聊天区 + 状态栏。
 */
function MainView() {
  let fileInput: HTMLInputElement | null = null;
  const s = stats;

  /**
   * 追加导入更多文件。
   */
  function importMore(files: FileList | null) {
    if (!files || files.length === 0) return;
    loadFiles(Array.from(files));
  }

  return (
    <div class="main">
      <div class="topbar">
        <h1>DeepSeek Chat Viewer</h1>
        <input
          class="search"
          type="text"
          placeholder={t('app.searchPlaceholder')}
          value={searchQuery()}
          onInput={(e) => setSearch(e.target.value)}
        />
        <button class="btn-import" onClick={() => fileInput?.click()}>
          {t('app.import')}
        </button>
        <LangSwitch />
        <input
          type="file"
          accept=".json,application/json"
          multiple
          onChange={(e) => importMore(e.target.files)}
          ref={(el) => {
            fileInput = el;
          }}
        />
      </div>

      <div class="layout">
        <ConversationList />
        <ChatView />
      </div>

      <div class="statusbar">
        {t('app.status', { c: s().totalConversations, m: s().totalMessages })}
        {s().exportedAt ? ` · ${t('app.exportedAt', { time: formatDateTime(s().exportedAt) })}` : ''}
      </div>
    </div>
  );
}

export function App() {
  const hasData = () => conversations().length > 0;

  return (
    <div class="app">
      <div class="view-wrap" hidden={hasData()}>
        <FileLoader />
      </div>
      <div class="view-wrap" hidden={!hasData()}>
        <MainView />
      </div>
    </div>
  );
}
