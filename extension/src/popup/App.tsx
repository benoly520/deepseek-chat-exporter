/**
 * Popup 主界面（plain 实现）—— 会话管理器。
 * 功能：自动加载全部会话列表（keyset 分页）、勾选导出、批量删除（学习式）、运行日志。
 */

import { signal, computed, resolve } from 'plain';
import type { StatusPayload, ExtensionMessage, SessionSummary } from '../types';
import { formatAll } from '../utils/logger';
import { describeError } from '../utils/error';
import type { LogEntry } from '../utils/logger';
import { lang, setLang, t } from './i18n';

// --- 状态 ---

/** 来自 background 的状态（每 2 秒轮询刷新） */
const status = signal<StatusPayload>({
  connected: false,
  currentSessionId: null,
  capturedSessions: 0,
  capturedMessages: 0,
  exporting: false,
  exportProgress: 0,
});

/**
 * 提示消息：存 key + 参数而非成品字符串，渲染时再翻译，
 * 这样切换语言时已显示的提示也会跟着变。
 */
type MessageState = { key: string; vars?: Record<string, string | number>; error: boolean };

/** 提示消息 */
const message = signal<MessageState | null>(null);

/** 会话列表（popup 本地副本） */
const sessions = signal<SessionSummary[]>([]);
/** 勾选的会话 ID */
const selected = signal<Set<string>>(new Set());
/** 列表加载中 */
const listLoading = signal(false);
/** 列表加载进度（已加载条数，来自 SW 广播） */
const listLoaded = signal(0);

/** 当前标签页：置顶 / 非置顶 */
type SessionTab = 'pinned' | 'normal';
const activeTab = signal<SessionTab>('normal');

/**
 * 日期分组的显式展开状态（只记录用户点过的分组）。
 * 未记录的分组按「第一个分组展开、其余收起」的默认规则判定。
 */
const groupExpanded = signal<Record<string, boolean>>({});

/** 汇总日志文本（从 service worker 拉取） */
const logsText = signal('');

/** 扩展版本号（从 manifest 读取，日志头与界面展示共用） */
const extVersion = chrome.runtime.getManifest().version;

// --- 确认弹窗（替代 window.confirm，风格与 popup 统一） ---

/** 弹窗是否可见 */
const confirmVisible = signal(false);
/** 弹窗正文 */
const confirmText = signal('');
/** 待 resolve 的回调（confirmDialog 返回的 Promise） */
let confirmResolve: ((ok: boolean) => void) | null = null;

/**
 * 弹出风格统一的确认框，返回用户是否确认。
 */
function confirmDialog(text: string): Promise<boolean> {
  confirmText.set(text);
  confirmVisible.set(true);
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

/**
 * 处理确认框按钮点击（取消 / 确认），关闭弹窗并兑现 Promise。
 */
function answerConfirm(ok: boolean) {
  confirmVisible.set(false);
  const resolve = confirmResolve;
  confirmResolve = null;
  resolve?.(ok);
}

/**
 * 归一化会话时间字段为毫秒时间戳，取不到（缺失 / 无法解析）返回 null。
 */
function sessionTimeMs(s: SessionSummary): number | null {
  const raw = s.updated_at ?? s.created_at;
  if (raw === undefined || raw === null || raw === '') return null;
  let ms: number;
  if (typeof raw === 'number') {
    // 秒级时间戳（>1e12 视为毫秒）
    ms = raw > 1e12 ? raw : raw * 1000;
  } else if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    ms = n > 1e12 ? n : n * 1000;
  } else {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    ms = d.getTime();
  }
  return isNaN(new Date(ms).getTime()) ? null : ms;
}

/**
 * 归一化会话时间字段并格式化为本地 "YYYY-MM-DD HH:mm"，取不到返回空串。
 */
