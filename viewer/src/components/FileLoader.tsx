/**
 * 文件加载组件：支持拖拽 / 点击选择（可多选合并导入）。
 */

import { signal } from 'plain';
import { loadFiles, loading, loadError } from '../state';
import { LangSwitch } from './LangSwitch';
import { t } from '../i18n';

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
      <LangSwitch />
      <div class="loader-inner">
        <h1>DeepSeek Chat Viewer</h1>
        <div class="sub">{t('loader.subtitle')}</div>

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
          <div>{t('loader.dropHint')}</div>
          <div class="hint">{t('loader.multiHint')}</div>
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

        {loadError() ? (
          <div class="load-error">{t(loadError()?.key ?? '', loadError()?.vars)}</div>
        ) : null}
        {loading() ? <div class="load-loading">{t('loader.loading')}</div> : null}
      </div>
    </div>
  );
}
