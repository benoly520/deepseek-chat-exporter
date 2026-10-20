import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
// 通过依赖包名引用框架（package.json 的 "plain": "link:<框架路径>"），
// 不要直接 import 框架源码/构建产物路径。
import plain from 'plain/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

// popup.html 作为 Vite 入口：脚本路径与 CSS 链接都由 Vite 正确生成。
// Vue 插件换成 plain 插件，popup UI 改用 plain（TSX）实现。
export default defineConfig({
  // plain 插件从 vite 配置自动取 root；类型断言规避与 vite5 PluginOption 的签名差异
  plugins: [plain() as any],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
      },
      output: {
        entryFileNames: 'popup/main.js',
        chunkFileNames: 'popup/chunks/[name]-[hash].js',
        assetFileNames: 'popup/assets/[name]-[hash][extname]',
      },
    },
    minify: false,
  },
});
