/**
 * Popup 主界面（plain 实现）—— 会话管理器。
 * 功能：自动加载全部会话列表（keyset 分页）、勾选导出、批量删除（学习式）、运行日志。
 */

import { signal, computed, resolve } from 'plain';
import type { StatusPayload, ExtensionMessage, SessionSummary } from '../types';
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

/** 会话列表（popup 本地副本） */
const sessions = signal<SessionSummary[]>([]);
/** 勾选的会话 ID */
const selected = signal<Set<string>>(new Set());
/** 列表加载中 */
const listLoading = signal(false);
/** 列表加载进度（已加载条数，来自 SW 广播） */
const listLoaded = signal(0);

/** 汇总日志文本（从 service worker 拉取） */
const logsText = signal('');

/** 进度区标题：批量操作显示 N/总数 + 会话标题，单会话导出显示百分比 */
const progressTitle = computed(() => {
  const cur = status().exportCurrent;
  if (cur && cur.total > 0) {
    return `正在导出 ${cur.index}/${cur.total}：${cur.title}`;
  }
  return `导出中… ${status().exportProgress}%`;
});

/** 已选数量 */
const selectedCount = computed(() => selected().size);

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
 * 加载全部会话列表（SW 自动 keyset 分页 + 缓存）。
 */
async function loadList(force = false) {
  if (listLoading()) return;
  showMessage('', false);

  if (!force && sessions().length > 0) {
    return; // 已有列表，不重复加载
  }

  listLoading.set(true);
  listLoaded.set(0);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LOAD_SESSIONS' });
    if (response?.error) {
      showMessage(`加载会话列表失败: ${response.error}`, true);
      return;
    }
    const list = (response?.sessions || []) as SessionSummary[];
    sessions.set(list);
    // 默认全选（全量导出语义）
    selected.set(new Set(list.map((s) => s.id)));
    showMessage(`已加载 ${list.length} 个会话`, false);
  } catch (error) {
    showMessage(`加载会话列表失败: ${String(error)}`, true);
  } finally {
    listLoading.set(false);
  }
}

/**
 * 勾选 / 取消勾选一个会话。
 */
function toggleSelect(id: string, checked: boolean) {
  const next = new Set(selected.peek());
  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }
  selected.set(next);
}

/**
 * 全选 / 全不选。
 */
function toggleAll() {
  const list = sessions.peek();
  if (selected.peek().size === list.length) {
    selected.set(new Set());
  } else {
    selected.set(new Set(list.map((s) => s.id)));
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
    status.set({ ...s, exporting: false, exportProgress: 0, exportCurrent: null });
  }
}

/**
 * 导出选中的会话（全选 = 真正的全量导出）。
 */
async function exportSelected() {
  const ids = Array.from(selected.peek());
  if (ids.length === 0) {
    showMessage('请先勾选要导出的会话', true);
    return;
  }
  showMessage('', false);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EXPORT_SELECTED',
      payload: { sessionIds: ids },
    });

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
 * 批量删除选中的会话（需先学习删除接口，二次确认）。
 */
async function deleteSelected() {
  const ids = Array.from(selected.peek());
  if (ids.length === 0) {
    showMessage('请先勾选要删除的会话', true);
    return;
  }
  if (!status.peek().deleteTemplateReady) {
    showMessage(
      '删除接口尚未学习：请先在 DeepSeek 页面上手动删除任意一个会话，扩展会自动捕获该操作',
      true
    );
    return;
  }
  if (!window.confirm(`确认删除 ${ids.length} 个会话？此操作不可恢复！`)) {
    return;
  }
  showMessage('', false);

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DELETE_SESSIONS',
      payload: { sessionIds: ids },
    });

    if (!response) {
      throw new Error('无响应，请刷新页面后重试');
    }
    if (response.error) {
      showMessage(`删除失败: ${response.error}`, true);
    } else {
      showMessage(`删除完成: 成功 ${response.ok} 个，失败 ${response.failed} 个`, response.failed > 0);
      // 从本地列表移除已删除项
      const deleted = new Set(ids);
      sessions.set(sessions.peek().filter((s) => !deleted.has(s.id)));
      selected.set(new Set());
    }
  } catch (error) {
    showMessage(`删除失败: ${String(error)}`, true);
  } finally {
    const s = status.peek();
    status.set({ ...s, exporting: false, exportProgress: 0, exportCurrent: null });
  }
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

// 进度监听只注册一次（popup 打开期间始终监听，不只在操作后）
let progressListenerAdded = false;

/**
 * 注册进度 / 列表加载进度监听（幂等）。
 */
function ensureListeners() {
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
    } else if (msg.type === 'LIST_PROGRESS') {
      const payload = msg.payload as { loaded: number } | undefined;
      if (payload) {
        listLoaded.set(payload.loaded);
      }
    }
  });
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
 * 会话列表条目（勾选框 + 标题）。
 */
function SessionItem(props: { session: SessionSummary }) {
  const s = () => resolve(props.session);
  const checked = () => selected().has(s().id);

  return (
    <label class="session-item">
      <input
        type="checkbox"
        checked={checked()}
        onChange={(e) => toggleSelect(s().id, (e.target as HTMLInputElement).checked)}
      />
      <span class="session-title" title={s().title}>
        {s().title || 'Untitled'}
      </span>
    </label>
  );
}

/**
 * 会话列表面板。
 */
function SessionListPanel() {
  const list = sessions;
  const allChecked = computed(
    () => list().length > 0 && selected().size === list().length
  );

  return (
    <div class="panel">
      <div class="panel-toolbar">
        <label class="check-all">
          <input
            type="checkbox"
            checked={allChecked()}
            onChange={toggleAll}
          />
          全选
        </label>
        <span class="muted">
          已选 {selectedCount()} / {list().length}
        </span>
        <button class="mini-btn" onClick={() => loadList(true)}>
          刷新列表
        </button>
      </div>

      {listLoading() ? (
        <div class="list-loading">
          正在加载会话列表… 已加载 {listLoaded()} 条
        </div>
      ) : list().length === 0 ? (
        <div class="list-loading">点击「刷新列表」加载会话</div>
      ) : (
        <div class="session-list">
          {list().map((s) => (
            <SessionItem session={s} />
          ))}
        </div>
      )}
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
        // 注册监听 + 自动加载列表 + 轮询状态；popup 关闭时停止定时器
        ensureListeners();
        fetchStatus();
        loadList();
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

      {s().connected ? null : (
        <div class="tip">
          未连接时请刷新 DeepSeek 页面后重试
          {s().swError ? <div class="tip-detail">原因: {s().swError}</div> : null}
        </div>
      )}

      <div class="info">
        <InfoItem
          label="删除接口:"
          value={s().deleteTemplateReady ? '已学习（可批量删除）' : '未学习（手动删除一次会话即可）'}
        />
      </div>

      <SessionListPanel />

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
          disabled={s().exporting || selectedCount() === 0}
          onClick={exportSelected}
        >
          导出选中 ({selectedCount()})
        </button>
        <button
          class="btn btn-danger"
          disabled={s().exporting || selectedCount() === 0 || !s().deleteTemplateReady}
          onClick={deleteSelected}
        >
          删除选中 ({selectedCount()})
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
