# deepseek-chat-exporter

DeepSeek 网页版（chat.deepseek.com）聊天记录导出与离线查看工具，包含两个子项目：

| 子项目 | 目录 | 技术栈 | 说明 |
|--------|------|--------|------|
| Chrome 扩展（导出端） | `extension/` | Manifest V3 + TypeScript + plain + esbuild | 拦截 DeepSeek API 响应，将聊天记录导出为结构化 JSON |
| 查看器（展示端） | `viewer/` | [plain-framework](https://benoly520.github.io/plain-framework/) + markdown-it + highlight.js | 导入导出的 JSON，以气泡对话形式离线浏览 |

> 软件设计文档（SDD）见 [doc/deepseek-chat-exporter_sdd.md](doc/deepseek-chat-exporter_sdd.md)，已随当前实现修订（v1.2.0）。

## 功能列表

### Chrome 扩展（导出端）

- **会话管理器**：打开 popup 自动分页加载**全部**会话列表（keyset 翻页，不受单页数量限制），每行显示编号 / 标题 / 日期，支持全选 / 单选
- **导出当前会话**：导出正在浏览的对话
- **批量导出选中**：勾选的会话合并导出为一个 JSON，实时进度（N/总数 + 标题 + 百分比）
- **批量删除会话**：学习式捕获删除接口（页面手动删除一次即学会），自定义弹窗二次确认，限速逐个重放
- **正文容错提取**：多级探测（顶层字段 / 片段数组 / 深度扫描），兼容 v0 API 的嵌套消息结构，保留思考过程（thinking）
- **运行日志**：content/SW 日志汇总持久化（SW 休眠不丢），可拉取 / 下载 / 拷贝 / 清空，日志头带扩展版本号
- **诊断面板**：API 捕获诊断（最近 /api/ 请求 URL）与日志面板统一可折叠卡片
- **状态可见**：popup 显示扩展版本号、连接状态、删除接口学习状态
- **友好错误**：未登录 / 登录过期、页面未刷新（未连接）、无活跃标签页等场景均有明确提示
- **防风控限速**：每 5 个请求暂停 800ms、翻页间隔 300ms，删除逐个执行

### 查看器（展示端）

- **导入**：拖拽 / 点击多选，多文件按会话 id 合并去重
- **浏览**：气泡对话布局，会话侧栏（按更新时间倒序）
- **渲染**：Markdown（代码高亮 / 表格 / 引用）+ 思考过程折叠块
- **搜索**：标题与消息内容全文匹配过滤
- **离线安全**：纯前端本地解析，零上传

## 目录结构

```
deepseek-chat-exporter/
├── doc/                # 设计文档（SDD）
├── extension/          # Chrome 扩展
│   ├── manifest.json   # MV3 清单
│   ├── build.js        # 构建脚本（Vite 构建 popup + esbuild 构建 content/background）
│   ├── icons/
│   └── src/
│       ├── popup/      # 点击扩展图标弹出的 UI（plain / TSX）
│       ├── content/    # content script：fetch hook 注入、路由监听、API 代理
│       ├── background/ # service worker：导出编排（分页 + 限速）
│       ├── types/
│       └── utils/
└── viewer/             # 查看器（plain-framework）
    ├── index.html
    └── src/
        ├── components/ # FileLoader / ConversationList / ChatView
        ├── utils/      # json-parser / date-format / markdown
        ├── state.ts    # 模块级 signal 状态
        └── App.tsx
```

## Chrome 扩展使用

### 构建

```bash
cd extension
pnpm install
pnpm build
```

### 安装

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/dist` 目录

### 导出与会话管理

1. 打开 [chat.deepseek.com](https://chat.deepseek.com) 并登录（若扩展是后装的，先刷新一次页面）
2. 点击扩展图标，popup 即为会话管理器：
   - 自动分页加载**全部**会话列表（keyset 翻页，不受单页数量限制），每行显示编号 / 标题 / 日期
   - **导出当前会话**：导出正在浏览的对话
   - **导出选中**：默认全选，勾选后合并导出为一个 JSON（限速：每 5 个请求暂停 800ms，进度实时显示）
   - **删除选中**：批量删除（学习式，见下），需自定义弹窗二次确认，不可恢复

### 批量删除（学习式）

删除接口由 DeepSeek 页面内部使用、无文档且不可逆，扩展不硬编码：
先在页面上**手动删除任意一个会话**，扩展会自动捕获这条真实请求作为模板（持久化保存），
之后即可在 popup 中勾选批量删除。popup 顶部的「删除接口」状态会显示是否已学习。

## 查看器使用

```bash
cd viewer
pnpm install
pnpm dev         # 开发：http://localhost:5180
pnpm build       # 构建产物在 viewer/dist
```

打开页面后，把扩展导出的 JSON 拖入（或点击选择，支持多选合并），即可按会话浏览、搜索、渲染 Markdown 与思考过程。

> 两个子项目的 `plain` 依赖均通过 `link:` 指向本地 `plain-framework` 仓库
> （见各自 `package.json`，[文档地址](https://benoly520.github.io/plain-framework/)），
> 使用前请确保该仓库已执行过 `pnpm install && pnpm run build`。两端均使用 pnpm 安装依赖。

## 导出 JSON 格式

```json
{
  "export_meta": {
    "exporter": "deepseek-chat-exporter",
    "version": "1.0.0",
    "exported_at": "2026-10-20T08:30:00.000Z",
    "source": "chat.deepseek.com"
  },
  "conversations": [
    {
      "id": "5a298e61-4fd4-455b-9aaf-7c6142d727a0",
      "title": "会话标题",
      "model": "deepseek-chat",
      "created_at": "...",
      "updated_at": "...",
      "messages": [
        { "role": "user", "content": "...", "created_at": "..." },
        { "role": "assistant", "content": "...", "thinking": "...", "created_at": "..." }
      ]
    }
  ]
}
```

## 安全说明

- 所有请求均由用户浏览器发起，仅调用 DeepSeek 页面自身使用的 API，不上传任何数据到第三方
- 唯一的写操作是「删除会话」：仅用户明确勾选并二次确认后执行，逐个重放页面真实请求形态
- 查看器为纯前端应用，JSON 文件仅在本地解析
