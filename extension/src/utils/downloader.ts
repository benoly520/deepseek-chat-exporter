/**
 * 下载触发工具。
 *
 * MV3 service worker 中没有 URL.createObjectURL（Blob URL 被禁用），因此：
 * 1. 小文件（<1.5MB）：data URL + chrome.downloads；
 * 2. 大文件或 data URL 失败：把 JSON 发给 content script，
 *    在页面上下文创建 Blob URL 并通过 <a download> 触发下载。
 */

/** data URL 方式的安全大小上限（JSON 字符数） */
const DATA_URL_MAX = 1_500_000;

/**
 * UTF-8 安全的 base64 编码（分块避免爆栈）。
 */
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

/**
 * 包装 chrome.downloads.download 为 Promise。
 */
function chromeDownload(url: string, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * 触发 JSON 文件下载。
 *
 * @param data 导出数据对象
 * @param filename 文件名
 * @param tabId 用于兜底的 DeepSeek 标签页 ID（content script blob 下载）
 */
export async function triggerDownload(
  data: unknown,
  filename: string,
  tabId?: number | null
): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const sizeHint = `${json.length} chars`;

  // 1) 小文件：data URL 方式
  if (json.length <= DATA_URL_MAX) {
    try {
      const dataUrl = `data:application/json;base64,${utf8ToBase64(json)}`;
      await chromeDownload(dataUrl, filename);
      console.info('[DeepSeek Exporter][sw] Download via data URL:', filename, sizeHint);
      return;
    } catch (error) {
      // data URL 可能被拒（过大 / 浏览器限制），走 content 兜底
      console.warn('[DeepSeek Exporter][sw] data URL download failed, fallback to content:', error);
    }
  }

  // 2) 兜底：content script 在页面上下文用 Blob URL 下载
  if (tabId) {
    await chrome.tabs.sendMessage(tabId, {
      type: 'DOWNLOAD_BLOB',
      payload: { filename, json },
    });
    console.info('[DeepSeek Exporter][sw] Download via content blob:', filename, sizeHint);
    return;
  }

  throw new Error('无法触发下载：data URL 方式失败且没有可用的 DeepSeek 标签页');
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
