/**
 * Chrome 扩展的文件下载触发工具。
 */

/**
 * 触发 JSON 文件下载。
 */
export async function triggerDownload(data: unknown, filename: string): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // 优先使用 Chrome downloads API（manifest 已声明 downloads 权限）
  if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
    await new Promise<void>((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true }, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve();
        }
      });
    });
    // 等下载任务接管 Blob URL 后再释放
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } else {
    // 兜底：SW 环境没有 document，理论上不会走到这里
    throw new Error('chrome.downloads API 不可用，无法触发下载');
  }
}

/**
 * 生成带本地时间戳的文件名（避免旧版用 UTC 导致时间偏差 8 小时）。
 */
export function generateFilename(prefix: string = 'deepseek-export'): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${prefix}-${timestamp}.json`;
}