function formatSessionDate(s: SessionSummary): string {
  const ms = sessionTimeMs(s);
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日期分组的兜底键：会话时间缺失或无法解析时归入此组 */
const UNKNOWN_DAY = 'unknown';

/**
 * 周几文案：从字典取（按 | 分隔），用 Date.getDay() 索引。
 */
function weekdayNames(): string[] {
  return t('date.weekdays').split('|');
}

/**
 * 取本地自然日的分组键 "YYYY-MM-DD"，时间不可用时返回 UNKNOWN_DAY。
 */
function dayKeyOf(ms: number | null): string {
  if (ms === null) return UNKNOWN_DAY;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 日期分组标题：今天 / 昨天 / MM-DD 周X（跨年补年份）。
 */
function formatDayLabel(key: string): string {
  if (key === UNKNOWN_DAY) return t('date.unknown');
  const now = Date.now();
  if (key === dayKeyOf(now)) return t('date.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKeyOf(yesterday.getTime())) return t('date.yesterday');
  const [y, m, d] = key.split('-').map(Number);
  const week = weekdayNames()[new Date(y, m - 1, d).getDay()] ?? '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = `${pad(m)}-${pad(d)}`;
  const yearText = y === new Date(now).getFullYear() ? md : `${y}-${md}`;
  return `${yearText} ${week}`;
}

/**
 * 构造日志文本头部（版本号 + 导出时间 + 条数），便于定位用户环境。
 */
function buildLogsHeader(entryCount: number): string {
  return t('logs.header', {
    v: extVersion,
    time: new Date().toLocaleString(),
    n: entryCount,
  });
}

/** 进度区标题：批量操作显示 N/总数 + 会话标题，单会话导出显示百分比 */
const progressTitle = computed(() => {
  const cur = status().exportCurrent;
  if (cur && cur.total > 0) {
    return t('progress.current', { i: cur.index, total: cur.total, title: cur.title });
  }
  return t('progress.exporting', { p: status().exportProgress });
});

/** 已选数量（跨标签页合计） */
const selectedCount = computed(() => selected().size);

/** 置顶会话（保持接口返回顺序，即时间倒序） */
const pinnedList = computed(() => sessions().filter((s) => Boolean(s.pinned)));

/** 非置顶会话（保持接口返回顺序，即时间倒序） */
const normalList = computed(() => sessions().filter((s) => !s.pinned));

/** 当前标签页的会话列表 */
const currentList = computed(() =>
  activeTab() === 'pinned' ? pinnedList() : normalList()
);

/** 当前标签页已选数量 */
const currentCheckedCount = computed(() => {
  const sel = selected();
  return currentList().filter((s) => sel.has(s.id)).length;
});

/** 日期分组项：start 为该组首条在整个非置顶列表中的序号偏移 */
type DateGroup = { key: string; label: string; start: number; items: SessionSummary[] };

/**
 * 非置顶会话按本地自然日分组。
 * 组间按日期倒序（无日期的排最后），组内保持接口返回顺序。
 */
const dateGroups = computed<DateGroup[]>(() => {
  const groups: DateGroup[] = [];
  const index = new Map<string, DateGroup>();
  for (const s of normalList()) {
    const key = dayKeyOf(sessionTimeMs(s));
    const hit = index.get(key);
    if (hit) {
      hit.items.push(s);
    } else {
      const group: DateGroup = { key, label: formatDayLabel(key), start: 0, items: [s] };
      index.set(key, group);
      groups.push(group);
    }
  }
  // 组间排序：日期倒序，日期未知的固定排最后
  groups.sort((a, b) => {
    if (a.key === UNKNOWN_DAY) return 1;
    if (b.key === UNKNOWN_DAY) return -1;
    return b.key.localeCompare(a.key);
  });
  // 排序后再分配偏移，保证编号在展开的所有分组间连续
  let offset = 0;
  for (const g of groups) {
    g.start = offset;
    offset += g.items.length;
  }
  return groups;
});

/**
 * 判断某个日期分组是否展开：用户手动设置过则以其为准，否则只有第一个分组展开。
 */
function isGroupExpanded(key: string, index: number): boolean {
  const explicit = groupExpanded()[key];
  return explicit === undefined ? index === 0 : explicit;
}

/**
 * 切换某个日期分组的展开 / 收起状态。
 */
function toggleGroup(key: string, index: number) {
  // 在事件处理器里读取 signal 不会建立订阅，peek 与内联读取取到的都是最新值
  groupExpanded.set({ ...groupExpanded.peek(), [key]: !isGroupExpanded(key, index) });
}

/**
 * 从 background 获取当前状态。
 */
async function fetchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    // 无响应（如 service worker 刚被唤醒）时保持默认状态
    if (response) {
      status.set(response);
    }
  } catch (error) {
    console.error('Failed to fetch status:', error);
  }
}

/**
 * 设置提示消息。
 */
function showMessage(key: string, error: boolean, vars?: Record<string, string | number>) {
  message.set(key ? { key, vars, error } : null);
}

/**
 * 加载全部会话列表（SW 自动 keyset 分页 + 缓存）。
 */
async function loadList(force = false) {
  if (listLoading()) return;
  showMessage('', false);

  if (!force && sessions().length > 0) {
    return; // 已有列表，不重复加载
  }

  listLoading.set(true);
  listLoaded.set(0);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LOAD_SESSIONS' });
    if (response?.error) {
      showMessage('msg.loadFailed', true, { err: response.error });
      return;
    }
    const list = (response?.sessions || []) as SessionSummary[];
    sessions.set(list);
    // 默认全选（全量导出语义）
    selected.set(new Set(list.map((s) => s.id)));
    showMessage('msg.loaded', false, { n: list.length });
  } catch (error) {
    showMessage('msg.loadFailed', true, { err: describeError(error) });
  } finally {
    listLoading.set(false);
  }
}

