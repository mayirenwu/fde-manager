/**
 * AI 算力平台对接（默认 api.lk888.ai；ai.my10086.cn 是网页控制台）
 * ------------------------------------------------------------------
 * 目标：软件本体不绑死某一家模型，而是"填一个地址 + 一把密钥"就能用，
 * 各 FDE 跟着自己的密钥走，卖软件的同时把算力服务也接上。
 *
 * 平台文档里的控制台入口：
 *   https://ai.my10086.cn/api/console        密钥 / 用量
 *   https://ai.my10086.cn/api/console/skill  技能（一键对接说明）
 *
 * 只依赖 fetch，不引第三方 SDK，方便打包和离线排查。
 */

// 注意：ai.my10086.cn 是网页控制台（/v1 只会回 SPA 页面），真正的算力接口在 api.lk888.ai
const fs = require('fs');
const path = require('path');
const DEFAULT_BASE = 'https://api.lk888.ai/v1';
const CONSOLE = {
  home: 'https://ai.my10086.cn/home?menu=zhinengti',
  console: 'https://ai.my10086.cn/api/console',
  key: 'https://ai.my10086.cn/api/console/keys',
  keys: 'https://ai.my10086.cn/api/console/keys',
  skill: 'https://ai.my10086.cn/api/console/skill'
};
// 常见部署路径，自动探测时依次试；成功一个就停
const CANDIDATES = [
  'https://api.lk888.ai/v1',
  'https://ai.my10086.cn/v1',
  'https://ai.my10086.cn/api/v1',
  'https://ai.my10086.cn/openai/v1',
  'https://ai.my10086.cn/api/openai/v1',
  'https://ai.my10086.cn/moxing/v1',
  'https://api.my10086.cn/v1'
];

/** 把用户粘进来的地址整理成 base（允许直接粘 …/chat/completions 或 …/models） */
function normalizeBase(input) {
  let s = String(input || '').trim();
  if (!s) return DEFAULT_BASE;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '').replace(/\/models$/i, '').replace(/\/completions$/i, '');
  s = s.replace(/\/+$/, '');
  // 裸域名（没有路径）自动补 /v1：OpenAI 兼容接口几乎都在 /v1 下
  try { const u = new URL(s); if (u.pathname === '/' || u.pathname === '') s = s + '/v1'; } catch (e) {}
  return s;
}

function endpoints(base) {
  const b = normalizeBase(base);
  return {
    base: b,
    models: b + '/models',
    chat: b + '/chat/completions',
    // 媒体（图片/视频/音乐）与平台能力查询
    skills: b + '/skills/models',
    mediaModels: b + '/media/models',
    generate: b + '/media/generate',
    upload: b + '/media/upload',
    status: b + '/media/status',
    taskStatus: b + '/skills/task-status',
    balance: b + '/skills/balance'
  };
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '***';
  return s.slice(0, 5) + '…' + s.slice(-4);
}

function looksLikeKey(s) {
  const t = String(s || '').trim();
  return /^sk-[A-Za-z0-9_\-]{8,}$/.test(t) || /^[A-Za-z0-9_\-]{24,}$/.test(t);
}

function timeoutSignal(ms) {
  if (typeof AbortController === 'undefined') return { signal: undefined, done: () => {} };
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch (e) {} }, ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

