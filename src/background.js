/**
 * Service Worker：唯一的下载调度者。
 *
 * 设计要点
 *  - 单任务：一次只处理一个动画（Mixamo 的 monitor 是「按角色」的，并发会互相干扰）。
 *  - 可恢复：队列 / 已下载记录 / 状态全部落 chrome.storage.local，每个条目处理后立即写盘。
 *  - 默认不爬取：初始状态 idle，必须由用户点「开始」。
 *  - 限流：条目间隔默认 1.5s，遇到 429 按 Retry-After 指数退避。
 */

import * as store from './lib/store.js';
import * as api from './lib/api.js';
import * as fs from './lib/fs.js';

const ALARM_TICK = 'mm-tick';
const MIXAMO_MATCH = 'https://www.mixamo.com/*';

let loopActive = false;
let contextCache = { at: 0, value: null };

/* ============================ 页面上下文 ============================== */

async function findMixamoTabs() {
  try {
    return await chrome.tabs.query({ url: MIXAMO_MATCH });
  } catch (e) {
    return [];
  }
}

async function readFromTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'MM_GET_CONTEXT' });
    if (res && res.token) return res;
  } catch (e) { /* 内容脚本可能尚未注入，走下面的兜底 */ }
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        ok: true,
        token: localStorage.getItem('access_token') || '',
        firstName: localStorage.getItem('first_name') || '',
        hash: location.hash || '',
        url: location.href,
      }),
    });
    return out && out.result ? out.result : null;
  } catch (e) {
    return null;
  }
}

/** 读取 mixamo 标签页的 token / 筛选参数 */
export async function getContext(force = false) {
  if (!force && contextCache.value && Date.now() - contextCache.at < 5000) {
    return contextCache.value;
  }
  const tabs = await findMixamoTabs();
  if (!tabs.length) {
    throw new Error('没有找到 mixamo.com 标签页，请先打开并登录 https://www.mixamo.com/');
  }
  let best = null;
  for (const tab of tabs) {
    const ctx = await readFromTab(tab.id);
    if (!ctx) continue;
    ctx.tabId = tab.id;
    if (ctx.token) { best = ctx; break; }
    if (!best) best = ctx;
  }
  if (!best) {
    throw new Error('无法读取 mixamo.com 页面上下文，请刷新该标签页后重试');
  }
  if (!best.token) {
    throw new Error('mixamo.com 尚未登录（localStorage 中没有 access_token），请先登录 Adobe 账号');
  }
  contextCache = { at: Date.now(), value: best };
  return best;
}

/** 从页面 hash 里解析用户的筛选条件：#/?limit=24&page=1&type=Motion%2CMotionPack&query=walk */
function parseHashFilters(hash) {
  const qIndex = (hash || '').indexOf('?');
  const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : '');
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

/* ============================== 抓取列表 ============================== */

