/**
 * FDE 运行时 · 可迁移层（v7）
 *
 * 解决的问题：换一台电脑 / 换一个 Windows 用户 / 给客户部署，原来要"从头再搭一遍"。
 * 这里提供四件事：
 *   1) 便携数据根：数据可以放在程序目录、U 盘、网盘同步目录，整套跟着文件夹走。
 *   2) 环境快照 .fdeenv：单文件（zip）打包「项目 + 脚本 + 工作流 + 上下文 + 场景包」，
 *      导出时把本机绝对路径换成 ${HOME} / ${DESKTOP} / ${APPDIR} 这类变量，换用户名也不炸。
 *   3) 环境体检：导入后立刻告诉你这台机器缺什么（解释器 / 程序 / 路径），而不是等你点开才发现。
 *   4) 算力预算：提示词按需裁剪 + 指纹缓存 + 分级执行统计，把"每次都要模型重读一遍"降下来。
 *
 * 本模块不 require electron，路径由调用方传入，方便单测。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------- 便携数据根 ----------

/**
 * 决定数据放哪。优先级：
 *   1. --data-dir=<路径>        （命令行，测试/多开）
 *   2. FDE_DATA_DIR 环境变量
 *   3. 程序目录/portable.json   {"dataDir": "fde-data"}  相对程序目录；这是"绿色版"
 *   4. 默认 userData（%APPDATA%）
 * @returns {{dir:string, mode:'custom'|'portable'|'appdata', source:string}}
 */
function resolveDataRoot({ argv = [], env = process.env, appDir, defaultDir }) {
  const pick = (p, mode, source) => {
    const abs = path.isAbsolute(p) ? p : path.join(appDir, p);
    return { dir: path.resolve(abs), mode, source };
  };
  for (const a of argv) {
    const m = /^--data-dir=(.+)$/i.exec(String(a));
    if (m) return pick(m[1].trim().replace(/^"|"$/g, ''), 'custom', '--data-dir');
  }
  if (env.FDE_DATA_DIR && String(env.FDE_DATA_DIR).trim()) {
    return pick(String(env.FDE_DATA_DIR).trim(), 'custom', 'FDE_DATA_DIR');
  }
  try {
    const f = path.join(appDir, 'portable.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      if (j && j.dataDir) return pick(String(j.dataDir), 'portable', 'portable.json');
    }
  } catch (e) { /* 配置坏了就当没有，别影响启动 */ }
  return { dir: defaultDir, mode: 'appdata', source: 'default' };
}

// ---------- 极简 zip（写 deflate，读 deflate/store） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** entries: [{name, data:Buffer|string}] -> Buffer */
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime();
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    let method = 0;
    let body = raw;
    if (raw.length > 256) {
      const d = zlib.deflateRawSync(raw, { level: 9 });
      if (d.length < raw.length) { method = 8; body = d; }
    }
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** Buffer -> Map<name, Buffer> */
function unzip(buf) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的压缩包（找不到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // 本地头长度可能与中央目录不同，以本地头为准
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = buf.slice(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body);
    else throw new Error('不支持的压缩方式: ' + method + ' (' + name + ')');
    out.set(name, data);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// ---------- 路径变量化 ----------

function makeRoots(p = {}) {
  const home = p.home || os.homedir();
  const r = {
    HOME: home,
    USER: path.basename(home) || p.user || os.userInfo().username,
    DESKTOP: p.desktop || path.join(home, 'Desktop'),
    DOCS: p.docs || path.join(home, 'Documents'),
    DOWNLOADS: p.downloads || path.join(home, 'Downloads'),
    APPDATA: p.appData || process.env.APPDATA || '',
    LOCALAPPDATA: p.localAppData || process.env.LOCALAPPDATA || '',
    PROGRAMFILES: p.programFiles || process.env.ProgramFiles || '',
    APPDIR: p.appDir || ''
  };
  // 长路径优先替换，避免 ${HOME} 先吃掉 ${HOME}\Desktop
  return Object.entries(r)
    .filter(([, v]) => v && String(v).length > 3)
    .map(([k, v]) => ({ key: k, val: String(v).replace(/[\\/]+$/, '') }))
    .sort((a, b) => b.val.length - a.val.length);
}