async function requestJson(url, opts) {
  const o = opts || {};
  const t = timeoutSignal(o.timeout || 20000);
  let res;
  try {
    res = await fetch(url, {
      method: o.method || 'GET',
      headers: o.headers || {},
      body: o.body === undefined ? undefined : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)),
      signal: t.signal
    });
  } catch (e) {
    t.done();
    const msg = String(e && e.message || e);
    if (/abort/i.test(msg)) return { ok: false, error: '连接超时（' + Math.round((o.timeout || 20000) / 1000) + ' 秒）', kind: 'timeout' };
    if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(msg)) return { ok: false, error: '域名解析失败，检查地址或网络', kind: 'dns' };
    if (/self.signed|CERT|SSL|TLS/i.test(msg)) return { ok: false, error: '证书校验失败：' + msg, kind: 'tls' };
    return { ok: false, error: msg, kind: 'net' };
  }
  t.done();
  const ct = String(res.headers.get('content-type') || '');
  const raw = await res.text();
  let json = null;
  if (/json/i.test(ct) || /^\s*[[{]/.test(raw)) {
    try { json = JSON.parse(raw); } catch (e) { json = null; }
  }
  if (!json) {
    const html = /<html|<!doctype/i.test(raw);
    return {
      ok: false, status: res.status, raw: raw.slice(0, 300), kind: html ? 'html' : 'notjson',
      error: html
        ? '这个地址返回的是网页，不是接口（HTTP ' + res.status + '）。多半是路径不对，把地址改成 …/v1 再试。'
        : '接口返回的不是 JSON（HTTP ' + res.status + '）：' + raw.slice(0, 120)
    };
  }
  if (!res.ok) {
    const msg = (json.error && (json.error.message || json.error.code)) || json.message || json.msg || ('HTTP ' + res.status);
    return { ok: false, status: res.status, json, kind: res.status === 401 || res.status === 403 ? 'auth' : 'http', error: String(msg) };
  }
  return { ok: true, status: res.status, json };
}

/** 统一解析模型列表：兼容 OpenAI data[] / {models:[]} / {data:{list:[]}} 几种写法 */
function parseModels(json) {
  const pick = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.list) ? v.list : null);
  let arr = pick(json && json.data) || pick(json && json.models) || pick(json && json.result) || [];
  const out = [];
  for (const m of arr) {
    if (!m) continue;
    const id = typeof m === 'string' ? m : (m.id || m.模型id || m.model || m.name || m.模型名称 || m.名称 || m.标题 || m.key);
    if (!id) continue;
    if (out.some(x => x.id === id)) continue;
    const name = m.display_name || m.label || m.title || m.模型名称 || m.名称 || m.标题 || id;
    const owner = m.owned_by || m.owner || m.厂商 || m.厂商名 || '';
    out.push({ id: String(id), name: String(owner ? owner + ' · ' + name : name), owner: String(owner) });
  }
  return out;
}

/** 统一解析一次对话结果 */
function parseChat(json) {
  const j = json || {};
  let text = '';
  let usage = j.usage || null;
  if (Array.isArray(j.choices) && j.choices.length) {
    const c = j.choices[0] || {};
    const m = c.message || c.delta || {};
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) text = m.content.map(x => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
    else if (typeof c.text === 'string') text = c.text;
    if (!usage && c.usage) usage = c.usage;
  }
  if (!text && typeof j.output_text === 'string') text = j.output_text;
  if (!text && typeof j.content === 'string') text = j.content;
  if (!text && typeof j.text === 'string') text = j.text;
  if (!text && j.data && typeof j.data.content === 'string') text = j.data.content;
  return { text: String(text || '').trim(), usage, model: j.model || '' };
}

/**
 * 站点原生协议（照 ai.my10086.cn 前端包逐字复刻）
 * ------------------------------------------------------------------
 * 网站自己的画布/对话不走 OpenAI /v1，而是：
 *   POST /moxing/moxingliebiao       模型列表（中文字段）
 *   POST /moxing/tongyirukouchat     统一入口对话（SSE 流式）
 *   POST /moxing/liaotian/xuliu      按任务id续流
 * 鉴权头 token = 加密Token(密钥)，算法是前端 JiaMi 模块里的异或+base64。
 */

// S()：由混淆数组异或还原的密钥串（a=137，e=e*17+23&255 逐字节推进）
const SECRET_I = [188, 125, 42, 166, 175, 21, 53, 39, 111, 122, 214, 134, 92, 108, 3, 33,
  63, 102, 67, 255, 152, 119, 164, 104, 166, 113, 195, 231, 106, 99, 61, 121];