async function enumerateProducts(token, settings) {
  const ctx = await getContext();
  const filters = parseHashFilters(ctx.hash);
  const type = filters.type || 'Motion,MotionPack';
  const query = filters.query || '';
  const extra = { ...filters };

  const limit = settings.scope === 'page'
    ? Math.max(1, Math.min(96, Number(filters.limit) || 24))
    : Math.max(1, Math.min(96, Number(settings.pageSize) || 96));

  await store.patchRuntime({ phase: '读取列表' });

  const seen = new Set();
  const products = [];

  const first = await api.searchProducts({ token, type, query, page: settings.scope === 'page' ? (Number(filters.page) || 1) : 1, limit, extra });
  const numPages = settings.scope === 'page' ? 1 : Math.max(1, Number(first.pagination.num_pages) || 1);
  const total = Number(first.pagination.num_results) || first.results.length;

  const push = (list) => {
    for (const p of list) {
      if (!p || !p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      products.push(p);
    }
  };
  push(first.results);

  for (let page = 2; page <= numPages; page++) {
    await store.patchRuntime({ phase: `读取列表 ${page}/${numPages}` });
    if (page > 2) await api.sleep(200); // 目录接口很轻，但也不要打太快
    const r = await api.searchProducts({ token, type, query, page, limit, extra });
    push(r.results);
  }

  const filtered = products.filter((p) => settings.includeMotionPacks || p.type !== 'MotionPack');
  await store.log('info', `筛选条件 ${JSON.stringify({ type, query, scope: settings.scope })}：命中 ${products.length} 个，可下载动画 ${filtered.length} 个（站点报告总数 ${total}）`);
  return { products: filtered, totalRaw: products.length, totalReported: total, filters, numPages };
}

/* ============================== 队列合并 ============================== */

async function buildQueue(products) {
  const records = await store.getRecords();
  const oldQueue = await store.getQueue();
  const oldById = new Map(oldQueue.map((i) => [i.id, i]));

  const queue = [];
  for (const p of products) {
    const old = oldById.get(p.id);
    if (old) {
      if (records[p.id]) {
        old.status = 'done';
        old.file = records[p.id].file || old.file;
        old.bytes = records[p.id].bytes || old.bytes;
      } else if (old.status === 'running') {
        old.status = 'pending';
      }
      queue.push(old);
      continue;
    }
    const item = store.newQueueItem(p);
    if (records[p.id]) {
      item.status = 'done';
      item.file = records[p.id].file || '';
      item.bytes = records[p.id].bytes || 0;
    }
    queue.push(item);
  }
  return queue;
}

/* ================================ 循环 ================================ */

function pickNextIndex(queue, maxRetries) {
  const now = Date.now();
  return queue.findIndex((i) => i.status === 'pending'
    || (i.status === 'failed' && i.attempts < maxRetries && (i.nextAttemptAt || 0) <= now));
}

async function ensureLoop() {
  if (loopActive) return;
  loopActive = true;
  try {
    await runLoop();
  } catch (e) {
    await store.log('error', `调度循环异常：${e && e.message ? e.message : e}`);
    await store.patchRuntime({ status: 'paused', phase: '', message: `出错已暂停：${e && e.message ? e.message : e}` });
  } finally {
    loopActive = false;
  }
}

async function runLoop() {
  // Service Worker 可能在处理中途被回收，留下 status='running' 的孤儿条目；
  // 进入循环时先把它们放回 pending，避免它们永远卡住。
  const orphan = await store.getQueue();
  let repaired = false;
  for (const i of orphan) {
    if (i.status === 'running') { i.status = 'pending'; repaired = true; }
  }
  if (repaired) {
    await store.setQueue(orphan);
    await store.log('warn', '发现上次中断留下的进行中条目，已放回队列重试');
  }

  for (;;) {
    const rt = await store.getRuntime();
    if (rt.status !== 'running' || rt.intent === 'stop') return;

    const settings = await store.getSettings();
    const queue = await store.getQueue();
    const idx = pickNextIndex(queue, settings.maxRetries);

    if (idx < 0) {
      const waiting = queue.filter((i) => i.status === 'failed' && i.attempts < settings.maxRetries);
      if (waiting.length) {
        const soonest = Math.min(...waiting.map((i) => i.nextAttemptAt || Date.now()));
        const wait = Math.max(1000, Math.min(60000, soonest - Date.now()));
        await store.patchRuntime({ phase: `等待重试 ${Math.round(wait / 1000)}s` });
        await api.sleep(wait);
        continue;
      }
      const stat = summarize(queue);
      await store.patchRuntime({
        status: 'idle', intent: 'idle', phase: '', currentId: null, currentName: '',
        message: `已完成：成功 ${stat.done}，失败 ${stat.failed}`,
        finishedAt: Date.now(),
      });
      await store.log('info', `队列处理结束：成功 ${stat.done}，失败 ${stat.failed}`);
      notifyPopup();
      return;
    }

    const item = queue[idx];
    item.status = 'running';
    item.attempts += 1;
    item.error = '';
    queue[idx] = item;
    await store.setQueue(queue);

    await store.patchRuntime({ currentId: item.id, currentName: item.name, phase: '准备导出' });
    notifyPopup();

    try {
      const saved = await processItem(item, settings);
      item.status = 'done';
      item.error = '';
      item.file = saved.file;
      item.bytes = saved.bytes;
      await store.addRecord(item.id, {
        id: item.id,
        name: item.name,
        file: saved.file,
        // downloads 模式下浏览器可能因为重名自动加 "(1)"，这里记下真实绝对路径便于核对
        absolutePath: saved.absolutePath || '',
        bytes: saved.bytes,
        at: Date.now(),
        format: settings.format,
        fps: settings.fps,
      });
      const where = saved.absolutePath || saved.file;
      await store.log('info', `✔ ${item.name} → ${where}${saved.bytes ? ` (${formatBytes(saved.bytes)})` : ''}`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      item.error = msg;
      item.status = 'failed';
      if (e && e.name === 'DirAuthError') {
        // 目录授权问题：已经暂停过了，这条不算失败、不消耗重试次数
        item.status = 'pending';
        item.attempts = Math.max(0, item.attempts - 1);
        item.nextAttemptAt = 0;
      } else if (e && e.name === 'RateLimitError') {
        const backoff = Math.min(300000, (e.retryAfterMs || 30000) * Math.pow(2, Math.max(0, item.attempts - 1)));
        item.nextAttemptAt = Date.now() + backoff;
        await store.log('warn', `⟳ ${item.name} 被限流（429），${Math.round(backoff / 1000)}s 后重试（第 ${item.attempts} 次）`);
      } else {
        item.nextAttemptAt = Date.now() + Math.min(30000, 1500 * item.attempts);
        await store.log('error', `✘ ${item.name} 失败（第 ${item.attempts}/${settings.maxRetries} 次）：${msg}`);
      }
      if (e && e.name === 'AuthError') {
        // 登录状态失效：继续跑只会把剩下的条目全部试错一遍，直接暂停等用户处理
        contextCache = { at: 0, value: null };
        item.nextAttemptAt = 0;
        await store.patchRuntime({
          status: 'paused',
          intent: 'pause',
          phase: '',
          currentId: null,
          currentName: '',
          message: `登录状态失效，任务已暂停：${msg}`,
        });
        await store.log('warn', '登录状态失效，已暂停任务；请在 mixamo.com 重新登录后点「继续」');
      }
    }

    const fresh = await store.getQueue();
    const pos = fresh.findIndex((i) => i.id === item.id);
    if (pos >= 0) fresh[pos] = item;
    await store.setQueue(fresh);
    notifyPopup();

    const after = await store.getRuntime();
    if (after.status !== 'running' || after.intent === 'stop') return;

    await api.sleep(Math.max(0, Number(settings.minDelayMs) || 1500));
  }
}

/** 处理单个动画：详情 → 导出 → 轮询 → 落盘 */
async function processItem(item, settings) {
  const ctx = await getContext();
  const token = ctx.token;

  const character = await ensureCharacter(token);

  await store.patchRuntime({ phase: '读取动画参数' });
  const detail = await api.getProductDetail({ token, id: item.id, characterId: character.id });
  const gms = detail && detail.details && detail.details.gms_hash;
  if (!gms) throw new Error('该素材缺少 gms_hash，无法导出（可能是动画包或需要特殊处理）');

  await store.patchRuntime({ phase: '服务器生成中' });
  const job = await api.startExport({
    token,
    characterId: character.id,
    productName: detail.name || item.name,
    type: detail.type || item.type || 'Motion',
    gmsHash: api.buildGmsHash(gms),
    preferences: preferencesFrom(settings),
  });

  await store.patchRuntime({ phase: '等待导出完成' });
  const result = await api.waitForExport({
    token,
    uuid: job.uuid,
    intervalMs: Number(settings.pollIntervalMs) || 2500,
    timeoutMs: Number(settings.pollTimeoutMs) || 180000,
  });
  if (result.status !== 'completed' || !result.jobResult) {
    throw new Error(result.message || `导出未成功（${result.status}）`);
  }

  await store.patchRuntime({ phase: '写入文件' });
  const filename = await uniqueFilename(item, settings);

  if (settings.saveMode === 'fs') {
    try {
      const saved = await fs.writeToDirectory(result.jobResult, filename);
      return { file: filename, bytes: saved.bytes, absolutePath: '' };
    } catch (e) {
      if (e && (e.code === 'NO_DIR' || e.code === 'NO_PERM')) {
        // 不静默回退到浏览器下载目录——那会把文件写到你没预期的地方。
        // 直接暂停并给出可执行的指引，由用户决定是重新授权还是改用下载目录。
        const hint = e.code === 'NO_PERM'
          ? '保存目录授权已失效（Chrome 重启后常见）：请在设置页点「重新授权」，或把保存方式改成「浏览器下载目录」再点继续'
          : '还没有授权保存目录：请在设置页点「选择目录…」选中 D:\\sgames\\animation-ai\\mixamo';
        await store.patchRuntime({
          status: 'paused', intent: 'pause', phase: '',
          currentId: null, currentName: '', message: hint,
        });
        await store.log('warn', `已暂停：${hint}`);
        const err = new Error(hint);
        err.name = 'DirAuthError';
        throw err;
      }
      throw e;
    }
  }
  return await saveViaDownloads(result.jobResult, filename, settings);
}

async function saveViaDownloads(url, filename, settings) {
  const res = await fs.writeViaDownloads(url, filename, settings.downloadSubdir);
  const info = await fs.waitForDownload(res.downloadId, 180000);
  return { file: res.file, bytes: info.bytes, absolutePath: info.absolutePath };
}

function preferencesFrom(settings) {
  return {
    format: settings.format,
    skin: settings.skin,
    fps: settings.fps,
    reducekf: settings.reducekf,
  };
}

let characterCache = { id: null, name: '', at: 0 };

async function ensureCharacter(token) {
  const rt = await store.getRuntime();
  if (characterCache.id && Date.now() - characterCache.at < 10 * 60 * 1000) return characterCache;
  if (rt.characterId) {
    characterCache = { id: rt.characterId, name: rt.characterName || '', at: Date.now() };
    return characterCache;
  }
  const c = await api.getPrimaryCharacter(token);
  characterCache = { id: c.id, name: c.name, at: Date.now() };
  await store.patchRuntime({ characterId: c.id, characterName: c.name });
  return characterCache;
}

/** 同名动画不要互相覆盖 */
async function uniqueFilename(item, settings) {
  const records = await store.getRecords();
  const ext = fs.formatExt(settings.format);
  const base = fs.sanitizeFilename(item.name);

  if (records[item.id] && records[item.id].file) return records[item.id].file;

  // 只比较文件名本身：downloads 模式下记录里存的是 "mixamo/xxx.fbx"，
  // 而候选名是 "xxx.fbx"，不比 basename 的话同名不同动画会互相覆盖。
  const baseName = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase();
  const used = new Set(Object.values(records).map((r) => baseName(r.file)));
  let candidate = `${base}.${ext}`;
  if (!used.has(candidate.toLowerCase())) return candidate;
  let n = 2;
  while (used.has(`${base} (${n}).${ext}`.toLowerCase())) n++;
  return `${base} (${n}).${ext}`;
}

function summarize(queue) {
  const s = { total: queue.length, done: 0, failed: 0, pending: 0, running: 0, skipped: 0 };
  for (const i of queue) {
    if (i.status === 'done') s.done++;
    else if (i.status === 'failed') s.failed++;
    else if (i.status === 'running') s.running++;
    else if (i.status === 'skipped') s.skipped++;
    else s.pending++;
  }
  return s;
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'MM_STATE_CHANGED' }).catch(() => {});
}