const PATHISH_KEYS = new Set(['path', 'browserPath', 'value', 'file', 'folder', 'dir', 'cwd',
  'exe', 'scriptPath', 'wallpaper', 'originalWallpaper', 'outputDir', 'workDir', 'ref']);

function looksAbs(s) {
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s);
}

function toVars(s, roots) {
  if (typeof s !== 'string' || !looksAbs(s)) return s;
  const low = s.toLowerCase();
  for (const r of roots) {
    const rl = r.val.toLowerCase();
    if (low === rl) return '${' + r.key + '}';
    if (low.startsWith(rl) && /[\\/]/.test(s.charAt(r.val.length))) {
      return '${' + r.key + '}' + s.slice(r.val.length);
    }
  }
  return s;
}

function fromVars(s, roots) {
  if (typeof s !== 'string' || s.indexOf('${') < 0) return s;
  return s.replace(/\$\{([A-Z]+)\}/g, (m, k) => {
    const r = roots.find(x => x.key === k);
    return r ? r.val : m;
  });
}

function mapPaths(obj, fn, keyHint) {
  if (typeof obj === 'string') {
    return (keyHint && PATHISH_KEYS.has(keyHint)) ? fn(obj) : obj;
  }
  if (Array.isArray(obj)) return obj.map(v => mapPaths(v, fn, keyHint));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = mapPaths(obj[k], fn, k);
    return out;
  }
  return obj;
}

// ---------- 环境快照 ----------

const ENV_SCHEMA = 'fde.env/1';

function snapshotEntries(data, { roots, packsDir, packScriptsDir, appVersion, extra = {} }) {
  const cloned = JSON.parse(JSON.stringify(data));
  // 日志只带最近 150 条：交接时看得到"上次做到哪"，又不是把历史全背走
  if (Array.isArray(cloned.logs)) cloned.logs = cloned.logs.slice(-150);
  // 运行态清掉，导入后由本机重新探测
  delete cloned.originalWindows;
  for (const p of (cloned.projects || [])) {
    p.windows = [];
    p.status = 'stopped';
    p.statusMsg = '';
  }
  const portable = mapPaths(cloned, s => toVars(s, roots));

  const manifest = {
    schema: ENV_SCHEMA,
    app: 'FDE Manager',
    version: appVersion || '',
    createdAt: new Date().toISOString(),
    machine: {
      host: os.hostname(),
      user: os.userInfo().username,
      platform: process.platform,
      arch: process.arch
    },
    counts: {
      projects: (portable.projects || []).length,
      canvasNodes: ((portable.canvas || {}).nodes || []).length,
      flows: (portable.flows || []).length
    },
    roots: roots.map(r => ({ key: r.key, val: r.val })),
    ...extra
  };

  const entries = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'data.json', data: JSON.stringify(portable, null, 2) },
    { name: 'README.txt', data: readmeText(manifest) }
  ];
  for (const [dir, prefix] of [[packsDir, 'packs/'], [packScriptsDir, 'pack-scripts/']]) {
    if (!dir) continue;
    for (const f of walkFiles(dir)) {
      try {
        entries.push({ name: prefix + f.rel.replace(/\\/g, '/'), data: fs.readFileSync(f.abs) });
      } catch (e) { /* 文件被占用就跳过，不阻塞整体导出 */ }
    }
  }
  return entries;
}

function walkFiles(root, base = root, out = []) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of names) {
    const abs = path.join(root, d.name);
    if (d.isDirectory()) walkFiles(abs, base, out);
    else if (d.isFile()) out.push({ abs, rel: path.relative(base, abs) });
  }
  return out;
}

