/**
 * Service Worker 端的日志仓库。
 * 汇总自身与 content script 转发的日志，节流持久化到 chrome.storage.local，
 * SW 冷启动时恢复历史日志（规避 MV3 service worker 休眠导致的日志丢失）。
 */

import type { LogEntry } from './logger';
import { formatAll, LOG_STORAGE_KEY, MAX_PERSISTED_ENTRIES } from './logger';

export class LogStore {
  private entries: LogEntry[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 从 chrome.storage.local 恢复历史日志（幂等）。
   */
  init(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
        const stored = result[LOG_STORAGE_KEY] as LogEntry[] | undefined;
        if (Array.isArray(stored) && stored.length > 0) {
          this.entries = stored;
        }
      } catch (error) {
        console.error('[DeepSeek Exporter][sw] Failed to load logs:', error);
      } finally {
        this.loaded = true;
      }
    })();

    return this.loadPromise;
  }

  /**
   * 追加日志（自动去抖持久化）。
   */
  add(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_PERSISTED_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_PERSISTED_ENTRIES);
    }
    this.schedulePersist();
  }

  /**
   * 获取全部日志（确保已完成历史恢复）。
   */
  async getAll(): Promise<LogEntry[]> {
    if (!this.loaded) {
      await this.init();
    }
    return [...this.entries];
  }

  /**
   * 导出为文本。
   */
  async getText(): Promise<string> {
    const entries = await this.getAll();
    return formatAll(entries);
  }

  /**
   * 清空日志（内存 + 存储）。
   */
  async clear(): Promise<void> {
    this.entries = [];
    try {
      await chrome.storage.local.remove(LOG_STORAGE_KEY);
    } catch (error) {
      console.error('[DeepSeek Exporter][sw] Failed to clear logs:', error);
    }
  }

  /**
   * 节流持久化：500ms 内的连续日志合并写一次。
   */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      chrome.storage.local
        .set({ [LOG_STORAGE_KEY]: this.entries.slice(-MAX_PERSISTED_ENTRIES) })
        .catch((error) => console.error('[DeepSeek Exporter][sw] Failed to persist logs:', error));
    }, 500);
  }
}