/* =============================== 控制指令 ============================== */

async function cmdStart() {
  const settings = await store.getSettings();
  // 立刻声明本次运行的意图，这样「抓取列表期间点暂停/停止」不会被后面的启动覆盖
  await store.patchRuntime({ intent: 'run' });

  const ctx = await getContext(true);
  if (!ctx.token) throw new Error('未检测到 Mixamo 登录状态');

  const character = await api.getPrimaryCharacter(ctx.token);
  characterCache = { id: character.id, name: character.name, at: Date.now() };

  const { products, totalReported, numPages, filters } = await enumerateProducts(ctx.token, settings);
  if (!products.length) {
    await store.patchRuntime({ status: 'idle', intent: 'idle', phase: '', message: '当前筛选条件下没有可下载的动画' });
    return { ok: true, empty: true };
  }

  const queue = await buildQueue(products);
  await store.setQueue(queue);
  const stat = summarize(queue);

  // 抓取列表可能耗时数十秒，期间用户可能已经点了暂停/停止
  const rt = await store.getRuntime();
  if (rt.intent === 'pause') {
    await store.patchRuntime({ status: 'paused', phase: '', message: '已暂停（列表已抓取完成）' });
    await store.log('info', `已在抓取列表期间请求暂停：队列 ${stat.total} 条，待下载 ${stat.pending + stat.failed}`);
    notifyPopup();
    return { ok: true, paused: true, queue: stat };
  }
  if (rt.intent === 'stop') {
    await store.patchRuntime({ status: 'idle', phase: '', message: '已停止（队列已保留）' });
    await store.log('info', '已在抓取列表期间请求停止');
    notifyPopup();
    return { ok: true, stopped: true, queue: stat };
  }

  await store.patchRuntime({
    status: 'running',
    intent: 'run',
    phase: '启动中',
    message: '',
    currentId: null,
    currentName: '',
    characterId: character.id,
    characterName: character.name,
    startedAt: Date.now(),
    finishedAt: null,
  });
  await store.log('info', `开始任务：角色「${character.name}」，待下载 ${stat.pending + stat.failed}，已完成 ${stat.done}（筛选 ${JSON.stringify(filters)}，共 ${numPages} 页，站点报告 ${totalReported} 条）`);

  ensureLoop();
  notifyPopup();
  return { ok: true, queue: stat };
}

