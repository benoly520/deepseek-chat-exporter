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
 * @param structureOut 回传结构信息：成功时为命中的路径，失败时为结构详情（用于日志诊断）
 */
export function extractMessages(
  data: unknown,
  structureOut?: { keys: string }
): RawMessage[] | null {
  const known = ['messages', 'chat_messages', 'items'];
  const paths: string[][] = [
    ['data', 'messages'],
    ['data', 'chat_messages'],
    ['data', 'biz_data', 'chat_messages'],
    ['data', 'biz_data', 'messages'],
    ['messages'],
  ];

  // 1) 显式路径（即使空数组也命中），记录命中路径
  for (const path of paths) {
    const arr = getAtPath(data, path);
    if (Array.isArray(arr)) {
      if (structureOut) structureOut.keys = `matched=data.${path.join('.')}`;
      return arr as RawMessage[];
    }
  }

  // 2) 递归兜底：找元素形如消息的数组
  const deep = findArray<RawMessage>(data, looksLikeMessage, known);
  if (deep) {
    if (structureOut) structureOut.keys = 'matched=<deep-scan: role+content array>';
    return deep;
  }

  if (structureOut) {
    structureOut.keys = describeStructure(data);
  }
  return null;
}

/**
 * 从 fetch_page 响应中提取会话列表与游标。
 *
 * @param structureOut 回传结构信息：成功时为命中的路径，失败时为结构详情
 */
export function extractSessions(
  data: unknown,
  structureOut?: { keys: string }
): { sessions: SessionSummary[]; nextCursor: string } | null {
  const known = ['sessions', 'items', 'list'];
  const paths: string[][] = [
    ['data', 'sessions'],
    ['data', 'items'],
    ['sessions'],
  ];

  let sessions: SessionSummary[] | null = null;
  let matched = '';

  for (const path of paths) {
    const arr = getAtPath(data, path);
    if (Array.isArray(arr)) {
      sessions = arr as SessionSummary[];
      matched = `data.${path.join('.')}`;
      break;
    }
  }

  if (!sessions) {
    const deep = findArray<SessionSummary>(data, looksLikeSession, known);
    if (deep) {
      sessions = deep;
      matched = '<deep-scan: id+title array>';
    }
  }

  if (sessions) {
    const nextCursor = findString(data, 'next_cursor') || findString(data, 'cursor');
    if (structureOut) structureOut.keys = `matched=${matched}`;
    return { sessions, nextCursor };
  }

  if (structureOut) {
    structureOut.keys = describeStructure(data);
  }
  return null;
}

/**
 * 按路径链依次取值，全部存在才返回（不要求最终为数组，由调用方判断）。
 */
