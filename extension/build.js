#!/usr/bin/env node
/**
 * DeepSeek Chat Exporter 扩展构建脚本。
 *
 * 步骤：
 * 1. Vite 构建 popup UI（popup.html 作为入口，脚本路径 / CSS 自动注入）
 * 2. esbuild 构建 content scripts 与 service worker
 * 3. 拷贝 manifest.json / icons 到 dist
 */
import { execSync } from 'child_process';
import { cpSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname);

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

// 步骤 1：Vite 构建 popup（Vue 3 应用）
console.log('\n=== Step 1: Building popup UI with Vite ===');
run('npx vite build');

// 步骤 2：esbuild 构建 content scripts 与 service worker
console.log('\n=== Step 2: Building content scripts & service worker ===');

// Content script（IIFE，注入页面隔离环境）
run(`npx esbuild src/content/index.ts --bundle --outfile=dist/content/index.js --format=iife --target=chrome100 --minify=false`);

// Fetch hook（IIFE，注入页面 MAIN world）
run(`npx esbuild src/content/fetch-hook.ts --bundle --outfile=dist/content/fetch-hook.js --format=iife --target=chrome100 --minify=false`);

// Service worker（ESM，Manifest V3 要求）
run(`npx esbuild src/background/service-worker.ts --bundle --outfile=dist/background/service-worker.js --format=esm --target=chrome100 --minify=false --external:chrome`);

// 步骤 3：拷贝静态文件
console.log('\n=== Step 3: Copying static files ===');
cpSync(resolve(root, 'manifest.json'), resolve(root, 'dist/manifest.json'));
cpSync(resolve(root, 'icons'), resolve(root, 'dist/icons'), { recursive: true });

console.log('\n=== Build complete! ===');
console.log('Load the extension from dist/ directory in chrome://extensions');
