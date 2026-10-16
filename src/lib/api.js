/**
 * Mixamo 非公开 API 客户端。
 *
 * 说明：Mixamo 的「下载」并不是在页面里用 JS 生成文件，而是
 *   POST /api/v1/animations/export  -> 202 + uuid
 *   GET  /api/v1/characters/<uuid>/monitor -> status=completed + job_result(S3 签名直链)
 * 因此扩展可以在 Service Worker 里直接完成，无需操作页面 DOM。
 */

export const API_BASE = 'https://www.mixamo.com/api/v1';

/**
 * `X-Api-Key` 的值是 Mixamo **网页端公开下发的客户端标识**，不是凭据。
 *
 * 该字符串随 mixamo.com 的前端 bundle 一起发给每一位访客：打开 mixamo.com，
 * 在 DevTools → Network 里任取一个 /api/v1 请求，请求头里都能直接看到它。
 * 因此它不具备机密性 —— 硬编码在此不构成信息泄露，也不是可轮换的密钥。
 * 保留明文是为了让扩展开箱即用，避免引入构建期注入的复杂度。
 *
 * 真正的凭据只有用户的 OAuth access_token，它的处理方式是：
 *   - 仅由内容脚本在运行时从 mixamo.com 标签页的 localStorage 读取并回传
 *     （见 src/content/mixamo.js），不写入任何源码；
 *   - 只在 Service Worker 内存与 chrome.storage 中以上下文形式短暂停留；
 *   - 不写日志、不落磁盘、不进仓库。
 *
 * ⚠️ 若 Mixamo 将来把这个标识收紧为需要保密的密钥，必须改为构建期注入
 *    （例如从环境变量或未纳管的本地配置读取），切勿提交进仓库。
 */
const API_KEY = 'mixamo2';

export class MixamoError extends Error {
  constructor(message, { status = 0, code = '', body = null } = {}) {
    super(message);
    this.name = 'MixamoError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class RateLimitError extends MixamoError {
  constructor(message, retryAfterMs) {
    super(message, { status: 429, code: '429' });
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthError extends MixamoError {
  constructor(message) {
    super(message, { status: 401, code: '401' });
    this.name = 'AuthError';
  }
}

function headers(token, json) {
  const h = {
    'X-Api-Key': API_KEY,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (json) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  return h;
}

function parseRetryAfter(res) {
  const ra = res.headers.get('Retry-After');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(1000, secs * 1000);
    const when = Date.parse(ra);
    if (!Number.isNaN(when)) return Math.max(1000, when - Date.now());
  }
  return 30000;
}

async function request(path, { token, method = 'GET', body, signal } = {}) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: headers(token, body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
    signal,
  });

  if (res.status === 429) {
    throw new RateLimitError('Mixamo 限流（429）', parseRetryAfter(res));
  }
  if (res.status === 401 || res.status === 403) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.message || j.error_code || '';
    } catch { /* ignore */ }
    throw new AuthError(detail || '登录状态无效，请在 mixamo.com 重新登录');
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.error_code)) || `HTTP ${res.status}`;
    throw new MixamoError(msg, { status: res.status, body: data });
  }
  return { status: res.status, data };
}

/* ------------------------------- 认证 ---------------------------------- */

export async function getPrimaryCharacter(token) {
  const { data } = await request('/characters/primary', { token });
  return {
    id: data.primary_character_id,
    name: data.primary_character_name,
    source: data.primary_character_source,
  };
}

/* ------------------------------- 目录 ---------------------------------- */

/**
 * 按当前页面筛选条件检索动画。
 * @param {object} p
 * @param {string} p.token
 * @param {string} p.type       例如 'Motion,MotionPack'
 * @param {string} [p.query]    搜索词
 * @param {number} p.page
 * @param {number} p.limit
 * @param {object} [p.extra]    页面 hash 上其它过滤参数（order 等）原样透传
 */
export async function searchProducts({ token, type = 'Motion,MotionPack', query = '', page = 1, limit = 96, extra = {} } = {}) {
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.set('limit', String(limit));
  qs.set('order', extra.order || 'relevance');
  qs.set('type', type);
  if (query) qs.set('query', query);
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'page' || k === 'limit' || k === 'query' || k === 'type' || k === 'order') continue;
    if (v) qs.set(k, v);
  }
  const { data } = await request('/products?' + qs.toString(), { token });
  return {
    results: data.results || [],
    pagination: data.pagination || { page, num_pages: 1, num_results: (data.results || []).length },
  };
}

/** 产品详情，含 details.gms_hash（导出所需） */
export async function getProductDetail({ token, id, characterId }) {
  const qs = new URLSearchParams({ similar: '0' });
  if (characterId) qs.set('character_id', characterId);
  const { data } = await request(`/products/${id}?${qs.toString()}`, { token });
  return data;
}

/* ------------------------------- 导出 ---------------------------------- */

/**
 * 把详情里的 gms_hash 转成导出接口要求的形状。
 * 关键点：params 必须是「逗号分隔的数字串」（每项相对默认值的偏移），
 * 名字-值数组会直接导致 400 / 服务端生成失败。
 */
export function buildGmsHash(detailGms) {
  const params = Array.isArray(detailGms.params) ? detailGms.params : [];
  return {
    'model-id': detailGms['model-id'],
    mirror: !!detailGms.mirror,
    trim: Array.isArray(detailGms.trim) ? detailGms.trim : [0, 100],
    overdrive: 0,
    params: new Array(params.length || 4).fill('0').join(','),
    'arm-space': detailGms['arm-space'] || 0,
    inplace: !!detailGms.inplace,
  };
}

/** 提交导出任务，返回 job uuid */
export async function startExport({ token, characterId, productName, type, gmsHash, preferences }) {
  const body = {
    gms_hash: [gmsHash],
    preferences,
    character_id: characterId,
    type: type || 'Motion',
    product_name: productName,
  };
  const { data } = await request('/animations/export', { token, method: 'POST', body });
  const uuid = data && (data.uuid || data.job_uuid);
  if (!uuid) throw new MixamoError('导出接口未返回任务 id', { body: data });
  return { uuid, raw: data };
}

/** 查询导出任务状态 */
export async function monitorJob({ token, uuid }) {
  const { data } = await request(`/characters/${uuid}/monitor`, { token });
  return data;
}

/**
 * 轮询直到任务完成 / 失败 / 超时。
 * @returns {Promise<{status:string, jobResult?:string, message:string}>}
 */
export async function waitForExport({ token, uuid, intervalMs = 2500, timeoutMs = 180000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new MixamoError('已取消');
    last = await monitorJob({ token, uuid });
    if (last && last.job_result) {
      const failed = last.status === 'failed';
      return {
        status: failed ? 'failed' : (last.status || 'completed'),
        jobResult: failed ? undefined : last.job_result,
        message: typeof last.job_result === 'object' ? (last.job_result.message || '') : (last.message || ''),
        raw: last,
      };
    }
    if (last && last.status === 'failed') {
      return {
        status: 'failed',
        message: (last.job_result && last.job_result.message) || last.message || '导出失败',
        raw: last,
      };
    }
    await sleep(intervalMs);
  }
  return { status: 'timeout', message: '导出超时', raw: last };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
