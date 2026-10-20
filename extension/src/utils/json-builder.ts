/**
 * 导出 JSON 结构的构建工具。
 */

import type {
  ExportedConversation,
  Conversation,
  Message,
  RawMessage,
  SessionSummary,
} from '../types';
import { extractMessageBody, normalizeRole, toIsoTimestamp } from './api-extract';

/**
 * 构建导出 JSON 的顶层结构。
 */
export function buildExportJSON(
  conversations: Conversation[],
  user?: { id: string; name: string; email?: string }
): ExportedConversation {
  return {
    export_meta: {
      exporter: 'deepseek-chat-exporter',
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      source: 'chat.deepseek.com',
    },
    user,
    conversations,
  };
}

/**
 * 将 API 原始消息转换为导出格式。
 *
 * v0 API 适配：
 * - role 大写（USER/ASSISTANT）→ 归一化为小写；
 * - 正文可能藏在嵌套片段结构里 → extractMessageBody 多级探测；
 * - 时间戳为 Unix 数字 → toIsoTimestamp 归一化；
 * - 任一环节取不到时记录失败样本（由调用方传入日志通道）。
 */
export function convertMessages(
  rawMessages: RawMessage[],
  onSample?: (msg: RawMessage, sample: string) => void
): Message[] {
  return rawMessages.map((msg) => {
    const sampleOut = { sample: '' };
    const body = extractMessageBody(msg, sampleOut);
    // 正文提取失败时把消息 JSON 预览交给日志（诊断真实字段结构）
    if (!body.content && sampleOut.sample && onSample) {
      onSample(msg, sampleOut.sample);
    }

    return {
      role: normalizeRole(msg.role),
      content: body.content,
      thinking: body.thinking ?? (typeof msg.thinking === 'string' ? msg.thinking : undefined),
      // 缺失时间戳时保留空串，不用导出时刻的时间伪造，避免数据失真
      created_at: toIsoTimestamp(msg.created_at),
      id: typeof msg.id === 'string' ? msg.id : undefined,
      attachments: Array.isArray(msg.attachments)
        ? msg.attachments.map((att: any) => ({
            type: String(att?.type ?? ''),
            url: String(att?.url ?? ''),
            name: typeof att?.name === 'string' ? att.name : undefined,
          }))
        : undefined,
    };
  });
}

/**
 * 由会话摘要与消息列表构建会话对象。
 */
export function buildConversation(
  session: SessionSummary,
  rawMessages: RawMessage[],
  onSample?: (msg: RawMessage, sample: string) => void
): Conversation {
  return {
    id: session.id,
    title: session.title || 'Untitled',
    model: session.model || 'deepseek-chat',
    created_at: toIsoTimestamp(session.created_at),
    updated_at: toIsoTimestamp(session.updated_at),
    messages: convertMessages(rawMessages, onSample),
  };
}
