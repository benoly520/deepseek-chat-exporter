/**
 * 导出 JSON 的解析与校验工具。
 */

import type { ExportedConversation } from '../types';

/**
 * 解析并校验导出 JSON 文本。
 */
export function parseJSON(text: string): ExportedConversation {
  try {
    const data = JSON.parse(text);

    if (!data.export_meta) {
      throw new Error('无效的导出文件：缺少 export_meta 字段');
    }

    if (!data.export_meta.exporter || !data.export_meta.version || !data.export_meta.exported_at) {
      throw new Error('无效的 export_meta：缺少必要字段');
    }

    if (!Array.isArray(data.conversations)) {
      throw new Error('无效的导出文件：conversations 必须是数组');
    }

    return data as ExportedConversation;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('无效的 JSON 格式');
    }
    throw error;
  }
}

/**
 * 将 File 读取为文本。
 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}
