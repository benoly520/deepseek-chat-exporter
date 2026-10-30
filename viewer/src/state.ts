/**
 * 全局状态：plain 的模块级 signal（替代原 Vue 版的 Pinia store）。
 */

import { signal, computed } from 'plain';
import { parseJSON, readFileAsText, ViewerError } from './utils/json-parser';
import type { Conversation, ExportedConversation, ExportMeta } from './types';

// --- 原始状态 ---

/** 导出元数据 */
export const exportMeta = signal<ExportMeta | null>(null);
/** 会话列表（按更新时间倒序） */
export const conversations = signal<Conversation[]>([]);
/** 当前选中的会话 ID */
export const currentId = signal<string | null>(null);
/** 搜索关键词 */
export const searchQuery = signal('');
/** 加载中 */
export const loading = signal(false);
/** 加载错误：存 key + 参数而非成品文案，切换语言时已显示的提示也会重译 */
export type LoadError = { key: string; vars?: Record<string, string | number> };
export const loadError = signal<LoadError | null>(null);

// --- 派生状态 ---

/**
 * 搜索过滤后的会话列表（匹配标题或消息内容）。
 */
export const filteredConversations = computed(() => {
  const q = searchQuery().trim().toLowerCase();
  const list = conversations();
  if (!q) return list;
  return list.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.messages.some((m) => m.content.toLowerCase().includes(q))
  );
});

/**
 * 当前选中的会话。
 */
export const currentConversation = computed(
  () => conversations().find((c) => c.id === currentId()) || null
);

/**
 * 统计信息。
 */
export const stats = computed(() => ({
  totalConversations: conversations().length,
  totalMessages: conversations().reduce((sum, c) => sum + c.messages.length, 0),
  exportedAt: exportMeta()?.exported_at || '',
}));

/**
 * 时间串转时间戳（无效值视为 0）。
 */
function ts(dateString: string): number {
  const t = dateString ? new Date(dateString).getTime() : NaN;
  return isNaN(t) ? 0 : t;
}

/**
 * 按 id 合并会话列表，新数据覆盖旧数据。
 */
function mergeConversations(existing: Conversation[], incoming: Conversation[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const c of existing) map.set(c.id, c);
  for (const c of incoming) map.set(c.id, c);
  return Array.from(map.values());
}

/**
 * 加载并合并一个或多个导出 JSON 文件。
 */
export async function loadFiles(fileList: File[]): Promise<void> {
  if (fileList.length === 0) return;

  loading.set(true);
  loadError.set(null);

  try {
    let merged = conversations();
    let meta = exportMeta();

    for (const file of fileList) {
      const text = await readFileAsText(file);
      const data: ExportedConversation = parseJSON(text);
      meta = meta || data.export_meta;
      merged = mergeConversations(merged, data.conversations);
    }

    // 按更新时间倒序排列
    merged.sort((a, b) => ts(b.updated_at) - ts(a.updated_at));

    conversations.set([...merged]);
    exportMeta.set(meta);

    // 首次加载时默认选中第一个会话
    if (!currentId() && merged.length > 0) {
      currentId.set(merged[0].id);
    }
  } catch (error) {
    if (error instanceof ViewerError) {
      loadError.set({ key: error.key, vars: error.vars });
    } else {
      // 未知异常兜底：带上原始信息，便于定位
      loadError.set({
        key: 'error.loadFailed',
        vars: { msg: error instanceof Error ? error.message : String(error) },
      });
    }
  } finally {
    loading.set(false);
  }
}

/**
 * 选择会话。
 */
export function selectConversation(id: string): void {
  currentId.set(id);
}

/**
 * 设置搜索关键词。
 */
export function setSearch(q: string): void {
  searchQuery.set(q);
}
