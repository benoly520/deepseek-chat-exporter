/**
 * Markdown 渲染工具（markdown-it + highlight.js）。
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';

/**
 * HTML 转义工具（避免 md 实例自引用导致的类型循环）。
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const md: MarkdownIt = new MarkdownIt({
  // 禁用原始 HTML，防止 XSS
  html: false,
  linkify: true,
  // 聊天内容单换行即换行
  breaks: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          `<pre class="hljs"><code>` +
          hljs.highlight(code, { language: lang, ignoreIllegals: true }).value +
          `</code></pre>`
        );
      } catch (error) {
        // 高亮失败时退回转义输出
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  },
});

// markdown-it v14 类型未导出命名空间，这里手写渲染规则的最小类型
type RenderRule = (tokens: any[], idx: number, options: any, env: any, self: any) => string;

// 外链统一加 target="_blank" + rel="noopener noreferrer"
const defaultLinkOpen: RenderRule =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

const linkOpenRule: RenderRule = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.link_open = linkOpenRule;

/**
 * 渲染 Markdown 文本为 HTML，失败时回退为纯文本转义。
 */
export function renderMarkdown(content: string): string {
  try {
    return md.render(content || '');
  } catch (error) {
    console.error('Markdown render failed:', error);
    return escapeHtml(content || '');
  }
}
