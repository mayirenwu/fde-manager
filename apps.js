/**
 * 应用功能（专家 / 技能 / 连接器 / 资料库）
 * ------------------------------------------------------------------
 * 这是 FDE 自己的"可用能力"清单：一份份小资产，存在本机数据目录的 apps/ 下，
 * 跟着数据目录走（便携版/换电脑都能带走），可以自建、改、导入、导出，
 * 也可以从 WorkBuddy / Codex / Claude 这些工具里"下载"过来直接用。
 *
 * 刻意不依赖 electron：路径由调用方传进来，纯 Node 就能测。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const runtime = require('./runtime');   // 复用里面的 zip 解析（纯 JS，跨平台，不依赖 Expand-Archive）

const KINDS = {
  expert:    { label: '专家',  icon: '🧭', hint: '一个角色的判断力：谁在用、看什么、怎么下结论' },
  skill:     { label: '技能',  icon: '🧠', hint: '一套可复用的做法：步骤 + 判断标准 + 产出格式' },
  connector: { label: '连接器', icon: '🔌', hint: '接外部系统：MCP / 接口 / 数据库 / 命令行' },
  library:   { label: '资料库', icon: '📚', hint: '文件、模板、样例、知识条目，随取随用' }
};
const KIND_KEYS = Object.keys(KINDS);
const SOURCE_LABEL = {
  self: '自建', import: '导入', workbuddy: 'WorkBuddy', codex: 'Codex', claude: 'Claude', pack: '场景包', copy: '复制'
};

const ID_RE = /^[a-z]+\.[a-z0-9][a-z0-9-]{1,60}$/;
const MAX_BODY = 200 * 1024;

/* ---------------- 基础 ---------------- */

function ensure(root) {
  for (const k of KIND_KEYS) fs.mkdirSync(path.join(root, k), { recursive: true });
  fs.mkdirSync(path.join(root, '_trash'), { recursive: true });
}

function newId(kind) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return kind + '.' + t + r;
}

function cleanStr(v, max) {
  const s = String(v == null ? '' : v).replace(/\u0000/g, '').trim();
  return max ? s.slice(0, max) : s;
}

function cleanTags(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/);
  const out = [];
  for (const t of arr) {
    const s = cleanStr(t, 18);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 8) break;
  }
  return out;
}

function dirOf(root, item) {
  return path.join(root, item.kind, item.id);
}

/** 只允许 apps/ 下的合法 id，挡住 ../ 这类路径穿越 */
function safeId(root, id, kindHint) {
  const s = String(id || '');
  if (ID_RE.test(s)) return s;
  return null;
}

/* ---------------- 读写 ---------------- */

function readManifest(dir) {
  const f = path.join(dir, 'manifest.json');
  if (!fs.existsSync(f)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!m || !m.id || !KINDS[m.kind]) return null;
    return m;
  } catch (e) { return null; }
}

function list(root) {
  ensure(root);
  const out = [];
  for (const kind of KIND_KEYS) {
    const kd = path.join(root, kind);
    let names = [];
    try { names = fs.readdirSync(kd); } catch (e) { continue; }
    for (const n of names) {
      const dir = path.join(kd, n);
      let st;
      try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      const m = readManifest(dir);
      if (!m) continue;
      m.kind = kind;
      m.dir = dir;
      m.size = dirSize(dir);
      out.push(m);
    }
  }
  out.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return out;
}

function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const f of names) {
      const p = path.join(d, f);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      n += st.size;
    }
  };
  walk(dir);
  return n;
}

function get(root, id) {
  const sid = safeId(root, id);
  if (!sid) return null;
  const kind = sid.split('.')[0];
  if (!KINDS[kind]) return null;
  const dir = path.join(root, kind, sid);
  const m = readManifest(dir);
  if (!m) return null;
  m.kind = kind;
  m.dir = dir;
  return m;
}

