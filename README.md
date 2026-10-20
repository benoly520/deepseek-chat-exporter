# deepseek-chat-exporter

DeepSeek 网页版（chat.deepseek.com）聊天记录导出与离线查看工具，包含两个子项目：

| 子项目 | 目录 | 技术栈 | 说明 |
|--------|------|--------|------|
| Chrome 扩展（导出端） | `extension/` | Manifest V3 + TypeScript + plain + esbuild | 拦截 DeepSeek API 响应，将聊天记录导出为结构化 JSON |
| 查看器（展示端） | `viewer/` | [plain-framework](https://benoly520.github.io/plain-framework/) + markdown-it + highlight.js | 导入导出的 JSON，以气泡对话形式离线浏览 |

> 软件设计文档（SDD）见 [doc/deepseek-chat-exporter_sdd.md](doc/deepseek-chat-exporter_sdd.md)，已随当前实现修订（v1.1.1）。

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

### 导出

1. 打开 [chat.deepseek.com](https://chat.deepseek.com) 并登录（若扩展是后装的，先刷新一次页面）
2. 点击扩展图标：
   - **导出当前会话**：导出正在浏览的对话
   - **批量导出全部**：分页拉取全部会话与完整历史，合并为一个 JSON（每 5 个请求限速 800ms）

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

- 所有请求均由用户浏览器发起，仅调用只读 API，不上传任何数据到第三方
- 查看器为纯前端应用，JSON 文件仅在本地解析
