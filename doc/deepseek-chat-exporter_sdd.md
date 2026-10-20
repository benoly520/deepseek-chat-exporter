# DeepSeek Chat 数据导出与展示工具 — 软件设计文档 (SDD)

> 版本：1.1.0（2026-10-20 修订）
> 本文档由初版 SDD（Vue 3 方案）随实际实现修订而来，描述当前仓库的**真实架构**。
> 与初版的主要差异：展示端与 Popup UI 统一改用 [plain-framework](https://benoly520.github.io/plain-framework/) 实现，
> 导出端补充了鉴权代理、游标分页等落地决策，详见「修订记录」。

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | — | 初版 SDD（Chrome 扩展 + Vue 3 SPA 方案） |
| 1.1.0 | 2026-10-20 | 随迁移重构修订：Popup 与查看器统一改用 plain-framework；修复 popup 白屏 / hook 注入路径 / UUID 正则 / downloads 权限等缺陷；新增 FETCH_PROXY 鉴权代理与游标分页导出 |

## 1. 项目概述

### 1.1 项目目标

开发一套 DeepSeek 网页版聊天数据导出与展示工具，包含两个独立子系统：

1. **Chrome 扩展（导出端）**：通过拦截 DeepSeek 网页版 API 响应，将完整聊天数据导出为结构化 JSON 文件。
2. **查看器（展示端）**：读取导出的 JSON 文件，以气泡对话形式展示聊天内容，支持 Markdown 渲染与搜索。

### 1.2 目标用户

DeepSeek 网页版（`chat.deepseek.com`）的长期使用用户，需要备份、归档或离线浏览自己的聊天历史。

### 1.3 技术栈总览

| 子系统 | 技术栈 |
|--------|--------|
| Chrome 扩展（导出端） | Chrome Extension Manifest V3, TypeScript, plain（Popup UI）, Vite + esbuild |
| 查看器（展示端） | plain-framework（signals + TSX）, markdown-it, highlight.js, Vite |

两端 UI 均基于 plain：组件为「返回 JSX 的函数」，状态为模块级 `signal`，无虚拟 DOM。
`plain` 依赖通过 `link:` 指向本地框架仓库（见根 README），两端均使用 pnpm 管理依赖。

---

## 2. 系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────┐
│                    chat.deepseek.com                     │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Chrome Extension (Content Script)        │   │
│  │                                                   │   │
│  │  ┌─────────────┐   ┌──────────────────────────┐  │   │
│  │  │  Fetch Hook  │──▶│  SSE Stream Assembler    │  │   │
│  │  │  (拦截API)   │   │  (流式数据拼接)           │  │   │
│  │  └─────────────┘   └──────────────────────────┘  │   │
│  │         │ 捕获 Bearer Token / 会话 / 消息          │   │
│  │                              ▼                    │   │
│  │  ┌─────────────────────────────────────────────┐  │   │
│  │  │  FETCH_PROXY（页面上下文代理 API 请求）       │  │   │
│  │  └─────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────┘   │
│                          │                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Background Service Worker（导出编排）             │   │
│  │  单会话导出 / 批量游标分页导出 / 限速 / 下载        │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                          │
                          │ .json 文件下载
                          ▼
┌─────────────────────────────────────────────────────────┐
│              查看器（plain SPA，纯前端）                  │
│  FileLoader → JSON Parser → 会话列表 / 聊天视图          │
│                             │                            │
│                             ▼                            │
│                    Markdown 渲染 + 思考过程折叠          │
└─────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
DeepSeek 后端 API
    │  HTTP Response / SSE Stream
    ▼
Fetch Hook（MAIN world，拦截 + 捕获 Token）
    │  CustomEvent（__ds_data__）
    ▼
Content Script（合并累积 / FETCH_PROXY 代理）
    │  chrome.runtime.sendMessage
    ▼
Service Worker（导出编排：分页拉取 + 限速 + JSON 构建）
    │  chrome.downloads
    ▼
JSON File (.json)
    │  用户拖入 / 选择文件
    ▼
查看器（plain signal 状态 → 气泡展示）
```

---

## 3. DeepSeek 网页版 API 分析

> 以下为基于逆向分析与开源项目验证的内部 API，**非官方契约**，结构变更需同步适配扩展端解析逻辑。

### 3.1 已知 API 端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/users/current` | GET | 获取当前登录用户信息 |
| `/api/chat_session/fetch_page` | POST | 分页获取会话列表（keyset cursor 翻页） |
| `/api/chat/history_messages` | POST | 获取指定会话的历史消息 |

### 3.2 认证机制

- 网页版使用 **Bearer Token** 认证，Token 存在于页面 JS 发起的请求头中。
- Fetch Hook 拦截请求时顺带捕获 `Authorization` 头，供 FETCH_PROXY 代理请求复用。

### 3.3 会话列表 API 详情

**请求：**

```http
POST /api/chat_session/fetch_page
Content-Type: application/json
Authorization: Bearer <token>

{
  "cursor": "",           // 分页游标，首次为空
  "limit": 50,            // 每页数量（扩展端实现值）
  "order_by": "updated_at",
  "direction": "DESC"
}
```

**响应结构：**

```json
{
  "code": 0,
  "data": {
    "sessions": [
      { "id": "...", "title": "...", "created_at": "...", "updated_at": "...", "model": "..." }
    ],
    "next_cursor": "abc123"   // 为空表示无更多数据
  }
}
```

### 3.4 历史消息 API 详情

**请求：**

```http
POST /api/chat/history_messages
Content-Type: application/json
Authorization: Bearer <token>

{ "session_id": "session_id" }
```

**响应结构：**

```json
{
  "code": 0,
  "data": {
    "messages": [
      { "role": "user", "content": "...", "created_at": "..." },
      { "role": "assistant", "content": "Markdown", "thinking": "思考过程", "created_at": "..." }
    ]
  }
}
```

### 3.5 SSE 流式响应

用户在页面发送新消息时，响应以 SSE 流式返回（`Accept: text/event-stream`）：

```
data: {"choices":[{"delta":{"content":"你","role":"assistant"}}]}

data: [DONE]
```

扩展拦截并拼接 `delta.content` / `delta.thinking` 以获取完整的助手回复。

---

## 4. Chrome 扩展设计（导出端）

### 4.1 扩展结构

```
extension/
├── manifest.json              # Manifest V3 配置
├── build.js                   # 构建脚本（Vite 构建 popup + esbuild 构建 content/background）
├── vite.config.ts             # popup 构建配置（plain/vite 插件）
├── icons/
└── src/
    ├── background/
    │   └── service-worker.ts  # 导出编排（游标分页 + 限速）
    ├── content/
    │   ├── index.ts           # Content Script 入口（FETCH_PROXY / 状态查询）
    │   ├── fetch-hook.ts      # MAIN world 拦截器（含 Token 捕获）
    │   └── page-watcher.ts    # SPA 路由监听（UUID 会话 ID）
    ├── popup/
    │   ├── popup.html         # popup 页面（样式内联）
    │   ├── App.tsx            # Popup UI（plain / TSX）
    │   └── main.tsx           # popup 入口
    ├── types/
    │   └── index.ts           # 类型定义
    └── utils/
        ├── json-builder.ts    # JSON 结构化构建
        └── downloader.ts      # 下载触发（chrome.downloads）
```

### 4.2 核心模块设计

#### 4.2.1 Fetch Hook（`fetch-hook.ts`）

- 以**经典脚本**（IIFE）注入页面 MAIN world（`content/fetch-hook.js`，与 manifest 的
  `web_accessible_resources` 声明一致），覆盖 `window.fetch`。
- `document_start` 时**立即注入**，确保 hook 赶在页面首批 API 请求之前安装。
- 拦截目标：`/api/chat_session/fetch_page`、`/api/chat/history_messages`、
  `Accept: text/event-stream` 的 SSE 请求（兼容 `Request` 对象与 `init.headers` 两种形态）。
- 同时捕获 `Authorization` 头，经 `__ds_data__` 事件（`auth_token`）上报给 content script。
- 数据经 `CustomEvent('__ds_data__')` 传回 content script，不修改原始响应。

#### 4.2.2 Content Script（`content/index.ts`）

- 会话列表**按 id 合并累积**（fetch_page 是分页接口，跨页不丢失）。
- 提供 **FETCH_PROXY**：service worker 无法携带页面的 Bearer Token，
  由 content script 在页面上下文代为发起 API 请求（附带捕获的 Token + `credentials: 'include'`）。
- 捕获/上报类消息发送失败时静默处理（扩展重载、通道关闭等场景）。

#### 4.2.3 Page Watcher（`page-watcher.ts`）

- 从 URL 提取会话 ID：`/a/chat/{session_id}`，**session_id 为带连字符的 UUID**
  （如 `5a298e61-4fd4-455b-9aaf-7c6142d727a0`），正则必须包含连字符。
- 监听 `popstate` + 劫持 `pushState/replaceState` + MutationObserver 兜底
  （观察 `documentElement`，因 `document_start` 时 `body` 尚不存在）。

#### 4.2.4 Background Service Worker（`service-worker.ts`）

| 模式 | 说明 |
|------|------|
| 当前会话导出 | FETCH_PROXY 拉取完整历史 → 从会话列表补全元数据 → 生成 JSON |
| 批量全量导出 | FETCH_PROXY 游标翻页拉取全部会话 → 逐个拉取历史 → 合并为单个 JSON |

- **限速策略**：每 5 个请求暂停 800ms，翻页间隔 300ms，防止触发风控。
- 目标标签页通过 `chrome.tabs.query({ active: true, currentWindow: true })` 实时确定，
  不依赖内存态 `currentTabId`（规避 service worker 休眠丢状态）。
- 下载使用 `chrome.downloads`（manifest 已声明 `downloads` 权限），`saveAs: true`。
- 文件名时间戳使用**本地时区**。

#### 4.2.5 Popup UI（`popup/App.tsx`，plain 实现）

- `signal` 管理状态（连接状态 / 捕获统计 / 导出进度 / 提示消息），每 2 秒轮询 `GET_STATUS`。
- 轮询定时器通过 `ref` 逃逸口挂载，返回清理函数，popup 关闭时停止。
- 未连接时显示引导提示并禁用导出按钮。

### 4.3 导出 JSON Schema

```typescript
interface ExportedConversation {
  export_meta: {
    exporter: 'deepseek-chat-exporter';
    version: '1.0.0';
    exported_at: string;        // ISO 8601（UTC）
    source: 'chat.deepseek.com';
  };
  user?: { id: string; name: string; email?: string };
  conversations: Conversation[];
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  created_at: string;   // 缺失时为空串，不伪造
  updated_at: string;
  messages: Message[];
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;            // Markdown
  thinking?: string;          // 思考过程（DeepSeek R1 等）
  created_at: string;         // 缺失时为空串，不伪造
  id?: string;
  attachments?: Attachment[];
}
```

### 4.4 Manifest V3 要点

```json
{
  "permissions": ["activeTab", "storage", "downloads"],
  "host_permissions": ["https://chat.deepseek.com/*"],
  "content_scripts": [{ "js": ["content/index.js"], "run_at": "document_start" }],
  "web_accessible_resources": [{ "resources": ["content/fetch-hook.js"] }]
}
```

- `downloads` 权限是 service worker 触发下载的必要条件（初版缺失导致批量导出失败，已修复）。
- `run_at: document_start` 保证 hook 先于页面 API 请求安装。

### 4.5 构建方式

```
pnpm build → build.js
  1. Vite 构建 popup（popup.html 为入口，plain/vite 插件编译 TSX，
     脚本路径与 CSS/样式自动注入 —— 修复初版手动拷贝 HTML 导致的白屏）
  2. esbuild 分别打包 content/index.ts、content/fetch-hook.ts（IIFE）
     与 background/service-worker.ts（ESM）
  3. 拷贝 manifest.json / icons 到 dist/
```

加载目录为 `extension/dist`。

---

## 5. 查看器设计（plain 实现）

### 5.1 项目结构

```
viewer/
├── index.html            # 页面骨架 + 全部样式（与 plain 官方示例一致）
├── vite.config.ts        # plain/vite 插件
└── src/
    ├── main.tsx          # 入口：mount('#app', App())
    ├── App.tsx           # 根组件：加载页 / 主视图切换（hidden 属性响应式切换）
    ├── state.ts          # 模块级 signal 状态（替代原 Pinia store）
    ├── components/
    │   ├── FileLoader.tsx          # 拖拽 / 多选导入
    │   ├── ConversationList.tsx    # 会话列表侧栏（过滤 + 选中态）
    │   └── ChatView.tsx            # 聊天视图（气泡 / 思考块 / Markdown）
    ├── utils/
    │   ├── json-parser.ts          # JSON 解析与 export_meta 校验
    │   ├── date-format.ts          # 本地时区日期格式化
    │   └── markdown.ts             # markdown-it + highlight.js
    └── types.ts                    # 与导出 JSON 对应的类型
```

### 5.2 状态设计（plain signal）

模块级 signal 替代初版的 Pinia store：

| signal | 说明 |
|--------|------|
| `conversations` | 会话列表（按 `updated_at` 倒序，多文件按 id 合并去重） |
| `currentId` | 当前选中会话 |
| `searchQuery` | 搜索关键词 |
| `exportMeta` / `loading` / `loadError` | 元数据与加载状态 |

派生值（`computed`）：`filteredConversations`（标题或消息内容匹配）、
`currentConversation`、`stats`。

### 5.3 plain 使用约定（重要）

- 组件 = 返回 JSX 的函数，动态 props 编译器自动包 getter，组件内用 `resolve()` 读取；
  **读取必须发生在渲染上下文内**（如 `const v = () => resolve(props.value)` 再 `{v()}`），
  不能在组件体顶层一次性解构（响应性会静默丢失）。
- 条件渲染用三元（编译为 `when`）、列表用 `.map()`（编译为 `each`）、
  面板级切换用 `hidden` 响应式属性。
- Markdown HTML 注入通过 `ref` 逃逸口 + `effect` 更新 `innerHTML`，
  需 `// plain-ignore-next-line PLAIN_E1104` 抑制 lint
  （markdown-it 已关闭原始 HTML，内容安全；effect 在 ref 清理函数中回收）。
- Markdown 渲染安全：`html: false` 防注入、`breaks: true` 适配聊天换行、
  外链统一 `target="_blank" rel="noopener noreferrer"`、代码块 highlight.js 高亮。

### 5.4 页面布局

```
┌──────────────────────────────────────────────────────┐
│  DeepSeek Chat Viewer          [搜索] [导入文件]      │
├────────────┬─────────────────────────────────────────┤
│  会话列表   │  聊天主视图                              │
│  (倒序)     │  用户消息：右对齐蓝色气泡                  │
│  标题/统计  │  助手消息：左对齐浅色气泡                  │
│            │    ├ ▶ 思考过程（折叠，默认收起）          │
│            │    └ Markdown 渲染（代码高亮 / 表格）      │
│            │    [复制原文]                             │
├────────────┴─────────────────────────────────────────┤
│  共 N 个会话 · M 条消息 · 导出时间: ...                │
└──────────────────────────────────────────────────────┘
```

- 未加载数据时显示拖拽导入页；支持多选合并导入（按会话 id 去重）。
- 切换会话时聊天区自动滚动到底部。

---

## 6. 接口契约

### 6.1 Popup ↔ Background ↔ Content Script

通过 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`：

| type | 方向 | 说明 |
|------|------|------|
| `GET_STATUS` | popup → SW → content | 连接状态 / 捕获统计 |
| `EXPORT_CURRENT` | popup → SW → content | 导出当前会话 |
| `EXPORT_ALL` | popup → SW → content | 批量导出（SW 内游标分页编排） |
| `EXPORT_PROGRESS` | SW → popup | 批量导出进度（0-100） |
| `PAGE_CHANGED` | content → SW | 路由变化通知 |
| `SESSION_LIST` / `HISTORY_MESSAGES` / `SSE_COMPLETE` / `AUTH_TOKEN` | content → SW | hook 捕获上报 |
| `FETCH_PROXY` | SW → content | 页面上下文代理 API 请求（携带 url + body，返回 JSON 或 error） |

### 6.2 Fetch Hook ↔ Content Script

同页面上下文，通过 CustomEvent：

- `__ds_data__`：`detail: { type: 'session_list' | 'history_messages' | 'sse_complete' | 'auth_token', data }`
- `__ds_hook_control__`：`detail: { status: 'installed' }`（安装确认）

---

## 7. 错误处理策略

### 7.1 Chrome 扩展端

| 场景 | 处理方式 |
|------|----------|
| content script 未注入（页面未刷新） | popup 显示"未连接时请刷新 DeepSeek 页面后重试" |
| 无活跃 DeepSeek 标签页 | 导出请求返回明确错误信息 |
| API 请求失败（FETCH_PROXY 报错） | 单会话导出失败展示错误；批量导出跳过该会话继续 |
| API 结构变更（如 next_cursor 字段变更） | 解析失败给出明确错误，不静默吞掉 |
| 会话数据为空 | 跳过该会话 |
| 防御性上限 | 会话列表翻页最多 100 页，避免异常响应死循环 |

### 7.2 查看器端

| 场景 | 处理方式 |
|------|----------|
| JSON 格式错误 | 显示解析错误详情（缺 export_meta / conversations 非数组等） |
| 无效时间戳 | 格式化返回空串，不抛错 |
| Markdown 渲染失败 | 回退为纯文本转义输出 |
| 空数据 | 显示空状态引导提示 |

---

## 8. 安全考量

- **零外联**：所有请求由用户浏览器发起，仅调用只读 API，不向第三方发送数据。
- **Token 安全**：Bearer Token 仅存于内存（content script 变量），不持久化到 `chrome.storage`。
- **只读操作**：仅调用只读 API。
- **查看器纯前端**：JSON 文件通过 FileReader 本地读取，不上传任何服务器。
- **Markdown 渲染**：`markdown-it` 关闭原始 HTML；外链强制 `noopener noreferrer`。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| DeepSeek API 结构变更 | 扩展无法正确解析数据 | 数据校验 + 明确错误提示（见 §7.1） |
| DeepSeek 反爬/风控 | 批量导出被限制 | 限速策略（800ms/5 请求 + 翻页间隔） |
| Manifest V3 SW 休眠 | 内存态丢失 | 导出目标 tab 实时 query；导出流程单次完成不依赖跨唤醒状态 |
| 大文件渲染性能 | 浏览器卡顿 | 会话列表/消息为细粒度更新；后续可引入虚拟滚动 |
| SSE 流中断 | 助手回复不完整 | 流未以 [DONE] 结束也派发已拼装内容 |
| `plain` 为本地 link 依赖 | clone 后需框架仓库可用 | 根 README 标注前置条件（框架仓库需先构建） |

---

## 10. 后续计划（Backlog）

- [ ] 暗色主题
- [ ] 消息级虚拟滚动（超长会话性能）
- [ ] 导出 Markdown / HTML 格式（当前仅 JSON）
- [ ] 导出进度断点续传（SW 被唤醒后恢复）
- [ ] `plaindev check` 接入 CI（两端统一 lint 门禁）
