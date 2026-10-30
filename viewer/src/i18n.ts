/**
 * 界面文案多语言：模块级字典 + lang signal。
 *
 * viewer 是纯前端页面，没有 chrome.* 接口，语言偏好存 localStorage；
 * 同步读写，所以首屏直接以目标语言渲染，不存在「先中文再变英文」的闪烁。
 *
 * 用法：在 JSX 表达式里调用 t('key')，会自动订阅语言变化。
 * 注意：不要在 map / each 的回调体里把 t() 的结果存成常量（plain 依赖追踪陷阱）。
 */

import { signal } from 'plain';

export type Lang = 'zh' | 'en';

/** localStorage 的键名 */
const STORAGE_KEY = 'viewer_lang';

/** 语言代码 → <html lang> 取值 */
const HTML_LANG: Record<Lang, string> = { zh: 'zh-CN', en: 'en' };

/**
 * 读取语言偏好：优先用用户上次的选择，没有则按浏览器语言猜一个。
 */
function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch (error) {
    // 隐私模式下 localStorage 可能抛异常，降级为按浏览器语言判断
    console.warn('[i18n] 语言偏好读取失败', error);
  }
  try {
    const ui = (navigator.language || '').toLowerCase();
    return ui.startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

/** 当前界面语言 */
export const lang = signal<Lang>(detectLang());

type Dict = Record<string, string>;

const zh: Dict = {
  'app.searchPlaceholder': '搜索会话标题或消息内容…',
  'app.import': '导入文件',
  'app.status': '共 {c} 个会话 · {m} 条消息',
  'app.exportedAt': '导出时间: {time}',

  'loader.subtitle': '导入 DeepSeek Chat Exporter 导出的 JSON 文件，离线浏览聊天记录',
  'loader.dropHint': '拖拽 JSON 文件到此处，或点击选择文件',
  'loader.multiHint': '支持多选，多个文件将自动按会话 ID 合并',
  'loader.loading': '正在加载…',

  'chat.thinkingExpand': '思考过程（点击展开）',
  'chat.thinkingCollapse': '思考过程（点击收起）',
  'chat.copy': '复制原文',
  'chat.noSelection': '未选择会话',
  'chat.empty': '从左侧选择一个会话开始浏览',

  'list.meta': '{n} 条消息 · {time}',
  'list.noMatch': '没有匹配的会话',
  'list.untitled': '无标题',

  'time.today': '今天',
  'time.yesterday': '昨天',
  'time.daysAgo': '{n}天前',
  'time.weeksAgo': '{n}周前',
  'time.monthsAgo': '{n}个月前',
  'time.yearsAgo': '{n}年前',

  'error.missingMeta': '无效的导出文件：缺少 export_meta 字段',
  'error.invalidMeta': '无效的 export_meta：缺少必要字段',
  'error.badConversations': '无效的导出文件：conversations 必须是数组',
  'error.badJSON': '无效的 JSON 格式',
  'error.readFailed': '文件读取失败',
  'error.loadFailed': '文件加载失败：{msg}',

  'lang.switchToEn': '切换到英文',
  'lang.switchToZh': '切换到中文',
};

const en: Dict = {
  'app.searchPlaceholder': 'Search titles or message content…',
  'app.import': 'Import files',
  'app.status': '{c} conversations · {m} messages',
  'app.exportedAt': 'Exported: {time}',

  'loader.subtitle':
    'Import JSON files exported by DeepSeek Chat Exporter and browse them offline',
  'loader.dropHint': 'Drop JSON files here, or click to choose',
  'loader.multiHint': 'Multiple files supported; they are merged by conversation id',
  'loader.loading': 'Loading…',

  'chat.thinkingExpand': 'Thinking (click to expand)',
  'chat.thinkingCollapse': 'Thinking (click to collapse)',
  'chat.copy': 'Copy text',
  'chat.noSelection': 'No conversation selected',
  'chat.empty': 'Select a conversation on the left to start browsing',

  'list.meta': '{n} messages · {time}',
  'list.noMatch': 'No matching conversations',
  'list.untitled': 'Untitled',

  'time.today': 'today',
  'time.yesterday': 'yesterday',
  'time.daysAgo': '{n}d ago',
  'time.weeksAgo': '{n}w ago',
  'time.monthsAgo': '{n}mo ago',
  'time.yearsAgo': '{n}y ago',

  'error.missingMeta': 'Invalid export file: missing export_meta',
  'error.invalidMeta': 'Invalid export_meta: missing required fields',
  'error.badConversations': 'Invalid export file: conversations must be an array',
  'error.badJSON': 'Invalid JSON',
  'error.readFailed': 'Failed to read file',
  'error.loadFailed': 'Failed to load file: {msg}',

  'lang.switchToEn': 'Switch to English',
  'lang.switchToZh': 'Switch to Chinese',
};

const dicts: Record<Lang, Dict> = { zh, en };

/**
 * 取文案。key 缺失时回退为 key 本身，便于发现遗漏。
 * 支持 {name} 占位符，未提供的占位符原样保留。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template = dicts[lang()][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    const value = vars[name];
    return value === undefined ? raw : String(value);
  });
}

/**
 * 设置语言：写 localStorage 并同步 <html lang>。
 */
export function setLang(next: Lang): void {
  lang.set(next);
  document.documentElement.lang = HTML_LANG[next];
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch (error) {
    // 只在本次会话生效，不阻断界面切换
    console.warn('[i18n] 语言偏好保存失败', error);
  }
}

/**
 * 在中 / 英之间切换。
 */
export function toggleLang(): void {
  setLang(lang.peek() === 'zh' ? 'en' : 'zh');
}

/**
 * 启动时同步一次 <html lang>，避免 HTML 静态声明的语言与实际界面不一致。
 */
export function initLang(): void {
  document.documentElement.lang = HTML_LANG[lang()];
}
