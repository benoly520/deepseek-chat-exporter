/**
 * Popup 主界面（plain 实现）。
 * 状态：与 background 轮询同步的连接状态 / 导出进度 / 提示消息 / 运行日志。
 */

import { signal, computed, resolve } from 'plain';
import type { StatusPayload, ExtensionMessage } from '../types';
import { formatAll } from '../utils/logger';
import type { LogEntry } from '../utils/logger';

// --- 状态 ---

/** 来自 background 的状态（每 2 秒轮询刷新） */
const status = signal<StatusPayload>({
  connected: false,
  currentSessionId: null,
  capturedSessions: 0,
  capturedMessages: 0,
  exporting: false,
  exportProgress: 0,
});

/** 提示消息 */
const message = signal('');
/** 提示消息是否为错误 */
const isError = signal(false);

/** 汇总日志文本（从 service worker 拉取） */
const logsText = signal('');

/** 进度区标题：批量导出显示 N/总数 + 会话标题，单会话导出显示百分比 */
const progressTitle = computed(() => {
  const cur = status().exportCurrent;
  if (cur && cur.total > 0) {
    return `正在导出 ${cur.index}/${cur.total}：${cur.title}`;
  }
  return `导出中… ${status().exportProgress}%`;
});

// 进度监听只注册一次（popup 打开期间始终监听，不只在导出点击后）
let progressListenerAdded = false;

/**
 * 注册批量导出进度监听（幂等）。
 */
function ensureProgressListener() {
  if (progressListenerAdded) return;
  progressListenerAdded = true;
  chrome.runtime.onMessage.addListener((msg: ExtensionMessage) => {
    if (msg.type === 'EXPORT_PROGRESS') {
      const payload = msg.payload as
        | { progress: number; current?: number; total?: number; title?: string }
        | undefined;
      if (payload) {
        const s = status.peek();
        status.set({
          ...s,
          exporting: true,
          exportProgress: payload.progress,
          exportCurrent: {
            index: payload.current ?? 0,
            total: payload.total ?? 0,
            title: payload.title ?? '',
          },
        });
      }
    }
  });
}

/**
 * 从 background 获取当前状态。
 */
async function fetchStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    // 无响应（如 service worker 刚被唤醒）时保持默认状态
    if (response) {
      status.set(response);
    }
  } catch (error) {
    console.error('Failed to fetch status:', error);
  }
}

/**
 * 设置提示消息。
 */
function showMessage(text: string, error: boolean) {
  message.set(text);
  isError.set(error);
}

/**
 * 从 service worker 拉取汇总日志。
 */
async function loadLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    if (response?.error) {
      logsText.set(`日志拉取失败: ${response.error}`);
    } else {
      const entries = (response?.entries || []) as LogEntry[];
      logsText.set(entries.length > 0 ? formatAll(entries) : '暂无日志');
    }
  } catch (error) {
    logsText.set(`日志拉取失败: ${String(error)}`);
  }
}

/**
 * 下载日志文件。
 */
