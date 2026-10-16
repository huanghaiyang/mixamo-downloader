import { getSettings, patchSettings } from '../lib/store.js';
import { dirStatus, saveDirHandle, clearDirHandle, reauthorizeDirectory, testDirectoryWrite } from '../lib/fs.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_DIR = 'D:\\sgames\\animation-ai\\mixamo';

const el = {
  statusDot: $('statusDot'), statusPill: $('statusPill'),
  dirLine: $('dirLine'), dirHint: $('dirHint'), btnPick: $('btnPick'), btnClearDir: $('btnClearDir'),
  btnReauth: $('btnReauth'), reauthNote: $('reauthNote'), btnTestWrite: $('btnTestWrite'), testResult: $('testResult'),
  subdirLabel: $('subdirLabel'), saveModeNote: $('saveModeNote'),
  optFormat: $('optFormat'), optSkin: $('optSkin'), optFps: $('optFps'), optReducekf: $('optReducekf'),
  optScope: $('optScope'), optPacks: $('optPacks'), optDelay: $('optDelay'), optRetries: $('optRetries'),
  optPollInterval: $('optPollInterval'), optPollTimeout: $('optPollTimeout'), optPageSize: $('optPageSize'),
  queueLine: $('queueLine'), lastRecord: $('lastRecord'), btnRetry: $('btnRetry'), btnClearAll: $('btnClearAll'),
  connLine: $('connLine'), filterLine: $('filterLine'), btnTest: $('btnTest'),
  logs: $('logs'), logCount: $('logCount'), btnLogClear: $('btnLogClear'),
};

const STATUS_TEXT = { idle: '空闲', running: '运行中', paused: '已暂停' };

function send(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: '无响应' });
    });
  });
}

function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ------------------------------- 渲染 -------------------------------- */

async function renderDir() {
  const st = await dirStatus();
  const settings = await getSettings();

  if (st.state === 'granted') {
    el.dirLine.textContent = `已授权目录：“${st.name}”`;
    el.dirLine.style.color = '#1f9d55';
    el.dirHint.textContent = '扩展会直接写入该目录（无需经过浏览器下载目录）。';
  } else if (st.state === 'needs-permission') {
    el.dirLine.textContent = `需要重新授权：“${st.name}”`;
    el.dirLine.style.color = '#d9534f';
    el.dirHint.textContent = '目录句柄还在，但浏览器把授权降级了；点「重新授权」即可，不用重新选目录。';
  } else {
    el.dirLine.textContent = '未授权目录';
    el.dirLine.style.color = '#d9534f';
    el.dirHint.textContent = `点击「选择目录…」并选中 ${DEFAULT_DIR}`;
  }

  el.btnReauth.hidden = st.state !== 'needs-permission';
  el.reauthNote.hidden = st.state !== 'needs-permission';

  el.subdirLabel.textContent = settings.downloadSubdir || 'mixamo';
  for (const radio of document.querySelectorAll('input[name="saveMode"]')) {
    radio.checked = radio.value === settings.saveMode;
  }
  el.saveModeNote.textContent = settings.saveMode === 'fs'
    ? `当前：写入已授权目录（建议 ${DEFAULT_DIR}）。授权不可用时会**暂停任务**并提示重新授权，不会偷偷写到别处。`
    : `当前：写入浏览器下载目录 / ${settings.downloadSubdir}。该目录由 Chrome 设置决定，扩展无法改成绝对路径；下载完成后日志会显示文件的真实绝对路径。`;
}

async function renderSettings() {
  const s = await getSettings();
  el.optFormat.value = s.format;
  el.optSkin.value = s.skin;
  el.optFps.value = s.fps;
  el.optReducekf.value = s.reducekf;
  el.optScope.value = s.scope;
  el.optPacks.value = String(!!s.includeMotionPacks);
  el.optDelay.value = s.minDelayMs;
  el.optRetries.value = s.maxRetries;
  el.optPollInterval.value = s.pollIntervalMs;
  el.optPollTimeout.value = Math.round(s.pollTimeoutMs / 1000);
  el.optPageSize.value = s.pageSize;
}

async function renderState() {
  const state = await send('MM_GET_STATE');
  if (!state || !state.ok) return;
  const { runtime, summary, logs, records } = state;

  el.statusDot.className = `dot ${runtime.status || 'idle'}`;
  el.statusPill.className = `pill ${runtime.status || ''}`;
  el.statusPill.textContent = STATUS_TEXT[runtime.status] || runtime.status;

  el.queueLine.textContent = `队列 ${summary.total} 条：成功 ${summary.done}，失败 ${summary.failed}，待处理 ${summary.pending + summary.running}；已下载记录 ${Object.keys(records || {}).length} 条。`
    + (runtime.currentName ? ` 当前：${runtime.currentName}（${runtime.phase || ''}）` : '')
    + (runtime.message ? ` — ${runtime.message}` : '');

  // 最近一条记录写在哪个目录，便于核对是否写到了预期位置
  const recents = Object.values(records || {}).sort((a, b) => (b.at || 0) - (a.at || 0));
  const lastWhere = recents.length ? (recents[0].absolutePath || recents[0].file || '') : '';
  el.lastRecord.textContent = lastWhere ? `最近写入：${lastWhere}` : '';

  const lines = (logs || []).slice(-40).map((l) => {
    const cls = l.level === 'error' ? 'e' : l.level === 'warn' ? 'w' : 'i';
    return `<span class="${cls}">[${fmtTime(l.t)}] ${escapeHtml(l.message)}</span>`;
  });
  el.logs.innerHTML = lines.join('\n');
  el.logs.scrollTop = el.logs.scrollHeight;
  el.logCount.textContent = `共 ${(logs || []).length} 条`;
}

