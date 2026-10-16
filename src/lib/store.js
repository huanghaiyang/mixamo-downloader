/**
 * 持久化状态层：设置 / 运行状态 / 下载队列 / 已下载记录 / 日志
 * 全部落在 chrome.storage.local，保证 Service Worker 被回收后仍可恢复。
 */

const K = {
  settings: 'mm_settings',
  runtime: 'mm_runtime',
  queue: 'mm_queue',
  records: 'mm_records',
  logs: 'mm_logs',
};

/** 与截图一致的默认下载参数 */
export const DEFAULT_SETTINGS = {
  // 图1 的四个下拉框
  format: 'fbx7_2019',      // FBX Binary(.fbx)
  skin: 'true',             // With Skin
  fps: '60',                // 60
  reducekf: '0',            // none
  // 采集范围
  scope: 'all',             // all = 当前筛选结果的全部页; page = 仅当前页
  pageSize: 96,             // 每页条数（接口上限 96）
  includeMotionPacks: false, // 动画包(MotionPack)导出为 zip，默认跳过
  // 频率与重试（Mixamo 有 429 限流，默认放慢）
  minDelayMs: 1500,
  pollIntervalMs: 2500,
  pollTimeoutMs: 180000,
  maxRetries: 3,
  // 保存方式
  saveMode: 'fs',           // fs = 目录句柄（可指定 D:\sgames\animation-ai\mixamo）; downloads = 浏览器下载目录
  dirLabel: 'D:\\sgames\\animation-ai\\mixamo',
  downloadSubdir: 'mixamo',
};

export const DEFAULT_RUNTIME = {
  status: 'idle',           // idle | running | paused
  intent: 'idle',           // idle | run | pause | stop  —— 用于消除「抓取列表期间点暂停」的竞态
  phase: '',                // 当前阶段描述
  currentId: null,
  currentName: '',
  message: '',
  characterId: null,
  characterName: '',
  startedAt: null,
  finishedAt: null,
  updatedAt: null,
};

async function get(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  return v;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

/* ------------------------------ settings ------------------------------ */

export async function getSettings() {
  const s = await get(K.settings, {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function patchSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch };
  await set(K.settings, next);
  return next;
}

/* ------------------------------ runtime ------------------------------- */

export async function getRuntime() {
  const r = await get(K.runtime, {});
  return { ...DEFAULT_RUNTIME, ...r };
}

export async function patchRuntime(patch) {
  const r = await getRuntime();
  const next = { ...r, ...patch, updatedAt: Date.now() };
  await set(K.runtime, next);
  return next;
}

/* ------------------------------- queue -------------------------------- */

export async function getQueue() {
  return await get(K.queue, []);
}

export async function setQueue(queue) {
  await set(K.queue, queue);
  return queue;
}

/** 队列项结构：{ id, name, type, status, attempts, error, file, bytes, nextAttemptAt } */
export function newQueueItem(product) {
  return {
    id: product.id,
    name: product.name,
    type: product.type,
    description: product.description || '',
    status: 'pending',     // pending | running | done | failed | skipped
    attempts: 0,
    error: '',
    file: '',
    bytes: 0,
    nextAttemptAt: 0,
  };
}

/* ------------------------------ records ------------------------------- */

export async function getRecords() {
  return await get(K.records, {});
}

export async function addRecord(id, rec) {
  const records = await getRecords();
  records[id] = rec;
  await set(K.records, records);
  return records;
}

export async function clearRecords() {
  await set(K.records, {});
}

/* ------------------------------- logs --------------------------------- */

export async function getLogs() {
  return await get(K.logs, []);
}

export async function log(level, message) {
  const logs = await getLogs();
  logs.push({ t: Date.now(), level, message: String(message).slice(0, 500) });
  while (logs.length > 200) logs.shift();
  await set(K.logs, logs);
  return logs;
}

export async function clearLogs() {
  await set(K.logs, []);
}

/* ------------------------------ helpers ------------------------------- */

export async function resetAll() {
  await chrome.storage.local.set({
    [K.queue]: [],
    [K.records]: {},
    [K.logs]: [],
    [K.runtime]: { ...DEFAULT_RUNTIME },
  });
}