function readmeText(m) {
  return [
    'FDE 环境快照 · ' + (m.createdAt || ''),
    '',
    '这个文件打包了：项目桌面、脚本、工作流画布、上下文材料、场景包。',
    '里面的本机路径已经换成 ${HOME} / ${DESKTOP} / ${APPDIR} 这类变量，',
    '所以换电脑、换 Windows 用户、给客户部署都能直接还原。',
    '',
    '怎么用：打开 FDE 智能体 控制台 → 「环境 / 迁移」→ 导入快照。',
    '导入后会自动做一次环境体检，把这台机器缺的程序和解释器列出来。',
    '',
    '来源机器：' + ((m.machine || {}).host || '') + ' / ' + ((m.machine || {}).user || ''),
    '项目数：' + (((m.counts || {}).projects) || 0),
    ''
  ].join('\r\n');
}

function parseSnapshot(buf) {
  const files = unzip(buf);
  const mf = files.get('manifest.json');
  if (!mf) throw new Error('快照缺少 manifest.json，可能不是 FDE 导出的文件');
  const manifest = JSON.parse(mf.toString('utf8').replace(/^\uFEFF/, ''));
  if (!String(manifest.schema || '').startsWith('fde.env/')) {
    throw new Error('快照格式版本不支持: ' + manifest.schema);
  }
  const df = files.get('data.json');
  if (!df) throw new Error('快照缺少 data.json');
  return { manifest, data: JSON.parse(df.toString('utf8').replace(/^\uFEFF/, '')), files };
}

function restorePaths(data, roots) {
  return mapPaths(data, s => fromVars(s, roots));
}

// ---------- 环境体检 ----------

function which(cmd) {
  return new Promise((resolve) => {
    const exe = process.platform === 'win32' ? 'where.exe' : 'which';
    execFile(exe, [cmd], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      if (err) return resolve('');
      const first = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      resolve(first || '');
    });
  });
}

/**
 * 体检：这台机器到底能不能跑起这套东西。
 * 返回分级的检查项，error 会挡住使用，warn 只影响某个项目。
 */
