/**
 * 窗口管理适配层（Window Manager Provider）
 *
 * 目的：让 main.js 里那一大套"枚举窗口 / 隐藏 / 显示 / 移动 / 关闭"的逻辑
 * 在三个系统上跑同一套命令协议，只是背后执行者不同：
 *
 *   Windows  —— winhelper.ps1 常驻助手（Win32，能力最全，main.js 里原样保留）
 *   macOS    —— osascript(JXA) + System Events（应用级：隐藏整个 App，需辅助功能授权）
 *   Linux    —— xdotool / wmctrl（窗口级，X11；Wayland 下自动降级为不可用）
 *
 * 命令协议与 winhelper.ps1 一致，逐条对应：
 *   ENUM|<excludePids>|<knownIds>   -> JSON 数组 [{hwnd,pid,proc,title,vis,iconic,x,y,exe,tool,cloaked,fg}]
 *   FG                              -> 前台窗口 id（认不出返回 0）
 *   HIDE|id1,id2                    -> ok
 *   SHOW|id1,id2                    -> ok    （顺带还原最小化）
 *   SHOWMIN|id1,id2 / MIN|id1,id2   -> ok
 *   CLOSE|id1,id2                   -> ok    （优雅关闭）
 *   FOCUS|id                        -> ok
 *   MOVE|id|x|y                     -> ok
 *   RECT|id1,id2                    -> JSON [{hwnd,l,t,r,b}]（拿不到返回 ''，调用方有兜底）
 *   WORK                            -> JSON {l,t,r,b}（不支持返回 ''，调用方用 Electron 的 workArea）
 *   SETRECT|id|x|y|w|h              -> ok
 *   PPID|p1,p2                      -> JSON [{ProcessId,ParentProcessId}]
 *   WALL|<path> / GENWALL|...       -> ok（不支持的系统直接回 ok，壁纸功能关闭）
 *   QUIT                            -> ok
 *
 * 设计要点：任何一条命令失败都不抛异常，只回 '' 或 'ok'。
 * 窗口隔离是"锦上添花"的能力 —— 挂了也不能让主程序崩。
 */
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

const CACHE_TTL = 1500;

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: timeout || 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
    } catch (e) { resolve(''); }
  });
}

/* ---------------- macOS（JXA / System Events） ---------------- */

const MAC_ENUM = `
function run(argv) {
  var out = [];
  var se, procs;
  try { se = Application('System Events'); procs = se.applicationProcesses(); }
  catch (e) { return '[]'; }
  var frontPid = 0;
  try {
    var fp = se.applicationProcesses.whose({ frontmost: true })();
    if (fp.length) frontPid = fp[0].unixId();
  } catch (e) {}
  for (var i = 0; i < procs.length; i++) {
    var pr = procs[i], pid = 0, name = '', vis = true;
    try { pid = pr.unixId(); } catch (e) { continue; }
    if (!pid || pid === 0) continue;
    try { name = pr.name() || ''; } catch (e) { name = ''; }
    if (!name) continue;
    try { vis = pr.visible(); } catch (e) { vis = true; }
    var wins = [];
    try { wins = pr.windows(); } catch (e) { wins = []; }
    for (var j = 0; j < wins.length; j++) {
      var w = wins[j], title = '', x = 0, y = 0, mini = false, foc = false;
      try { title = w.name() || ''; } catch (e) {}
      try { var pos = w.position(); x = pos[0]; y = pos[1]; } catch (e) {}
      try { mini = w.attributes.byName('AXMinimized').value() === true; } catch (e) {}
      try { foc = w.attributes.byName('AXFocused').value() === true; } catch (e) {}
      out.push({
        hwnd: pid * 1000 + j + 1, pid: pid, proc: name, title: title,
        vis: !!vis && !mini, iconic: !!mini, x: x || 0, y: y || 0, exe: '',
        tool: false, cloaked: !vis, fg: !!(foc || (pid === frontPid && foc))
      });
    }
  }
  return JSON.stringify(out);
}
`;