let _secret = null;
function siteSecret() {
  if (_secret !== null) return _secret;
  let a = 137, out = '';
  for (let i = 0; i < SECRET_I.length; i++) {
    out += String.fromCharCode(SECRET_I[i] ^ a);
    a = a * 17 + 23 & 255;
  }
  _secret = out;
  return out;
}

const ALPHA = {
  a: 'abcdefghijklmnopqrstuvwxyz', n: '0123456789',
  m: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  an: 'abcdefghijklmnopqrstuvwxyz0123456789',
  mn: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
};
function randStr(len, set) {
  let s = '';
  for (let i = 0; i < len; i++) s += set[Math.floor(Math.random() * set.length)];
  return s;
}
// v()：每次加密前置一段随机干扰串（网站原样，服务器按 '|' 截掉）
function decoyPrefix() {
  return randStr(5, ALPHA.a) + '.' + randStr(3, ALPHA.n) + '@' + randStr(6, ALPHA.m) +
    '-' + randStr(4, ALPHA.an) + '=' + randStr(6, ALPHA.mn);
}

function utf8Bytes(s) {
  return Array.from(new TextEncoder().encode(s));
}
function b64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function unb64(s) {
  return Array.from(Buffer.from(String(s || ''), 'base64'));
}

/** 加密Token（与网站 C() 一致：加7 → 异或密钥 → 倒序 → base64） */
function encryptToken(raw) {
  const secret = utf8Bytes(siteSecret());
  let bytes = utf8Bytes(decoyPrefix() + '|' + String(raw || '')).map(b => (b + 7) % 256);
  const mixed = bytes.map((b, i) => b ^ secret[i % secret.length]);
  mixed.reverse();
  return b64(mixed);
}

/** 解密Token（与网站 E() 一致，测试用） */
function decryptToken(enc) {
  try {
    let t = unb64(enc).slice().reverse();
    const secret = utf8Bytes(siteSecret());
    const x = new Array(t.length);
    for (let i = 0; i < t.length; i++) x[i] = t[i] ^ secret[i % secret.length];
    const s = Buffer.from(x.map(b => ((b - 7) + 256) % 256)).toString('utf-8');
    const p = s.indexOf('|');
    return p < 0 ? '' : s.substring(p + 1);
  } catch (e) { return ''; }
}

/** 站点接口基址：Z.baseURL 站外无法确认，常见的就「同源」和「/api 前缀」两种 */
function siteApiBases(siteBase) {
  const o = String(siteBase || '').replace(/\/+$/, '');
  return [o, o + '/api'];
}

function siteHeaders(rawKey) {
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json',
    'x-kongjian': 'geren',
    token: encryptToken(rawKey)
  };
}

/** 站点模型列表（字段中文名，宽容解析） */
async function siteModels(cfg, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const origin = normalizeBase(c.baseUrl).replace(/\/v1$/i, '');
  const lastErr = [];
  for (const api of siteApiBases(origin)) {
    const r = await requestJson(api + '/moxing/moxingliebiao', {
      method: 'POST', headers: siteHeaders(key), body: { page: 0 },
      timeout: (opts && opts.timeout) || 15000
    });
    if (!r.ok) { lastErr.push(r.error); continue; }
    const models = parseModels(r.json);
    if (!models.length) { lastErr.push('接口通了但没有模型（HTTP ' + r.status + '）'); continue; }
    return { ok: true, models, base: api, protocol: 'site' };
  }
  return { ok: false, error: lastErr[lastErr.length - 1] || '站点模型列表拉不到', kind: 'http' };
}

