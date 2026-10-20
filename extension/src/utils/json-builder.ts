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
 */
export function convertMessages(rawMessages: RawMessage[]): Message[] {
  return rawMessages.map((msg) => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content || '',
    thinking: msg.thinking,
    // 缺失时间戳时保留空串，不用导出时刻的时间伪造，避免数据失真
    created_at: msg.created_at || '',
    id: msg.id,
    attachments: msg.attachments?.map((att) => ({
      type: att.type,
      url: att.url,
      name: att.name,
    })),
  }));
}

/**
 * 由会话摘要与消息列表构建会话对象。
 */
export function buildConversation(
  session: SessionSummary,
  rawMessages: RawMessage[]
): Conversation {
  return {
    id: session.id,
    title: session.title || 'Untitled',
    model: session.model || 'deepseek-chat',
    created_at: session.created_at || '',
    updated_at: session.updated_at || '',
    messages: convertMessages(rawMessages),
  };
}