const MAC_HIDE_SHOW = `
function run(argv) {
  var cmd = argv[0] || 'HIDE';
  var ids = (argv[1] || '').split(',');
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  var byPid = {};
  for (var i = 0; i < ids.length; i++) {
    var id = parseInt(ids[i], 10);
    if (!id) continue;
    var pid = Math.floor(id / 1000), idx = (id % 1000) - 1;
    if (!byPid[pid]) byPid[pid] = [];
    byPid[pid].push(idx);
  }
  for (var p = 0; p < procs.length; p++) {
    var pr = procs[p], pid2 = 0;
    try { pid2 = pr.unixId(); } catch (e) { continue; }
    if (!byPid[pid2]) continue;
    try {
      if (cmd === 'HIDE') {
        pr.visible = false;
      } else {
        pr.visible = true;
        if (cmd === 'SHOW' || cmd === 'SHOWMIN') {
          try {
            var wins = pr.windows();
            for (var k = 0; k < wins.length; k++) {
              if (cmd === 'SHOW' && byPid[pid2].indexOf(k) >= 0) {
                try { wins[k].attributes.byName('AXMinimized').value = false; } catch (e) {}
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  return 'ok';
}
`;

const MAC_MIN = `
function run(argv) {
  var ids = (argv[0] || '').split(',');
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  for (var p = 0; p < procs.length; p++) {
    var pr = procs[p], pid = 0;
    try { pid = pr.unixId(); } catch (e) { continue; }
    var wins = [];
    try { wins = pr.windows(); } catch (e) { continue; }
    for (var i = 0; i < ids.length; i++) {
      var id = parseInt(ids[i], 10);
      if (!id) continue;
      if (Math.floor(id / 1000) !== pid) continue;
      var idx = (id % 1000) - 1;
      if (idx < 0 || idx >= wins.length) continue;
      try { wins[idx].attributes.byName('AXMinimized').value = true; } catch (e) {}
    }
  }
  return 'ok';
}
`;

const MAC_CLOSE = `
function run(argv) {
  var ids = (argv[0] || '').split(',');
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  for (var p = 0; p < procs.length; p++) {
    var pr = procs[p], pid = 0;
    try { pid = pr.unixId(); } catch (e) { continue; }
    var wins = [];
    try { wins = pr.windows(); } catch (e) { continue; }
    for (var i = 0; i < ids.length; i++) {
      var id = parseInt(ids[i], 10);
      if (!id || Math.floor(id / 1000) !== pid) continue;
      var idx = (id % 1000) - 1;
      if (idx < 0 || idx >= wins.length) continue;
      var w = wins[idx];
      try {
        var btn = w.buttons.whose({ subrole: 'AXCloseButton' })();
        if (btn.length) btn[0].actions.byName('AXPress').perform();
        else w.actions.byName('AXPress').perform();
      } catch (e) {
        try { w.attributes.byName('AXCloseButton').value; } catch (e2) {}
      }
    }
  }
  return 'ok';
}
`;

const MAC_FOCUS = `
function run(argv) {
  var id = parseInt(argv[0] || '0', 10);
  if (!id) return 'ok';
  var pid = Math.floor(id / 1000), idx = (id % 1000) - 1;
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  for (var p = 0; p < procs.length; p++) {
    var pr = procs[p], pid2 = 0;
    try { pid2 = pr.unixId(); } catch (e) { continue; }
    if (pid2 !== pid) continue;
    try { pr.frontmost = true; } catch (e) {}
    try {
      var wins = pr.windows();
      if (idx >= 0 && idx < wins.length) {
        try { wins[idx].actions.byName('AXRaise').perform(); } catch (e) {}
        try { wins[idx].attributes.byName('AXMinimized').value = false; } catch (e) {}
      }
    } catch (e) {}
  }
  return 'ok';
}
`;

const MAC_MOVE = `
function run(argv) {
  var id = parseInt(argv[0] || '0', 10);
  var x = parseInt(argv[1] || '0', 10), y = parseInt(argv[2] || '0', 10);
  if (!id) return 'ok';
  var pid = Math.floor(id / 1000), idx = (id % 1000) - 1;
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  for (var p = 0; p < procs.length; p++) {
    var pr = procs[p], pid2 = 0;
    try { pid2 = pr.unixId(); } catch (e) { continue; }
    if (pid2 !== pid) continue;
    try {
      var wins = pr.windows();
      if (idx >= 0 && idx < wins.length) wins[idx].position = [x, y];
    } catch (e) {}
  }
  return 'ok';
}
`;