let ctxRetries = 0;
async function renderContext() {
  const ctx = await send('MM_CONTEXT');
  if (!ctx || !ctx.ok) {
    if (ctxRetries++ < 3) {
      setTimeout(renderContext, 1200);
    } else {
      el.connLine.textContent = ctx && ctx.error ? ctx.error : '未找到 mixamo.com 标签页，请先打开并登录 mixamo.com';
      el.connLine.style.color = '#d9534f';
    }
    return;
  }
  ctxRetries = 0;
  el.connLine.textContent = `${ctx.user ? '已登录：' + ctx.user : '已登录'}${ctx.character ? ' · 角色：' + ctx.character : ''}`;
  el.connLine.style.color = '#1f9d55';

  const f = ctx.filters || {};
  const parts = [];
  if (f.query) parts.push(`搜索「${f.query}」`);
  if (f.type) parts.push(`类型 ${decodeURIComponent(f.type)}`);
  if (f.page) parts.push(`第 ${f.page} 页`);
  if (f.limit) parts.push(`每页 ${f.limit}`);
  el.filterLine.textContent = parts.length ? `当前 mixamo 页面筛选：${parts.join(' · ')}` : '当前 mixamo 页面没有筛选条件（将抓取全部动画）';
}

async function renderAll() {
  await Promise.all([renderDir(), renderSettings(), renderState(), renderContext()]);
}

/* ------------------------------- 事件 -------------------------------- */

function bindAutoSave() {
  const map = [
    [el.optFormat, 'format', (v) => v],
    [el.optSkin, 'skin', (v) => v],
    [el.optFps, 'fps', (v) => v],
    [el.optReducekf, 'reducekf', (v) => v],
    [el.optScope, 'scope', (v) => v],
    [el.optPacks, 'includeMotionPacks', (v) => v === 'true'],
    [el.optDelay, 'minDelayMs', (v) => Math.max(500, Number(v) || 1500)],
    [el.optRetries, 'maxRetries', (v) => Math.max(0, Math.min(10, Number(v) || 0))],
    [el.optPollInterval, 'pollIntervalMs', (v) => Math.max(1000, Number(v) || 2500)],
    [el.optPollTimeout, 'pollTimeoutMs', (v) => Math.max(30, Number(v) || 180) * 1000],
    [el.optPageSize, 'pageSize', (v) => Math.max(1, Math.min(96, Number(v) || 96))],
  ];
  for (const [node, key, cast] of map) {
    node.addEventListener('change', async () => {
      await patchSettings({ [key]: cast(node.value) });
      await renderSettings();
    });
  }
  for (const radio of document.querySelectorAll('input[name="saveMode"]')) {
    radio.addEventListener('change', async () => {
      await patchSettings({ saveMode: radio.value });
      await renderDir();
    });
  }
}

el.btnPick.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'mixamo-target', mode: 'readwrite', startIn: 'downloads' });
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      el.dirHint.textContent = '授权被拒绝，请重试。';
      return;
    }
    await saveDirHandle(handle);
    await patchSettings({ saveMode: 'fs' });
    el.testResult.textContent = '';
    await renderDir();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    el.dirHint.textContent = `选择目录失败：${e && e.message ? e.message : e}`;
  }
});

el.btnReauth.addEventListener('click', async () => {
  el.testResult.textContent = '正在重新授权…';
  try {
    const r = await reauthorizeDirectory();
    el.testResult.textContent = `✔ 已重新授权：“${r.dir}”`;
    el.testResult.style.color = '#1f9d55';
  } catch (e) {
    el.testResult.textContent = `重新授权失败：${e && e.message ? e.message : e}`;
    el.testResult.style.color = '#d9534f';
  }
  await renderDir();
});

el.btnTestWrite.addEventListener('click', async () => {
  el.testResult.textContent = '正在测试写入…';
  el.testResult.style.color = '';
  try {
    const r = await testDirectoryWrite();
    el.testResult.textContent = `✔ 写入成功，目标目录可用：“${r.dir}”（测试文件已自动删除）`;
    el.testResult.style.color = '#1f9d55';
  } catch (e) {
    const code = e && e.code;
    el.testResult.textContent = code === 'NO_PERM'
      ? '✘ 目录授权已失效，请点「重新授权」；若按钮不可见就重新「选择目录…」'
      : `✘ ${e && e.message ? e.message : e}`;
    el.testResult.style.color = '#d9534f';
  }
  await renderDir();
});

el.btnClearDir.addEventListener('click', async () => {
  await clearDirHandle();
  el.testResult.textContent = '';
  await renderDir();
});

el.btnRetry.addEventListener('click', async () => { await send('MM_RETRY_FAILED'); await renderAll(); });
el.btnClearAll.addEventListener('click', async () => {
  if (!confirm('确定清空下载队列与已下载记录吗？磁盘上已下载的文件不会被删除，但下次会重新下载。')) return;
  await send('MM_CLEAR');
  await renderAll();
});
el.btnTest.addEventListener('click', async () => {
  el.connLine.textContent = '检测中…';
  await send('MM_TEST');
  await renderContext();
});
el.btnLogClear.addEventListener('click', async () => {
  await chrome.storage.local.set({ mm_logs: [] });
  await renderState();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'MM_STATE_CHANGED') renderState();
});
chrome.storage.onChanged.addListener(() => { renderState(); });

(async function init() {
  bindAutoSave();
  await renderAll();
  setInterval(renderState, 2000);
})();
