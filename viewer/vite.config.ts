import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 通过依赖包名引用框架（package.json 的 "plain": "link:<框架路径>"），
// 不要直接 import 框架源码/构建产物路径。
import plain from 'plain/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [plain({ root: here })],
  server: { port: 5180 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