/** 从 SSE 的一行 data 里抠出正文（字段中英文都认，拦截/心跳事件丢弃） */
function sseDelta(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  let t = obj.content;
  if (typeof t !== 'string') t = obj.内容;
  if (typeof t !== 'string' && obj.delta && typeof obj.delta.content === 'string') t = obj.delta.content;
  if (typeof t !== 'string' && obj.data && typeof obj.data.content === 'string') t = obj.data.content;
  if (typeof t !== 'string' && obj.choices && obj.choices[0]) {
    const m = obj.choices[0].delta || obj.choices[0].message || {};
    if (typeof m.content === 'string') t = m.content;
  }
  return typeof t === 'string' ? t : '';
}

/**
 * 站点统一入口对话：POST /moxing/tongyirukouchat，SSE 流式。
 * payload.model 当作 模型id 用；payload.messages 拼成 用户消息（站点只收一条）。
 */
async function siteChat(cfg, payload, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const model = String((payload && payload.model) || c.model || '').trim();
  if (!model) return { ok: false, error: '还没选模型', kind: 'nomodel' };
  const msgs = (payload && payload.messages) || [];
  const userMsg = msgs.map(m => (m.role === 'system' ? m.content + '\n\n' : m.content)).join('\n\n');
  const origin = normalizeBase(c.baseUrl).replace(/\/v1$/i, '');
  const t = timeoutSignal((opts && opts.timeout) || 120000);
  let lastErr = null;
  try {
    for (const api of siteApiBases(origin)) {
      let res;
      try {
        res = await fetch(api + '/moxing/tongyirukouchat', {
          method: 'POST',
          headers: siteHeaders(key),
          body: JSON.stringify({ 模型id: model, 用户消息: userMsg }),
          signal: t.signal
        });
      } catch (e) {
        lastErr = String(e && e.message || e);
        continue;
      }
      const ct = String(res.headers.get('content-type') || '');
      if (!res.ok) {
        const raw = await res.text();
        lastErr = 'HTTP ' + res.status + '：' + raw.slice(0, 120);
        continue;
      }
      if (/json/i.test(ct)) {
        // 没走流式，直接回 JSON
        const j = await res.json().catch(() => null);
        const p = parseChat(j);
        if (!p.text) return { ok: false, error: '站点返回了空内容', kind: 'empty', base: api, protocol: 'site' };
        return { ok: true, text: p.text, usage: p.usage, model, base: api, protocol: 'site', taskId: (j && (j.任务id || (j.data && j.data.任务id))) || '' };
      }
      // SSE 流式（先窥探首块：同源路径可能返回 SPA 网页，那就换下一个基址）
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', text = '', taskId = '', sessionId = '', intercepted = '';
      const head = await reader.read();
      if (head.done) { lastErr = '站点返回了空流'; continue; }
      buf = dec.decode(head.value, { stream: true });
      if (/<html|<!doctype|\{spoof/i.test(buf) || /text\/html/i.test(ct)) {
        try { await reader.cancel(); } catch (e) {}
        lastErr = '这个基址返回的是网页而不是接口';
        continue;
      }
      const feed = (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data: ')) continue;
          const d = line.slice(6);
          if (d === '[DONE]') return true;
          let j = null;
          try { j = JSON.parse(d); } catch (e) {
            const s = d.trim();
            if (!s.startsWith('{') && !s.startsWith('[')) text += s;
            continue;
          }
          if (j) {
            if (j.是否拦截) { intercepted = j.提示标题 ? (j.提示标题 + '：' + (j.提示内容 || '')) : '内容被平台拦截'; return true; }
            if (j.任务id) taskId = j.任务id;
            if (j.会话id) sessionId = j.会话id;
            if (j.错误 || j.error) { lastErr = String(j.错误 || (j.error && j.error.message) || j.error); continue; }
            text += sseDelta(j);
          }
        }
        return false;
      };
      let done = false;
      for (;;) {
        const { value, done: rdDone } = await reader.read();
        if (rdDone) break;
        if (feed(dec.decode(value, { stream: true }))) { done = true; break; }
      }
      if (!done) feed('\n');
      t.done();
      if (intercepted) return { ok: false, error: intercepted, kind: 'blocked', base: api, protocol: 'site' };
      if (!text.trim()) {
        if (taskId) return { ok: true, text: '', taskId, base: api, protocol: 'site', pending: true };
        return { ok: false, error: lastErr || '站点流式返回里没有内容', kind: 'empty', base: api, protocol: 'site' };
      }
      return { ok: true, text: text.trim(), model, base: api, protocol: 'site', taskId, sessionId };
    }
    t.done();
    const msg = /abort/i.test(String(lastErr)) ? '连接超时' : (lastErr || '站点接口连不上');
    return { ok: false, error: msg, kind: /abort/i.test(String(lastErr)) ? 'timeout' : 'net' };
  } catch (e) {
    t.done();
    return { ok: false, error: String(e && e.message || e), kind: 'net' };
  }
}