async function cmdPause() {
  await store.patchRuntime({ status: 'paused', intent: 'pause', phase: '', message: '已暂停' });
  await store.log('info', '用户暂停（当前正在处理的那一条会先完成）');
  notifyPopup();
  return { ok: true };
}

async function cmdResume() {
  const rt = await store.getRuntime();
  if (!rt.status || rt.status === 'idle') return cmdStart();
  await store.patchRuntime({ status: 'running', intent: 'run', phase: '', message: '' });
  await store.log('info', '用户继续');
  ensureLoop();
  notifyPopup();
  return { ok: true };
}

async function cmdStop() {
  await store.patchRuntime({ status: 'idle', intent: 'stop', phase: '', currentId: null, currentName: '', message: '已停止（队列保留，可再次开始继续）' });
  await store.log('info', '用户停止（当前正在处理的那一条会先完成）');
  const queue = await store.getQueue();
  for (const i of queue) if (i.status === 'running') i.status = 'pending';
  await store.setQueue(queue);
  notifyPopup();
  return { ok: true };
}

async function cmdRetryFailed() {
  const queue = await store.getQueue();
  let n = 0;
  for (const i of queue) {
    if (i.status === 'failed') { i.status = 'pending'; i.attempts = 0; i.error = ''; i.nextAttemptAt = 0; n++; }
  }
  await store.setQueue(queue);
  await store.log('info', `重置 ${n} 个失败条目待重试`);
  const rt = await store.getRuntime();
  if (rt.status === 'running') {
    await store.patchRuntime({ intent: 'run' });
    ensureLoop();
  }
  notifyPopup();
  return { ok: true, reset: n };
}