function getAtPath(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null || !(key in cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
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

/** 失败诊断时 JSON 预览的最大长度（保证能看清完整结构） */
const STRUCTURE_PREVIEW_MAX = 2000;

/**
 * 描述响应结构（多层 keys + 截断 JSON 预览），用于失败诊断。
 */
function describeStructure(data: unknown): string {
  try {
    const parts: string[] = [];

    // 逐层 keys（最多 3 层），看清嵌套骨架
    let level = 0;
    let cur = data;
    while (typeof cur === 'object' && cur !== null && !Array.isArray(cur) && level < 3) {
      const keys = Object.keys(cur);
      parts.push(`L${level}.keys=[${keys.join(',')}]`);
      // 进入第一个"像数据容器"的子对象继续
      const containerKey = keys.find((k) => {
        const v = (cur as Record<string, unknown>)[k];
        return typeof v === 'object' && v !== null && !Array.isArray(v);
      });
      if (!containerKey) break;
      cur = (cur as Record<string, unknown>)[containerKey];
      level++;
    }

    // JSON 预览（截断），保留数组元素样例
    const json = JSON.stringify(data);
    if (json.length <= STRUCTURE_PREVIEW_MAX) {
      parts.push(`json=${json}`);
    } else {
      parts.push(`json(${json.length}chars)=${json.slice(0, STRUCTURE_PREVIEW_MAX)}…`);
    }

    return parts.join(' ');
  } catch {
    return '(unserializable)';
  }
}

/**
 * 从消息对象中提取正文与思考过程。
 *
 * v0 API 的消息正文可能不在顶层 content 字段（如 fragment_content 片段数组），
 * 这里做多级探测：
 * 1. 顶层字符串字段（content / text 等）；
 * 2. 顶层片段数组（fragment_content / content_chunks 等），拼接其中 text；
 * 3. 深度扫描兜底：递归找片段数组或 key 匹配 content/text 的最长字符串。
 *
 * @param msg 原始消息对象
 * @param sampleOut 可选，未提取到内容时回传消息 JSON 预览（供日志诊断真实字段）
 */
export function extractMessageBody(
  msg: unknown,
  sampleOut?: { sample: string }
): { content: string; thinking?: string } {
  const found: { content: string; thinking?: string } = { content: '' };

  if (typeof msg !== 'object' || msg === null) {
    return found;
  }

  const topLevel = msg as Record<string, unknown>;

  // 1) 顶层字符串字段
  const textKeys = ['content', 'text', 'message_content', 'content_text'];
  for (const key of textKeys) {
    const v = topLevel[key];
    if (typeof v === 'string' && v.trim()) {
      found.content = v;
      break;
    }
  }

  // 2) 顶层片段数组（元素为 {type, text} / {text} / 字符串）
  if (!found.content) {
    const fragKeys = [
      'fragment_content',
      'content_chunks',
      'fragments',
      'segments',
      'content_segments',
    ];
    for (const key of fragKeys) {
      const arr = topLevel[key];
      if (Array.isArray(arr)) {
        const joined = joinFragmentTexts(arr);
        if (joined) {
          found.content = joined;
          break;
        }
      }
    }
  }

  // 思考过程（常见命名）
  const thinkingKeys = ['thinking', 'reasoning', 'thinking_content', 'reasoning_content'];
  for (const key of thinkingKeys) {
    const v = topLevel[key];
    if (typeof v === 'string' && v.trim()) {
      found.thinking = v;
      break;
    }
  }

  // 3) 深度扫描兜底（限制深度，避免误取 id 类字段）
  if (!found.content) {
    const deep = deepFindContent(msg, 0);
    if (deep) {
      found.content = deep;
    }
  }

  if (!found.content && sampleOut) {
    sampleOut.sample = describeStructure(msg);
  }
  return found;
}

/**
 * 拼接片段数组中的文本（元素为 {type, text} / {text} / 字符串）。
 */
function joinFragmentTexts(arr: unknown[]): string {
  const parts: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      parts.push(item);
    } else if (typeof item === 'object' && item !== null) {
      const t = item as Record<string, unknown>;
      const text = t.text ?? t.content ?? t.value;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  return parts.join('');
}

/**
 * 深度扫描消息对象，兜底提取正文：
 * 优先找"片段数组"（元素带 text），其次取 key 匹配 content/text 的最长字符串。
 */
function deepFindContent(root: unknown, depth: number): string {
  if (depth > 3 || typeof root !== 'object' || root === null) return '';

  let bestText = '';
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length > 0) {
      const joined = joinFragmentTexts(value);
      if (joined && joined.length > bestText.length) {
        bestText = joined;
      }
    } else if (
      typeof value === 'string' &&
      /content|text/i.test(key) &&
      !/query|id|type|status/i.test(key) &&
      value.length > bestText.length
    ) {
      bestText = value;
    } else if (typeof value === 'object' && value !== null) {
      const nested = deepFindContent(value, depth + 1);
      if (nested.length > bestText.length) {
        bestText = nested;
      }
    }
  }
  return bestText;
}

/**
 * 归一化 role 为小写（v0 API 返回 USER / ASSISTANT）。
 */
export function normalizeRole(role: unknown): 'user' | 'assistant' | 'system' {
  const r = String(role || '').toLowerCase();
  if (r === 'assistant' || r === 'user' || r === 'system') {
    return r;
  }
  return r === 'bot' ? 'assistant' : (r as 'user' | 'assistant' | 'system');
}

/**
 * 时间戳归一化为 ISO 字符串：
 * 数字按 Unix 秒（>1e12 视为毫秒）转换；字符串尝试解析；无效返回空串。
 */
export function toIsoTimestamp(v: unknown): string {
  if (typeof v === 'number' && isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  if (typeof v === 'string' && v) {
    // 纯数字字符串也按时间戳处理
    if (/^\d+(\.\d+)?$/.test(v)) {
      return toIsoTimestamp(Number(v));
    }
    const d = new Date(v);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  return '';
}
