/**
 * DeepSeek API 响应的容错提取工具。
 *
 * DeepSeek 内部 API 响应结构随时可能变化（且带版本前缀），
 * 这里不做固定路径假设，而是：
 * 1. 优先尝试已知常见路径（data.messages / data.biz_data.chat_messages 等）；
 * 2. 兜底递归查找"形如目标"的数组（元素含 role+content / id+title）；
 * 3. 全部失败时返回 null，由调用方记录原始结构 keys 用于诊断。
 */

import type { RawMessage, SessionSummary } from '../types';

/**
 * 判断是否为"形如消息"的对象。
 */
function looksLikeMessage(o: unknown): boolean {
  return (
    typeof o === 'object' &&
    o !== null &&
    'role' in o &&
    'content' in (o as Record<string, unknown>)
  );
}

/**
 * 判断是否为"形如会话摘要"的对象。
 */
function looksLikeSession(o: unknown): boolean {
  return (
    typeof o === 'object' &&
    o !== null &&
    'id' in o &&
    'title' in (o as Record<string, unknown>)
  );
}

/**
 * 递归查找第一个满足谓词的非空数组（限制深度防炸栈）。
 * emptyKeys 用于额外命中"即使为空但字段名明确"的数组（如 messages: []）。
 */
function findArray<T>(
  root: unknown,
  predicate: (o: unknown) => boolean,
  emptyKeys: string[],
  depth = 0
): T[] | null {
  if (depth > 5 || root == null) return null;

  if (Array.isArray(root)) {
    if (root.length > 0 && predicate(root[0])) {
      return root as T[];
    }
    // 非对象数组：尝试在元素里继续找
    if (typeof root[0] === 'object') {
      for (const item of root) {
        const found = findArray<T>(item, predicate, emptyKeys, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  if (typeof root === 'object') {
    for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
      // 字段名明确但为空数组（如 messages: []）——视为有效空结果
      if (Array.isArray(value) && value.length === 0 && emptyKeys.includes(key)) {
        return [] as unknown as T[];
      }
      const found = findArray<T>(value, predicate, emptyKeys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 从 history_messages 响应中提取消息数组。
 * 已知尝试路径：data.messages / data.data.messages / data.biz_data.chat_messages /
 * data.biz_data.messages / data.data.chat_messages，失败后递归兜底。
 *
 * @param structureOut 可选，用于回传"未找到时的结构线索"（顶层与二级 keys / 预览）
 */
export function extractMessages(
  data: unknown,
  structureOut?: { keys: string }
): RawMessage[] | null {
  const known = [
    'messages',
    'chat_messages',
    'items',
  ];
  const direct =
    findArray<RawMessage>(data, looksLikeMessage, known) ??
    // 显式尝试常见嵌套路径（即使空数组也能命中）
    tryPaths<RawMessage[]>(data, [
      ['data', 'messages'],
      ['data', 'chat_messages'],
      ['data', 'biz_data', 'chat_messages'],
      ['data', 'biz_data', 'messages'],
      ['messages'],
    ]);
  if (direct) return direct;

  if (structureOut) {
    structureOut.keys = describeStructure(data);
  }
  return null;
}

/**
 * 从 fetch_page 响应中提取会话列表与游标。
 */
export function extractSessions(
  data: unknown,
  structureOut?: { keys: string }
): { sessions: SessionSummary[]; nextCursor: string } | null {
  const known = ['sessions', 'items', 'list'];
  const sessions =
    findArray<SessionSummary>(data, looksLikeSession, known) ??
    tryPaths<SessionSummary[]>(data, [
      ['data', 'sessions'],
      ['data', 'items'],
      ['sessions'],
    ]);

  if (sessions) {
    const nextCursor = findString(data, 'next_cursor') || findString(data, 'cursor');
    return { sessions, nextCursor };
  }

  if (structureOut) {
    structureOut.keys = describeStructure(data);
  }
  return null;
}

/**
 * 按路径链依次取值，全部存在才返回。
 */
function tryPaths<T>(root: unknown, paths: string[][]): T | null {
  for (const path of paths) {
    let cur: unknown = root;
    let ok = true;
    for (const key of path) {
      if (typeof cur !== 'object' || cur === null || !(key in cur)) {
        ok = false;
        break;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    if (ok && Array.isArray(cur)) {
      return cur as T;
    }
  }
  return null;
}

/**
 * 在对象树中查找指定字符串字段（限制深度）。
 */
function findString(root: unknown, key: string, depth = 0): string {
  if (depth > 3 || typeof root !== 'object' || root === null) return '';
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (k === key && typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null) {
      const found = findString(v, key, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

/**
 * 描述响应结构（顶层/二级 keys + 截断预览），用于失败诊断。
 */
function describeStructure(data: unknown): string {
  try {
    const topKeys =
      typeof data === 'object' && data !== null ? Object.keys(data).join(',') : typeof data;
    const second =
      typeof data === 'object' && data !== null && 'data' in (data as Record<string, unknown>)
        ? ` data.keys=${Object.keys((data as Record<string, unknown>).data || {}).join(',')}`
        : '';
    const preview = JSON.stringify(data).slice(0, 300);
    return `topKeys=${topKeys}${second} preview=${preview}`;
  } catch {
    return '(unserializable)';
  }
}
