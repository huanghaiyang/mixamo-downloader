import { getSettings, patchSettings } from '../lib/store.js';
import { dirStatus } from '../lib/fs.js';

const $ = (id) => document.getElementById(id);

const el = {
  statusDot: $('statusDot'),
  statusPill: $('statusPill'),
  connLine: $('connLine'),
  filterLine: $('filterLine'),
  btnTest: $('btnTest'),
  progressText: $('progressText'),
  progressBar: $('progressBar'),
  currentLine: $('currentLine'),
  statDone: $('statDone'),
  statFailed: $('statFailed'),
  statPending: $('statPending'),
  btnStart: $('btnStart'),
  btnPause: $('btnPause'),
  btnResume: $('btnResume'),
  btnStop: $('btnStop'),
  btnRetry: $('btnRetry'),
  btnClear: $('btnClear'),
  btnPick: $('btnPick'),
  btnOptions: $('btnOptions'),
  btnOptions2: $('btnOptions2'),
  btnLogClear: $('btnLogClear'),
  dirLine: $('dirLine'),
  dirHint: $('dirHint'),
  paramsLine: $('paramsLine'),
  logs: $('logs'),
};

const STATUS_TEXT = { idle: '空闲', running: '运行中', paused: '已暂停' };
const STATUS_CLASS = { idle: 'idle', running: 'running', paused: 'paused' };

const FORMAT_LABEL = {
  fbx7_2019: 'FBX Binary(.fbx)',
  fbx7_2019_ascii: 'FBX ASCII(.fbx)',
  fbx7_unity: 'FBX for Unity(.fbx)',
  fbx7_2014: 'FBX 7.4(.fbx)',
  fbx6: 'FBX 6.1(.fbx)',
  dae_mixamo: 'Collada(.dae)',
};
const REDUCEKF_LABEL = { 0: 'none', 1: 'uniform', 2: 'non-uniform' };

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
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function render(state) {
  const { runtime, summary, logs } = state;
  const status = runtime.status || 'idle';

  el.statusDot.className = `dot ${STATUS_CLASS[status] || 'idle'}`;
  el.statusPill.className = `pill ${STATUS_CLASS[status] || ''}`;
  el.statusPill.textContent = STATUS_TEXT[status] || status;

  const done = summary.done || 0;
  const total = summary.total || 0;
  el.progressBar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  el.progressText.textContent = `${done} / ${total}`;
  el.statDone.textContent = `成功 ${done}`;
  el.statFailed.textContent = `失败 ${summary.failed || 0}`;
  el.statPending.textContent = `待处理 ${(summary.pending || 0) + (summary.running || 0)}`;

  if (runtime.currentName) {
    el.currentLine.textContent = `${runtime.currentName} · ${runtime.phase || ''}`;
  } else if (runtime.message) {
    el.currentLine.textContent = runtime.message;
  } else if (total) {
    el.currentLine.textContent = '等待中…';
  } else {
    el.currentLine.textContent = '还没有队列，点「开始」抓取当前页面的筛选结果';
  }

  el.btnStart.disabled = status === 'running';
  el.btnPause.hidden = status !== 'running';
  el.btnResume.hidden = status !== 'paused';
  el.btnStop.disabled = status === 'idle' && !total;

  const lines = (logs || []).slice(-12).map((l) => {
    const cls = l.level === 'error' ? 'e' : l.level === 'warn' ? 'w' : 'i';
    return `<span class="${cls}">[${fmtTime(l.t)}] ${escapeHtml(l.message)}</span>`;
  });
  el.logs.innerHTML = lines.join('\n');
  el.logs.scrollTop = el.logs.scrollHeight;
}

async function refresh() {
  const state = await send('MM_GET_STATE');
  if (state && state.ok) render(state);
  await Promise.all([refreshDir(), refreshParams()]);
}

async function refreshParams() {
  const s = await getSettings();
  el.paramsLine.textContent = `${FORMAT_LABEL[s.format] || s.format} · ${s.skin === 'true' ? 'With Skin' : 'Without Skin'} · ${s.fps} FPS · kf ${REDUCEKF_LABEL[s.reducekf] || s.reducekf} · 范围 ${s.scope === 'all' ? '全部结果' : '仅当前页'} · 间隔 ${s.minDelayMs}ms`;
}