async function envCheck(data, { dataRoot, appDir } = {}) {
  const items = [];
  const add = (level, title, detail, fix) => items.push({ level, title, detail, fix: fix || null });

  // 数据目录
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const probe = path.join(dataRoot, '.fde-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    add('ok', '数据目录可写', dataRoot);
  } catch (e) {
    add('error', '数据目录不可写', dataRoot + ' · ' + e.message, { type: 'datadir' });
  }

  // 解释器 / 依赖：按平台给不同的"必需项"，不要拿 Windows 的清单去卡 macOS
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const bins = isWin
    ? [
      ['powershell.exe', '窗口隔离助手（必需）', 'error'],
      ['node', '跑 .js 脚本', 'warn'],
      ['python', '跑 .py 脚本', 'warn'],
      ['git', '拉取/更新场景包脚本', 'warn']
    ]
    : (isMac
      ? [
        ['osascript', '窗口控制（系统自带，需辅助功能授权）', 'warn'],
        ['python3', '跑 .py 脚本', 'warn'],
        ['git', '拉取/更新场景包脚本', 'warn'],
        ['node', '跑 .js 脚本', 'warn']
      ]
      : [
        ['xdotool', '窗口隔离（可选，X11 下才生效）', 'warn'],
        ['wmctrl', '窗口列表（可选）', 'warn'],
        ['python3', '跑 .py 脚本', 'warn'],
        ['git', '拉取/更新场景包脚本', 'warn'],
        ['node', '跑 .js 脚本', 'warn']
      ]);
  for (const [cmd, use, level] of bins) {
    const p = await which(cmd);
    if (p) add('ok', cmd, use + ' · ' + p);
    else add(level, '缺少 ' + cmd, use + (level === 'error' ? '，没有它无法隐藏/切换窗口' : '，相关脚本会跑不起来'), { type: 'install', cmd });
  }

  // 程序目录完整性
  const required = ['main.js', 'preload.js', 'platform.js', 'wmp.js'];
  if (isWin) required.push('winhelper.ps1');
  for (const f of required) {
    const abs = path.join(appDir, f);
    if (fs.existsSync(abs)) add('ok', f, '就位');
    else add('error', '程序文件缺失: ' + f, abs, { type: 'repair' });
  }

  // 项目里的真实路径
  const missExe = [];
  const missScript = [];
  const missCtx = [];
  for (const p of (data.projects || [])) {
    const handled = new Set();
    for (const a of (p.autorun || [])) {
      const target = a.type === 'url' ? (a.browserPath || '') : a.path;
      if (!target || !looksAbs(target)) continue;
      if (fs.existsSync(target) || handled.has(target)) continue;
      handled.add(target);
      (a.optional ? add.bind(null, 'warn') : add.bind(null, 'error'))(
        '「' + p.name + '」要启动的程序不在这台机器上',
        target, { type: 'path', value: target, projectId: p.id });
      missExe.push({ project: p.name, path: target, optional: !!a.optional });
    }
    for (const it of (p.items || [])) {
      if (!it.path) continue;
      if (!fs.existsSync(it.path) && looksAbs(it.path)) {
        add('warn', '「' + p.name + '」的脚本路径失效', it.path, { type: 'path', value: it.path, projectId: p.id });
        missScript.push({ project: p.name, name: it.name, path: it.path });
      }
    }
    for (const c of (p.context || [])) {
      if ((c.kind === 'file' || c.kind === 'folder') && c.value && looksAbs(c.value) && !fs.existsSync(c.value)) {
        add('warn', '「' + p.name + '」的上下文材料找不到', (c.title || '') + ' · ' + c.value, { type: 'path', value: c.value, projectId: p.id });
        missCtx.push({ project: p.name, title: c.title, path: c.value });
      }
    }
  }
  if (!missExe.length && !missScript.length && !missCtx.length && (data.projects || []).length) {
    add('ok', '项目引用的路径全部存在', (data.projects || []).length + ' 个项目');
  }
  if (!(data.projects || []).length) add('ok', '还没有项目', '导入快照或新建一个都能开始');

  const score = items.filter(i => i.level === 'error').length;
  return {
    items,
    summary: {
      total: items.length,
      error: score,
      warn: items.filter(i => i.level === 'warn').length,
      ok: items.filter(i => i.level === 'ok').length,
      ready: score === 0
    },
    missing: { exe: missExe, scripts: missScript, context: missCtx }
  };
}

// ---------- 算力预算与缓存 ----------

/** 粗略 token 估算：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token。宁高不低。 */
function estTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 1.0 + rest / 3.5);
}

function fingerprint(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

class AiCache {
  constructor(file, limit = 400) {
    this.file = file;
    this.limit = limit;
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { this.map = {}; }
  }
  get(key) {
    const v = this.map[key];
    if (!v) return null;
    v.hits = (v.hits || 0) + 1;
    v.last = Date.now();
    return v;
  }
  set(key, value) {
    this.map[key] = { value, created: Date.now(), last: Date.now(), hits: 0 };
    const keys = Object.keys(this.map);
    if (keys.length > this.limit) {
      keys.sort((a, b) => (this.map[a].last || 0) - (this.map[b].last || 0));
      for (const k of keys.slice(0, keys.length - this.limit)) delete this.map[k];
    }
    this.save();
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.map)); } catch (e) { /* 缓存丢了不影响主流程 */ }
  }
  stats() {
    const keys = Object.keys(this.map);
    return {
      entries: keys.length,
      hits: keys.reduce((n, k) => n + (this.map[k].hits || 0), 0),
      tokensSaved: keys.reduce((n, k) => n + (this.map[k].hits || 0) * (this.map[k].tokens || 0), 0)
    };
  }
  clear() { this.map = {}; this.save(); }
}

module.exports = {
  resolveDataRoot,
  zip, unzip,
  makeRoots, toVars, fromVars, mapPaths, looksAbs,
  ENV_SCHEMA, snapshotEntries, parseSnapshot, restorePaths, walkFiles,
  envCheck, which,
  estTokens, fingerprint, AiCache
};
