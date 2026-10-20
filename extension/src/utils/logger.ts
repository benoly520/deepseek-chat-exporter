/**
 * 轻量日志工具（供 content script / service worker / popup 共用）。
 *
 * 设计：
 * - 每个上下文维护内存环形缓冲（最多 500 条）；
 * - content script 的日志转发给 service worker 统一汇总；
 * - service worker 将全部日志节流持久化到 chrome.storage.local，
 *   SW 冷启动时恢复，日志不因 SW 休眠而丢失；
 * - popup 通过 GET_LOGS 拉取并支持下载 / 拷贝 / 清空。
 */

import type { ExtensionMessage } from '../types';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ISO 时间 */
  t: string;
  lv: LogLevel;
  /** 来源作用域：'sw' | 'content' | 'popup' */
  sc: string;
  msg: string;
  data?: unknown;
}

/** SW 持久化的日志上限 */
export const MAX_PERSISTED_ENTRIES = 1000;
/** chrome.storage.local 中的存储键 */
export const LOG_STORAGE_KEY = 'ds_exporter_logs';

/**
 * 将单条日志格式化为一行文本。
 */
export function formatEntry(e: LogEntry): string {
  let line = `[${e.t}] [${e.lv.toUpperCase().padEnd(5)}] [${e.sc}] ${e.msg}`;
  if (e.data !== undefined) {
    try {
      line += ` ${JSON.stringify(e.data)}`;
    } catch {
      line += ' [unserializable]';
    }
  }
  return line;
}

/**
 * 将日志列表格式化为多行文本（用于导出 / 展示）。
 */
export function formatAll(entries: LogEntry[]): string {
  return entries.map(formatEntry).join('\n');
}

/**
 * 控制台映射：debug 也走 console.log。
 */
function consolePrint(lv: LogLevel, scope: string, msg: string, data?: unknown) {
  const prefix = `[DeepSeek Exporter][${scope}]`;
  if (lv === 'error') {
    console.error(prefix, msg, data ?? '');
  } else if (lv === 'warn') {
    console.warn(prefix, msg, data ?? '');
  } else {
    console.log(prefix, msg, data ?? '');
  }
}

/**
 * 创建本地日志器（content / popup / sw 用）。
 *
 * @param scope 作用域标识
 * @param forward 是否转发给 service worker 汇总（content script 传 true）
 * @param sink 自定义落点（SW 传入 LogStore.add，让自身日志也持久化）
 */
export function createLocalLogger(
  scope: string,
  forward = false,
  sink?: (entry: LogEntry) => void
) {
  const entries: LogEntry[] = [];

  function log(lv: LogLevel, msg: string, data?: unknown) {
    const entry: LogEntry = { t: new Date().toISOString(), lv, sc: scope, msg, data };
    entries.push(entry);
    if (entries.length > 500) entries.shift();

    consolePrint(lv, scope, msg, data);

    if (sink) {
      try {
        sink(entry);
      } catch {
        // sink 异常不影响主流程
      }
    } else if (forward && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        const msgObj: ExtensionMessage = { type: 'LOG_ENTRY', payload: entry };
        const result = chrome.runtime.sendMessage(msgObj);
        // 无监听 / 扩展重载时静默失败
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch(() => {});
        }
      } catch {
        // 扩展上下文失效，忽略
      }
    }
  }

  return {
    debug: (msg: string, data?: unknown) => log('debug', msg, data),
    info: (msg: string, data?: unknown) => log('info', msg, data),
    warn: (msg: string, data?: unknown) => log('warn', msg, data),
    error: (msg: string, data?: unknown) => log('error', msg, data),
    /** 本上下文的内存日志（未持久化的部分） */
    entries,
  };
}
