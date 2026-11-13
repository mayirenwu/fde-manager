/**
 * 知识库引擎（纯本地，无第三方依赖）
 * ─────────────────────────────────────────────────────────────
 * 负责：文本抽取（txt/md/csv/json/html/code/docx/xlsx/pptx）
 *      切块 → 分词（中文二元 + 英文单词）→ 建索引 → BM25 检索
 *      摘要 / 标签（本地启发式，接不接算力都能用）
 *
 * 设计取向：知识库是"地基"，必须离线可用、可迁移、可解释。
 * 所以不引外部包、不做向量库，检索结果能指回原文第几段。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const VERSION = 1;

/** 可导入的文本类扩展名 */
const TEXT_EXTS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.yml', '.yaml',
  '.html', '.htm', '.xml', '.sql', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.css', '.sh', '.ps1', '.bat', '.ini', '.conf'];
/** 能抽文本的办公文件 */
const DOC_EXTS = ['.docx', '.xlsx', '.pptx'];
/** 明确不支持的（给出人话指引） */
const UNSUPPORTED = ['.pdf', '.doc', '.xls', '.ppt', '.zip', '.rar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mp3', '.exe', '.dll'];

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', '$recycle.bin', 'system volume information',
  'windows', 'program files', 'program files (x86)', 'programdata', 'appdata']);

/** 六类库的骨架字段：建库先定用途，知识才可被复用 */
const KINDS = [
  { id: 'solution', name: '方案库', hint: '做过的方案、报价、SOP：下次遇到同类需求直接拼', fields: ['适用场景', '交付物', '周期', '报价区间', '风险点'] },
  { id: 'client', name: '客户库', hint: '客户背景、痛点、决策链：谈之前先看一遍', fields: ['客户名', '行业', '规模', '痛点', '决策人角色', '预算区间'] },
  { id: 'delivery', name: '交付库', hint: '项目过程与验收：避免同一个坑踩两次', fields: ['项目', '阶段', '关键动作', '验收标准', '遗留问题'] },
  { id: 'selection', name: '选品库', hint: '品的价格、毛利、竞争度：卖货台的底座', fields: ['品名', '售价', '拿货价', '毛利', '竞争度', '卖点'] },
  { id: 'compliance', name: '合规库', hint: '平台规则、法规条款、红线：文案过审靠它', fields: ['平台/法规', '条款', '红线', '处罚', '来源'] },
  { id: 'case', name: '案例库', hint: '做过的事与结果数据：写标书、谈客户都用得上', fields: ['场景', '做法', '结果数据', '可复用点'] },
  { id: 'general', name: '通用库', hint: '暂不确定用途的资料，先扔进来，后面再分', fields: ['主题', '用途'] }
];

/* ============================ 文本抽取 ============================ */

