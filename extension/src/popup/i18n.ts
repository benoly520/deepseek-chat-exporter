/**
 * popup 界面的中英文词典与语言状态。
 *
 * 语言是运行时可变状态（signal）：t() 内部读取 lang()，因此在 JSX 表达式、computed
 * 或 when getter 内调用 t() 即可随语言变化自动重绘。注意不要在 map / each 的回调体里
 * 把 t() 的返回值提前赋给 const，那样会脱离依赖追踪（同 v1.0.16 折叠失效的成因）。
 */

import { signal } from 'plain';

export type Lang = 'zh' | 'en';

/** 语言偏好的存储键 */
const STORAGE_KEY = 'ui_lang';

/**
 * 猜默认语言：跟随浏览器 UI 语言，以 zh 开头用中文，其余用英文。
 */
function detectInitialLang(): Lang {
  try {
    const ui = chrome.i18n.getUILanguage();
    return ui && ui.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

/** 当前界面语言 */
export const lang = signal<Lang>(detectInitialLang());

type Dict = Record<string, string>;

// --- 中文 ---
const zh: Dict = {
  // 标题栏与状态
  'app.connected': '已连接',
  'app.disconnected': '未连接',
  'app.disconnectedTip': '未连接时请刷新 DeepSeek 页面后重试',
  'app.reason': '原因: {msg}',
  'app.deleteApi': '删除接口:',
  'app.deleteReady': '已学习（可批量删除）',
  'app.deleteNotReady': '未学习（手动删除一次会话即可）',

  // 标签页与工具栏
  'list.tabPinned': '置顶 ({n})',
  'list.tabNormal': '非置顶 ({n})',
  'list.checkAll': '全选本页',
  'list.summary': '已选 {checked}/{total} · 共 {all}',
  'list.refresh': '刷新列表',
  'list.loading': '正在加载会话列表… 已加载 {n} 条',
  'list.loadHint': '点击「刷新列表」加载会话',
  'list.emptyPinned': '暂无置顶会话',
  'list.empty': '暂无会话',

  // 列表条目
  'item.pinBadge': '置顶',
  'item.pinTitle': '置顶会话',
  'item.untitled': '无标题',

  // 日期标签与周几
  'date.today': '今天',
  'date.yesterday': '昨天',
  'date.unknown': '日期未知',
  'date.weekdays': '周日|周一|周二|周三|周四|周五|周六',

  // 主按钮
  'action.exportCurrent': '导出当前会话',
  'action.exportSelected': '导出选中 ({n})',
  'action.deleteSelected': '删除选中 ({n})',

  // 进度
  'progress.exporting': '导出中… {p}%',
  'progress.current': '正在导出 {i}/{total}：{title}',
  'progress.hint': '耗时操作，请保持 DeepSeek 页面开启',

  // 提示消息
  'msg.loadFailed': '加载会话列表失败: {err}',
  'msg.loaded': '已加载 {n} 个会话',
  'msg.noResponse': '无响应，请刷新页面后重试',
  'msg.exportFailed': '导出失败: {err}',
  'msg.exported': '导出成功: {name}',
  'msg.exportedMulti': '导出成功: {name} ({n} 个会话)',
  'msg.selectFirstExport': '请先勾选要导出的会话',
  'msg.selectFirstDelete': '请先勾选要删除的会话',
  'msg.deleteNotLearned':
    '删除接口尚未学习：请先在 DeepSeek 页面上手动删除任意一个会话，扩展会自动捕获该操作',
  'msg.deleteConfirm': '即将永久删除 {n} 个会话，此操作不可恢复！确认继续？',
  'msg.deleteFailed': '删除失败: {err}',
  'msg.deleteDone': '删除完成: 成功 {ok} 个，失败 {failed} 个',

  // 日志面板
  'logs.title': '运行日志（排查问题用）',
  'logs.refresh': '刷新',
  'logs.download': '下载日志',
  'logs.copy': '拷贝',
  'logs.clear': '清空',
  'logs.hint': '点「刷新」加载日志',
  'logs.header': 'DeepSeek Chat Exporter v{v} · 导出时间 {time} · 共 {n} 条日志',
  'logs.none': '暂无日志',
  'logs.fetchFailed': 'DeepSeek Chat Exporter v{v} · 日志拉取失败: {err}',
  'logs.downloadFailed': '日志下载失败: {err}',
  'logs.copied': '日志已拷贝到剪贴板',
  'logs.copyFailed': '日志拷贝失败: {err}',
  'logs.cleared': '日志已清空',
  'logs.clearFailed': '日志清空失败: {err}',

  // 诊断面板
  'diag.title': 'API 捕获诊断 ({n})',

  // 确认弹窗
  'modal.title': '删除确认',
  'modal.cancel': '取消',
  'modal.confirm': '确认删除',

  // 语言切换
  'lang.switchToEn': '切换到英文',
  'lang.switchToZh': '切换到中文',
};

// --- English ---
const en: Dict = {
  // Header & status
  'app.connected': 'Connected',
  'app.disconnected': 'Disconnected',
  'app.disconnectedTip': 'Not connected — refresh the DeepSeek page and try again',
  'app.reason': 'Reason: {msg}',
  'app.deleteApi': 'Delete API:',
  'app.deleteReady': 'Learned (batch delete available)',
  'app.deleteNotReady': 'Not learned (delete any session once on the page)',

  // Tabs & toolbar
  'list.tabPinned': 'Pinned ({n})',
  'list.tabNormal': 'Others ({n})',
  'list.checkAll': 'Select page',
  'list.summary': '{checked}/{total} selected · {all} total',
  'list.refresh': 'Refresh',
  'list.loading': 'Loading sessions… {n} loaded',
  'list.loadHint': 'Click "Refresh" to load sessions',
  'list.emptyPinned': 'No pinned sessions',
  'list.empty': 'No sessions',

  // List item
  'item.pinBadge': 'Pinned',
  'item.pinTitle': 'Pinned session',
  'item.untitled': 'Untitled',

  // Date labels & weekdays
  'date.today': 'Today',
  'date.yesterday': 'Yesterday',
  'date.unknown': 'Unknown date',
  'date.weekdays': 'Sun|Mon|Tue|Wed|Thu|Fri|Sat',

  // Primary actions
  'action.exportCurrent': 'Export current',
  'action.exportSelected': 'Export selected ({n})',
  'action.deleteSelected': 'Delete selected ({n})',

  // Progress
  'progress.exporting': 'Exporting… {p}%',
  'progress.current': 'Exporting {i}/{total}: {title}',
  'progress.hint': 'This may take a while — keep the DeepSeek tab open',

  // Messages
  'msg.loadFailed': 'Failed to load sessions: {err}',
  'msg.loaded': 'Loaded {n} sessions',
  'msg.noResponse': 'No response — refresh the page and retry',
  'msg.exportFailed': 'Export failed: {err}',
  'msg.exported': 'Exported: {name}',
  'msg.exportedMulti': 'Exported: {name} ({n} sessions)',
  'msg.selectFirstExport': 'Select at least one session to export',
  'msg.selectFirstDelete': 'Select at least one session to delete',
  'msg.deleteNotLearned':
    'Delete API not learned yet — delete any session manually on the DeepSeek page and the extension will capture it',
  'msg.deleteConfirm': '{n} sessions will be permanently deleted. This cannot be undone. Continue?',
  'msg.deleteFailed': 'Delete failed: {err}',
  'msg.deleteDone': 'Delete finished: {ok} succeeded, {failed} failed',

  // Logs panel
  'logs.title': 'Runtime logs (for troubleshooting)',
  'logs.refresh': 'Refresh',
  'logs.download': 'Download',
  'logs.copy': 'Copy',
  'logs.clear': 'Clear',
  'logs.hint': 'Click "Refresh" to load logs',
  'logs.header': 'DeepSeek Chat Exporter v{v} · exported at {time} · {n} entries',
  'logs.none': 'No logs',
  'logs.fetchFailed': 'DeepSeek Chat Exporter v{v} · failed to fetch logs: {err}',
  'logs.downloadFailed': 'Failed to download logs: {err}',
  'logs.copied': 'Logs copied to clipboard',
  'logs.copyFailed': 'Failed to copy logs: {err}',
  'logs.cleared': 'Logs cleared',
  'logs.clearFailed': 'Failed to clear logs: {err}',

  // Diagnostics panel
  'diag.title': 'API capture diagnostics ({n})',

  // Confirm dialog
  'modal.title': 'Confirm deletion',
  'modal.cancel': 'Cancel',
  'modal.confirm': 'Delete',

  // Language switch
  'lang.switchToEn': 'Switch to English',
  'lang.switchToZh': 'Switch to Chinese',
};

const dicts: Record<Lang, Dict> = { zh, en };

/**
 * 取文案并按 {name} 占位符插值。
 * 未命中的 key 原样返回，便于在真机上发现遗漏。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = dicts[lang()][key] ?? key;
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    const value = vars[name];
    return value === undefined ? raw : String(value);
  });
}

/**
 * 切换语言：先改 signal（界面立即重绘），再持久化。
 * 持久化失败只记控制台，不影响本次会话。
 */
export function setLang(next: Lang): void {
  lang.set(next);
  try {
    chrome.storage.local
      .set({ [STORAGE_KEY]: next })
      .catch((error) => console.warn('[i18n] 语言偏好保存失败', error));
  } catch (error) {
    console.warn('[i18n] 语言偏好保存失败', error);
  }
}

/**
 * 启动时读取语言偏好；失败或未设置时保留默认值。
 */
export async function loadLang(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const value = stored?.[STORAGE_KEY];
    if (value === 'zh' || value === 'en') {
      lang.set(value);
    }
  } catch (error) {
    console.warn('[i18n] 语言偏好读取失败', error);
  }
}
