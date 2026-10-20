/**
 * 文件加载组件：支持拖拽 / 点击选择（可多选合并导入）。
 */

import { signal } from 'plain';
import { loadFiles, loading, loadError } from '../state';

export function FileLoader() {
  const dragOver = signal(false);
  let fileInput: HTMLInputElement | null = null;

  /**
   * 处理选择的文件并触发导入。
   */
  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    loadFiles(Array.from(files));
  }

  return (
    <div class="loader">
      <div class="loader-inner">
        <h1>DeepSeek Chat Viewer</h1>
        <div class="sub">导入 DeepSeek Chat Exporter 导出的 JSON 文件，离线浏览聊天记录</div>

        <div
          class={dragOver() ? 'dropzone dragover' : 'dropzone'}
          onClick={() => fileInput?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            dragOver.set(true);
          }}
          onDragLeave={() => dragOver.set(false)}
          onDrop={(e) => {
            e.preventDefault();
            dragOver.set(false);
            handleFiles(e.dataTransfer?.files || null);
          }}
        >
          <div class="big">📂</div>
          <div>拖拽 JSON 文件到此处，或点击选择文件</div>
          <div class="hint">支持多选，多个文件将自动按会话 ID 合并</div>
        </div>

        <input
          type="file"
          accept=".json,application/json"
          multiple
          onChange={(e) => handleFiles(e.target.files)}
          ref={(el) => {
            fileInput = el;
          }}
        />

        {loadError() ? <div class="load-error">{loadError()}</div> : null}
        {loading() ? <div class="load-loading">正在加载…</div> : null}
      </div>
    </div>
  );
}