const MAC_RECT = `
function run(argv) {
  var ids = (argv[0] || '').split(',');
  var out = [];
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  for (var p = 0; p < procs.length; p++) {
    var pr = procs[p], pid = 0;
    try { pid = pr.unixId(); } catch (e) { continue; }
    var wins = [];
    try { wins = pr.windows(); } catch (e) { continue; }
    for (var i = 0; i < ids.length; i++) {
      var id = parseInt(ids[i], 10);
      if (!id || Math.floor(id / 1000) !== pid) continue;
      var idx = (id % 1000) - 1;
      if (idx < 0 || idx >= wins.length) continue;
      try {
        var pos = wins[idx].position(), sz = wins[idx].size();
        out.push({ hwnd: id, l: pos[0], t: pos[1], r: pos[0] + sz[0], b: pos[1] + sz[1] });
      } catch (e) {}
    }
  }
  return JSON.stringify(out);
}
`;

function createMac() {
  // 注意：osascript 会把 -e 之后、非选项的参数按顺序传给脚本的 run(argv)，
  // 中间不要插 '--'（它会被当成 argv[0]，把参数整体错位一格）。
  const osa = (code, args) => run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', code].concat(args || []), 6000);

  return {
    id: 'darwin',
    async start() {
      const r = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
        'Application("System Events").applicationProcesses().length.toString()'], 5000);
      return { ok: !!r, detail: r ? 'System Events 可用' : '需要在「系统设置 → 隐私与安全性 → 辅助功能」里授权' };
    },
    async exec(cmd) {
      const p = String(cmd || '').split('|');
      const c = String(p[0] || '').toUpperCase();
      if (c === 'ENUM') {
        const r = await osa(MAC_ENUM);
        return /^\[/.test(r) ? r : '[]';
      }
      if (c === 'HIDE' || c === 'SHOW' || c === 'SHOWMIN') {
        await osa(MAC_HIDE_SHOW, [c, p[1] || '']);
        return 'ok';
      }
      if (c === 'MIN') { await osa(MAC_MIN, [p[1] || '']); return 'ok'; }
      if (c === 'CLOSE') { await osa(MAC_CLOSE, [p[1] || '']); return 'ok'; }
      if (c === 'FOCUS') { await osa(MAC_FOCUS, [p[1] || '']); return 'ok'; }
      if (c === 'MOVE') { await osa(MAC_MOVE, [p[1], p[2], p[3]]); return 'ok'; }
      if (c === 'RECT') {
        const r = await osa(MAC_RECT, [p[1] || '']);
        return /^\[/.test(r) ? r : '[]';
      }
      if (c === 'PPID') return ppidViaPs(p[1]);
      if (c === 'FG') return '0';
      // WORK / SETRECT / WALL / GENWALL / QUIT：macOS 上交给 Electron 自己处理
      return c === 'WORK' || c === 'RECT' ? '' : 'ok';
    }
  };
}

/* ---------------- Linux（xdotool / wmctrl） ---------------- */

async function hasBin(bin) {
  const r = await run('/bin/sh', ['-c', 'command -v ' + bin + ' >/dev/null 2>&1 && echo ok'], 3000);
  return r === 'ok';
}