/** 断流续传：按任务id接着拉（网站 /moxing/liaotian/xuliu） */
async function siteResume(cfg, taskId, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key || !taskId) return { ok: false, error: '缺密钥或任务id', kind: 'nokey' };
  const origin = normalizeBase(c.baseUrl).replace(/\/v1$/i, '');
  for (const api of siteApiBases(origin)) {
    const r = await requestJson(api + '/moxing/liaotian/xuliu', {
      method: 'POST', headers: siteHeaders(key), body: { 任务id: taskId },
      timeout: (opts && opts.timeout) || 60000
    });
    if (r.ok) {
      const p = parseChat(r.json);
      if (p.text) return { ok: true, text: p.text, model: c.model || '', base: api, protocol: 'site', taskId };
    }
  }
  return { ok: false, error: '续流没拿到内容（任务可能已过期）', kind: 'empty' };
}

/** 拉模型列表（按协议分流：openai=兼容接口 / site=站点原生） */
async function listModels(cfg, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  if (c.protocol === 'site') return siteModels(c, opts);
  const ep = endpoints(c.baseUrl);
  const r = await requestJson(ep.models, {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
    timeout: (opts && opts.timeout) || 15000
  });
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind, base: ep.base };
  const models = parseModels(r.json);
  if (!models.length) return { ok: false, error: '接口通了，但没返回模型（可能是权限或分组问题）', kind: 'empty', base: ep.base };
  return { ok: true, models, base: ep.base };
}

/**
 * 平台模型目录（含类型与参数定义）
 * ------------------------------------------------------------------
 * 首选 GET /v1/skills/models（一次拿全，带展示名/标签/图标/中文文案）；
 * 老部署没有这个接口时退回 /v1/media/models?type=image|video|audio（带 params 定义）。
 * 两个都没有就返回空目录，界面提示"这家的接口没有模型目录"。
 */
async function catalog(cfg, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const ep = endpoints(c.baseUrl);
  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Accept-Language': 'zh-CN' };
  const timeout = (opts && opts.timeout) || 20000;

  const r = await requestJson(ep.skills, { headers, timeout });
  if (r.ok) {
    const j = r.json || {};
    const list = Array.isArray(j.models) ? j.models : (Array.isArray(j.data) ? j.data : []);
    if (list.length) return { ok: true, raw: list, base: ep.base, source: 'skills' };
  }
  // 兼容老接口：按类型逐个取，参数定义更全
  const acc = [];
  let errs = 0;
  for (const t of ['image', 'video', 'audio']) {
    const rr = await requestJson(ep.mediaModels + '?type=' + t, { headers, timeout });
    if (rr.ok) {
      const list = (rr.json && (rr.json.models || rr.json.data)) || [];
      for (const m of (Array.isArray(list) ? list : [])) acc.push(Object.assign({ type: t }, m));
    } else errs++;
  }
  if (acc.length) return { ok: true, raw: acc, base: ep.base, source: 'media' };
  return { ok: false, error: r.error || '这家的接口没有模型目录', kind: r.kind || 'empty', base: ep.base };
}

