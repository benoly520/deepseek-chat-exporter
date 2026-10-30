#!/usr/bin/env node
/**
 * Popup 本地预览：不装扩展、不登录 DeepSeek，直接在浏览器里渲染真实的 popup 产物。
 *
 * 用途：改完 UI 后快速看效果、验证交互（折叠 / 切标签页 / 切语言），
 * 或为 README 截图。渲染的是 dist/ 里的真实构建产物，只是把 chrome.* 换成假数据。
 *
 * 步骤：
 * 1. 把 dist/ 复制到 .preview/（构建产物，已被 .gitignore 忽略）
 * 2. 按 scripts/preview-data.json 生成 .preview/mock-chrome.js（伪造 chrome.* 接口）
 * 3. 在 .preview/src/popup/popup.html 中先于 popup 自身脚本注入 mock
 * 4. 用 Node 内置 http 起静态服务（必须走 HTTP，file:// 下会被 CORS 拦住）
 *
 * 用法：
 *   pnpm preview              # 默认端口 8934
 *   pnpm preview --port 9000  # 指定端口
 */
import { spawn } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { dirname, extname, join, normalize, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = join(root, 'dist');
const previewDir = join(root, '.preview');
const dataPath = join(__dirname, 'preview-data.json');
const manifestPath = join(root, 'manifest.json');

/** 静态资源 MIME 映射（只覆盖 popup 可能用到的类型） */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/** 解析命令行参数，目前只支持 --port */
function parseArgs(argv) {
  const portIndex = argv.indexOf('--port');
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : 8934;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    exitWith('端口不合法，示例：pnpm preview --port 9000');
  }
  return { port };
}

/** 打印错误并退出 */
function exitWith(message) {
  console.error(`\n[preview] ${message}\n`);
  process.exit(1);
}

/**
 * 读取预览数据与扩展版本号。
 * 版本号优先取 manifest.json，保证截图 / 调试看到的版本与实际构建一致。
 */
function loadConfig() {
  if (!existsSync(dataPath)) {
    exitWith(`找不到 ${dataPath}，请确认 scripts/preview-data.json 存在`);
  }
  try {
    const data = JSON.parse(readFileSync(dataPath, 'utf-8'));
    const { version } = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return { data, version };
  } catch (error) {
    exitWith(`配置读取失败：${error.message}`);
  }
}

/**
 * 生成 mock-chrome.js：把 popup 用到的 chrome.* 接口换成假实现。
 *
 * 只覆盖 popup 实际调用的四个入口：runtime.getManifest / runtime.sendMessage /
 * runtime.onMessage / i18n.getUILanguage / storage.local，多一个都不伪造，
 * 避免掩盖「代码误用了未声明的权限」这类问题。
 */
function buildMockScript(data, version) {
  // 会话按「距今 N 天」描述，避免每次改配置都要换算时间戳
  const sessions = (data.sessions || []).map((s, i) => ({
    id: s.id || `preview-${i + 1}`,
    title: s.title || `Session ${i + 1}`,
    model: s.model || 'deepseek-chat',
    createdDaysAgo: s.createdDaysAgo ?? s.updatedDaysAgo ?? 0,
    updatedDaysAgo: s.updatedDaysAgo ?? 0,
    pinned: s.pinned === true,
  }));

  const payload = {
    version,
    lang: data.lang === 'zh' ? 'zh' : 'en',
    connected: data.connected === true,
    deleteTemplateReady: data.deleteTemplateReady === true,
    currentSessionId: data.currentSessionId || null,
    recentApiUrls: data.recentApiUrls || [],
    sessions,
  };

  return `/* 由 scripts/preview.mjs 自动生成，请勿手改；改数据请编辑 scripts/preview-data.json */
(function () {
  var DATA = ${JSON.stringify(payload, null, 2)};
  var DAY = 86400000;
  var now = Date.now();

  function toSeconds(daysAgo) {
    return Math.floor((now - daysAgo * DAY) / 1000);
  }

  var sessions = DATA.sessions.map(function (s) {
    return {
      id: s.id,
      title: s.title,
      model: s.model,
      created_at: toSeconds(s.createdDaysAgo),
      updated_at: toSeconds(s.updatedDaysAgo),
      pinned: s.pinned,
    };
  });

  var status = {
    connected: DATA.connected,
    currentSessionId: DATA.currentSessionId,
    capturedSessions: sessions.length,
    capturedMessages: sessions.length,
    exporting: false,
    exportProgress: 0,
    exportCurrent: null,
    deleteTemplateReady: DATA.deleteTemplateReady,
    sessionCacheCount: sessions.length,
    recentApiUrls: DATA.recentApiUrls
  };

  // 语言偏好走内存，set 之后会生效到下一次 loadLang
  var stored = { ui_lang: DATA.lang };

  window.chrome = {
    runtime: {
      getManifest: function () {
        return { version: DATA.version };
      },
      sendMessage: function (message) {
        var type = message && message.type;
        if (type === 'GET_STATUS') return Promise.resolve(status);
        if (type === 'LOAD_SESSIONS') return Promise.resolve({ sessions: sessions });
        if (type === 'GET_LOGS') return Promise.resolve({ entries: [] });
        // 导出 / 删除类消息在预览里只打日志，不做真实动作
        if (type) console.info('[preview] 未模拟的消息：' + type);
        return Promise.resolve({});
      },
      onMessage: {
        addListener: function () {},
        removeListener: function () {},
      },
    },
    i18n: {
      getUILanguage: function () {
        return DATA.lang === 'zh' ? 'zh-CN' : 'en-US';
      },
    },
    storage: {
      local: {
        get: function (key) {
          if (typeof key === 'string') {
            return Promise.resolve(Object.prototype.hasOwnProperty.call(stored, key)
              ? (function () { var r = {}; r[key] = stored[key]; return r; })()
              : {});
          }
          return Promise.resolve(Object.assign({}, stored));
        },
        set: function (obj) {
          Object.assign(stored, obj);
          return Promise.resolve();
        },
      },
    },
  };

  console.info('[preview] mock chrome 就绪：v' + DATA.version + '，' + sessions.length + ' 条会话，语言 ' + DATA.lang);
})();
`;
}