/** 新建或更新。没有 id 视为新建；有 id 视为改。 */
function save(root, input) {
  ensure(root);
  const src = input && typeof input === 'object' ? input : {};
  const exist = src.id ? get(root, src.id) : null;
  const kind = KINDS[src.kind] ? src.kind : (exist ? exist.kind : null);
  if (!kind) return { ok: false, error: '类型不对（只能是专家 / 技能 / 连接器 / 资料库）' };

  const name = cleanStr(src.name, 60) || exist && exist.name || '';
  if (!name) return { ok: false, error: '名字不能为空' };

  const now = Date.now();
  const m = exist ? exist : {
    id: newId(kind), kind, name: '', icon: KINDS[kind].icon, tagline: '', desc: '', tags: [],
    body: '', source: { type: 'self', path: '', label: '自建' },
    connector: { type: 'mcp', config: '', url: '', command: '' },
    library: { path: '', items: [] },
    pinned: false, createdAt: now, updatedAt: now
  };

  m.kind = kind;
  m.name = name;
  m.icon = cleanStr(src.icon, 4) || m.icon || KINDS[kind].icon;
  m.tagline = cleanStr(src.tagline, 120);
  m.desc = cleanStr(src.desc, 2000);
  m.tags = cleanTags(src.tags);
  if (src.body !== undefined) m.body = cleanStr(src.body, MAX_BODY);
  if (src.pinned !== undefined) m.pinned = !!src.pinned;

  if (src.connector && typeof src.connector === 'object') {
    m.connector = {
      type: ['mcp', 'http', 'cli', 'db'].includes(src.connector.type) ? src.connector.type : 'mcp',
      config: cleanStr(src.connector.config, 20000),
      url: cleanStr(src.connector.url, 500),
      command: cleanStr(src.connector.command, 500)
    };
  }
  if (src.library && typeof src.library === 'object') {
    m.library = {
      path: cleanStr(src.library.path, 500),
      items: Array.isArray(src.library.items) ? src.library.items.slice(0, 200).map(x => cleanStr(x, 500)) : []
    };
  }
  if (src.source && typeof src.source === 'object' && src.source.type) {
    m.source = {
      type: SOURCE_LABEL[src.source.type] ? src.source.type : 'self',
      path: cleanStr(src.source.path, 800),
      label: cleanStr(src.source.label, 40) || SOURCE_LABEL[src.source.type] || '自建'
    };
  }

  m.updatedAt = now;
  if (!m.createdAt) m.createdAt = now;
  if (!m.version) m.version = 1;

  const dir = path.join(root, kind, m.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8');
  // 正文单独存一份纯文本，方便用别的编辑器改
  fs.writeFileSync(path.join(dir, 'body.md'), m.body || '', 'utf8');
  return { ok: true, item: m, created: !exist };
}

/** 删除 = 移到 _trash，可恢复（客户现场误删很常见） */
function remove(root, id) {
  const item = get(root, id);
  if (!item) return { ok: false, error: '找不到这一项' };
  const trashDir = path.join(root, '_trash');
  fs.mkdirSync(trashDir, { recursive: true });
  const dest = path.join(trashDir, item.id + '__' + Date.now().toString(36));
  try { fs.renameSync(item.dir, dest); } catch (e) {
    try { fs.cpSync(item.dir, dest, { recursive: true }); fs.rmSync(item.dir, { recursive: true, force: true }); }
    catch (e2) { return { ok: false, error: e2.message }; }
  }
  fs.writeFileSync(path.join(dest, '_trash.json'),
    JSON.stringify({ id: item.id, kind: item.kind, name: item.name, deletedAt: Date.now() }), 'utf8');
  return { ok: true };
}

function listTrash(root) {
  ensure(root);
  const td = path.join(root, '_trash');
  let names = [];
  try { names = fs.readdirSync(td); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const dir = path.join(td, n);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, '_trash.json'), 'utf8')); } catch (e) {}
    if (!meta) continue;
    out.push({ dir, id: meta.id, kind: meta.kind, name: meta.name, deletedAt: meta.deletedAt });
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

function restore(root, trashName) {
  const rec = listTrash(root).find(x => path.basename(x.dir) === trashName);
  if (!rec) return { ok: false, error: '回收站里找不到它' };
  const dest = path.join(root, rec.kind, rec.id);
  if (fs.existsSync(dest)) return { ok: false, error: '同名项已存在，先改名再恢复' };
  fs.mkdirSync(path.join(root, rec.kind), { recursive: true });
  try { fs.renameSync(rec.dir, dest); } catch (e) {
    try { fs.cpSync(rec.dir, dest, { recursive: true }); fs.rmSync(rec.dir, { recursive: true, force: true }); }
    catch (e2) { return { ok: false, error: e2.message }; }
  }
  try { fs.unlinkSync(path.join(dest, '_trash.json')); } catch (e) {}
  return { ok: true };
}

