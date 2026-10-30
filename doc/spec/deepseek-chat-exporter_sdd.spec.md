# DeepSeek Chat 数据导出与展示工具 — 软件设计文档 (SDD)

> 版本：1.2.4（2026-10-30 修订）
> 本文档由初版 SDD（Vue 3 方案）随实际实现修订而来，描述当前仓库的**真实架构**。
> 与初版的主要差异：展示端与 Popup UI 统一改用 [plain-framework](https://benoly520.github.io/plain-framework/) 实现，
> 导出端补充了鉴权代理、游标分页等落地决策，详见「修订记录」。

## 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | — | 初版 SDD（Chrome 扩展 + Vue 3 SPA 方案） |
| 1.1.0 | 2026-10-20 | 随迁移重构修订：Popup 与查看器统一改用 plain-framework；修复 popup 白屏 / hook 注入路径 / UUID 正则 / downloads 权限等缺陷；新增 FETCH_PROXY 鉴权代理与游标分页导出 |
| 1.1.1 | 2026-10-20 | 会话 URL 实际形如 /a/chat/s/{uuid}（含 /s/ 段），修正 page-watcher 正则；API 匹配改为路径后缀式（兼容 /api/v0/... 版本前缀）；新增 XHR 拦截兜底；popup 增加「API 捕获诊断」区块 |
| 1.1.2 | 2026-10-20 | manifest icons 由 SVG 改为 PNG（Chromium 不支持 SVG 图标，显示为字母占位符）；新增运行日志系统（content/SW 日志汇总持久化，popup 支持拉取 / 下载 / 拷贝 / 清空） |
| 1.2.0 | 2026-10-20 | Popup 重构为会话管理器（自动加载全部列表 / 编号+日期 / 全选 / 导出选中 / 批量删除）；导出全部突破 100 条限制（keyset 翻页 lte_cursor.updated_at）；新增学习式批量删除（捕获真实删除请求作模板，深度替换 UUID 重放）；GET_STATUS 由 SW 合并权威导出状态（修复进度被轮询覆盖）；消息正文多级提取（v0 片段结构）；日志头带版本号；统一可折叠面板与自定义展开箭头 / 确认弹窗；未登录友好提示 |
| 1.2.1 | 2026-10-30 | 修复"刷新列表报未登录"缺陷：兜底会话列表请求由错误的 `POST /api/chat_session/fetch_page`（被 SPA 前端路由接住返回 HTML）改为 v0 真实协议 `GET /api/v0/chat_session/fetch_page`；新增从捕获 URL 自适应发现端点、业务错误码（HTTP 200 + `code≠0`）识别，以及"端点不存在"与"真未登录"的提示分流。同日 Chrome PC 登录态实测「刷新列表」恢复正常（缺陷根源与复盘见 `doc/bugfix/01.session-list-refresh-false-logout.bugfix.md`） |
| 1.2.2 | 2026-10-30 | 会话列表区分置顶会话：条目渲染置顶徽标，列表按 `pinned` 稳定排序（置顶组在前，组内保持接口返回顺序）；`pinned` 由 v0 `fetch_page` 响应透传，缺失或非布尔按未置顶处理；版本 1.0.15（变更提案与验收记录见 `doc/change/01.pinned-sessions-display.change.md`） |
| 1.2.3 | 2026-10-30 | 会话列表改为「置顶 / 非置顶」双标签页；非置顶页按本地自然日分组（今天 / 昨天 / MM-DD 周X / 日期未知），分组可点击收起展开，默认只展开最近一天；序号为当前标签页内的可见行号（跨分组连续）；全选作用域收窄到当前标签页；稳定排序随之移除；版本 1.0.16（详见 `doc/change/01.pinned-sessions-display.change.md` §2.4.2） |
| 1.2.4 | 2026-10-30 | 新增 popup 本地预览工具（`pnpm preview`）：`scripts/preview.mjs` 将 `dist/` 复制到 `.preview/`、生成只覆盖 popup 实际调用接口的 mock chrome 并注入，再由 Node 内置 http 提供服务；预览数据外置为 `scripts/preview-data.json`，会话以「距今天数」描述。用于免装扩展、免登录地验证 UI 与交互，不替代真机验收（详见 §4.6） |

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
| `/api/v0/chat_session/fetch_page` | GET | 分页获取会话列表（keyset cursor 翻页） |
| `/api/v0/chat/history_messages` | GET | 获取指定会话的历史消息 |

> **路径必须带 `/v0/` 版本段**：去掉版本前缀的路径（如 `/api/chat_session/fetch_page`）
> 不存在于后端，会被 SPA 前端路由兜底接住，返回 **HTTP 200 + `text/html`（index.html）**，
> 表现形似"登录失效"。核对方式：`curl -i` 看 `content-type` 是否为 `application/json`。

### 3.2 认证机制

- 网页版使用 **Bearer Token** 认证，Token 存在于页面 JS 发起的请求头中。
- Fetch Hook 拦截请求时顺带捕获 `Authorization` 头，供 FETCH_PROXY 代理请求复用。

### 3.3 会话列表 API 详情

**请求：**

```http
GET /api/v0/chat_session/fetch_page?count=100&lte_cursor.pinned=false
Authorization: Bearer <token>
```

页面侧的真实调用（逆向自 `main.*.js`）为 `http.get('/api/v0/chat_session/fetch_page', { query })`，
query 依翻页方向取 `lte_cursor.*` 或 `gte_cursor.*`，游标由 `{pinned, updatedAt}` 二元组构成：

- **首页**：游标值为 `null`，序列化时省略 `lte_cursor.updated_at`，仅带 `lte_cursor.pinned=false`；
  `count` 缺省则用服务端默认页大小。
- **翻页**：追加 `lte_cursor.updated_at=<上一页末条 updated_at>`，并同步 `lte_cursor.pinned=<末条 pinned>`。

**响应结构：**

```json
{
  "code": 0,
  "data": {
    "sessions": [
      { "id": "...", "title": "...", "created_at": 1760000000, "updated_at": 1760000000, "model": "..." }
    ]
  }
}
```

> **翻页要点**：v0 响应实际**没有** `next_cursor` 字段，页面自身翻页用的是 keyset 游标——
> 在 query 上追加 `lte_cursor.updated_at=<上一页末条 updated_at>`。
> 扩展复刻该方式实现真实翻页（突破单页数量限制），时间字段为秒级数字时间戳。
>
> **错误包络**：业务错误同样返回 HTTP 200，形如 `{"code":40003,"msg":"INVALID_TOKEN","data":null}`。
> 代理层需在 JSON 解析后识别 `code≠0 && msg && data` 的包络特征并转成明确提示，
> 否则会落到"响应结构无法解析"这类晦涩分支。

### 3.4 删除会话 API（学习式捕获）

删除端点无公开文档且不可逆，扩展**不硬编码**，而是学习式捕获（见 §4.2.6）：
用户在页面手动删除一次会话，hook 捕获该请求的完整配置（url / method / body）作为模板。

### 3.5 历史消息 API 详情

**请求：**

```http
GET /api/v0/chat/history_messages?chat_session_id=<uuid>
Authorization: Bearer <token>
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

### 3.6 SSE 流式响应

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
- 拦截目标：`/api/v0/chat_session/fetch_page`、`/api/v0/chat/history_messages`、
  `Accept: text/event-stream` 的 SSE 请求（兼容 `Request` 对象与 `init.headers` 两种形态）。
- 同时捕获 `Authorization` 头，经 `__ds_data__` 事件（`auth_token`）上报给 content script。
- **API 请求捕获分类**（`api_request` 事件，含完整 method/url/body）：
  `fetchPage` / `history` 供导出重放，`delete`（正则 `chat_session/delete|/delete`）供删除接口学习，
  其余不捕获避免噪音。
- 数据经 `CustomEvent('__ds_data__')` 传回 content script，不修改原始响应。

#### 4.2.2 Content Script（`content/index.ts`）

- 会话列表**按 id 合并累积**（fetch_page 是分页接口，跨页不丢失）。
- 提供 **FETCH_PROXY**：service worker 无法携带页面的 Bearer Token，
  由 content script 在页面上下文代为发起 API 请求（附带捕获的 Token + `credentials: 'include'`）。
  响应异常按成因分流，避免误导：
  ① 401/403 或**无 Token** 且返回 HTML → "未登录或登录已过期"；
  ② **已有 Token** 却拿到 SPA 文档（`<!doctype html>`）→ "API 端点不存在，接口路径可能已变更"；
  ③ JSON 中 `code≠0` 的错误包络 → 认证类转登录提示，其余带 code/msg 原样上抛。
- **列表端点自愈**：页面列表组件挂载时会主动请求 `fetch_page`（`useLayoutEffect` → `fetchSessions`），
  但 hook 是异步注入的，存在“请求早于 hook 安装”的竞态（侧栏未挂载时也不会请求）。
  捕获缺失时，content 侧退回扫描已捕获的 `/api/` URL 列表发现该端点并按 v0 协议拼兜底请求，
  确保 SW 拿到的永远是 JSON 而不是前端路由的 HTML。
- 捕获/上报类消息发送失败时静默处理（扩展重载、通道关闭等场景）。

#### 4.2.3 Page Watcher（`page-watcher.ts`）

- 从 URL 提取会话 ID：`/a/chat/s/{session_id}`（注意存在 `/s/` 段），**session_id 为带
  连字符的 UUID**（如 `5a298e61-4fd4-455b-9aaf-7c6142d727a0`），正则需兼容 `/s/` 段并包含连字符。
- 监听 `popstate` + 劫持 `pushState/replaceState` + MutationObserver 兜底
  （观察 `documentElement`，因 `document_start` 时 `body` 尚不存在）。

#### 4.2.4 Background Service Worker（`service-worker.ts`）

| 模式 | 说明 |
|------|------|
| 当前会话导出 | FETCH_PROXY 拉取完整历史 → 从会话列表补全元数据 → 生成 JSON |
| 会话列表加载（LOAD_SESSIONS） | keyset 翻页拉取全部会话摘要，SW 内存缓存（60s TTL），LIST_PROGRESS 广播已加载数 |
| 批量导出选中（EXPORT_SELECTED） | 按勾选逐个拉取历史（缓存缺失时自动重拉列表）→ 合并为单个 JSON，EXPORT_PROGRESS 携带 N/总数+标题 |
| 批量删除（DELETE_SESSIONS） | 学习式重放（见 §4.2.6），逐个执行 + 限速 + 进度广播 |

- **限速策略**：每 5 个请求暂停 800ms，翻页间隔 300ms，防止触发风控。
- **keyset 翻页**：v0 响应无 `next_cursor`，复刻页面自身的 `lte_cursor.updated_at` 游标方式；
  三重终止保护（空页 / 本页无新会话 / 末条缺 `updated_at`）防死循环，上限 200 页。
- **导出状态权威源**：SW 维护 `exportInProgress/Progress/Current`，`GET_STATUS` 响应中合并
  （修复 popup 轮询拿 content 的空闲态覆盖本地进度的缺陷）。
- 目标标签页通过 `chrome.tabs.query({ active: true, currentWindow: true })` 实时确定，
  不依赖内存态 `currentTabId`（规避 service worker 休眠丢状态）。
- 下载使用 `chrome.downloads`（manifest 已声明 `downloads` 权限），`saveAs: true`。
- 文件名时间戳使用**本地时区**。

#### 4.2.5 Popup UI（`popup/App.tsx`，plain 实现）

- **会话管理器**：打开自动加载全部会话列表（SW keyset 翻页 + 缓存），列表展示
  行号 / 置顶徽标 / 标题 / 本地时间日期，支持全选 / 单选；「导出当前」「导出选中」「删除选中」三个操作。
- **双标签页**：「置顶 (k)」与「非置顶 (m)」两个标签页（带实时计数），置顶项只进置顶页；默认停在非置顶页。
- **日期分组**：非置顶页按本地自然日分组，组头文案为「今天 / 昨天 / MM-DD 周X（跨年补年份）/ 日期未知」，
  组间日期倒序；组头可点击收起 / 展开（`position: sticky` 吸顶），默认只展开第一个分组（最近一天），
  用户手动切换过的分组以显式状态为准。
- **置顶徽标**：`pinned` 由 v0 `fetch_page` 响应透传，缺失或非布尔按未置顶处理。
- **序号与全选**：序号 = 当前标签页内的可见行号（置顶页 1..k；非置顶页跨分组连续）；
  「全选本页」只作用于当前标签页，底部「导出选中 / 删除选中」的计数为跨页合计。
- `signal` 管理状态（连接状态 / 列表 / 勾选 / 导出与删除进度 / 提示消息），每 2 秒轮询 `GET_STATUS`。
- 轮询定时器通过 `ref` 逃逸口挂载，返回清理函数，popup 关闭时停止。
- **删除确认弹窗**：自定义模态（风格与 popup 统一），红色警示「不可恢复」，
  单个与批量删除均需二次确认。
- 内置诊断：API 捕获诊断与运行日志面板统一为可折叠卡片（SVG 雪佛龙箭头）。
- 版本可见性：标题旁显示版本号，日志文本头部携带 `版本 · 导出时间 · 条数`。
- 未连接时显示引导提示并禁用导出按钮。

#### 4.2.6 学习式批量删除（`deleteSessions` + 模板机制）

##### 背景与动机

DeepSeek 的删除会话端点（如 `chat_session/delete`）与列表 / 历史接口不同：

- **无文档**：不属于只读的数据拉取接口，页面 JS 中的请求构造逻辑难以静态逆向；
- **不可猜测**：URL、HTTP method、body 结构均无法像 `fetch_page` 那样凭约定拼出，猜错即为一次
  不可逆的误操作风险；
- **不可逆**：失败代价高，宁可「不可用」也不能「误删」。

因此不采用「硬编码端点 + 猜测 body」的传统做法，而是**让用户的一次真实操作充当接口文档**——
学习式（Learn-by-observation）适配：观察用户手动删除时页面实际发出的请求，将其作为模板重放。

##### 设计原则

1. **不猜测**：任何请求字段都不硬编码，全部来自页面真实请求的逐字节捕获；
2. **不越权**：扩展自身从不主动构造删除语义，仅重放用户操作产生的请求形态；
3. **可校验**：模板持久化、状态可见（`deleteTemplateReady`），用户始终知道扩展「学会了没有」；
4. **可恢复**：模板持久化到 storage，SW 休眠 / 浏览器重启后仍可用。

##### 完整流程（三阶段）

```
阶段一 捕获（页面上下文）
  用户在 DeepSeek 页面手动删除任意一个会话
    → fetch hook 拦截该请求（发出前记录 url / method / body）
    → 分类为 kind === 'delete'（正则 chat_session/delete|/delete）
    → content script 去重后上报 DELETE_REQUEST_CAPTURED

阶段二 学习（service worker）
  收到 DELETE_REQUEST_CAPTURED
    → 保存模板至内存（deleteTemplate）+ chrome.storage.local（持久化）
    → SW 冷启动时从 storage 恢复
    → GET_STATUS 返回 deleteTemplateReady=true，popup 启用「删除选中」

阶段三 重放（service worker → 页面上下文）
  用户勾选会话并确认删除
    → 逐个会话：buildDeleteRequest 用模板 body 深度替换 UUID 为目标 ID
    → 经 FETCH_PROXY 在页面上下文重放（携带页面 Bearer Token）
    → 每 5 个暂停 800ms 限速；单个失败记录并继续，不中断批次
```

##### 关键数据结构

```typescript
/** hook 捕获的删除请求模板（原样保存，重放时仅替换 body 中的会话 ID） */
interface CapturedApiRequest {
  kind: 'delete';
  url: string;      // 真实端点（含 query）
  method: string;   // 真实 method（如 DELETE / POST）
  body?: string;    // 真实请求体字符串
}

// 持久化：chrome.storage.local，键 'ds_exporter_delete_template'
```

##### UUID 替换策略（`replaceUuids`，核心技巧）

删除请求 body 的确切结构未知，不做字段级解析，而是**深度遍历整个 JSON**：

- 字符串节点：命中 UUID 正则（`/^[0-9a-f]{8}-…-[0-9a-f]{12}$/i`）→ 替换为目标会话 ID；
- 数组节点：若元素含 UUID 字符串 → 整组替换为目标 ID 数组（兼容批量 body 形态）；
- 对象节点：递归遍历所有键值。

这样无论 body 是 `{ "chat_session_id": "..." }` 还是 `{ "ids": [...] }` 等任意结构都能兼容，
且不会误伤非 ID 字段（时间戳、标题等不匹配 UUID 格式）。

##### 防护措施

| 措施 | 说明 |
|------|------|
| 学习门槛 | 未捕获到模板前，「删除选中」按钮禁用且有引导文案 |
| 二次确认 | 单个 / 批量删除均弹出统一风格确认弹窗，红色警示「不可恢复」 |
| 逐个执行 | 不做批量语义请求（body 一次只替换一个 ID），避免批量端点语义差异导致误删 |
| 限速 | 每 5 个请求暂停 800ms |
| 失败隔离 | 单个失败记录到日志并继续，批次结束时汇报成功 / 失败数 |
| 全程日志 | 开始（含模板 url/method，warn 级）/ 每个结果 / 结束汇总均打点 |

##### 局限与风险

- 模板依赖一次真实删除操作，首次使用前需用户配合（popup 有明确引导）；
- 若 DeepSeek 未来变更删除端点或 body 结构，已学模板可能失效——重放失败会逐个报错，
  用户重新手动删除一次即可重新学习；
- 模板与账号无关（仅含请求形态），但 Token 每次重放时实时取页面当前值，不做持久化。

该模式可推广到任何「无文档 + 不可逆 + 难以静态逆向」的私有 API 场景：
**观察一次真实交互 → 捕获请求形态 → 参数化重放**。

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
- **icons 必须使用 PNG**：Chromium 的 manifest icons 不支持 SVG，SVG 会显示为字母占位符。

### 4.5.1 运行日志系统

排查问题的自助手段，避免每次口述复现步骤：

- `utils/logger.ts`：`createLocalLogger(scope, forward)` —— 内存环形缓冲（500 条）+
  控制台输出 + 可选转发 SW（content script 开启转发）。
- `utils/log-store.ts`（SW 端）：汇总自身与 content 转发的日志，节流（500ms）持久化到
  `chrome.storage.local`（上限 1000 条），SW 冷启动时恢复，日志不因 SW 休眠丢失。
- 消息契约：`LOG_ENTRY`（content → SW 单条上报）、`GET_LOGS`（popup 拉取汇总）、
  `CLEAR_LOGS`（清空）。
- popup「运行日志」面板：刷新 / 下载（.log 文件）/ 拷贝 / 清空，用户可直接把日志发给维护者；
  日志文本头部携带 `扩展版本 · 导出时间 · 条数`（SW 启动与安装/更新日志也记录版本号，
  便于确认用户实际安装的版本）。
- 打点位置：content（init、hook 确认、各类捕获、代理请求、路由变化）、
  SW（消息路由、导出各阶段、分页明细、失败明细）。

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

### 4.6 本地预览与验证（mock chrome）

popup 的数据全部经 `chrome.runtime.sendMessage` 获取，脱离扩展环境直接打开产物只会白屏，
导致「改一行 UI 就得重装扩展 + 登录」的验证成本过高。为此仓库内置预览工具：

```
cd extension
pnpm build && pnpm preview     # 默认 http://127.0.0.1:8934/
```

`scripts/preview.mjs` 的流程：

1. 复制 `dist/` 到 `.preview/`（每次启动重建，避免残留旧产物造成「改了没生效」的错觉）
2. 依 `scripts/preview-data.json` 生成 `.preview/mock-chrome.js`，**只**伪造 popup 实际调用的
   `runtime.getManifest` / `runtime.sendMessage` / `runtime.onMessage` /
   `i18n.getUILanguage` / `storage.local`，不额外放权——新增对未声明 API 的依赖仍会立刻报错，
   而不是被 mock 掩盖
3. 在 `popup.html` 的 module 脚本**之前**注入 mock，否则挂载时 `chrome` 尚不存在
4. Node 内置 http 提供静态服务（`file://` 会被 CORS 拦住），根路径 302 到 popup 页面

预览数据用「距今 N 天」（`updatedDaysAgo`）描述会话，日期分组表头不会随时间推移错位；
`lang` 决定首屏语言，便于直接查看中 / 英两套界面。导出、删除类消息不做模拟，仅打日志。

**边界**：该工具覆盖纯前端路径（渲染、分组折叠、标签页切换、语言切换、空态 / 错误态文案）。
`chrome.*` 的真实行为——SW 生命周期与休眠、`storage` 持久化、content script 是否注入成功、
真实登录态与限速——仍必须在 Chrome 中加载 `dist/` 验收。

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
| `GET_STATUS` | popup → SW → content | 连接状态 / 捕获统计 / 导出进度（SW 权威源合并）/ deleteTemplateReady / sessionCacheCount |
| `EXPORT_CURRENT` | popup → SW → content | 导出当前会话 |
| `EXPORT_ALL` | popup → SW → content | 取导出请求模板（供 SW 编排复用） |
| `LOAD_SESSIONS` | popup → SW | 加载全部会话列表（keyset 翻页 + 缓存） |
| `EXPORT_SELECTED` | popup → SW | 批量导出勾选的会话 |
| `DELETE_SESSIONS` | popup → SW | 批量删除勾选的会话（学习式重放） |
| `DELETE_REQUEST_CAPTURED` | content → SW | 上报捕获的删除请求（学习删除接口模板） |
| `EXPORT_PROGRESS` | SW → popup | 批量导出/删除进度（0-100 + N/总数 + 标题） |
| `LIST_PROGRESS` | SW → popup | 会话列表加载进度（已加载数） |
| `PAGE_CHANGED` | content → SW | 路由变化通知 |
| `SESSION_LIST` / `HISTORY_MESSAGES` / `SSE_COMPLETE` / `AUTH_TOKEN` / `API_URL` / `API_REQUEST` | content → SW | hook 捕获上报 |
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
| 未登录 / 登录过期 | 代理请求识别 401/403 或 HTML 响应 + Token 缺失，提示"请先登录 chat.deepseek.com" |
| 无活跃 DeepSeek 标签页 | 导出请求返回明确错误信息 |
| API 请求失败（FETCH_PROXY 报错） | 单会话导出失败展示错误；批量导出跳过该会话继续；批量删除单个失败不中断 |
| API 结构变更（如 next_cursor 字段变更） | 解析失败给出明确错误，不静默吞掉 |
| 会话数据为空 | 跳过该会话 |
| 防御性上限 | 会话列表翻页最多 200 页 + 三重终止（空页/无新会话/缺游标字段），避免异常响应死循环 |

### 7.2 查看器端

| 场景 | 处理方式 |
|------|----------|
| JSON 格式错误 | 显示解析错误详情（缺 export_meta / conversations 非数组等） |
| 无效时间戳 | 格式化返回空串，不抛错 |
| Markdown 渲染失败 | 回退为纯文本转义输出 |
| 空数据 | 显示空状态引导提示 |

---

## 8. 安全考量

- **零外联**：所有请求由用户浏览器发起，仅调用 DeepSeek 官方页面自身使用的 API，不向第三方发送数据。
- **Token 安全**：Bearer Token 仅存于内存（content script 变量），不持久化到 `chrome.storage`。
- **删除操作**：唯一的写操作；端点不硬编码，由用户手动删除一次"学习"而来；
  仅用户在 popup 勾选并经过自定义弹窗二次确认后才执行，逐个重放页面真实请求形态。
- **查看器纯前端**：JSON 文件通过 FileReader 本地读取，不上传任何服务器。
- **导出数据隐私**：`.tmp/`（调试导出文件）不入 git，已在各级 `.gitignore` 声明。
- **Markdown 渲染**：`markdown-it` 关闭原始 HTML；外链强制 `noopener noreferrer`。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| DeepSeek API 结构变更 | 扩展无法正确解析数据 | 数据校验 + 明确错误提示（见 §7.1）；正文/列表均多级容错提取 |
| DeepSeek 反爬/风控 | 批量导出/删除被限制 | 限速策略（800ms/5 请求 + 翻页间隔），删除逐个重放真实请求形态 |
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
- [x] 会话管理器（列表 / 全选 / 批量导出 / 批量删除）— v1.0.12 已实现
- [x] 全量导出突破 100 条限制（keyset 翻页）— v1.0.12 已实现
- [x] 会话列表区分置顶会话（置顶徽标 + 置顶优先排序）— v1.0.15 已实现