async function refreshDir() {
  const st = await dirStatus();
  const settings = await getSettings();
  if (st.state === 'granted') {
    el.dirLine.textContent = `已授权：“${st.name}”`;
    el.dirLine.style.color = '#1f9d55';
    el.dirHint.textContent = `文件直接写入该目录（建议 ${settings.dirLabel}）`;
  } else if (st.state === 'needs-permission') {
    el.dirLine.textContent = `需要重新授权：“${st.name}”`;
    el.dirLine.style.color = '#d9534f';
    el.dirHint.textContent = '点「设置」→「重新授权」即可（Chrome 重启后常见）';
  } else {
    el.dirLine.textContent = `未授权 — 当前保存到浏览器下载目录/${settings.downloadSubdir}`;
    el.dirLine.style.color = '#d9534f';
    el.dirHint.textContent = `点「选择目录…」选中 ${settings.dirLabel}`;
  }
}

let ctxRetries = 0;
async function refreshContext() {
  const ctx = await send('MM_CONTEXT');
  if (!ctx || !ctx.ok) {
    if (ctxRetries++ < 4) {
      setTimeout(refreshContext, 1000);
      return;
    }
    el.connLine.textContent = ctx && ctx.error ? ctx.error : '请先打开并登录 mixamo.com';
    el.connLine.style.color = '#d9534f';
    el.filterLine.textContent = '';
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
  el.filterLine.textContent = parts.length ? `当前页面筛选：${parts.join(' · ')}` : '当前页面没有筛选条件（将抓取全部动画）';
}

/* ------------------------------- 按钮 ------------------------------- */

async function guardDirectory() {
  const st = await dirStatus();
  if (st.state === 'granted') return true;

  if (st.state === 'needs-permission') {
    const goFix = confirm(
      `保存目录“${st.name}”的授权已失效（Chrome 重启后常见）。\n\n`
      + '「确定」= 现在去设置页点「重新授权」（推荐）\n'
      + '「取消」= 本次改用浏览器下载目录保存'
    );
    if (goFix) {
      chrome.runtime.openOptionsPage();
      return false;
    }
    await patchSettings({ saveMode: 'downloads' });
    return true;
  }

  const goPick = confirm(
    '还没有授权保存目录。\n\n'
    + '「确定」= 现在去选择目录（推荐：D:\\sgames\\animation-ai\\mixamo）\n'
    + '「取消」= 本次改用浏览器下载目录保存（扩展无法指定绝对路径）'
  );
  if (goPick) {
    chrome.runtime.openOptionsPage();
    return false;
  }
  await patchSettings({ saveMode: 'downloads' });
  return true;
}

el.btnStart.addEventListener('click', async () => {
  if (!(await guardDirectory())) return;
  el.btnStart.disabled = true;
  el.currentLine.textContent = '正在抓取列表…';
  const res = await send('MM_START');
  if (!res.ok) el.currentLine.textContent = `开始失败：${res.error}`;
  await refresh();
  await refreshContext();
});

el.btnPause.addEventListener('click', async () => { await send('MM_PAUSE'); await refresh(); });
el.btnResume.addEventListener('click', async () => { await send('MM_RESUME'); await refresh(); });
el.btnStop.addEventListener('click', async () => { await send('MM_STOP'); await refresh(); });
el.btnRetry.addEventListener('click', async () => { await send('MM_RETRY_FAILED'); await refresh(); });

el.btnClear.addEventListener('click', async () => {
  if (!confirm('确定清空下载队列与已下载记录吗？磁盘上已下载的文件不会被删除，但下次会重新下载。')) return;
  await send('MM_CLEAR');
  await refresh();
});

el.btnLogClear.addEventListener('click', async () => {
  await chrome.storage.local.set({ mm_logs: [] });
  await refresh();
});

el.btnTest.addEventListener('click', async () => {
  el.connLine.textContent = '正在检测…';
  const res = await send('MM_TEST');
  if (!res.ok) {
    el.connLine.textContent = `检测失败：${res.error}`;
    el.connLine.style.color = '#d9534f';
    return;
  }
  await refreshContext();
});

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}
el.btnOptions.addEventListener('click', openOptions);
el.btnOptions2.addEventListener('click', openOptions);
el.btnPick.addEventListener('click', openOptions);

/* ------------------------------ 生命周期 ----------------------------- */

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'MM_STATE_CHANGED') refresh();
});
chrome.storage.onChanged.addListener(() => { refresh(); });

(async function init() {
  await refresh();
  await refreshContext();
  setInterval(refresh, 1500);
})();