/** 单个模型的参数定义（画布上要按它生成表单） */
async function modelDetail(cfg, modelName, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const ep = endpoints(c.baseUrl);
  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Accept-Language': 'zh-CN' };
  const nm = String(modelName || '');
  // 名字里带斜杠（kimi/kimi-k2.7-code）时按平台建议走占位路径 + ?model=，避免转义歧义
  const url = nm.includes('/')
    ? ep.skills + '/-?model=' + encodeURIComponent(nm)
    : ep.skills + '/' + encodeURIComponent(nm);
  const r = await requestJson(url, { headers, timeout: (opts && opts.timeout) || 15000 });
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  const j = r.json || {};
  return { ok: true, model: j.model || j.data || j };
}

/** 提交媒体生成任务（图片 / 视频 / 音乐 / 语音）→ { ok, taskId } */
async function mediaGenerate(cfg, body, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const ep = endpoints(c.baseUrl);
  const r = await requestJson(ep.generate, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body || {},
    timeout: (opts && opts.timeout) || 60000
  });
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind, raw: r.json };
  return { ok: true, json: r.json, base: ep.base };
}

/**
 * 上传本地素材 → 平台返回公网直链。
 * 平台的 /v1/media/upload 是 multipart（字段名 file），回 { url: "https://cos..." }。
 * 图片/音频/视频都能传；传完把 url 填进 generate 的对应参数即可。
 */
async function mediaUpload(cfg, filePath, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const p = String(filePath || '');
  if (!p) return { ok: false, error: '没选文件' };
  let buf;
  try { buf = await fs.promises.readFile(p); } catch (e) { return { ok: false, error: '读不到文件：' + (e.message || e) }; }
  const maxMB = (opts && opts.maxMB) || 200;
  if (buf.length > maxMB * 1024 * 1024) return { ok: false, error: '文件 ' + (buf.length / 1048576).toFixed(1) + 'MB，超过 ' + maxMB + 'MB' };
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const ep = endpoints(c.baseUrl);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), path.basename(p));
  const t = timeoutSignal((opts && opts.timeout) || 180000);
  let res;
  try {
    res = await fetch(ep.upload, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      body: fd,
      signal: t.signal
    });
  } catch (e) {
    t.done();
    return { ok: false, error: '上传失败：' + (e.message || e), kind: 'net' };
  }
  t.done();
  const raw = await res.text();
  let j = null;
  try { j = JSON.parse(raw); } catch (e) { j = null; }
  if (!j) return { ok: false, error: '上传接口返回的不是 JSON（HTTP ' + res.status + '）', raw: raw.slice(0, 200) };
  const url = j.url || (j.data && (j.data.url || j.data.file_url)) || (Array.isArray(j.urls) ? j.urls[0] : '');
  if (url) return { ok: true, url: String(url), name: path.basename(p), size: buf.length, mime };
  const msg = j.msg || j.message || (j.error && (j.error.message || j.error.code)) || ('HTTP ' + res.status);
  return { ok: false, error: String(msg), raw: j };
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  bmp: 'image/bmp', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', amr: 'audio/amr'
};

/** 查任务状态（优先增强版 /v1/skills/task-status，老部署退回 /v1/media/status） */
async function mediaStatus(cfg, taskId, opts) {
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  if (!Number(taskId)) return { ok: false, error: '任务 ID 不对' };
  const ep = endpoints(c.baseUrl);
  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Accept-Language': 'zh-CN' };
  const t = (opts && opts.timeout) || 20000;
  const a = await requestJson(ep.taskStatus + '?task_id=' + Number(taskId), { headers, timeout: t });
  if (a.ok && a.json && (a.json.state || a.json.status || a.json.task_id)) return { ok: true, json: a.json };
  const b = await requestJson(ep.status + '?task_id=' + Number(taskId), { headers, timeout: t });
  if (b.ok) return { ok: true, json: b.json };
  return { ok: false, error: b.error || a.error, kind: b.kind || a.kind };
}