async function cmdClear() {
  await store.resetAll();
  await store.patchRuntime({ status: 'idle', intent: 'idle', message: '已清空' });
  notifyPopup();
  return { ok: true };
}

async function cmdTest() {
  const ctx = await getContext(true);
  const character = await api.getPrimaryCharacter(ctx.token);
  const filters = parseHashFilters(ctx.hash);
  const r = await api.searchProducts({
    token: ctx.token,
    type: filters.type || 'Motion,MotionPack',
    query: filters.query || '',
    page: Number(filters.page) || 1,
    limit: 1,
    extra: filters,
  });
  characterCache = { id: character.id, name: character.name, at: Date.now() };
  await store.patchRuntime({ characterId: character.id, characterName: character.name });
  return {
    ok: true,
    user: ctx.firstName || '(已登录)',
    character: character.name,
    filters,
    reported: r.pagination.num_results,
    sample: r.results[0] ? r.results[0].name : null,
  };
}

/* =============================== 消息路由 ============================== */

const handlers = {
  MM_START: cmdStart,
  MM_PAUSE: cmdPause,
  MM_RESUME: cmdResume,
  MM_STOP: cmdStop,
  MM_RETRY_FAILED: cmdRetryFailed,
  MM_CLEAR: cmdClear,
  MM_TEST: cmdTest,
  MM_CONTEXT_READY: async (msg) => {
    if (msg.context && msg.context.token) contextCache = { at: Date.now(), value: { ...msg.context, tabId: null } };
    return { ok: true };
  },
  MM_GET_STATE: async () => {
    const [settings, runtime, queue, records, logs] = await Promise.all([
      store.getSettings(), store.getRuntime(), store.getQueue(), store.getRecords(), store.getLogs(),
    ]);
    return { ok: true, settings, runtime, queue, records, logs, summary: summarize(queue) };
  },
  MM_CONTEXT: async () => {
    try {
      const ctx = await getContext(true);
      let character = null;
      try {
        character = await ensureCharacter(ctx.token);
      } catch (e) { /* 不影响上下文展示 */ }
      return {
        ok: true,
        loggedIn: !!ctx.token,
        user: ctx.firstName || '',
        character: character ? character.name : '',
        hash: ctx.hash,
        filters: parseHashFilters(ctx.hash),
      };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  (async () => {
    try {
      const res = await fn(msg);
      sendResponse(res || { ok: true });
    } catch (e) {
      const message = e && e.message ? e.message : String(e);
      await store.log('error', message);
      await store.patchRuntime({ status: 'paused', phase: '', message });
      sendResponse({ ok: false, error: message, name: e && e.name });
      notifyPopup();
    }
  })();
  return true; // 异步响应
});

/* ============================== 生命周期 ============================== */

chrome.runtime.onInstalled.addListener(async () => {
  await store.patchSettings({});
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  await store.log('info', '扩展已安装/更新');
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
  const rt = await store.getRuntime();
  if (rt.status === 'running') {
    await store.patchRuntime({ status: 'paused', phase: '', message: '浏览器已重启，任务自动暂停，请点击「继续」' });
    await store.log('warn', '浏览器重启：任务已自动暂停');
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_TICK) return;
  const rt = await store.getRuntime();
  if (rt.status === 'running') await ensureLoop();
});

// 内容脚本上报的上下文（页面刷新后 token 可能变化）
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  if (!tab || !/^https:\/\/www\.mixamo\.com\//.test(tab.url || '')) return;
  contextCache = { at: 0, value: null };
});