/**
 * 准备 .preview 目录：复制产物 + 写入 mock + 注入脚本标签。
 * 每次启动都重建，避免残留上次的旧产物导致「改了没生效」的错觉。
 */
function preparePreview() {
  if (!existsSync(distDir)) {
    exitWith('找不到 dist/，请先执行 pnpm build');
  }

  rmSync(previewDir, { recursive: true, force: true });
  mkdirSync(previewDir, { recursive: true });
  cpSync(distDir, previewDir, { recursive: true });

  const { data, version } = loadConfig();
  writeFileSync(join(previewDir, 'mock-chrome.js'), buildMockScript(data, version), 'utf-8');

  // mock 必须排在 popup 的 module 脚本之前，否则挂载时 chrome 还不存在
  const popupHtml = join(previewDir, 'src', 'popup', 'popup.html');
  if (!existsSync(popupHtml)) {
    exitWith(`缺少 ${popupHtml}，构建产物结构可能已变化，请检查 vite.config.ts 的输出配置`);
  }
  const html = readFileSync(popupHtml, 'utf-8');
  const injected = html.replace(
    /<script type="module"/,
    '<script src="/mock-chrome.js"></script>\n  <script type="module"'
  );
  if (injected === html) {
    exitWith('popup.html 中找不到 <script type="module">，无法注入 mock');
  }
  writeFileSync(popupHtml, injected, 'utf-8');

  return { count: data.sessions ? data.sessions.length : 0 };
}

/** 校验请求路径不越出 .preview 目录 */
function resolveRequestPath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const target = join(previewDir, clean);
  if (target !== previewDir && !target.startsWith(previewDir + sep)) return null;
  return target;
}

/** 起静态服务 */
function startServer(port) {
  const server = createServer((req, res) => {
    try {
      const urlPath = (req.url || '/').split('?')[0];

      // 根路径直接跳到 popup，省去手敲长路径；favicon 静默跳过避免控制台报 404
      if (urlPath === '/' || urlPath === '') {
        res.writeHead(302, { Location: '/src/popup/popup.html' }).end();
        return;
      }
      if (urlPath === '/favicon.ico') {
        res.writeHead(204).end();
        return;
      }

      let target = resolveRequestPath(urlPath);
      if (!target) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = join(target, 'index.html');
      }
      if (!existsSync(target)) {
        res.writeHead(404).end(`Not found: ${urlPath}`);
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream' });
      res.end(readFileSync(target));
    } catch (error) {
      console.error('[preview] 请求处理失败：', error.message);
      res.writeHead(500).end('Internal error');
    }
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      exitWith(`端口 ${port} 已被占用，换一个：pnpm preview --port 9000`);
    }
    exitWith(`服务启动失败：${error.message}`);
  });

  return new Promise((done) => {
    server.listen(port, '127.0.0.1', () => done(server));
  });
}

/** 尝试用系统默认浏览器打开（失败不影响服务运行） */
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 无桌面环境时静默跳过，用户手动复制地址即可
  }
}

const { port } = parseArgs(process.argv.slice(2));
const { count } = preparePreview();
await startServer(port);

const url = `http://127.0.0.1:${port}/src/popup/popup.html`;
console.log('\n=== Popup 本地预览 ===');
console.log(`地址：${url}`);
console.log(`数据：scripts/preview-data.json（${count} 条会话）`);
console.log('改动预览数据或重新构建后，需重启本脚本才会生效');
console.log('按 Ctrl+C 退出\n');

if (process.argv.includes('--open')) openBrowser(url);

process.on('SIGINT', () => {
  console.log('\n[preview] 已停止');
  process.exit(0);
});
