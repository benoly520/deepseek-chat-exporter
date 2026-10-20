/**
 * DeepSeek 导出 JSON 的类型定义（与扩展端导出格式一致）。
 */

export interface ExportedConversation {
  export_meta: ExportMeta;
  user?: UserInfo;
  conversations: Conversation[];
}

export interface ExportMeta {
  exporter: string;
  version: string;
  exported_at: string;
  source: string;
}

export interface UserInfo {
  id: string;
  name: string;
  email?: string;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
  messages: Message[];
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  created_at: string;
  id?: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: string;
  url: string;
  name?: string;
}
