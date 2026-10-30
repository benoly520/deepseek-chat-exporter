/**
 * 导出 JSON 的解析与校验工具。
 */

import type { ExportedConversation } from '../types';

/**
 * 带文案 key 的错误：界面渲染时再翻译，切换语言后已显示的提示也会跟着变。
 */
export class ViewerError extends Error {
  /** 字典里的文案 key */
  key: string;
  /** 文案占位符参数 */
  vars?: Record<string, string | number>;

  constructor(key: string, vars?: Record<string, string | number>) {
    super(key);
    this.name = 'ViewerError';
    this.key = key;
    this.vars = vars;
  }
}

/**
 * 解析并校验导出 JSON 文本。
 */
export function parseJSON(text: string): ExportedConversation {
  try {
    const data = JSON.parse(text);

    if (!data.export_meta) {
      throw new ViewerError('error.missingMeta');
    }

    if (!data.export_meta.exporter || !data.export_meta.version || !data.export_meta.exported_at) {
      throw new ViewerError('error.invalidMeta');
    }

    if (!Array.isArray(data.conversations)) {
      throw new ViewerError('error.badConversations');
    }

    return data as ExportedConversation;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ViewerError('error.badJSON');
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
    reader.onerror = () => reject(new ViewerError('error.readFailed'));
    reader.readAsText(file);
  });
}