function hash(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

/** 缓冲区 → 字符串：先 UTF-8，乱码率高就按 GBK 再试一次 */
function decode(buf) {
  let s = buf.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;
  if (bad > 0 && bad > s.length * 0.002) {
    try {
      const alt = new TextDecoder('gbk').decode(buf);
      if ((alt.match(/\uFFFD/g) || []).length < bad) s = alt;
    } catch (e) {}
  }
  return s.replace(/^\uFEFF/, '');
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function unent(s) {
  return String(s).replace(/&[a-z#0-9]+;/gi, (m) => {
    if (ENT[m.toLowerCase()]) return ENT[m.toLowerCase()];
    const n = m.match(/^&#(\d+);$/);
    if (n) { try { return String.fromCharCode(Number(n[1])); } catch (e) { return ' '; } }
    return ' ';
  });
}

function stripHtml(html) {
  return unent(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 读 zip 里的若干条目（docx/xlsx/pptx 本质都是 zip） */
function zipEntries(buf, filter) {
  const out = [];
  let eocd = -1;
  const from = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (!filter || filter(name)) {
      try {
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.slice(start, start + compSize);
        out.push({ name, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
      } catch (e) { /* 单条坏了不影响其它 */ }
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function xmlToText(xml) {
  return unent(String(xml)
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDocx(buf) {
  const parts = zipEntries(buf, (n) => n === 'word/document.xml');
  return parts.length ? xmlToText(parts[0].data.toString('utf8')) : '';
}

function extractXlsx(buf) {
  const parts = zipEntries(buf, (n) => n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = parts.filter((p) => /sharedStrings/.test(p.name)).map((p) => p.data.toString('utf8')).join('');
  const cells = [];
  for (const m of shared.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) cells.push(unent(m[1]).trim());
  for (const p of parts.filter((x) => /worksheets/.test(x.name))) {
    const xml = p.data.toString('utf8');
    // 只取内联字符串与数字，够做人名/品名/金额的检索
    for (const m of xml.matchAll(/<c[^>]*?(?:t="inlineStr")?[^>]*>([\s\S]*?)<\/c>/g)) {
      const t = m[1].match(/<t[^>]*>([\s\S]*?)<\/t>/);
      const v = m[1].match(/<v>([\s\S]*?)<\/v>/);
      if (t) cells.push(unent(t[1]).trim());
      else if (v) cells.push(v[1].trim());
    }
  }
  return cells.filter(Boolean).join('\n');
}

function extractPptx(buf) {
  const parts = zipEntries(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  parts.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return parts.map((p) => xmlToText(p.data.toString('utf8'))).filter(Boolean).join('\n\n---\n\n');
}

/** 统一入口：返回 { ok, text, kind } */
function extractText(file, buf) {
  const ext = path.extname(file).toLowerCase();
  const b = buf || fs.readFileSync(file);
  try {
    if (DOC_EXTS.includes(ext)) {
      let t = '';
      if (ext === '.docx') t = extractDocx(b);
      else if (ext === '.xlsx') t = extractXlsx(b);
      else t = extractPptx(b);
      if (!t) return { ok: false, error: '这个 ' + ext + ' 里没抽到文字（可能是扫描件/纯图表格）' };
      return { ok: true, text: t, kind: 'office' };
    }
    if (ext === '.html' || ext === '.htm' || ext === '.xml') {
      return { ok: true, text: stripHtml(decode(b)), kind: 'html' };
    }
    if (UNSUPPORTED.includes(ext)) {
      return { ok: false, error: ext + ' 暂不支持直接读：先另存为 txt/md 或 docx 再导入' };
    }
    return { ok: true, text: decode(b), kind: 'text' };
  } catch (e) {
    return { ok: false, error: '读取失败：' + e.message };
  }
}

/* ============================ 切块 ============================ */

/** 按段落聚成 ~size 字的块，块间留 overlap 字，便于命中上下文 */
function chunk(text, opts) {
  const size = (opts && opts.size) || 900;
  const overlap = (opts && opts.overlap) || 120;
  const src = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!src) return [];
  const paras = src.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  let seq = 0;
  const push = () => {
    if (!cur.trim()) return;
    out.push({ i: seq++, text: cur.trim() });
    cur = overlap > 0 ? cur.slice(-overlap) : '';
  };
  for (const p of paras) {
    if (p.length > size * 1.6) {
      // 超长段落按句子切
      const sents = p.split(/(?<=[。！？；\.\!\?;])\s*/);
      for (const s of sents) {
        if ((cur + s).length > size) push();
        cur += s;
      }
      continue;
    }
    if ((cur + '\n\n' + p).length > size) push();
    cur += (cur ? '\n\n' : '') + p;
  }
  if (cur.trim()) out.push({ i: seq++, text: cur.trim() });
  return out;
}

/* ============================ 分词 ============================ */

const STOP = new Set(('的 了 和 是 在 我 有 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 '
  + 'the a an and or of to in for on with is are was were be been it this that as at by from we you they '
  + '我们的 我们 他们 可以 需要 什么 怎么 这个 那个 因为 所以 但是 如果 已经 还是 就是 这样 一些 通过 进行 以及 或者').split(/\s+/));

const isCJK = (ch) => /[\u4e00-\u9fa5]/.test(ch);

/** 中文按二元切（"适老改造"→适老/老改/改造），英文数字按词 */
function tokenize(s) {
  const text = String(s || '').toLowerCase();
  const out = [];
  const m = text.match(/[a-z0-9_]+|[\u4e00-\u9fa5]+/g) || [];
  for (const seg of m) {
    if (isCJK(seg[0])) {
      if (seg.length === 1) { if (!STOP.has(seg)) out.push(seg); continue; }
      for (let i = 0; i + 2 <= seg.length; i++) {
        const g = seg.slice(i, i + 2);
        if (!STOP.has(g)) out.push(g);
      }
    } else if (seg.length > 1 && !STOP.has(seg)) {
      out.push(seg);
    }
  }
  return out;
}

/* ============================ 检索（BM25） ============================ */

function docFields(d) {
  return {
    title: d.title || d.name || '',
    text: d.text || ''
  };
}

function buildIndex(docs) {
  const post = new Map();      // token -> Map(docIdx -> tf)
  const lens = [];
  const list = docs || [];
  for (let i = 0; i < list.length; i++) {
    const f = docFields(list[i]);
    const bodyTokens = tokenize(f.text);
    const titleTokens = tokenize(f.title + ' ' + (list[i].rel || '') + ' ' + (list[i].tags || []).join(' '));
    const tf = new Map();
    for (const t of bodyTokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of titleTokens) tf.set(t, (tf.get(t) || 0) + 3); // 标题/路径命中加权
    for (const [t, n] of tf) {
      if (!post.has(t)) post.set(t, new Map());
      post.get(t).set(i, n);
    }
    lens.push(Math.max(1, bodyTokens.length + titleTokens.length));
  }
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  return { post, lens, avg, n: list.length };
}

function snippet(text, tokens, len) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const L = len || 150;
  let at = -1;
  let hitToken = '';
  for (const tk of tokens) {
    if (!tk) continue;
    const i = t.toLowerCase().indexOf(tk.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) { at = i; hitToken = tk; }
  }
  if (at < 0) return { text: t.slice(0, L) + (t.length > L ? '…' : ''), at: 0 };
  const start = Math.max(0, at - Math.floor(L / 3));
  return {
    text: (start > 0 ? '…' : '') + t.slice(start, start + L) + (start + L < t.length ? '…' : ''),
    at, token: hitToken
  };
}

/** 检索：返回 [{docIdx, score, snippet, hits}]，按分数降序 */
function searchDocs(docs, query, opts) {
  const list = docs || [];
  const q = String(query || '').trim();
  if (!q || !list.length) return [];
  const qTokens = Array.from(new Set(tokenize(q)));
  if (!qTokens.length) return [];
  const idx = (opts && opts.indexFor && opts.indexFor.length === list.length) ? opts.indexFor : buildIndex(list);
  const k1 = 1.2;
  const b = 0.75;
  const scores = new Map();
  const hitMap = new Map();
  for (const tk of qTokens) {
    const m = idx.post.get(tk);
    if (!m) continue;
    const df = m.size;
    const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
    for (const [i, tf] of m) {
      const dl = idx.lens[i] || 1;
      const s = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / idx.avg));
      scores.set(i, (scores.get(i) || 0) + s);
      if (!hitMap.has(i)) hitMap.set(i, []);
      hitMap.get(i).push(tk);
    }
  }
  const out = [];
  for (const [i, score] of scores) {
    const d = list[i];
    // 短语整串命中额外加分（"适老改造"连写比分开命中更相关）
    const raw = (d.title || '') + ' ' + (d.text || '');
    const whole = raw.indexOf(q) >= 0 ? score * 0.5 : 0;
    out.push({
      docIdx: i,
      doc: d,
      score: Number((score + whole).toFixed(4)),
      hits: Array.from(new Set(hitMap.get(i) || [])),
      snippet: snippet(d.text || '', qTokens, (opts && opts.snippetLen) || 160)
    });
  }
  out.sort((a, b2) => b2.score - a.score);
  const limit = (opts && opts.limit) || 20;
  return out.slice(0, limit);
}

/* ============================ 摘要 / 标签 ============================ */

function firstHeading(text) {
  const lines = String(text || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines.slice(0, 12)) {
    const m = l.match(/^#{1,3}\s+(.+)$/);
    if (m) return m[1].trim();
  }
  const t = lines.find((l) => l.length >= 6 && l.length <= 60 && !/^[-*|>]/.test(l));
  return t ? t.slice(0, 60) : '';
}

function summarize(name, text) {
  const t = String(text || '');
  const body = t.replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();
  const title = firstHeading(t) || String(name || '').replace(/\.[^.]+$/, '');
  const summary = body.slice(0, 140) + (body.length > 140 ? '…' : '');
  const freq = new Map();
  for (const tk of tokenize(t.slice(0, 6000))) {
    if (tk.length < 2) continue;
    freq.set(tk, (freq.get(tk) || 0) + 1);
  }
  const tags = Array.from(freq.entries())
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);
  return { title: title.slice(0, 80), summary, tags, chars: body.length };
}

/** 内容指纹：同样内容改名/换路径不重复入库 */
function fingerprint(text) {
  const norm = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return crypto.createHash('md5').update(norm).digest('hex');
}

/* ============================ 问答提示词 ============================ */

function askPrompt(question, hits) {
  const ctx = (hits || []).map((h, i) => {
    const d = h.doc || {};
    return '【资料 ' + (i + 1) + '】' + (d.title || d.name || '') + '\n' + String(d.text || h.snippet && h.snippet.text || '').slice(0, 1800);
  }).join('\n\n');
  return [
    '你是企业知识库助手。只依据下面【资料】回答，不要编造。',
    '规则：',
    '1. 每条关键结论后用 [资料 n] 标注来源；',
    '2. 资料里没有的，直接说“知识库里没有这部分”，并给一句该补什么资料；',
    '3. 回答用中文，分点、短句，不超过 300 字；',
    '4. 如果问题需要跨多份资料，先给结论再列依据。',
    '',
    '【资料】',
    ctx || '（没有检索到相关资料）',
    '',
    '【问题】' + question
  ].join('\n');
}

/** 从模型回复里抽出引用了哪几段（[资料 2] / 【资料2】都认） */
function citations(answer) {
  const set = new Set();
  for (const m of String(answer || '').matchAll(/[\[【]资料\s*(\d+)[\]】]/g)) set.add(Number(m[1]));
  return Array.from(set).sort((a, b) => a - b);
}

/** 扫描目录：递归、跳过依赖/系统目录、白名单扩展名、限量 */
function scanDir(root, opts) {  const o = opts || {};
  const maxFiles = o.maxFiles || 4000;
  const maxBytes = o.maxBytes || 8 * 1024 * 1024;
  const exts = new Set((o.exts || TEXT_EXTS.concat(DOC_EXTS)).map((e) => e.toLowerCase()));
  const files = [];
  const skipped = { dir: 0, ext: 0, size: 0, hidden: 0 };
  const walk = (dir, depth) => {
    if (files.length >= maxFiles || depth > 12) return;
    let ent = [];
    try { ent = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ent) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.') || e.name === 'Thumbs.db' || e.name === 'desktop.ini') { skipped.hidden++; continue; }
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name.toLowerCase())) { skipped.dir++; continue; }
        walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!exts.has(ext)) { skipped.ext++; continue; }
      let st = null;
      try { st = fs.statSync(full); } catch (err) { continue; }
      if (st.size > maxBytes) { skipped.size++; continue; }
      files.push({
        path: full,
        rel: path.relative(root, full).replace(/\\/g, '/'),
        name: e.name,
        ext,
        size: st.size,
        mtime: st.mtimeMs
      });
    }
  };
  walk(root, 0);
  return { ok: true, root, files, skipped, truncated: files.length >= maxFiles };
}

/* ============================ 存储（库 + 文档） ============================ */

/**
 * 一个知识库存储实例。
 * 元数据放 <root>/kb-data.json，正文一篇一个 txt 放 <root>/text/<id>.txt：
 * 既避免 JSON 膨胀，又让资料在磁盘上始终是"人能直接打开"的文件。
 */
function createStore(rootDir) {
  const root = rootDir;
  const metaPath = () => path.join(root, 'kb-data.json');
  const textDir = () => path.join(root, 'text');
  const textPath = (id) => path.join(textDir(), String(id).replace(/[^\w-]/g, '') + '.txt');
  const cache = new Map();
  let idxCache = null;

  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
      return {
        version: 1,
        libs: Array.isArray(s.libs) ? s.libs : [],
        docs: Array.isArray(s.docs) ? s.docs : []
      };
    } catch (e) { return { version: 1, libs: [], docs: [] }; }
  }

  function save(st) {
    fs.mkdirSync(textDir(), { recursive: true });
    const tmp = metaPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      libs: (st.libs || []).slice(0, 200),
      docs: (st.docs || []).slice(0, 20000)
    }, null, 1), 'utf8');
    fs.renameSync(tmp, metaPath());
  }

  function textOf(meta) {
    if (!meta || !meta.id) return '';
    if (cache.has(meta.id)) return cache.get(meta.id);
    let t = '';
    try { t = fs.readFileSync(textPath(meta.id), 'utf8'); } catch (e) {}
    cache.set(meta.id, t);
    return t;
  }

  function corpus(libId) {
    return load().docs
      .filter((d) => !libId || d.libId === libId)
      .map((d) => Object.assign({}, d, { text: textOf(d) }));
  }

  function newId(prefix) {
    return (prefix || 'd') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function search(q, libId, limit) {
    const docs = corpus(libId);
    if (!docs.length || !String(q || '').trim()) return [];
    const key = String(libId || 'all') + '|' + docs.map((d) => d.id + ':' + d.chars).join(',');
    if (!idxCache || idxCache.key !== key) idxCache = { key, docs, index: buildIndex(docs) };
    return searchDocs(idxCache.docs, q, { indexFor: idxCache.index, limit: limit || 20, snippetLen: 200 })
      .map((h) => ({
        docId: h.doc.id, title: h.doc.title || h.doc.name, name: h.doc.name,
        rel: h.doc.rel, libId: h.doc.libId, score: h.score,
        hits: h.hits, snippet: h.snippet.text
      }));
  }

  /**
   * 导入文件：抽文本 → 指纹去重 → 摘要/标签 → 落盘。
   * 单文件失败不中断，逐条返回原因。
   */
  function addDocs(libId, files, opts) {
    const list = Array.isArray(files) ? files.slice(0, 800) : [];
    if (!list.length) return { ok: false, error: '没有要导入的文件' };
    const st = load();
    const lib = st.libs.find((l) => l.id === libId) || st.libs[0];
    if (!lib) return { ok: false, error: '先建一个知识库（或点「新建库」）' };
    const seen = new Set(st.docs.map((d) => d.hash).filter(Boolean));
    const added = [];
    const skipped = [];
    for (const f of list) {
      const filePath = String(f.path || '');
      try {
        if (!filePath || !fs.existsSync(filePath)) { skipped.push({ name: f.name || filePath, reason: '文件不存在' }); continue; }
        const buf = fs.readFileSync(filePath);
        if (buf.length > ((opts && opts.maxBytes) || 20 * 1024 * 1024)) { skipped.push({ name: f.name, reason: '文件超过 20MB' }); continue; }
        const ex = extractText(filePath, buf);
        if (!ex.ok) { skipped.push({ name: f.name || path.basename(filePath), reason: ex.error }); continue; }
        const text = String(ex.text || '').trim();
        if (text.length < 8) { skipped.push({ name: f.name, reason: '几乎没抽到文字（空文件或扫描件）' }); continue; }
        const fp = fingerprint(text);
        if (seen.has(fp)) { skipped.push({ name: f.name, reason: '内容重复，已跳过' }); continue; }
        seen.add(fp);
        const id = newId('d');
        const sum = summarize(f.name || path.basename(filePath), text);
        const body = text.slice(0, 600000);
        fs.mkdirSync(textDir(), { recursive: true });
        fs.writeFileSync(textPath(id), body, 'utf8');
        cache.set(id, body);
        const meta = {
          id,
          libId: lib.id,
          name: f.name || path.basename(filePath),
          rel: f.rel || f.name || path.basename(filePath),
          path: filePath,
          ext: f.ext || path.extname(filePath).toLowerCase(),
          size: buf.length,
          hash: fp,
          title: sum.title,
          summary: sum.summary,
          tags: sum.tags,
          chars: sum.chars,
          chunks: chunk(body, { size: 900, overlap: 120 }).length,
          addedAt: Date.now()
        };
        st.docs.push(meta);
        added.push(meta);
      } catch (err) {
        skipped.push({ name: f.name || filePath, reason: String(err.message || err).slice(0, 80) });
      }
    }
    if (added.length) {
      lib.updatedAt = Date.now();
      lib.count = st.docs.filter((d) => d.libId === lib.id).length;
      save(st);
      idxCache = null;
    }
    return { ok: true, added, skipped, libId: lib.id, total: st.docs.length };
  }

  function removeDocs(ids) {
    const set = new Set((ids || []).map(String));
    if (!set.size) return { ok: false, error: '没有指定文档' };
    const st = load();
    st.docs = st.docs.filter((d) => {
      if (!set.has(d.id)) return true;
      try { fs.unlinkSync(textPath(d.id)); } catch (e) {}
      cache.delete(d.id);
      return false;
    });
    st.libs.forEach((l) => { l.count = st.docs.filter((d) => d.libId === l.id).length; });
    save(st);
    idxCache = null;
    return { ok: true, left: st.docs.length };
  }

  function stats() {
    const st = load();
    return {
      libs: st.libs.length,
      docs: st.docs.length,
      chars: st.docs.reduce((a, d) => a + (d.chars || 0), 0),
      root
    };
  }

  return { root, load, save, textOf, corpus, search, addDocs, removeDocs, stats, textPath };
}

module.exports = {
  VERSION, KINDS, TEXT_EXTS, DOC_EXTS, UNSUPPORTED, SKIP_DIRS,
  hash, decode, stripHtml, extractText, extractDocx, extractXlsx, extractPptx,
  chunk, tokenize, buildIndex, search: searchDocs, snippet, summarize, fingerprint,
  askPrompt, citations, scanDir, firstHeading, createStore
};

