/**
 * 错误描述工具。
 *
 * 背景：`String(error)` 对 Error 实例会得到 "Error: 正文"，
 * 而 SW 把错误文本经 sendResponse 交给 popup 后 popup 还会再拼一次，
 * 最终展示成 "加载会话列表失败: Error: Error: 正文" 这种带冗余前缀的提示。
 * 这里统一取 message，保证跨上下文传递一次后仍是干净的一句话。
 */

/**
 * 将任意异常值描述为可读文本（Error 取 message，其余走字符串化）。
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || '未知错误';
  }
  return String(error);
}
