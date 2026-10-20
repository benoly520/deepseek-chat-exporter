/**
 * Popup 入口（plain 实现）。
 */

import { mount } from 'plain';
import { App } from './App';
import { createLocalLogger } from '../utils/logger';

// popup 自身日志（转发 SW 持久化）
const logger = createLocalLogger('popup', true);

// popup 未捕获异常记入日志（与 chrome://extensions 错误页同类信息）
window.addEventListener('error', (e) => {
  logger.error('未捕获异常', {
    msg: e.message,
    file: (e.filename || '').split('/').pop() || '',
    line: e.lineno,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason =
    e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack || ''}` : String(e.reason);
  logger.error('未处理的 Promise rejection', reason.slice(0, 1000));
});

mount('#app', App());