/** 余额（钱够不够跑媒体模型，跑之前看一眼） */
async function balance(cfg, opts) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const ep = endpoints(c.baseUrl);
  const r = await requestJson(ep.balance, {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json', 'Accept-Language': 'zh-CN' },
    timeout: (opts && opts.timeout) || 15000
  });
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  return { ok: true, json: r.json };
}

/** 发一次对话（按协议分流） */
async function chat(cfg, payload, opts) {  const c = cfg || {};
  if (c.protocol === 'site') return siteChat(c, payload, opts);
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, error: '还没填密钥', kind: 'nokey' };
  const model = String((payload && payload.model) || c.model || '').trim();
  if (!model) return { ok: false, error: '还没选模型', kind: 'nomodel' };
  const ep = endpoints(c.baseUrl);
  const body = {
    model,
    messages: (payload && payload.messages) || [],
    stream: false
  };
  if (payload && typeof payload.temperature === 'number') body.temperature = payload.temperature;
  if (payload && typeof payload.maxTokens === 'number') body.max_tokens = payload.maxTokens;
  const r = await requestJson(ep.chat, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    timeout: (opts && opts.timeout) || 120000
  });
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind, base: ep.base };
  const p = parseChat(r.json);
  if (!p.text) return { ok: false, error: '模型返回了空内容', kind: 'empty', base: ep.base, raw: r.json };
  return { ok: true, text: p.text, usage: p.usage, model: p.model || model, base: ep.base };
}

/**
 * 自动找接口：用给定密钥依次试候选地址，第一个能列出模型的就是它。
 * 用户不知道 base 该写什么的时候，点一下比手动试快得多。
 */
async function detect(cfg) {
  const key = String((cfg && cfg.apiKey) || '').trim();
  if (!key) return { ok: false, error: '先填密钥，再自动找接口', kind: 'nokey' };
  const tries = [];
  const seen = new Set();
  const list = [normalizeBase(cfg.baseUrl)].concat(CANDIDATES);
  for (const b of list) {
    if (seen.has(b)) continue;
    seen.add(b);
    const r = await listModels({ baseUrl: b, apiKey: key }, { timeout: 12000 });
    tries.push({ base: b, ok: r.ok, error: r.error || '', count: r.ok ? r.models.length : 0 });
    if (r.ok) return { ok: true, base: r.base, models: r.models, tries, protocol: 'openai' };
  }
  // OpenAI 兼容路径全军覆没 → 试站点原生协议（统一入口 / 模型列表）
  const origin = normalizeBase(cfg.baseUrl).replace(/\/v1$/i, '');
  const s = await siteModels({ baseUrl: origin, apiKey: key }, { timeout: 12000 });
  tries.push({ base: origin + '（站点原生）', ok: s.ok, error: s.error || '', count: s.ok ? s.models.length : 0 });
  if (s.ok) return { ok: true, base: origin, models: s.models, tries, protocol: 'site' };
  return { ok: false, error: '试了 ' + tries.length + ' 个常见地址都连不上', tries, kind: 'allfail' };
}