async function downloadLogs() {
  try {
    const text = logsText();
    if (!text || text === '暂无日志') {
      await loadLogs();
    }
    const blob = new Blob([logsText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deepseek-exporter-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    showMessage(`日志下载失败: ${String(error)}`, true);
  }
}

/**
 * 拷贝日志到剪贴板。
 */
async function copyLogs() {
  try {
    if (!logsText() || logsText() === '暂无日志') {
      await loadLogs();
    }
    await navigator.clipboard.writeText(logsText());
    showMessage('日志已拷贝到剪贴板', false);
  } catch (error) {
    showMessage(`日志拷贝失败: ${String(error)}`, true);
  }
}

/**
 * 清空汇总日志。
 */
async function clearLogs() {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
    logsText.set('暂无日志');
    showMessage('日志已清空', false);
  } catch (error) {
    showMessage(`日志清空失败: ${String(error)}`, true);
  }
}

/**
 * 导出当前会话。
 */
async function exportCurrent() {
  showMessage('', false);

  try {
    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_CURRENT' });

    if (!response) {
      throw new Error('无响应，请刷新页面后重试');
    }
    if (response.error) {
      showMessage(`导出失败: ${response.error}`, true);
    } else {
      showMessage(`导出成功: ${response.filename}`, false);
    }
  } catch (error) {
    showMessage(`导出失败: ${String(error)}`, true);
  } finally {
    const s = status.peek();
    status.set({ ...s, exporting: false, exportProgress: 0 });
  }
}

/**
 * 批量导出全部会话。
 */
async function exportAll() {
  showMessage('', false);

  try {
    ensureProgressListener();

    const response = await chrome.runtime.sendMessage({ type: 'EXPORT_ALL' });

    if (!response) {
      throw new Error('无响应，请刷新页面后重试');
    }
    if (response.error) {
      showMessage(`导出失败: ${response.error}`, true);
    } else {
      showMessage(`导出成功: ${response.filename} (${response.count} 个会话)`, false);
    }
  } catch (error) {
    showMessage(`导出失败: ${String(error)}`, true);
  } finally {
    const s = status.peek();
    status.set({ ...s, exporting: false, exportProgress: 0, exportCurrent: null });
  }
}

/**
 * 信息行。
 */
function InfoItem(props: { label: string; value: string }) {
  const value = () => resolve(props.value);
  return (
    <div class="info-item">
      <span class="label">{resolve(props.label)}</span>
      <span class="value">{value()}</span>
    </div>
  );
}

/**
 * 日志面板。
 */
function LogsPanel() {
  return (
    <details
      class="logs"
      ref={(el) => {
        // 首次展开时拉取日志
        const handler = () => {
          if ((el as HTMLDetailsElement).open) {
            loadLogs();
          }
        };
        el.addEventListener('toggle', handler);
        return () => el.removeEventListener('toggle', handler);
      }}
    >
      <summary>运行日志（排查问题用）</summary>
      <div class="logs-actions">
        <button class="log-btn" onClick={loadLogs}>刷新</button>
        <button class="log-btn" onClick={downloadLogs}>下载日志</button>
        <button class="log-btn" onClick={copyLogs}>拷贝</button>
        <button class="log-btn" onClick={clearLogs}>清空</button>
      </div>
      <pre class="logs-view">{logsText() || '点「刷新」加载日志'}</pre>
    </details>
  );
}

/**
 * Popup 根组件。
 */
export function App() {
  const s = status;

  return (
    <div
      class="popup"
      ref={() => {
        // 注册进度监听 + 轮询状态；返回清理函数，popup 关闭时停止定时器
        ensureProgressListener();
        fetchStatus();
        const timer = setInterval(fetchStatus, 2000);
        return () => {
          clearInterval(timer);
        };
      }}
    >
      <div class="header">
        <h1>DeepSeek Exporter</h1>
        <div class={s().connected ? 'status connected' : 'status'}>
          {s().connected ? '已连接' : '未连接'}
        </div>
      </div>

      <div class="info">
        <InfoItem label="当前会话 ID:" value={s().currentSessionId || '无'} />
        <InfoItem label="已捕获会话数:" value={String(s().capturedSessions)} />
        <InfoItem label="已捕获消息数:" value={String(s().capturedMessages)} />
      </div>

      {s().connected ? null : (
        <div class="tip">
          未连接时请刷新 DeepSeek 页面后重试
          {s().swError ? <div class="tip-detail">原因: {s().swError}</div> : null}
        </div>
      )}

      <div class="actions">
        <button
          class="btn btn-primary"
          disabled={!s().connected || !s().currentSessionId || s().exporting}
          onClick={exportCurrent}
        >
          导出当前会话
        </button>

        <button
          class="btn btn-secondary"
          disabled={!s().connected || s().exporting}
          onClick={exportAll}
        >
          批量导出全部
        </button>
      </div>

      {s().exporting ? (
        <div class="progress">
          <div class="progress-title">{progressTitle()}</div>
          <div class="progress-bar">
            <div class="progress-fill" style={`width:${s().exportProgress}%`} />
          </div>
          <div class="progress-hint">耗时操作，请保持 DeepSeek 页面开启</div>
        </div>
      ) : null}

      {message() ? (
        <div class={isError() ? 'message error' : 'message'}>{message()}</div>
      ) : null}

      {s().recentApiUrls && s().recentApiUrls!.length > 0 ? (
        <details class="debug">
          <summary>API 捕获诊断 ({s().recentApiUrls!.length})</summary>
          <ul>
            {s().recentApiUrls!.map((u) => (
              <li>{u}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <LogsPanel />
    </div>
  );
}
