/**
 * 落盘层。
 *
 * Chrome 扩展无法把 chrome.downloads 写到任意绝对路径（filename 只能相对下载目录），
 * 因此默认使用 File System Access API：用户在弹窗里点一次「选择目录」授权
 * D:\sgames\animation-ai\mixamo，句柄存进 IndexedDB，Service Worker 直接流式写入。
 * 拿不到句柄时回退到 chrome.downloads（下载目录下的 mixamo/ 子目录）。
 */

const DB_NAME = 'mixamo-downloader';
const DB_VERSION = 1;
const STORE = 'handles';
const DIR_KEY = 'targetDir';

const FORMAT_EXT = {
  fbx7_2019: 'fbx',
  fbx7_2019_ascii: 'fbx',
  fbx7_unity: 'fbx',
  fbx7_2014: 'fbx',
  fbx6: 'fbx',
  dae_mixamo: 'dae',
};

export function formatExt(format) {
  return FORMAT_EXT[format] || 'fbx';
}

/** Windows / macOS 都不允许的文件名字符 */
export function sanitizeFilename(name) {
  const cleaned = String(name || 'animation')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  return cleaned.slice(0, 120) || 'animation';
}

/* ----------------------------- IndexedDB ------------------------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 读：直接把 IDBRequest 的 result 交出来（没有记录时就是 undefined） */
function readStore(db, key) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务被中止'));
  });
}

/** 写：等事务 complete */
function writeStore(db, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务被中止'));
  });
}

export async function saveDirHandle(handle) {
  const db = await openDb();
  try {
    await writeStore(db, (s) => s.put(handle, DIR_KEY));
  } finally {
    db.close();
  }
}

export async function loadDirHandle() {
  const db = await openDb();
  try {
    return await readStore(db, DIR_KEY);
  } finally {
    db.close();
  }
}

export async function clearDirHandle() {
  const db = await openDb();
  try {
    await writeStore(db, (s) => s.delete(DIR_KEY));
  } finally {
    db.close();
  }
}

/** 目录句柄状态：none（没授权过） / needs-permission（授权被回收） / granted */
export async function dirStatus() {
  try {
    const handle = await loadDirHandle();
    if (!handle) return { granted: false, hasHandle: false, state: 'none', name: '' };
    let perm = 'prompt';
    try {
      perm = await handle.queryPermission({ mode: 'readwrite' });
    } catch (e) { /* 某些上下文不支持 queryPermission，按需要重新授权处理 */ }
    return {
      granted: perm === 'granted',
      hasHandle: true,
      state: perm === 'granted' ? 'granted' : 'needs-permission',
      name: handle.name || '',
      permission: perm,
    };
  } catch (e) {
    return { granted: false, hasHandle: false, state: 'none', name: '', error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 重新授权已保存的目录句柄（不需要重新选目录，但必须有用户手势 —— 只能在设置页里调用）。
 * Chrome 重启后 File System Access 的授权会降级成 prompt，用这个一键恢复。
 */
export async function reauthorizeDirectory() {
  const handle = await loadDirHandle();
  if (!handle) {
    const err = new Error('还没有保存过目录，请先「选择目录…」');
    err.code = 'NO_DIR';
    throw err;
  }
  const perm = await handle.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    const err = new Error('授权被拒绝');
    err.code = 'NO_PERM';
    throw err;
  }
  return { ok: true, dir: handle.name || '' };
}

/* ------------------------------ 写入文件 -------------------------------- */

function isPermissionError(e) {
  return !!e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
}

/**
 * 通过目录句柄流式写入（内存占用与文件大小无关）。
 *
 * 注意：这里**不**先用 queryPermission 做「悲观否决」。Chrome 重启后会把已授予的目录权限
 * 降级成 prompt，但 queryPermission 在不同上下文（弹窗 / Service Worker）下的返回值并不总是一致，
 * 直接尝试写入、由 createWritable 抛出真正的错误更准确。
 *
 * @returns {Promise<{bytes:number, file:string}>}
 */
export async function writeToDirectory(url, filename) {
  const handle = await loadDirHandle();
  if (!handle) {
    const err = new Error('尚未授权保存目录');
    err.code = 'NO_DIR';
    throw err;
  }

  // 先取数据，避免写失败时留下空文件
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok || !res.body) {
    throw new Error(`下载文件失败：HTTP ${res.status}`);
  }

  let writable = null;
  try {
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    writable = await fileHandle.createWritable();
    await res.body.pipeTo(writable);
    writable = null; // 已正常关闭
    const file = await fileHandle.getFile();
    return { bytes: file.size, file: filename };
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch { /* ignore */ } }
    if (isPermissionError(e)) {
      const err = new Error('保存目录授权已失效（Chrome 重启后常见），需要在设置页重新授权');
      err.code = 'NO_PERM';
      throw err;
    }
    throw e;
  }
}

/** 回退方案：交给浏览器下载到 <浏览器下载目录>/mixamo/ */
export async function writeViaDownloads(url, filename, subdir = 'mixamo') {
  const path = subdir ? `${subdir.replace(/[\\/]+$/, '')}/${filename}` : filename;
  const id = await chrome.downloads.download({ url, filename: path, saveAs: false });
  return { bytes: 0, file: path, downloadId: id };
}

/**
 * 等待 chrome.downloads 真正下载结束。
 * 顺带取出浏览器给出的**绝对路径**——这样即使用户没授权目录、走了回退，
 * 日志里也能明确写出文件到底落在哪里，不会让人以为写进了目标目录。
 * @returns {Promise<{bytes:number, absolutePath:string}>}
 */
export function waitForDownload(downloadId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      fn(arg);
    };
    const asResult = (it) => ({
      bytes: it ? (it.fileSize || it.bytesReceived || 0) : 0,
      absolutePath: (it && it.filename) || '',
    });
    const timer = setTimeout(() => finish(reject, new Error('下载超时')), timeoutMs);

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === 'complete') {
        chrome.downloads.search({ id: downloadId })
          .then((items) => finish(resolve, asResult(items && items[0])))
          .catch(() => finish(resolve, { bytes: 0, absolutePath: '' }));
      } else if (delta.state && delta.state.current === 'interrupted') {
        finish(reject, new Error(`下载被中断：${delta.error ? delta.error.current : 'unknown'}`));
      }
    }

    chrome.downloads.onChanged.addListener(onChanged);
    // 可能已经完成
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const it = items && items[0];
      if (it && it.state === 'complete') finish(resolve, asResult(it));
      if (it && it.state === 'interrupted') finish(reject, new Error('下载被中断'));
    }).catch(() => {});
  });
}

/** 设置页的「测试写入」：在目标目录里建一个临时文件再删掉 */
export async function testDirectoryWrite() {
  const handle = await loadDirHandle();
  if (!handle) {
    const err = new Error('尚未授权保存目录');
    err.code = 'NO_DIR';
    throw err;
  }
  const name = `.mixamo-write-test-${Date.now()}.tmp`;
  try {
    const fh = await handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    // 用标准 WritableStream writer，而不是 FileSystemWritableFileStream 特有的 .write()，
    // 这样对任何 WritableStream 实现都成立，也方便单测。
    const writer = w.getWriter();
    await writer.write(new Blob(['ok'], { type: 'text/plain' }));
    await writer.close();
    await handle.removeEntry(name);
    return { ok: true, dir: handle.name };
  } catch (e) {
    if (isPermissionError(e)) {
      const err = new Error('目录授权已失效，请点「重新授权」');
      err.code = 'NO_PERM';
      throw err;
    }
    throw e;
  }
}