/**
 * 勾选 / 取消勾选一个会话。
 */
function toggleSelect(id: string, checked: boolean) {
  const next = new Set(selected.peek());
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  selected.set(next);
}

/**
 * 全选 / 全不选：仅作用于当前标签页的会话（置顶页只动置顶项）。
 */
function toggleAll() {
  const tab = activeTab.peek();
  const cur = sessions
    .peek()
    .filter((s) => (tab === 'pinned' ? Boolean(s.pinned) : !s.pinned));
  const next = new Set(selected.peek());
  const allChecked = cur.length > 0 && cur.every((s) => next.has(s.id));
  for (const s of cur) {
    if (allChecked) {
      next.delete(s.id);
    } else {
      next.add(s.id);
    }
  }
  selected.set(next);
}

/**
 * 导出当前会话。
 */
async function exportCurrent() {
  showMessage('', false);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_CURRENT' });

    if (!response) {
      throw new Error(t('msg.noResponse'));
    }
    if (response.error) {
      showMessage('msg.exportFailed', true, { err: response.error });
    } else {
      showMessage('msg.exported', false, { name: response.filename });
    }
  } catch (error) {
    showMessage('msg.exportFailed', true, { err: describeError(error) });
  } finally {
    const s = status.peek();
    status.set({ ...s, exporting: false, exportProgress: 0, exportCurrent: null });
  }
}

/**
 * 导出选中的会话（全选 = 真正的全量导出）。
 */
async function exportSelected() {
  const ids = Array.from(selected.peek());
  if (ids.length === 0) {
    showMessage('msg.selectFirstExport', true);
    return;
  }
  showMessage('', false);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EXPORT_SELECTED',
      payload: { sessionIds: ids },
    });

    if (!response) {
      throw new Error(t('msg.noResponse'));
    }
    if (response.error) {
      showMessage('msg.exportFailed', true, { err: response.error });
    } else {
      showMessage('msg.exportedMulti', false, { name: response.filename, n: response.count });
    }
  } catch (error) {
    showMessage('msg.exportFailed', true, { err: describeError(error) });
  } finally {
    const s = status.peek();
    status.set({ ...s, exporting: false, exportProgress: 0, exportCurrent: null });
  }
}

/**
 * 批量删除选中的会话（需先学习删除接口，二次确认）。
 */
async function deleteSelected() {
  const ids = Array.from(selected.peek());
  if (ids.length === 0) {
    showMessage('msg.selectFirstDelete', true);
    return;
  }
  if (!status.peek().deleteTemplateReady) {
    showMessage('msg.deleteNotLearned', true);
    return;
  }
  if (
    !(await confirmDialog(
      t('msg.deleteConfirm', { n: ids.length })
    ))
  ) {
    return;
  }
  showMessage('', false);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DELETE_SESSIONS',
      payload: { sessionIds: ids },
    });

    if (!response) {
      throw new Error(t('msg.noResponse'));
    }
    if (response.error) {
      showMessage('msg.deleteFailed', true, { err: response.error });
    } else {
      showMessage('msg.deleteDone', response.failed > 0, {
        ok: response.ok,
        failed: response.failed,
      });
      // 从本地列表移除已删除项
      const deleted = new Set(ids);
      sessions.set(sessions.peek().filter((s) => !deleted.has(s.id)));
      selected.set(new Set());
    }
  } catch (error) {
    showMessage('msg.deleteFailed', true, { err: describeError(error) });
  } finally {
    const s = status.peek();
    status.set({ ...s, exporting: false, exportProgress: 0, exportCurrent: null });
  }
}

