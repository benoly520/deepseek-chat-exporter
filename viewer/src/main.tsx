/**
 * DeepSeek Chat Viewer 入口。
 */

import { mount } from 'plain';
import { App } from './App';
import { initLang } from './i18n';

// 先同步 <html lang>，再挂载，保证声明语言与界面语言一致
initLang();
mount('#app', App());