function createLinux() {
  let tools = null;
  async function ensureTools() {
    if (tools) return tools;
    const xdo = await hasBin('xdotool');
    const wm = await hasBin('wmctrl');
    tools = { xdo, wm };
    return tools;
  }

  // wmctrl -lpx: ID  desktop  PID  WM_CLASS  host  Title
  async function enumByWmctrl(exclude) {
    const out = await run('wmctrl', ['-lpx'], 6000);
    if (!out) return '[]';
    const rows = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const id = parseInt(m[1], 16);
      const pid = Number(m[3]);
      if (!id || exclude.has(pid)) continue;
      const cls = m[4] || '';
      const proc = (cls.split('.').pop() || cls || 'app').replace(/[^-A-Za-z0-9_.]/g, '') || 'app';
      rows.push({
        hwnd: id, pid, proc, title: m[6] || '',
        vis: true, iconic: false, x: 0, y: 0, exe: '',
        tool: false, cloaked: false, fg: false
      });
    }
    return JSON.stringify(rows);
  }

  return {
    id: 'linux',
    async start() {
      const t = await ensureTools();
      if (!t.xdo) return { ok: false, detail: '没装 xdotool：窗口隔离关闭（sudo apt install xdotool）' };
      const session = String(process.env.XDG_SESSION_TYPE || '').toLowerCase();
      if (session === 'wayland') return { ok: false, detail: 'Wayland 会话下不支持跨应用窗口隐藏（可切到 X11 登录）' };
      return { ok: true, detail: 'xdotool 可用' };
    },
    async exec(cmd) {
      const p = String(cmd || '').split('|');
      const c = String(p[0] || '').toUpperCase();
      const ids = (p[1] || '').split(',').filter(Boolean);
      if (c === 'ENUM') {
        const ex = new Set((p[1] || '').split(',').filter(Boolean).map(Number));
        const t = await ensureTools();
        if (t.wm) return enumByWmctrl(ex);
        return '[]';
      }
      if (c === 'HIDE' || c === 'SHOW' || c === 'SHOWMIN') {
        if (!ids.length) return 'ok';
        const args = [];
        for (const id of ids) args.push(c === 'HIDE' ? 'windowunmap' : 'windowmap', id);
        if (c === 'SHOW') for (const id of ids) args.push('windowactivate', '--sync', id);
        await run('xdotool', args, 8000);
        return 'ok';
      }
      if (c === 'MIN') {
        for (const id of ids) await run('xdotool', ['windowminimize', id], 4000);
        return 'ok';
      }
      if (c === 'CLOSE') {
        for (const id of ids) await run('xdotool', ['windowclose', id], 4000);
        return 'ok';
      }
      if (c === 'FOCUS') {
        if (ids[0]) await run('xdotool', ['windowactivate', '--sync', ids[0]], 4000);
        return 'ok';
      }
      if (c === 'MOVE') {
        if (p[1]) await run('xdotool', ['windowmove', p[1], String(p[2] || 0), String(p[3] || 0)], 4000);
        return 'ok';
      }
      if (c === 'SETRECT') {
        if (p[1]) {
          await run('xdotool', ['windowmove', p[1], String(p[2] || 0), String(p[3] || 0)], 4000);
          await run('xdotool', ['windowsize', p[1], String(p[4] || 0), String(p[5] || 0)], 4000);
        }
        return 'ok';
      }
      if (c === 'RECT') {
        const out = [];
        for (const id of ids) {
          const g = await run('xdotool', ['getwindowgeometry', '--shell', id], 4000);
          if (!g) continue;
          const kv = {};
          for (const line of g.split(/\r?\n/)) {
            const m = /^([A-Z]+)=(.+)$/.exec(line.trim());
            if (m) kv[m[1]] = m[2];
          }
          if (kv.X === undefined) continue;
          const x = Number(kv.X), y = Number(kv.Y), w = Number(kv.WIDTH), h = Number(kv.HEIGHT);
          out.push({ hwnd: Number(id), l: x, t: y, r: x + w, b: y + h });
        }
        return JSON.stringify(out);
      }
      if (c === 'PPID') return ppidViaPs(p[1]);
      if (c === 'FG') return '0';
      return 'ok';   // WORK / WALL / GENWALL 不支持但不要报错
    }
  };
}

/* ---------------- 父进程查询（POSIX：ps） ---------------- */

async function ppidViaPs(csv) {
  const want = new Set(String(csv || '').split(',').filter(Boolean).map(Number));
  if (!want.size) return '[]';
  const out = await run('/bin/ps', ['-Ao', 'pid=,ppid='], 5000);
  if (!out) return '[]';
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!want.has(pid)) continue;
    rows.push({ ProcessId: pid, ParentProcessId: Number(m[2]) });
  }
  return JSON.stringify(rows);
}

/* ---------------- 兜底（不支持的系统） ---------------- */

function createNone(id) {
  return {
    id: id || 'none',
    async start() { return { ok: false, detail: '当前系统不支持窗口隔离，其余功能正常' }; },
    async exec() { return ''; }
  };
}

function create(plat) {
  const p = plat || process.platform;
  if (p === 'darwin') return createMac();
  if (p === 'linux') return createLinux();
  if (p === 'win32') return null;    // Windows 用 main.js 里的 winhelper 常驻助手
  return createNone(p);
}

module.exports = { create, ppidViaPs, createMac, createLinux, createNone };