/**
 * 从 service worker 拉取汇总日志。
 */
async function loadLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    if (response?.error) {
      logsText.set(t('logs.fetchFailed', { v: extVersion, err: response.error }));
    } else {
      const entries = (response?.entries || []) as LogEntry[];
      logsText.set(
        entries.length > 0
          ? `${buildLogsHeader(entries.length)}\n${formatAll(entries)}`
          : `${buildLogsHeader(0)}\n${t('logs.none')}`
      );
    }
  } catch (error) {
    logsText.set(t('logs.fetchFailed', { v: extVersion, err: String(error) }));
  }
}

/**
 * 下载日志文件。
 */
async function downloadLogs() {
  try {
    const text = logsText();
    if (!text || text.endsWith(t('logs.none'))) {
      await loadLogs();
    }
    const blob = new Blob([logsText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepseek-exporter-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    showMessage('logs.downloadFailed', true, { err: String(error) });
  }
}

/**
 * 拷贝日志到剪贴板。
 */
async function copyLogs() {
  try {
    if (!logsText() || logsText().endsWith(t('logs.none'))) {
      await loadLogs();
    }
    await navigator.clipboard.writeText(logsText());
    showMessage('logs.copied', false);
  } catch (error) {
    showMessage('logs.copyFailed', true, { err: String(error) });
  }
}

/**
 * 清空汇总日志。
 */
async function clearLogs() {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
    logsText.set(`${buildLogsHeader(0)}\n${t('logs.none')}`);
    showMessage('logs.cleared', false);
  } catch (error) {
    showMessage('logs.clearFailed', true, { err: String(error) });
  }
}

// 进度监听只注册一次（popup 打开期间始终监听，不只在操作后）
let progressListenerAdded = false;

/**
 * 注册进度 / 列表加载进度监听（幂等）。
 */
function ensureListeners() {
  if (progressListenerAdded) return;
  progressListenerAdded = true;
  chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
    if (msg.type === 'EXPORT_PROGRESS') {
      const payload = msg.payload as
        | { progress: number; current?: number; total?: number; title?: string }
        | undefined;
      if (payload) {
        const s = status.peek();
        status.set({
          ...s,
          exporting: true,
          exportProgress: payload.progress,
          exportCurrent: {
            index: payload.current ?? 0,
            total: payload.total ?? 0,
            title: payload.title ?? '',
          },
        });
      }
    } else if (msg.type === 'LIST_PROGRESS') {
      const payload = msg.payload as { loaded: number } | undefined;
      if (payload) {
        listLoaded.set(payload.loaded);
      }
    }
  });
}

/**
 * 信息行。
 */
function InfoItem(props: { label: string; value: string }) {
  const value = () => resolve(props.value);
  return (
    <div class="info-item">
      <span class="label">{resolve(props.label)}</span>
      <span class="value">{value()}</span>
    </div>
  );
}

/**
 * 会话列表条目（编号 + 勾选框 + 置顶标记 + 标题 + 日期）。
 * index 为当前标签页内的连续序号（从 0 起，跨日期分组连续）。
 */
function SessionItem(props: { session: SessionSummary; index: number }) {
  const s = () => resolve(props.session);
  // 动态 props 是 getter 函数，必须 resolve 后再运算，否则会渲染成函数源码字符串
  const index = () => resolve(props.index) + 1;
  const checked = () => selected().has(s().id);
  const date = () => formatSessionDate(s());
  // pinned 由 v0 接口透传；缺失或非布尔时一律按「未置顶」处理，不报错、不影响列表加载
  const pinned = () => Boolean(s().pinned);

  return (
    <label class="session-item">
      <span class="session-index">{index()}</span>
      <input
        type="checkbox"
        checked={checked()}
        onChange={(e) => toggleSelect(s().id, (e.target as HTMLInputElement).checked)}
      />
      {/* 置顶标记：纯展示元素、不绑定事件，避免影响整行 label 的勾选行为 */}
      {pinned() ? (
        <span class="pin-badge" title={t('item.pinTitle')}>
          {t('item.pinBadge')}
        </span>
      ) : null}
      <span class="session-title" title={s().title}>
        {s().title || t('item.untitled')}
      </span>
      {date() ? <span class="session-date">{date()}</span> : null}
    </label>
  );
}

