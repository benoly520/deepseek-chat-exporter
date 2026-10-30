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
  /** v0 API 返回秒级数字时间戳，旧结构可能为 ISO 字符串，展示层负责归一化 */
  created_at?: string | number;
  updated_at?: string | number;
  /** 是否置顶：keyset 翻页游标由 {pinned, updated_at} 二元组构成 */
  pinned?: boolean;
}

export interface HistoryMessagesResponse {
  data: {
    messages: RawMessage[];
  };
}

export interface RawMessage {
  id?: string;
  role?: string;
  content?: string;
  thinking?: string;
  created_at?: unknown;
  // v0 API 消息字段结构与旧假设不同，放宽以兼容任意形态（正文可能嵌套在片段结构里）
  [key: string]: unknown;
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
  | 'EXPORT_SELECTED'
  | 'EXPORT_PROGRESS'
  | 'LOAD_SESSIONS'
  | 'LIST_PROGRESS'
  | 'DELETE_SESSIONS'
  | 'DELETE_REQUEST_CAPTURED'
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
  /** 批量导出详情（仅 SW 侧填充）：正在导出第几个会话 */
  exportCurrent?: { index: number; total: number; title: string } | null;
  /** 删除接口是否已学习（用户在页面手动删除过会话后为 true） */
  deleteTemplateReady?: boolean;
  /** 会话列表是否已加载及总数 */
  sessionCacheCount?: number;
  /** 诊断用：最近捕获到的 /api/ 请求 URL（最新在前，最多 20 条） */
  recentApiUrls?: string[];
  /** 诊断用：状态获取失败的详细原因（如 content script 不可达） */
  swError?: string;
}

/** FETCH_PROXY 消息载荷：由 service worker 发起、content script 在页面上下文代为执行 */
export interface FetchProxyPayload {
  url: string;
  body?: unknown;
  method?: string;
}

/** hook 捕获的页面 API 请求配置（SW 代理据此原样重放；delete 用于批量删除学习） */
export interface CapturedApiRequest {
  kind: 'fetchPage' | 'history' | 'delete' | 'other';
  url: string;
  method: string;
  body?: string;
}

// --- 自定义事件类型 ---

export interface DSDataEvent {
  type: string;
  data: unknown;
}