function purge(root, trashName) {
  const rec = listTrash(root).find(x => path.basename(x.dir) === trashName);
  if (!rec) return { ok: false, error: '回收站里找不到它' };
  try { fs.rmSync(rec.dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

function duplicate(root, id, newName) {
  const item = get(root, id);
  if (!item) return { ok: false, error: '找不到这一项' };
  const copy = { ...item, id: '', name: (newName || item.name + ' 副本'), source: { type: 'copy', label: '复制' } };
  delete copy.dir; delete copy.size;
  const r = save(root, copy);
  if (!r.ok) return r;
  // 连带把附件也复制过去（资料库常带文件）
  const from = path.join(root, item.kind, item.id);
  const to = path.join(root, item.kind, r.item.id);
  try {
    for (const f of fs.readdirSync(from)) {
      if (f === 'manifest.json' || f === 'body.md') continue;
      const src = path.join(from, f);
      const st = fs.statSync(src);
      if (st.isDirectory()) copyAll(src, path.join(to, f));
      else fs.copyFileSync(src, path.join(to, f));
    }
  } catch (e) {}
  return r;
}

/* ---------------- 从文本里猜元信息 ---------------- */

function stripFrontmatter(md) {
  const s = String(md || '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: s };
  const meta = {};
  let key = null;
  let folding = false;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) { key = null; folding = false; continue; }
    const kv = !/^\s/.test(line) && line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      key = kv[1].toLowerCase();
      let v = kv[2].trim();
      folding = /^[>|][-+]?$/.test(v);
      meta[key] = folding ? '' : v.replace(/^["']|["']$/g, '').trim();
      continue;
    }
    // YAML 折行（description: >- 下面缩进的那些行）接到上一个键上
    if (key && /^\s+/.test(line)) {
      const t = line.trim().replace(/^["']|["']$/g, '');
      meta[key] = (meta[key] ? meta[key] + ' ' : '') + t;
    }
  }
  return { meta, body: s.slice(m[0].length).trim() };
}

function firstHeading(md) {
  const m = String(md || '').match(/^\s*#\s+(.+)$/m);
  return m ? m[1].trim() : '';
}

function firstPara(md) {
  const lines = String(md || '').split(/\r?\n/).map(s => s.trim());
  for (const l of lines) {
    if (!l || l.startsWith('#') || l.startsWith('---') || l.startsWith('|') || l.startsWith('```')) continue;
    return l.replace(/^[-*>]\s*/, '').slice(0, 160);
  }
  return '';
}

/** 从目录/文件里读出一份资产（不落盘） */
function readSource(srcPath) {
  let st;
  try { st = fs.statSync(srcPath); } catch (e) { return { ok: false, error: '路径不存在：' + srcPath }; }

  if (st.isDirectory()) {
    const pick = ['manifest.json', 'app.json', 'expert.json', 'plugin.json', 'SKILL.md', 'README.md'];
    let body = '', meta = {}, found = '';
    for (const f of pick) {
      const p = path.join(srcPath, f);
      if (!fs.existsSync(p)) continue;
      if (f.endsWith('.json')) {
        try { meta = JSON.parse(fs.readFileSync(p, 'utf8')) || {}; found = f; } catch (e) {}
        if (found) break;
      } else {
        const s = stripFrontmatter(fs.readFileSync(p, 'utf8'));
        body = s.body; meta = Object.assign({}, s.meta, meta);
        found = f;
        if (f === 'SKILL.md') break;
      }
    }
    const name = cleanStr(meta.name_zh || meta.name || meta.title, 60) || path.basename(srcPath);
    const desc = cleanStr(meta.description_zh || meta.description || meta.tagline, 400) || firstPara(body);
    return {
      ok: true,
      dir: srcPath,
      data: {
        name,
        tagline: desc.slice(0, 120),
        desc,
        body: body || '',
        tags: cleanTags(meta.tags || meta.keywords || []),
        source: { type: 'import', path: srcPath, label: '导入' }
      }
    };
  }

  const ext = path.extname(srcPath).toLowerCase();
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    const raw = fs.readFileSync(srcPath, 'utf8');
    const s = stripFrontmatter(raw);
    const nm = cleanStr(s.meta.name_zh || s.meta.name || firstHeading(s.body), 60) || path.basename(srcPath, ext);
    const ds = cleanStr(s.meta.description_zh || s.meta.description || firstPara(s.body), 400);
    return {
      ok: true,
      dir: null,
      data: {
        name: nm,
        tagline: ds.slice(0, 120),
        desc: ds,
        body: s.body,
        tags: cleanTags(s.meta.tags || s.meta.keywords || []),
        source: { type: 'import', path: srcPath, label: '导入' }
      }
    };
  }
  if (ext === '.json') {
    let j;
    try { j = JSON.parse(fs.readFileSync(srcPath, 'utf8')); } catch (e) { return { ok: false, error: 'JSON 读不出来：' + e.message }; }
    if (j && Array.isArray(j.mcpServers) === false && j.mcpServers && typeof j.mcpServers === 'object') {
      const name = Object.keys(j.mcpServers)[0] || path.basename(srcPath, ext);
      return {
        ok: true, dir: null,
        data: {
          kind: 'connector', name,
          tagline: 'MCP 连接器',
          desc: '从 ' + path.basename(srcPath) + ' 导入的 MCP 配置',
          connector: { type: 'mcp', config: JSON.stringify(j.mcpServers[name], null, 2) },
          source: { type: 'import', path: srcPath, label: '导入' }
        }
      };
    }
    const name = cleanStr(j.name || j.title, 60) || path.basename(srcPath, ext);
    return {
      ok: true, dir: null,
      data: {
        kind: KINDS[j.kind] ? j.kind : undefined,
        name,
        tagline: cleanStr(j.tagline || j.description, 120),
        desc: cleanStr(j.desc || j.description, 400),
        body: typeof j.body === 'string' ? j.body : '',
        tags: cleanTags(j.tags),
        connector: j.connector,
        source: { type: 'import', path: srcPath, label: '导入' }
      }
    };
  }
  // 其它文件（pdf/xlsx/docx…）当资料库条目
  return {
    ok: true,
    dir: null,
    data: {
      kind: 'library',
      name: path.basename(srcPath, ext),
      tagline: '文件资料',
      desc: '外部文件导入：' + path.basename(srcPath),
      source: { type: 'import', path: srcPath, label: '导入' }
    }
  };
}

/** 猜类型：明确给了就用给的，否则按内容判断 */
function guessKind(srcPath, data) {
  if (data && data.kind && KINDS[data.kind]) return data.kind;
  if (data && data.connector) return 'connector';
  const base = path.basename(String(srcPath || '')).toLowerCase();
  if (/^skill\.md$|skill/i.test(base)) return 'skill';
  if (/agent|expert/i.test(base)) return 'expert';
  if (/\.(pdf|xlsx?|docx?|pptx?|csv)$/i.test(base)) return 'library';
  if (data && data.body && /步骤|流程|怎么做|step/i.test(data.body)) return 'skill';
  return data && data.body ? 'skill' : 'library';
}

/**
 * 导入一个路径（文件夹 / md / json / zip）
 * @param {string} root apps 根目录
 * @param {string} srcPath 源路径
 * @param {object} opts {kind}
 */
function importFrom(root, srcPath, opts) {
  ensure(root);
  const o = opts || {};
  const st = (() => { try { return fs.statSync(srcPath); } catch (e) { return null; } })();
  if (!st) return { ok: false, error: '路径不存在：' + srcPath };

  // zip：先解到临时目录，再按文件夹导入（自带 zip 解析器，Windows/macOS/Linux 一致）
  if (st.isFile() && /\.zip$/i.test(srcPath)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-app-'));
    try {
      const files = runtime.unzip(fs.readFileSync(srcPath));
      for (const [name, data] of files) {
        // 防 zip-slip：只允许解到临时目录内部
        const abs = path.resolve(tmp, name);
        if (!abs.startsWith(path.resolve(tmp) + path.sep)) continue;
        if (/(^|\/)__MACOSX(\/|$)/.test(name)) continue;   // macOS 压缩包带的垃圾目录
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, data);
      }
    } catch (e) {
      return { ok: false, error: '解压失败：' + (e.message || '') };
    }
    const subs = fs.readdirSync(tmp).filter(n => {
      try { return fs.statSync(path.join(tmp, n)).isDirectory(); } catch (e) { return false; }
    });
    // 压缩包里只有一个顶层文件夹时，进到里面去
    const inner = (subs.length === 1 && !fs.existsSync(path.join(tmp, 'SKILL.md'))) ? path.join(tmp, subs[0]) : tmp;
    return importFrom(root, inner, o);
  }

  const read = readSource(srcPath);
  if (!read.ok) return read;
  const d = read.data;
  const kind = o.kind && KINDS[o.kind] ? o.kind : guessKind(srcPath, d);
  const r = save(root, {
    kind,
    name: d.name,
    tagline: d.tagline,
    desc: d.desc,
    body: d.body,
    tags: d.tags,
    connector: d.connector,
    source: d.source
  });
  if (!r.ok) return r;

  // 文件夹导入：把附件带进来（跳过 manifest/body 和体积过大的杂项）
  if (read.dir) {
    const dest = path.join(root, kind, r.item.id, 'files');
    try {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(read.dir, dest, { maxFileSize: 2 * 1024 * 1024, maxFiles: 200, skip: ['manifest.json', 'app.json', 'expert.json', 'plugin.json'] });
    } catch (e) {}
    // 资料库条目把源目录也记下来，方便直接打开
    if (kind === 'library') {
      fs.writeFileSync(path.join(root, kind, r.item.id, 'manifest.json'),
        JSON.stringify({ ...r.item, library: { path: read.dir, items: [] } }, null, 2), 'utf8');
    }
  } else if (st.isFile() && kind === 'library') {
    const dest = path.join(root, kind, r.item.id, 'files');
    fs.mkdirSync(dest, { recursive: true });
    try { fs.copyFileSync(srcPath, path.join(dest, path.basename(srcPath))); } catch (e) {}
    fs.writeFileSync(path.join(root, kind, r.item.id, 'manifest.json'),
      JSON.stringify({ ...r.item, library: { path: srcPath, items: [path.basename(srcPath)] } }, null, 2), 'utf8');
  }
  return r;
}

function copyTree(from, to, o) {
  const opts = Object.assign({ maxFileSize: 2 * 1024 * 1024, maxFiles: 200, skip: [] }, o || {});
  let count = 0;
  const walk = (src, dst) => {
    let names = [];
    try { names = fs.readdirSync(src); } catch (e) { return; }
    for (const n of names) {
      if (count >= opts.maxFiles) return;
      if (n === 'node_modules' || n === '.git' || n.startsWith('.')) continue;
      if (opts.skip.includes(n)) continue;
      const s = path.join(src, n), t = path.join(dst, n);
      let st;
      try { st = fs.statSync(s); } catch (e) { continue; }
      if (st.isDirectory()) { fs.mkdirSync(t, { recursive: true }); walk(s, t); continue; }
      if (st.size > opts.maxFileSize) continue;
      try { fs.copyFileSync(s, t); count++; } catch (e) {}
    }
  };
  fs.mkdirSync(to, { recursive: true });
  walk(from, to);
  return count;
}

/** 整目录原样复制（不带过滤，用于导出/复制） */
function copyAll(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) {
    const s = path.join(from, n), t = path.join(to, n);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyAll(s, t);
    else fs.copyFileSync(s, t);
  }
  return to;
}

/* ---------------- 从别的工具"下载" ---------------- */

function listDirs(p) {
  try {
    return fs.readdirSync(p).filter(n => {
      try { return fs.statSync(path.join(p, n)).isDirectory(); } catch (e) { return false; }
    });
  } catch (e) { return []; }
}

function listFiles(p, filter) {
  try {
    return fs.readdirSync(p).filter(n => {
      try { return fs.statSync(path.join(p, n)).isFile(); } catch (e) { return false; }
    }).filter(n => !filter || filter.test(n));
  } catch (e) { return []; }
}

function readSmall(p, max) {
  try {
    const st = fs.statSync(p);
    if (st.size > (max || 16 * 1024)) {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(max || 16 * 1024);
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      return buf.toString('utf8');
    }
    return fs.readFileSync(p, 'utf8');
  } catch (e) { return ''; }
}

/** 解析 mcp.json 里的 mcpServers，变成"可下载"的连接器候选 */
function mcpCandidates(file, source) {
  let j;
  try { j = JSON.parse(readSmall(file, 256 * 1024)); } catch (e) { return []; }
  const servers = (j && j.mcpServers && typeof j.mcpServers === 'object') ? j.mcpServers : {};
  return Object.keys(servers).slice(0, 40).map(name => {
    const cfg = servers[name] || {};
    const where = cfg.url || cfg.command || cfg.type || '';
    return {
      key: source + ':mcp:' + name,
      source, kind: 'connector',
      name,
      desc: ('MCP 连接器 · ' + (where || '配置在 ' + path.basename(file))).slice(0, 160),
      path: file,
      inline: { connector: { type: 'mcp', config: JSON.stringify(cfg, null, 2), url: cfg.url || '', command: cfg.command || '' } }
    };
  });
}

/** 极简 TOML 读取：只认 [mcp_servers.xxx] 段（Codex 的配置格式） */
function tomlMcpCandidates(file, source) {
  const raw = readSmall(file, 256 * 1024);
  if (!raw) return [];
  const lines = raw.split(/\r?\n/);
  const out = [];
  let cur = null, buf = [];
  const flush = () => {
    if (!cur) return;
    const cfg = {};
    for (const l of buf) {
      const m = l.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      let v = m[2].replace(/^["']|["']$/g, '');
      if (/^\[/.test(m[2])) v = m[2];
      cfg[m[1]] = v;
    }
    out.push({
      key: source + ':mcp:' + cur,
      source, kind: 'connector',
      name: cur,
      desc: ('MCP 连接器 · ' + (cfg.url || cfg.command || 'Codex 配置')).slice(0, 160),
      path: file,
      inline: { connector: { type: 'mcp', config: JSON.stringify(cfg, null, 2), url: cfg.url || '', command: cfg.command || '' } }
    });
    buf = [];
  };
  for (const l of lines) {
    const sec = l.match(/^\s*\[+\s*mcp_servers\.([\w.-]+)\s*\]+\s*$/);
    if (sec) { flush(); cur = sec[1]; continue; }
    if (/^\s*\[/.test(l)) { flush(); cur = null; continue; }
    if (cur) buf.push(l);
  }
  flush();
  return out.slice(0, 40);
}

/**
 * 扫本机上已经"装过/配过"的能力（WorkBuddy 用户目录、Codex、Claude）
 */
function scanLocal(home, root) {
  const H = home || os.homedir();
  const store = root ? list(root) : [];
  const known = new Set(store.map(x => (x.source && x.source.path) || '').filter(Boolean));
  const out = [];

  const push = (c) => {
    const p = c.path || '';
    c.installed = !!(p && (known.has(p) || known.has(path.dirname(p))));
    if (!out.some(x => x.name === c.name && x.kind === c.kind)) out.push(c);
  };

  // ---- WorkBuddy ----
  const wb = path.join(H, '.workbuddy');
  // 技能：~/.workbuddy/skills/<name>/SKILL.md
  for (const d of listDirs(path.join(wb, 'skills'))) {
    const dir = path.join(wb, 'skills', d);
    const read = readSource(dir);
    push({
      key: 'workbuddy:skill:' + d, source: 'workbuddy', kind: 'skill',
      name: (read.ok && read.data.name) || d,
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'WorkBuddy 技能',
      path: dir
    });
  }
  // 专家：~/.workbuddy/experts/<name>/  以及自建市场目录
  for (const d of listDirs(path.join(wb, 'experts'))) {
    const dir = path.join(wb, 'experts', d);
    const read = readSource(dir);
    push({
      key: 'workbuddy:expert:' + d, source: 'workbuddy', kind: 'expert',
      name: (read.ok && read.data.name) || d,
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'WorkBuddy 专家',
      path: dir
    });
  }
  for (const mk of listDirs(path.join(wb, 'plugins', 'marketplaces'))) {
    for (const d of listDirs(path.join(wb, 'plugins', 'marketplaces', mk))) {
      const dir = path.join(wb, 'plugins', 'marketplaces', mk, d);
      const hasSkill = fs.existsSync(path.join(dir, 'SKILL.md'));
      const hasExpert = fs.existsSync(path.join(dir, 'expert.json')) || fs.existsSync(path.join(dir, 'plugin.json'));
      if (!hasSkill && !hasExpert) continue;
      const read = readSource(dir);
      push({
        key: 'workbuddy:plugin:' + mk + ':' + d, source: 'workbuddy', kind: hasExpert ? 'expert' : 'skill',
        name: (read.ok && read.data.name) || d,
        desc: (read.ok && (read.data.tagline || read.data.desc)) || ('WorkBuddy 插件 · ' + mk),
        path: dir
      });
    }
  }
  // 连接器：~/.workbuddy/mcp.json（真正配过的那些）
  for (const c of mcpCandidates(path.join(wb, 'mcp.json'), 'workbuddy')) push(c);

  // ---- Codex ----
  const cx = path.join(H, '.codex');
  for (const d of listDirs(path.join(cx, 'skills'))) {
    const dir = path.join(cx, 'skills', d);
    const read = readSource(dir);
    push({
      key: 'codex:skill:' + d, source: 'codex', kind: 'skill',
      name: (read.ok && read.data.name) || d,
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'Codex 技能',
      path: dir
    });
  }
  for (const f of listFiles(path.join(cx, 'prompts'), /\.md$/i)) {
    const p = path.join(cx, 'prompts', f);
    const read = readSource(p);
    push({
      key: 'codex:prompt:' + f, source: 'codex', kind: 'skill',
      name: (read.ok && read.data.name) || path.basename(f, '.md'),
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'Codex 提示词',
      path: p
    });
  }
  for (const f of ['AGENTS.md', 'config.md']) {
    const p = path.join(cx, f);
    if (fs.existsSync(p)) {
      const read = readSource(p);
      push({ key: 'codex:agents', source: 'codex', kind: 'skill', name: 'Codex 全局说明 (AGENTS.md)', desc: 'Codex 的项目约定与工作方式', path: p });
    }
  }
  for (const c of tomlMcpCandidates(path.join(cx, 'config.toml'), 'codex')) push(c);

  // ---- Claude Code ----
  const cl = path.join(H, '.claude');
  for (const d of listDirs(path.join(cl, 'skills'))) {
    const dir = path.join(cl, 'skills', d);
    const read = readSource(dir);
    push({
      key: 'claude:skill:' + d, source: 'claude', kind: 'skill',
      name: (read.ok && read.data.name) || d,
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'Claude 技能',
      path: dir
    });
  }
  for (const f of listFiles(path.join(cl, 'agents'), /\.md$/i)) {
    const p = path.join(cl, 'agents', f);
    const read = readSource(p);
    push({
      key: 'claude:agent:' + f, source: 'claude', kind: 'expert',
      name: (read.ok && read.data.name) || path.basename(f, '.md'),
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'Claude 子代理',
      path: p
    });
  }

  return out;
}

/**
 * 扫"市场目录"：本机已经缓存下来的官方市场（连接器 / 技能 / 团队专家）。
 * 这些是还没进 FDE、但可以一键下载的东西 —— 相当于货架。
 */
function scanCatalog(home, root) {
  const H = home || os.homedir();
  const mk = path.join(H, '.workbuddy', 'plugins', 'marketplaces');
  const store = root ? list(root) : [];
  const have = new Set(store.map(x => x.kind + '|' + x.name));
  const out = [];
  const push = (c) => {
    c.catalog = true;
    c.installed = have.has(c.kind + '|' + c.name);
    if (!out.some(x => x.kind === c.kind && x.name === c.name)) out.push(c);
  };

  // ---- 连接器市场（每个目录 = 一个 MCP 服务） ----
  const cdir = path.join(mk, 'workbuddy-connector-plugins-official', 'connectors');
  for (const d of listDirs(cdir)) {
    const dir = path.join(cdir, d);
    let pj = {};
    try { pj = JSON.parse(readSmall(path.join(dir, '.codebuddy-plugin', 'plugin.json'), 64 * 1024)); } catch (e) {}
    const disp = (pj.extensions && pj.extensions['ai.workbuddy'] && pj.extensions['ai.workbuddy'].display) || {};
    const name = cleanStr(disp.name_zh || disp.name, 60) || d;
    const desc = cleanStr(disp.description_zh || disp.description || pj.description, 200);
    let cfg = null, url = '', cmd = '';
    try {
      const mj = JSON.parse(readSmall(path.join(dir, 'mcp.json'), 32 * 1024));
      const first = Object.keys(mj.mcpServers || {})[0];
      if (first) { cfg = mj.mcpServers[first]; url = cfg.url || ''; cmd = cfg.command || ''; }
    } catch (e) {}
    const skills = listDirs(path.join(dir, 'skills')).length;
    push({
      key: 'cat:conn:' + d, source: 'workbuddy', kind: 'connector', group: '连接器市场',
      name, desc: desc || ('MCP 连接器 · ' + (url || cmd || d)),
      path: dir,
      inline: cfg ? { connector: { type: 'mcp', config: JSON.stringify(cfg, null, 2), url, command: cmd } } : null,
      extra: skills ? '含 ' + skills + ' 个技能' : ''
    });
  }

  // ---- 官方技能（SKILL.md 在根目录） ----
  const sdir = path.join(mk, 'codebuddy-plugins-official', 'plugins');
  for (const d of listDirs(sdir)) {
    const dir = path.join(sdir, d);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    const read = readSource(dir);
    push({
      key: 'cat:skill:' + d, source: 'workbuddy', kind: 'skill', group: '官方技能',
      name: (read.ok && read.data.name) || d,
      desc: (read.ok && (read.data.tagline || read.data.desc)) || 'WorkBuddy 官方技能',
      path: dir
    });
  }

  // ---- 团队市场：agents/*.md 是专家，skills/*/SKILL.md 是技能 ----
  const tdir = path.join(mk, 'cb_teams_marketplace', 'plugins');
  for (const d of listDirs(tdir)) {
    const dir = path.join(tdir, d);
    for (const f of listFiles(path.join(dir, 'agents'), /\.md$/i)) {
      const p = path.join(dir, 'agents', f);
      const read = readSource(p);
      push({
        key: 'cat:agent:' + d + ':' + f, source: 'workbuddy', kind: 'expert', group: '团队专家',
        name: (read.ok && read.data.name) || path.basename(f, '.md'),
        desc: (read.ok && (read.data.tagline || read.data.desc)) || ('团队专家 · ' + d),
        path: p, extra: d
      });
    }
    for (const s of listDirs(path.join(dir, 'skills'))) {
      const sd = path.join(dir, 'skills', s);
      if (!fs.existsSync(path.join(sd, 'SKILL.md'))) continue;
      const read = readSource(sd);
      push({
        key: 'cat:tskill:' + d + ':' + s, source: 'workbuddy', kind: 'skill', group: '团队技能',
        name: (read.ok && read.data.name) || s,
        desc: (read.ok && (read.data.tagline || read.data.desc)) || ('团队技能 · ' + d),
        path: sd, extra: d
      });
    }
  }

  // ---- 内置技能（已随软件装好，可拿来改） ----
  const cache = path.join(H, '.workbuddy', 'plugins', 'cache');
  for (const pkg of listDirs(cache)) {
    for (const s of listDirs(path.join(cache, pkg, 'skills'))) {
      const dir = path.join(cache, pkg, 'skills', s);
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
      const read = readSource(dir);
      push({
        key: 'cat:builtin:' + pkg + ':' + s, source: 'workbuddy', kind: 'skill', group: '内置技能',
        name: (read.ok && read.data.name) || s,
        desc: (read.ok && (read.data.tagline || read.data.desc)) || 'WorkBuddy 内置技能',
        path: dir
      });
    }
  }

  // ---- 我的专家（用户自己在 WorkBuddy 里建的） ----
  for (const d of listDirs(path.join(mk, 'my-experts'))) {
    const dir = path.join(mk, 'my-experts', d);
    const read = readSource(dir);
    push({
      key: 'cat:myexpert:' + d, source: 'workbuddy', kind: 'expert', group: '我的专家',
      name: (read.ok && read.data.name) || d,
      desc: (read.ok && (read.data.tagline || read.data.desc)) || '自定义专家',
      path: dir
    });
  }

  return out;
}

/** 本地已装 + 市场货架，合成一份候选清单 */
function scanSources(home, root) {
  const local = scanLocal(home, root);
  const cat = scanCatalog(home, root);
  const seen = new Set(local.map(x => x.kind + '|' + x.name));
  const out = local.slice();
  for (const c of cat) if (!seen.has(c.kind + '|' + c.name)) out.push(c);
  return out;
}

function installCandidate(root, cand) {
  if (!cand || !cand.path && !cand.inline) return { ok: false, error: '这条候选信息不完整' };
  if (cand.inline && cand.inline.connector) {
    return save(root, {
      kind: 'connector', name: cand.name, tagline: cand.desc, desc: cand.desc,
      connector: cand.inline.connector,
      source: { type: cand.source, path: cand.path || '', label: SOURCE_LABEL[cand.source] || '导入' }
    });
  }
  if (cand.inline && cand.inline.installedPlugin) {
    return save(root, {
      kind: 'connector', name: cand.name, tagline: cand.desc, desc: cand.desc,
      connector: { type: 'mcp', config: '', url: '', command: '' },
      source: { type: cand.source, path: cand.path || '', label: SOURCE_LABEL[cand.source] || '导入' }
    });
  }
  const r = importFrom(root, cand.path, { kind: cand.kind });
  if (!r.ok) return r;
  return save(root, {
    id: r.item.id,
    source: {
      type: cand.source, path: cand.path,
      label: (SOURCE_LABEL[cand.source] || '导入') + (cand.path ? '' : '')
    }
  });
}

/* ---------------- 导出 / 给 AI 用 ---------------- */

function exportTo(root, id, destDir) {
  const item = get(root, id);
  if (!item) return { ok: false, error: '找不到这一项' };
  const safe = item.name.replace(/[\\/:*?"<>|]/g, '_');
  let dest = path.join(destDir, safe);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(destDir, safe + ' (' + (n++) + ')');
  try {
    // 注意：不用 fs.cpSync —— 在 Windows 上目标不存在时中文名会被写坏
    copyAll(item.dir, dest);
    return { ok: true, dir: dest };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 生成一段可直接粘给 AI 的文字（专家/技能）或配置说明（连接器/资料库） */
function promptOf(item) {
  if (!item) return '';
  const K = KINDS[item.kind] || KINDS.skill;
  const head = '【' + K.label + '】' + item.name + (item.tagline ? ' —— ' + item.tagline : '');
  if (item.kind === 'connector') {
    const c = item.connector || {};
    return [head, '',
      '类型：' + (c.type || 'mcp'),
      c.url ? '地址：' + c.url : '',
      c.command ? '命令：' + c.command : '',
      c.config ? '配置：\n' + c.config : '',
      item.desc ? '\n说明：' + item.desc : ''
    ].filter(Boolean).join('\n');
  }
  if (item.kind === 'library') {
    const l = item.library || {};
    return [head, '',
      l.path ? '位置：' + l.path : '',
      (l.items && l.items.length) ? '包含：' + l.items.join('、') : '',
      item.desc ? '说明：' + item.desc : ''
    ].filter(Boolean).join('\n');
  }
  return [head, item.desc ? '\n' + item.desc : '', item.tags && item.tags.length ? '\n标签：' + item.tags.join('、') : '',
    item.body ? '\n---\n' + item.body : ''].filter(Boolean).join('\n');
}

function stats(items) {
  const s = { total: items.length };
  for (const k of KIND_KEYS) s[k] = 0;
  for (const it of items) s[it.kind] = (s[it.kind] || 0) + 1;
  s.bytes = items.reduce((n, x) => n + (x.size || 0), 0);
  return s;
}

module.exports = {
  KINDS, KIND_KEYS, SOURCE_LABEL,
  ensure, list, get, save, remove, listTrash, restore, purge, duplicate,
  readSource, importFrom, scanLocal, scanCatalog, scanSources, installCandidate,
  exportTo, promptOf, stats, stripFrontmatter, guessKind, newId, cleanTags,
  copyTree
};