/**
 * 单个日期分组（组头 + 可折叠的会话条目）。
 *
 * 展开状态必须用 computed 读取：若在渲染回调里把它求值成普通布尔（如 `const expanded =
 * isGroupExpanded(...)`），则脱离依赖追踪，点组头只会改状态而不会重新渲染。
 */
function DateGroupPanel(props: { group: DateGroup; index: number }) {
  const g = () => resolve(props.group);
  const index = () => resolve(props.index);
  const expanded = computed(() => isGroupExpanded(g().key, index()));

  return (
    <div class="date-group">
      <div
        class="date-group-header"
        onClick={() => toggleGroup(g().key, index())}
      >
        <span class="date-group-arrow">{expanded() ? '▾' : '▸'}</span>
        <span class="date-group-label">{g().label}</span>
        <span class="date-group-count">{g().items.length}</span>
      </div>
      {expanded()
        ? g().items.map((s, i) => (
            <SessionItem session={s} index={g().start + i} />
          ))
        : null}
    </div>
  );
}

/**
 * 会话列表面板：置顶 / 非置顶 两个标签页，非置顶列表按自然日分组且可折叠。
 */
function SessionListPanel() {
  // 全选状态只看当前标签页：置顶页不因非置顶项未选而显示半选
  const allChecked = computed(() => {
    const cur = currentList();
    const sel = selected();
    return cur.length > 0 && cur.every((s) => sel.has(s.id));
  });

  return (
    <div class="panel">
      <div class="list-tabs">
        <button
          class={activeTab() === 'pinned' ? 'list-tab active' : 'list-tab'}
          onClick={() => activeTab.set('pinned')}
        >
          {t('list.tabPinned', { n: pinnedList().length })}
        </button>
        <button
          class={activeTab() === 'normal' ? 'list-tab active' : 'list-tab'}
          onClick={() => activeTab.set('normal')}
        >
          {t('list.tabNormal', { n: normalList().length })}
        </button>
      </div>

      <div class="panel-toolbar">
        <label class="check-all">
          <input
            type="checkbox"
            checked={allChecked()}
            onChange={toggleAll}
          />
          {t('list.checkAll')}
        </label>
        <span class="muted">
          {t('list.summary', {
            checked: currentCheckedCount(),
            total: currentList().length,
            all: selectedCount(),
          })}
        </span>
        <button class="mini-btn" onClick={() => loadList(true)}>
          {t('list.refresh')}
        </button>
      </div>

      {listLoading() ? (
        <div class="list-loading">
          {t('list.loading', { n: listLoaded() })}
        </div>
      ) : sessions().length === 0 ? (
        <div class="list-loading">{t('list.loadHint')}</div>
      ) : (
        <div class="session-list">
          {activeTab() === 'pinned' ? (
            pinnedList().length === 0 ? (
              <div class="list-empty">{t('list.emptyPinned')}</div>
            ) : (
              pinnedList().map((s, i) => <SessionItem session={s} index={i} />)
            )
          ) : dateGroups().length === 0 ? (
            <div class="list-empty">{t('list.empty')}</div>
          ) : (
            dateGroups().map((g, gi) => <DateGroupPanel group={g} index={gi} />)
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 日志面板。
 */
function LogsPanel() {
  return (
    <details
      class="collapsible"
      ref={(el) => {
        // 首次展开时拉取日志
        const handler = () => {
          if ((el as HTMLDetailsElement).open) {
            loadLogs();
          }
        };
        el.addEventListener('toggle', handler);
        return () => el.removeEventListener('toggle', handler);
      }}
    >
      <summary>{t('logs.title')}</summary>
      <div class="collapsible-body">
        <div class="logs-actions">
          <button class="log-btn" onClick={loadLogs}>{t('logs.refresh')}</button>
          <button class="log-btn" onClick={downloadLogs}>{t('logs.download')}</button>
          <button class="log-btn" onClick={copyLogs}>{t('logs.copy')}</button>
          <button class="log-btn" onClick={clearLogs}>{t('logs.clear')}</button>
        </div>
        <pre class="logs-view">{logsText() || t('logs.hint')}</pre>
      </div>
    </details>
  );
}

/**
 * 在中文 / 英文之间切换（写 signal 后持久化）。
 */
function toggleLang() {
  setLang(lang.peek() === 'zh' ? 'en' : 'zh');
}

/**
 * Popup 根组件。
 */
export function App() {
  const s = status;

  return (
    <div
      class="popup"
      ref={() => {
        // 注册监听 + 自动加载列表 + 轮询状态；popup 关闭时停止定时器
        ensureListeners();
        fetchStatus();
        loadList();
        const timer = setInterval(fetchStatus, 2000);
        return () => {
          clearInterval(timer);
        };
      }}
    >
      <div class="header">
        <h1>
          DeepSeek Exporter
          <span class="version">v{extVersion}</span>
        </h1>
        <div class="header-right">
          <button
            class="lang-switch"
            title={lang() === 'zh' ? t('lang.switchToEn') : t('lang.switchToZh')}
            onClick={toggleLang}
          >
            {/* 用拉丁字母而非「中」字：英文系统往往没有中文字体，汉字会渲染成方框 */}
            {lang() === 'zh' ? 'EN' : 'ZH'}
          </button>
          <div class={s().connected ? 'status connected' : 'status'}>
            {s().connected ? t('app.connected') : t('app.disconnected')}
          </div>
        </div>
      </div>

      {s().connected ? null : (
        <div class="tip">
          {t('app.disconnectedTip')}
          {s().swError ? (
            <div class="tip-detail">{t('app.reason', { msg: s().swError ?? '' })}</div>
          ) : null}
        </div>
      )}

      <div class="info">
        <InfoItem
          label={t('app.deleteApi')}
          value={s().deleteTemplateReady ? t('app.deleteReady') : t('app.deleteNotReady')}
        />
      </div>

      <SessionListPanel />

      <div class="actions">
        <button
          class="btn btn-primary"
          disabled={!s().connected || !s().currentSessionId || s().exporting}
          onClick={exportCurrent}
        >
          {t('action.exportCurrent')}
        </button>
        <button
          class="btn btn-secondary"
          disabled={s().exporting || selectedCount() === 0}
          onClick={exportSelected}
        >
          {t('action.exportSelected', { n: selectedCount() })}
        </button>
        <button
          class="btn btn-danger"
          disabled={s().exporting || selectedCount() === 0 || !s().deleteTemplateReady}
          onClick={deleteSelected}
        >
          {t('action.deleteSelected', { n: selectedCount() })}
        </button>
      </div>

      {s().exporting ? (
        <div class="progress">
          <div class="progress-title">{progressTitle()}</div>
          <div class="progress-bar">
            <div class="progress-fill" style={`width:${s().exportProgress}%`} />
          </div>
          <div class="progress-hint">{t('progress.hint')}</div>
        </div>
      ) : null}

      {message() ? (
        <div class={message()?.error ? 'message error' : 'message'}>
          {t(message()?.key ?? '', message()?.vars)}
        </div>
      ) : null}

      {s().recentApiUrls && s().recentApiUrls!.length > 0 ? (
        <details class="collapsible">
          <summary>{t('diag.title', { n: s().recentApiUrls!.length })}</summary>
          <div class="collapsible-body">
            <ul class="url-list">
              {s().recentApiUrls!.map((u) => (
                <li>{u}</li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}

      <LogsPanel />

      {/* 确认弹窗（删除等不可逆操作） */}
      {confirmVisible() ? (
        <div class="modal-mask">
          <div class="modal">
            <div class="modal-title">{t('modal.title')}</div>
            <div class="modal-text">
              <span class="modal-warn">⚠ {confirmText()}</span>
            </div>
            <div class="modal-actions">
              <button class="modal-btn" onClick={() => answerConfirm(false)}>
                {t('modal.cancel')}
              </button>
              <button class="modal-btn danger" onClick={() => answerConfirm(true)}>
                {t('modal.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
