/**
 * DeepSeek Chat Exporter 扩展的类型定义。
 */

// --- 导出 JSON Schema ---

export interface ExportedConversation {
  export_meta: {
    exporter: 'deepseek-chat-exporter';
    version: '1.0.0';
    exported_at: string; // ISO 8601
    source: 'chat.deepseek.com';
  };
  user?: { id: string; name: string; email?: string };
  conversations: Conversation[];
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

// --- API 响应类型 ---

export interface SessionListResponse {
  data: {
    sessions: SessionSummary[];
    next_cursor?: string;
    total?: number;
  };
}

export interface SessionSummary {
  id: string;
  title: string;
  model?: string;
  created_at?: string;
  updated_at?: string;
}

export interface HistoryMessagesResponse {
  data: {
    messages: RawMessage[];
  };
}

export interface RawMessage {
  id?: string;
  role: string;
  content: string;
  thinking?: string;
  created_at?: string;
  attachments?: Array<{
    type: string;
    url: string;
    name?: string;
  }>;
}

// --- SSE 类型 ---

export interface SSEChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      thinking?: string;
      role?: string;
    };
  }>;
  model?: string;
}

// --- 扩展内部通信 ---

export type MessageType =
  | 'SESSION_LIST'
  | 'HISTORY_MESSAGES'
  | 'SSE_COMPLETE'
  | 'AUTH_TOKEN'
  | 'PAGE_CHANGED'
  | 'GET_STATUS'
  | 'EXPORT_CURRENT'
  | 'EXPORT_ALL'
  | 'EXPORT_PROGRESS'
  | 'FETCH_PROXY'
  | 'LOG_ENTRY'
  | 'GET_LOGS'
  | 'CLEAR_LOGS'
  | 'DOWNLOAD_BLOB';

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface StatusPayload {
  connected: boolean;
  currentSessionId: string | null;
  capturedSessions: number;
  capturedMessages: number;
  exporting: boolean;
  exportProgress: number;
  /** 诊断用：最近捕获到的 /api/ 请求 URL（最新在前，最多 20 条） */
  recentApiUrls?: string[];
  /** 诊断用：状态获取失败的详细原因（如 content script 不可达） */
  swError?: string;
}

/** FETCH_PROXY 消息载荷：由 service worker 发起、content script 在页面上下文代为执行 */
export interface FetchProxyPayload {
  url: string;
  body: unknown;
}

// --- 自定义事件类型 ---

export interface DSDataEvent {
  type: string;
  data: unknown;
}