/** 自定义/本地模型供应商：校验与钳制（Ollama/LM Studio/vLLM 等 OpenAI 兼容端点） */
function sanitizeProviders(list) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : []).slice(0, 10)) {
    if (!p || typeof p !== 'object') continue;
    const raw = String(p.baseUrl || '');
    const baseUrl = normalizeBase(raw);
    if (!baseUrl || !/^https?:\/\//.test(raw)) continue;
    out.push({
      id: String(p.id || 'pv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 24),
      name: String(p.name || '自定义').slice(0, 30),
      baseUrl,
      apiKey: String(p.apiKey || '').slice(0, 200),
      models: (Array.isArray(p.models) ? p.models : []).map(x => String(x).slice(0, 80)).slice(0, 100),
      local: !!p.local
    });
  }
  return out;
}

/**
 * 交付文件对外分发前的清洗：默认把 apiKey 剥掉。
 * 便携版/安装包是给别人的，带着密钥等于把这条 key 送出去；
 * 只有 "shareKey": true（渠道统一买单）才保留。
 */
function sanitizeDelivery(d) {
  const o = Object.assign({}, d || {});
  if (o.shareKey !== true) delete o.apiKey;
  return o;
}

/**
 * 交付配置：预置「接口地址 + 模型清单」，可选预置渠道密钥。
 *
 * 默认不种密钥 —— 把软件给别的 FDE 用，密钥必须各人填自己的，
 * 否则全团队都在烧同一个 key（而且在别人机器上能看到"已接上"）。
 * 只有交付文件里显式写 "shareKey": true（渠道统一买单）才把 apiKey 种进去。
 */
function seedDelivery(saved, delivery) {
  const s = saved || {};
  const d = delivery || {};
  const shareKey = d.shareKey === true;
  const key = String(d.apiKey || '').trim();
  if (shareKey && !looksLikeKey(key)) return { ok: false, reason: '交付文件里的密钥格式不对' };
  // 已经配过（有 updatedAt / 自己填过密钥）就不再动，免得每次启动把用户的选择冲掉
  if (String(s.apiKey || '').trim() || s.updatedAt) return { ok: false, reason: '已配置过，不覆盖' };
  return {
    ok: true,
    keySeeded: shareKey,
    config: {
      baseUrl: normalizeBase(d.baseUrl || DEFAULT_BASE),
      // 不是 shareKey 就留空：让对方自己贴，界面显示"未接"
      apiKey: shareKey ? key : '',
      model: String(d.model || '').trim(),
      // 统一存 {id,name} 对象，跟 listModels 的返回一致（界面按 m.id/m.name 渲染）
      models: Array.isArray(d.models)
        ? d.models.map((m) => {
            if (typeof m === 'string') return String(m).trim() ? { id: String(m).trim(), name: String(m).trim() } : null;
            if (m && m.id) return { id: String(m.id), name: String(m.name || m.id) };
            return null;
          }).filter(Boolean).slice(0, 300)
        : [],
      protocol: d.protocol === 'site' ? 'site' : 'openai',
      delivered: shareKey,
      deliveredLabel: shareKey ? String(d.label || '渠道密钥').slice(0, 30) : '',
      updatedAt: Date.now()
    }
  };
}

/** 状态：给界面用的一句话结论 */
function status(cfg) {
  const c = cfg || {};
  const hasKey = !!String(c.apiKey || '').trim();
  const model = String(c.model || '').trim();
  const tag = (c.delivered ? '（渠道预置）' : '') + (c.protocol === 'site' ? '（站点原生）' : '');
  if (!hasKey) return { level: 'off', text: '还没接算力：填密钥就能在画布里直接跑模型' };
  if (!model) return { level: 'half', text: '密钥有了，还差选一个模型' };
  if (model === 'auto') return { level: 'on', text: '已接上：自动挑模型（按任务选最合适的，失败自动换）' + tag };
  return { level: 'on', text: '已接上 ' + model + tag };
}

module.exports = {
  DEFAULT_BASE, CONSOLE, CANDIDATES,
  normalizeBase, endpoints, maskKey, looksLikeKey,
  requestJson, parseModels, parseChat,
  encryptToken, decryptToken, siteSecret,
  siteModels, siteChat, siteResume, sseDelta,
  listModels, chat, detect, status, seedDelivery, sanitizeDelivery, sanitizeProviders,
  catalog, modelDetail, mediaGenerate, mediaUpload, mediaStatus, balance
};
