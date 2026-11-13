/**
 * FDE 管理软件 v3 —— 真实多桌面（窗口级半隔离）
 *
 * 设计要点（和 v2 的"假桌面"彻底不同）：
 *  - 不再用全屏窗口模拟桌面。桌面就是 Windows 真实桌面（真实图标、真实任务栏）。
 *  - 每个项目"拥有"一组真实窗口句柄（HWND）。进入某项目桌面时：
 *      其它项目 / 原桌面的窗口 → 隐藏（SW_HIDE，进程照常运行，内存不丢）
 *      本项目的窗口            → 显示（原先最小化的自动还原）
 *      同时切换真实 Windows 壁纸为该项目的专属配色
 *  - 在项目桌面里新打开的程序，会被自动归入当前项目（轮询 2.5s 捕获）。
 *  - 原电脑桌面只是"第 0 个桌面"，同样有自己的一组窗口，互不干扰。
 *  - 所有 Win32 调用走一个常驻 PowerShell 助手（winhelper.ps1），避免频繁启动进程。
 */
const { app, BrowserWindow, ipcMain, screen, dialog, shell, Tray, Menu, globalShortcut, nativeImage, clipboard, desktopCapturer } = require('electron');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const runtime = require('./runtime');
const trust = require('./trust');
const adopt = require('./adopt');
const acks = require('./acks');
const panels = require('./panels');
const desktop = require('./desktop');
const urlopen = require('./urlopen');
const gbk = require('./gbk');   // 1688 搜索页是 GBK，关键词必须换编码，否则搜索框乱码
const kbLib = require('./kb');   // 知识库引擎：抽文本 / 切块 / 索引 / 检索
const platform = require('./platform');   // 跨平台能力矩阵（Win / macOS Intel+M / Linux）
const wmp = require('./wmp');             // 窗口管理适配层：同一套命令，三个系统各自实现

const PLAT = platform.caps();
const IS_WIN = PLAT.id === 'win32';
const IS_MAC = PLAT.id === 'darwin';
const IS_LINUX = PLAT.id === 'linux';
// 非 Windows 的窗口执行者（macOS: osascript，Linux: xdotool）；Windows 为 null，走常驻助手
const wmProvider = IS_WIN ? null : wmp.create(PLAT.id);

/**
 * 打包后（asar）被外部进程（PowerShell 助手 / 资源管理器 / 资源管理器代启）读取的文件，
 * 必须换算成 app.asar.unpacked 里的真实路径 —— 外部进程看不见 asar 虚拟文件系统。
 */
function unpackedPath(p) {
  const s = String(p || '');
  return app.isPackaged ? s.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : s;
}

// 应用名会出现在 macOS 菜单栏、Linux 窗口列表、通知里（不设的话会显示 "Electron"）
try { app.setName('FDE Manager'); } catch (e) {}
if (IS_WIN) { try { app.setAppUserModelId('com.fde.manager'); } catch (e) {} }

// ---------- 打开网页：先记"意图"，再把新窗口认领到当前桌面 ----------
//
// 用「系统默认浏览器」打开网址时，Windows 常常是让**已经在运行的那个浏览器进程**
// 再开一个窗口 / 一个标签页。那个进程早就属于别的桌面了，按"同一进程跟随"规则，
// 新窗口会被判给别的桌面、立刻被隐藏 —— 用户看到的就是"闪一下就不见了、任务栏也没有"，
// 浏览器其实开着。（2026-11-06 用户反馈）
//
// 所以：打开前先记一条意图（谁开的 / 什么网址 / 用哪个 exe / 几秒内有效），
// 新窗口一律先查意图；万一浏览器只在已有窗口里加了个标签页，再靠 rescue 把那个窗口搬过来。

const openIntents = [];
let lastFgWindow = { hwnd: 0, at: 0 };

function noteOpenIntent(owner, url, exe) {
  const now = Date.now();
  for (let i = openIntents.length - 1; i >= 0; i--) {
    if (openIntents[i].used || now - openIntents[i].at > 30000) openIntents.splice(i, 1);
  }
  const it = {
    owner: owner === undefined ? null : owner,
    url: String(url || ''),
    host: urlopen.hostOf(url),
    exe: exe || '',
    at: now,
    used: false
  };
  openIntents.push(it);
  return it;
}

/** 新窗口是不是"刚打开的那个网页"：命中就标记意图已用 */
function claimByIntent(w) {
  const it = urlopen.matchIntent(openIntents, w, Date.now());
  if (!it) return null;
  it.used = true;
  // 有些浏览器开完窗不会自己到最前面（或被我们上一轮的收敛压下去），
  // 这是用户刚点的网页，帮它到前台来一次
  setTimeout(() => {
    try {
      winCmd('SHOW|' + w.hwnd, 5000);
      setTimeout(() => { try { winCmd('FOCUS|' + w.hwnd, 5000); } catch (e) {} }, 180);
    } catch (e) {}
  }, 220);
  return it;
}

/**
 * 系统默认浏览器的 exe（查不到返回空 → 退化为交给系统打开）。
 * 具体逻辑在 urlopen.js（可单测）：读注册表 + ProgId 兜底 + 缓存。
 */
function defaultBrowserExe() {
  // 注册表只有 Windows 有；macOS / Linux 交给系统壳（open / xdg-open）去选默认浏览器
  if (!IS_WIN) return Promise.resolve('');
  return urlopen.resolveDefaultBrowser({ browsers: () => detectBrowsers() });
}

/** 起浏览器进程；真起不来（找不到 exe / 被拦）才返回 false，交给系统兜底 */
function trySpawn(plan) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; resolve(ok); };
    let child;
    try {
      child = spawn(plan.exe, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (e) { return finish(false); }
    child.once('error', () => finish(false));
    child.once('spawn', () => finish(true));
    setTimeout(() => finish(true), 800);
    try { child.unref(); } catch (e) {}
  });
}

/**
 * 在指定桌面打开网址。
 * 自己 spawn 浏览器并带 --new-window：只有"新窗口"才有新句柄可以认领；
 * 交给系统打开会复用已有窗口的标签页，认领不到，就会被当成别的桌面的窗口藏起来。
 */
async function openUrlOn(owner, url, browserPath) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, error: '网址为空' };
  let exe = String(browserPath || '').trim();
  if (!exe) exe = await defaultBrowserExe();
  const it = noteOpenIntent(owner, target, exe);
  if (exe) {
    const plan = urlopen.launchPlan(exe, target);
    if (plan && await trySpawn(plan)) {
      watchForeground(it);
      scheduleIntentRescue(it);
      return { ok: true, via: 'spawn', exe: plan.exe };
    }
  }
  try {
    await shell.openExternal(target);
    watchForeground(it);
    scheduleIntentRescue(it);
    return { ok: true, via: 'shell' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 打开「给人看的网页」：官网、密钥页、用量页、资料库里的文档链接。
 *
 * 这类链接不能用 openUrlOn 那套「spawn --new-window 再认领新窗口」：
 *  - 360 / QQ / Edge 这些默认浏览器常常在已有进程里就地开标签，spawn 出来的新进程
 *    抢不到句柄，还会顺手弹出自己的助手小窗（标题就是纯数字）；
 *  - 意图被小窗吃掉，真正的页面窗口没人认领 → 被判成"别的桌面的窗口"藏起来，
 *    用户看到的就是「闪一下就没了」。
 *  - 更常见的是：注册表里那个"默认浏览器"根本起不来（这台机器上的 360se 直接 exit 21），
 *    系统壳 openExternal 也不报错、就是没窗口。
 *
 * 所以按"能看见才算成功"来：系统默认浏览器 → 换一个装着的浏览器 → 实在不行在 FDE 里开内置窗口。
 */
async function openUserSite(url) {
  const target = String(url || '').trim();
  if (!target) return { ok: false, error: '网址为空' };
  const it = noteOpenIntent(activeId, target, '');
  let before = new Set();
  try { before = new Set((await enumWindows()).map(w => w.hwnd)); } catch (e) {}

  // 1) 系统默认浏览器（正常机器上走这条就够）
  try { await shell.openExternal(target); } catch (e) {}
  if (!IS_WIN) return { ok: true, via: 'default', url: target };   // mac/Linux 交给系统，不掺和窗口归属
  let hit = await adoptSiteWindow(it, 2200, before);
  if (hit) return { ok: true, via: 'default', url: target };

  // 2) 默认浏览器没起来：换一个装着的浏览器直接起（跳过起不来的那个）
  let defExe = '';
  try { defExe = await defaultBrowserExe(); } catch (e) {}
  for (const b of await altBrowsers(defExe)) {
    const plan = urlopen.launchPlan(b.path, target);
    if (!plan || !(await trySpawn(plan))) continue;
    hit = await adoptSiteWindow(it, 2600, before);
    if (hit) {
      addLog('系统默认浏览器没起来，已改用 ' + (b.name || urlopen.baseName(b.path)) + ' 打开网页', activeId);
      return { ok: true, via: 'alt', exe: b.path, url: target };
    }
  }

  // 3) 都打不开：在 FDE 里开一个内置窗口，至少让用户看得到页面、能登录拿密钥
  openSiteInside(target);
  addLog('系统里的浏览器都没起来，已用 FDE 内置窗口打开：' + target, activeId);
  return { ok: true, via: 'internal', url: target };
}

/** 除默认浏览器之外，还能试的浏览器（按"最可能正常"排序，最多 3 个） */
async function altBrowsers(defExe) {
  let list = [];
  try { list = await detectBrowsers(); } catch (e) { list = []; }
  // 注册表里没登记（绿色版 / 只有 Edge 的干净系统）时，按常见安装路径补一份
  const seen = new Set((list || []).map(b => String(b.path || '').toLowerCase()));
  for (const [name, p] of platform.knownBrowsers()) {
    if (!p || seen.has(String(p).toLowerCase())) continue;
    try { if (!fs.existsSync(p)) continue; } catch (e) { continue; }
    seen.add(String(p).toLowerCase());
    list.push({ name, path: p });
  }
  const defBase = urlopen.baseName(defExe).toLowerCase();
  const order = ['chrome', 'msedge', 'firefox', 'qqbrowser', 'sogou', '360se', 'edge', 'opera', 'brave'];
  const rank = (b) => {
    const n = urlopen.baseName(b.path).toLowerCase().replace(/\.exe$/, '');
    const i = order.findIndex(k => n.includes(k));
    return i < 0 ? 99 : i;
  };
  return (list || [])
    .filter(b => b && b.path && fs.existsSync(b.path))
    .filter(b => urlopen.baseName(b.path).toLowerCase() !== defBase)
    .filter(b => urlopen.isBrowserExe(b.path))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3);
}

/** 内置窗口：系统浏览器全都不灵时兜底，能登录、能复制密钥 */
let siteWin = null;
function openSiteInside(target) {
  try {
    if (siteWin && !siteWin.isDestroyed()) {
      siteWin.loadURL(target);
      if (siteWin.isMinimized()) siteWin.restore();
      siteWin.show(); siteWin.focus();
      return;
    }
    const a = panelArea();
    const w = Math.min(1120, a.width - 60), h = Math.min(860, a.height - 70);
    siteWin = new BrowserWindow({
      x: a.x + Math.round((a.width - w) / 2),
      y: a.y + Math.round((a.height - h) / 2),
      width: w, height: h, show: false,
      backgroundColor: '#0b0f17',
      title: 'API 网站（FDE 内置窗口）',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    siteWin.once('ready-to-show', () => { try { siteWin.show(); siteWin.focus(); } catch (e) {} });
    applyWinPin(siteWin);
    siteWin.on('closed', () => { siteWin = null; });
    siteWin.loadURL(target);
  } catch (e) { /* 兜底都失败就算了，日志里会留下 */ }
}

/**
 * 等浏览器窗口出现并把它认领到当前桌面（顺带显示+前置）。
 * @param before 打开之前就存在的句柄集合：只有"新出现的/刚变成前台的/标题对得上"的才算数，
 *               免得把用户原本就摆在前面的浏览器窗口当成刚打开的那个。
 * @returns 命中的窗口 | null
 */
async function adoptSiteWindow(it, budget, before) {
  const deadline = Date.now() + (budget || 2200);
  while (Date.now() < deadline) {
    await sleep(280);
    try {
      await collect(activeId);
      const list = await enumWindows();
      const pool = list.filter(w => w && w.vis && !w.iconic && urlopen.isBrowserExe(w.exe));
      const isNew = (w) => !before || !before.has(w.hwnd);
      const recent = lastFgWindow.at >= it.at - 500 ? lastFgWindow.hwnd : 0;
      const hit = pool.find(w => w.fg && (isNew(w) || w.hwnd === recent)) ||
        pool.find(w => recent && w.hwnd === recent) ||
        pool.find(w => urlopen.titleLooksLike(w.title, it.host)) ||
        pool.find(w => isNew(w));
      if (!hit) continue;
      it.used = true;
      const rec = winRecs.get(hit.hwnd);
      if (rec && rec.owner !== it.owner) {
        rec.owner = it.owner;
        await applyVisibility();
        try { persistOwners(); } catch (e) {}
        const p = it.owner ? data.projects.find(x => x.id === it.owner) : null;
        addLog('网页在别的桌面的浏览器里打开了，已把这个窗口搬到「' + (p ? p.name : '原电脑桌面') + '」', it.owner);
      }
      await winCmd('SHOW|' + hit.hwnd, 5000);
      await winCmd('FOCUS|' + hit.hwnd, 5000);
      // 有的浏览器加载完会自己再抢一次焦点/被系统收敛，1.6 秒后再确认一次
      setTimeout(() => { try { winCmd('SHOW|' + hit.hwnd, 4000); winCmd('FOCUS|' + hit.hwnd, 4000); } catch (e) {} }, 1600);
      refreshStatuses(true);
      return hit;
    } catch (e) { /* 后台重试，失败继续等 */ }
  }
  return null;
}

/**
 * 打开网页后盯着前台窗口 5 秒：浏览器把哪个窗口翻上来了，就记下来。
 * 「默认浏览器」常常只在已有窗口里加个标签页（没有新窗口可认领），
 * 这种情况下前台窗口的句柄变化就是最好的线索。
 */
function watchForeground(it, ms) {
  const end = Date.now() + (ms || 5000);
  const tick = async () => {
    if (!it || it.used || Date.now() > end) return;
    try {
      const raw = await winCmd('FG', 4000);
      const h = Number(String(raw || '').trim()) || 0;
      if (h) {
        if (!it.fgHits) it.fgHits = [];
        if (it.fgHits[it.fgHits.length - 1] !== h) it.fgHits.push(h);
      }
    } catch (e) {}
    setTimeout(tick, 350);
  };
  setTimeout(tick, 260);
}

/**
 * 兜底：浏览器只在已有窗口里开了个标签页（没有新窗口可认领）。
 * 几秒后如果意图还没用掉，就把那个浏览器窗口搬到发起打开的桌面 ——
 * 否则它会被当成"别的桌面的窗口"藏起来，用户看到的就是闪一下没了。
 */
function scheduleIntentRescue(it, tries) {
  const t = tries || [1800, 3400];
  t.forEach((delay, i) => setTimeout(() => rescueIntent(it, i === t.length - 1), delay));
}

async function rescueIntent(it, last) {
  try {
    if (!it || it.used) return;
    await collect(activeId);
    const list = await enumWindows();
    // 只认"打开网址之后才变成前台"的窗口，避免把很久以前的焦点窗口搬过来
    const recent = lastFgWindow.at >= it.at - 1500 && Date.now() - lastFgWindow.at < 12000
      ? lastFgWindow.hwnd : 0;
    const hit = urlopen.pickRescueWindow(list, it, { recentFgHwnd: recent, fgHits: it.fgHits });
    if (!hit) return;
    const rec = winRecs.get(hit.hwnd);
    if (!rec) return;
    if (rec.owner === it.owner) { it.used = true; return; }
    // 证据够硬才动手：它现在就是前台，或者它刚在我们打开网址后被翻到过前台。
    // 否则等最后一轮，别抢在浏览器前面下结论（可能还在加载/切窗口）
    const strong = !!hit.fg || (it.fgHits || []).includes(hit.hwnd);
    if (!last && !strong) return;
    it.used = true;
    rec.owner = it.owner;
    const p = it.owner ? data.projects.find(x => x.id === it.owner) : null;
    addLog('网页在别的桌面的浏览器里打开了，已把这个窗口搬到「' + (p ? p.name : '原电脑桌面') + '」', it.owner);
    await applyVisibility();
    await winCmd('SHOW|' + hit.hwnd, 5000);
    await winCmd('FOCUS|' + hit.hwnd, 5000);
    persistOwners();
    refreshStatuses(true);
  } catch (e) { /* 后台补救，失败不影响主流程 */ }
}


/**
 * 数据放哪 —— 必须在 app ready 之前定下来，之后所有 getPath('userData') 才一致。
 * 支持：--data-dir= / 环境变量 FDE_DATA_DIR / 程序目录下的 portable.json（绿色版）。
 * 这样整套东西可以放在网盘或 U 盘里跟着走，换电脑不用重新搭。
 */
const APP_DIR = __dirname;
const DATA_ROOT = runtime.resolveDataRoot({
  argv: process.argv.slice(1),
  env: process.env,
  appDir: APP_DIR,
  defaultDir: app.getPath('userData')
});
try {
  fs.mkdirSync(DATA_ROOT.dir, { recursive: true });
  app.setPath('userData', DATA_ROOT.dir);
} catch (e) { /* 目录建不出来就退回默认，启动优先 */ }

let panelWin = null;
let switcherWin = null; // 桌面切换总览（覆盖层）
let switcherWatchdog = null; // 工作台窗口看门狗：被悄悄隐藏时自动拉回并留痕
const projectPanels = new Map(); // projectId -> BrowserWindow（项目控制面板，非全屏）

const COLORS = ['#4f8cff', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#eab308'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 不参与桌面归属的进程（系统外壳 / 本软件自身）
// 注意：explorer 的桌面/任务栏窗口已由助手按窗口类名（Progman/WorkerW/Shell_TrayWnd）排除，
// 这里不再整体排除 explorer，否则「文件资源管理器」窗口会漏到每个桌面上。
const APP_EXCLUDE = new Set([
  'textinputhost', 'searchhost', 'shellexperiencehost',
  'startmenuexperiencehost', 'systemsettings',
  'lockapp', 'peopleexperiencehost', 'sihost', 'dwm'
]);

// ---------- 数据持久化 ----------
let data = {
  projects: [],
  flows: [],
  logs: [],
  trash: [],
  inbox: {},          // projectId -> [msg]
  originalWindows: [], // 原电脑桌面的窗口（用于重启后恢复归属）
  exeOwners: {},       // 可执行文件路径(小写) -> 项目 id | null（"这个软件属于哪个桌面"）
  // 工作流画布：把「项目 / 应用窗口 / 网页 / 脚本 / 文件 / 笔记 / AI」编排成一张上下文图
  canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } },
  settings: { originalWallpaper: '', wallpaper: true, needAdmin: true, lastIsAdmin: null }
};

// 启动诊断日志：第一次启动"没反应"这类问题，没有日志只能猜
function slog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'startup.log');
    const st = fs.statSync(f);
    if (st.size > 256 * 1024) fs.writeFileSync(f, '');
  } catch (e) { /* 文件不存在，正常 */ }
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'),
      new Date().toISOString() + '  ' + msg + '\r\n');
  } catch (e) {}
}

// 画布节点的合法类型（其余一律按 note 处理，避免脏数据打崩渲染）
const CANVAS_TYPES = new Set(['project', 'window', 'url', 'script', 'file', 'folder', 'note', 'ai', 'group', 'gen']);
// 连线类型：flow=执行顺序（参与流程） / handoff=项目间交接（参与流程但只是提示） / ref=仅参考（不参与执行）
const EDGE_KINDS = new Set(['flow', 'handoff', 'ref']);

function emptyCanvas() {
  return { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } };
}

function normalizeCanvas(c) {
  const out = emptyCanvas();
  if (!c || typeof c !== 'object') return out;
  const nodes = Array.isArray(c.nodes) ? c.nodes : [];
  for (const n of nodes) {
    if (!n || !n.id) continue;
    out.nodes.push({
      id: String(n.id),
      type: CANVAS_TYPES.has(n.type) ? n.type : 'note',
      title: String(n.title || '未命名'),
      note: String(n.note || ''),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      w: Math.max(120, Math.min(900, Number(n.w) || 240)),
      h: Math.max(0, Math.min(1400, Number(n.h) || 0)),
      color: String(n.color || ''),
      ref: (n.ref && typeof n.ref === 'object') ? n.ref : {},
      collapsed: !!n.collapsed,
      locked: !!n.locked,
      tags: Array.isArray(n.tags) ? n.tags.slice(0, 8).map(t => String(t).slice(0, 18)) : [],
      z: Number(n.z) || 0
    });
  }
  const ids = new Set(out.nodes.map(n => n.id));
  const edges = Array.isArray(c.edges) ? c.edges : [];
  for (const e of edges) {
    if (!e || !ids.has(String(e.from)) || !ids.has(String(e.to))) continue;
    if (String(e.from) === String(e.to)) continue;
    out.edges.push({
      id: String(e.id || ('e' + Math.random().toString(36).slice(2, 9))),
      from: String(e.from),
      to: String(e.to),
      label: String(e.label || ''),
      kind: EDGE_KINDS.has(e.kind) ? e.kind : 'flow',
      dashed: !!e.dashed
    });
  }
  const v = c.view || {};
  out.view = { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Math.min(2.5, Math.max(0.2, Number(v.z) || 1)) };
  return out;
}

function dataFile() {
  return path.join(app.getPath('userData'), 'fde-data.json');
}

function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    data = {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      flows: Array.isArray(parsed.flows) ? parsed.flows : [],
      logs: Array.isArray(parsed.logs) ? parsed.logs : [],
      trash: Array.isArray(parsed.trash) ? parsed.trash : [],
      inbox: parsed.inbox && typeof parsed.inbox === 'object' ? parsed.inbox : {},
      originalWindows: Array.isArray(parsed.originalWindows) ? parsed.originalWindows : [],
      exeOwners: parsed.exeOwners && typeof parsed.exeOwners === 'object' ? parsed.exeOwners : {},
      canvas: normalizeCanvas(parsed.canvas),
      settings: Object.assign({ originalWallpaper: '', wallpaper: true, needAdmin: true, lastIsAdmin: null }, parsed.settings || {})
    };
  } catch (e) {
    data = {
      projects: [], flows: [], logs: [], trash: [], inbox: {},
      originalWindows: [], exeOwners: {},
      canvas: emptyCanvas(),
      settings: { originalWallpaper: '', wallpaper: true, needAdmin: true, lastIsAdmin: null }
    };
  }
  // 兼容旧版本数据
  normalizeData(data);
}

/** 把外部来的数据（导入的快照 / 旧版本文件）补齐成当前结构 */
function normalizeData(d) {
  if (!d || typeof d !== 'object') return d;
  d.projects = Array.isArray(d.projects) ? d.projects : [];
  d.flows = Array.isArray(d.flows) ? d.flows : [];
  d.logs = Array.isArray(d.logs) ? d.logs : [];
  d.trash = Array.isArray(d.trash) ? d.trash : [];
  d.inbox = (d.inbox && typeof d.inbox === 'object') ? d.inbox : {};
  d.exeOwners = (d.exeOwners && typeof d.exeOwners === 'object') ? d.exeOwners : {};
  d.canvas = normalizeCanvas(d.canvas);
  // winPin：功能窗口是否浮在最前。默认 false —— 置顶会挡住浏览器/文档，用户没法在底下操作
  d.settings = Object.assign({ originalWallpaper: '', wallpaper: true, needAdmin: true, lastIsAdmin: null, winPin: false }, d.settings || {});
  d.stats = Object.assign({ aiCalls: 0, cacheHits: 0, tokensSaved: 0 }, d.stats || {});
  for (const p of d.projects) {
    if (!p.id) p.id = 'p' + Math.random().toString(36).slice(2, 9);
    if (!p.approvals || typeof p.approvals !== 'object') p.approvals = {};
    if (!Array.isArray(p.items)) p.items = [];
    if (!Array.isArray(p.autorun)) p.autorun = [];
    if (!Array.isArray(p.windows)) p.windows = [];
    if (typeof p.exclusive !== 'boolean') p.exclusive = true;
    if (!p.status) p.status = 'stopped';
    if (typeof p.statusMsg !== 'string') p.statusMsg = '';
    // 案例/交付信息：给客户看的那部分（客户名、痛点、口径、授权）
    if (!p.case || typeof p.case !== 'object') p.case = {};
    // 推进信息：干系人、口径、决策档案（项目推不动时先看这里）
    if (!Array.isArray(p.stakeholders)) p.stakeholders = [];
    if (!p.adoption || typeof p.adoption !== 'object') p.adoption = {};
    // 确认台账：客户与服务方各自点过的"确认/有异议"，谁点的、什么时候点的一目了然
    if (!p.acks || typeof p.acks !== 'object' || Array.isArray(p.acks)) p.acks = {};
    // 项目上下文：给 AI / 脚本 / 交付文档用的材料（文件、目录、数据源、网页、笔记）
    if (!Array.isArray(p.context)) p.context = [];
    for (const c of p.context) {
      if (!c.id) c.id = 'c' + Math.random().toString(36).slice(2, 9);
      if (!c.kind) c.kind = 'text';
      if (typeof c.title !== 'string') c.title = '';
      if (typeof c.value !== 'string') c.value = '';
    }
  }
  return d;
}

function saveData() {
  try {
    fs.writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('保存数据失败:', e);
  }
}

function addLog(text, projectId) {
  data.logs.unshift({ time: Date.now(), text, projectId: projectId || null });
  if (data.logs.length > 200) data.logs = data.logs.slice(0, 200);
  saveData();
  broadcast('fde:logs', data.logs);
}

/** 主进程侧的飞行记录仪：窗口显示/隐藏等关键事件写进 renderer.log，与渲染进程日志同一文件 */
function __diagLog(text) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'renderer.log'),
      '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] [main] ' + String(text) + '\n');
  } catch (e) {}
}

/**
 * 全局进度播报：AI / 媒体生成这类几十秒的操作，写进日志让用户知道在跑什么。
 * （之前只有画布执行节点里有同名局部函数，其它地方调用会直接抛 ReferenceError）
 */
function say(text, projectId) {
  addLog(String(text || ''), projectId || null);
}

function broadcast(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) {
    try { panelWin.webContents.send(channel, payload); } catch (e) {}
  }
  if (switcherWin && !switcherWin.isDestroyed()) {
    try { switcherWin.webContents.send(channel, payload); } catch (e) {}
  }
  if (marketWin && !marketWin.isDestroyed()) {
    try { marketWin.webContents.send(channel, payload); } catch (e) {}
  }
  for (const win of projectPanels.values()) {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(channel, payload); } catch (e) {}
    }
  }
  // 项目列表变化时，同步刷新托盘菜单和全局热键（项目数量变化才重建热键）
  if (channel === 'fde:projects' && Array.isArray(payload)) {
    rebuildTrayMenu();
    if (payload.length !== lastShortcutCount) {
      lastShortcutCount = payload.length;
      rebuildShortcuts();
    }
  }
}
let lastShortcutCount = -1;

function snapshot() {
  // 每个桌面的窗口标题列表（总览卡片展示用），最多取 5 个
  const titles = { 'null': [] };
  for (const rec of winRecs.values()) {
    const k = rec.owner === null ? 'null' : rec.owner;
    if (!titles[k]) titles[k] = [];
    if (titles[k].length < 5 && rec.title) titles[k].push(rec.title);
  }
  return {
    projects: data.projects,
    flows: data.flows,
    logs: data.logs,
    trash: data.trash,
    inbox: data.inbox,
    // 项目面板用它判断"哪些项目在画布上已经连过线"（消息默认发给连线目标）
    canvas: { nodes: data.canvas.nodes, edges: data.canvas.edges },
    activeId,
    uncontrolled: uncontrollable.size,
    missing: lastMissing.length,
    isAdmin,
    originalCount: data.originalWindowsCount || 0,
    originalTitles: titles['null'] || [],
    windowTitles: titles,
    autostart: isAutostartOn(),
    settings: data.settings
  };
}

// ---------- 常驻 Win32 助手 ----------
let helperProc = null;
let helperReady = false;
let helperDetail = '';        // 非 Windows 上记录"窗口隔离能不能用、为什么"
const helperQueue = [];
let inflight = null;

function startHelper() {
  // 非 Windows：没有 PowerShell 助手，改由 wmp 提供同一套命令（macOS / Linux）
  if (!IS_WIN) {
    helperReady = true;
    wmProvider.start().then((r) => {
      helperDetail = (r && r.detail) || '';
      // macOS / Linux 上 isAdmin 的语义改为"窗口隔离就绪"（面板按这个渲染）
      if (r && r.ok && !isAdmin) {
        isAdmin = true;
        broadcast('fde:desktop', desktopPayload());
      } else if (!(r && r.ok)) {
        addLog('窗口隔离不可用：' + helperDetail);
        broadcast('fde:desktop', desktopPayload());
      }
    }).catch((e) => { helperDetail = e.message; });
    return;
  }
  if (helperProc) return;
  const script = unpackedPath(path.join(__dirname, 'winhelper.ps1'));
  try {
    helperProc = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('启动 Win32 助手失败:', e.message);
    helperProc = null;
    setTimeout(startHelper, 2000);
    return;
  }
  helperReady = true;
  const rl = readline.createInterface({ input: helperProc.stdout });
  rl.on('line', (line) => {
    if (line.slice(0, 2) !== '@@') return;
    settle(line.slice(2));
  });
  helperProc.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) console.error('[winhelper]', s);
  });
  helperProc.on('exit', () => {
    helperProc = null;
    helperReady = false;
    settle('');
    if (!quitting) setTimeout(startHelper, 1500);
  });
}

function settle(val) {
  if (!inflight) return;
  clearTimeout(inflight.timer);
  const job = inflight;
  inflight = null;
  job.resolve(val);
  setImmediate(pumpHelper);
}

function winCmd(cmd, timeout = 12000) {
  // 非 Windows：同一套命令协议，交给平台适配层执行（见 wmp.js）。
  // 失败一律回 ''，调用方本来就要处理"拿不到结果"，所以不会连锁报错。
  if (!IS_WIN) {
    try { return Promise.resolve(wmProvider.exec(cmd, timeout)); } catch (e) { return Promise.resolve(''); }
  }
  return new Promise((resolve) => {
    helperQueue.push({ cmd, resolve, timeout, timer: null });
    pumpHelper();
  });
}

function pumpHelper() {
  if (inflight) return;
  const job = helperQueue.shift();
  if (!job) return;
  if (!helperProc || !helperReady) { job.resolve(''); return; }
  inflight = job;
  job.timer = setTimeout(() => settle(''), job.timeout);
  try {
    helperProc.stdin.write(job.cmd + '\n');
  } catch (e) {
    settle('');
  }
}

// ---------- 窗口归属表 ----------
// hwnd -> { hwnd, pid, proc, title, owner }   owner: 项目 id 或 null（原电脑桌面）
const winRecs = new Map();
let activeId = null;                   // 当前桌面：项目 id 或 null（原电脑桌面）
const autorunDone = new Set();          // 本次运行中已经执行过自动打开的项目
const uncontrollable = new Set();       // 无法隐藏的窗口（管理员权限程序）
let pidsSeen = new Set();               // 见过的所有进程 pid（用于父进程查询与切换快照）
let pidsAtSwitch = new Set();           // 上次切换桌面那一刻已存在的进程（"老进程"判定）

function ownerOfPid(pid) {
  for (const rec of winRecs.values()) {
    if (rec.pid === pid) return rec.owner;
  }
  return undefined;
}

// 同一个可执行文件的归一化键 / 「同一个软件」的归并键：见 desktop.js（纯函数，有单测）
const exeKey = desktop.exeKey;
const appKey = desktop.appKey;
// 屏幕外的判定（我们自己搬走的 -30000、或显示器变化后窗口留在不存在的区域）
function displayUnion() {
  try { return desktop.unionOfDisplays(screen.getAllDisplays()); } catch (e) { return null; }
}

function ownerOfApp(key) {
  if (!key) return undefined;
  for (const rec of winRecs.values()) {
    if (appKey(rec.exe) === key) return rec.owner;
  }
  // 手动指定的「这个软件属于哪个桌面」记录（windows:assign 里写入的 exeOwners）
  for (const [k, v] of Object.entries(data.exeOwners || {})) {
    if (appKey(k) === key) return v;
  }
  return undefined;
}

// 进程级归属记忆：pid -> { owner, exe }
// 窗口记录会因为 cloaked（UWP 挂起）/ 标题为空等原因瞬时消失，如果只靠 hwnd 记录，
// 归属一丢，同一个软件再新建的窗口就会被当成"全新软件"落到当前桌面 —— 这正是
// "切回项目桌面后有些窗口不见了"的主因之一。
const procOwners = new Map();
function rememberProc(pid, owner, exe) {
  const p = Number(pid);
  if (!p) return;
  const prev = procOwners.get(p);
  procOwners.set(p, { owner, exe: exeKey(exe) || (prev && prev.exe) || '' });
}
function forgetProc(pid) { procOwners.delete(Number(pid)); }
function ownerOfProc(pid, exe) {
  const m = procOwners.get(Number(pid));
  if (!m) return undefined;
  // pid 可能被系统复用给别的程序：可执行文件对不上就不认这条记忆
  if (m.exe && exe && exeKey(exe) !== m.exe) return undefined;
  return m.owner;
}

/**
 * 判断一个新窗口属于哪个桌面（自动分析，不需要用户指明）。
 * 规则细节与单测见 desktop.js（decideOwner）。
 * 这里补上"当前环境"：同进程归属、进程记忆、软件归属、父进程归属。
 */
function ownerForWindow(w, pidExe) {
  const ppid = parentOfPid.get(w.pid);
  const r = desktop.decideOwner(w, {
    assignNewTo: collectAssignTo,
    ownerOfPid: (pid) => ownerOfPid(pid),
    ownerOfProc: (pid, exe) => ownerOfProc(pid, exe),
    isOldProcess: (pid) => pidsAtSwitch.has(pid),
    ownerOfApp: (key) => ownerOfApp(key),
    parentOwner: () => (ppid ? ownerOfPid(ppid) : undefined),
    parentAppOwner: () => {
      if (!ppid) return undefined;
      const pexe = pidExe ? pidExe.get(ppid) : '';
      return pexe ? ownerOfApp(appKey(pexe)) : undefined;
    }
  });
  if (r.via === 'fg') {
    // 记录一次，便于排查"窗口怎么跑到这个桌面了"
    const prev = ownerOfPid(w.pid);
    if (prev !== undefined && prev !== r.owner) {
      addLog('新窗口归到当前桌面: ' + String(w.proc || '') + '「' + String(w.title || '').slice(0, 18) + '」', r.owner);
    }
  }
  return r;
}

// 查询一批进程的父进程 pid（走常驻助手，不另起 PowerShell 窗口），结果缓存
const parentOfPid = new Map();
async function queryParents(pids) {
  const need = pids.filter(p => p && !parentOfPid.has(p));
  if (!need.length) return;
  try {
    const raw = await winCmd('PPID|' + need.join(','));
    if (raw && raw.slice(0, 4) !== 'err:') {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const o of arr) {
        if (o && o.ProcessId && o.ParentProcessId) {
          parentOfPid.set(Number(o.ProcessId), Number(o.ParentProcessId));
        }
      }
    }
  } catch (e) {}
  // 查不到的也标记为 0，避免每次轮询反复查询
  for (const p of need) if (!parentOfPid.has(p)) parentOfPid.set(p, 0);
}

// 某个软件被移动到别的桌面时，把它下面所有进程/窗口一起搬走
function moveAppTo(rec, target) {
  const key = appKey(rec.exe);
  for (const r of winRecs.values()) {
    if (r.pid === rec.pid || (key && appKey(r.exe) === key)) {
      r.owner = target;
      rememberProc(r.pid, target, r.exe);
    }
  }
  const ek = exeKey(rec.exe);
  if (ek) data.exeOwners[ek] = target;
}

function restoreOwnersFromDisk() {
  winRecs.clear();
  const seed = (w, owner) => {
    winRecs.set(Number(w.hwnd), {
      hwnd: Number(w.hwnd), pid: w.pid, proc: w.proc, exe: w.exe || '',
      title: w.title, owner,
      // 上次运行被搬到屏幕外的窗口：把原坐标一起带回来，否则重启后它一直躺在屏幕外
      savedRect: (w.savedRect && typeof w.savedRect.x === 'number') ? w.savedRect : null
    });
    if (w.pid) rememberProc(w.pid, owner, w.exe);
  };
  for (const p of data.projects) {
    for (const w of (p.windows || [])) seed(w, p.id);
  }
  for (const w of (data.originalWindows || [])) {
    const h = Number(w.hwnd);
    if (!winRecs.has(h)) seed(w, null);
  }
}

function persistOwners() {
  const byOwner = new Map();
  for (const rec of winRecs.values()) {
    const key = rec.owner === null ? '__orig' : rec.owner;
    if (!byOwner.has(key)) byOwner.set(key, []);
    const row = {
      hwnd: rec.hwnd, pid: rec.pid, proc: rec.proc, exe: rec.exe, title: rec.title
    };
    // 被搬到屏幕外的窗口必须记住原坐标：只是内存里记着的话，FDE 一重启
    // 这个窗口就永远留在 -30000 的位置，"显示了但看不见"。
    if (rec.savedRect) row.savedRect = { x: rec.savedRect.x, y: rec.savedRect.y };
    byOwner.get(key).push(row);
  }
  for (const p of data.projects) p.windows = byOwner.get(p.id) || [];
  data.originalWindows = byOwner.get('__orig') || [];
}

function isVisibleOnTarget(rec) {
  return activeId === null ? rec.owner === null : rec.owner === activeId;
}

/** 桌面状态：面板/项目页都靠它渲染"当前桌面 / 警告 / 没显示的窗口" */
function desktopPayload(extra) {
  return Object.assign({
    activeId,
    originalCount: data.originalWindowsCount || 0,
    uncontrolled: uncontrollable.size,
    missing: lastMissing.length,
    isAdmin,
    // 跨平台：面板上"管理员权限"那块要按系统改说法（mac/Linux 没有 UAC）
    platformId: PLAT.id,
    platformLabel: PLAT.label,
    isolation: PLAT.windowMgmt,
    isolationNote: (!IS_WIN && helperDetail) ? helperDetail : ''
  }, extra || {});
}

// 顽固窗口连续出现计数（诊断"会自己弹回来"的软件）
const escapeCount = new Map();

async function enumWindows() {
  const pids = new Set([process.pid]);
  try { for (const m of app.getAppMetrics()) pids.add(m.pid); } catch (e) {}
  // 带上已知句柄：被我们隐藏的窗口也必须能枚举到，否则无法恢复显示
  const known = Array.from(winRecs.keys()).join(',');
  const raw = await winCmd('ENUM|' + Array.from(pids).join(',') + '|' + known);
  if (!raw || raw.slice(0, 4) === 'err:') return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const own = ownHwndSet();
  return arr
    .filter(w => w && w.hwnd)
    // 自有窗口永远不参与桌面管理（句柄复用/进程枚举漏掉的兜底）
    .filter(w => !own.has(Number(w.hwnd)))
    .filter(w => !APP_EXCLUDE.has(String(w.proc || '').toLowerCase()))
    .map(w => ({
      hwnd: Number(w.hwnd),
      pid: Number(w.pid),
      proc: String(w.proc || '?'),
      exe: String(w.exe || ''),
      title: String(w.title || ''),
      vis: !!w.vis,
      iconic: !!w.iconic,
      // UWP 应用被挂起时窗口是 cloaked（系统层面隐藏），坐标还在、句柄还在
      cloaked: w.cloaked === 1 || w.cloaked === true,
      // 用户此刻的焦点窗口：判断"这个窗口是不是他自己刚点开的"（见 desktop.decideOwner）
      fg: w.fg === 1 || w.fg === true,
      tool: w.tool === 1 || w.tool === true,
      x: Number(w.x) || 0,
      y: Number(w.y) || 0
    }));
}

/**
 * 拉取当前窗口列表并维护归属。
 * @param {string|null} assignNewTo 新出现的可见窗口归给谁（通常传当前桌面 activeId）
 * @returns 新归属的窗口记录数组
 */
let collectAssignTo;
async function collect(assignNewTo) {
  collectAssignTo = assignNewTo;
  const list = await enumWindows();
  const alive = new Set(list.map(w => w.hwnd));
  // 清理已关闭窗口（设置面板只应看到真实存在、真实打开的窗口）
  // 注意：清理前先把 pid -> 归属记进进程记忆。窗口记录消失不等于窗口没了
  // （UWP 挂起会被 cloaked、标题可能暂时为空），归属必须留住。
  for (const h of Array.from(winRecs.keys())) {
    if (!alive.has(h)) {
      const rec = winRecs.get(h);
      if (rec) rememberProc(rec.pid, rec.owner, rec.exe);
      winRecs.delete(h);
      uncontrollable.delete(h);
      escapeCount.delete(h);
    }
  }
  // 句柄可能被系统复用给别的进程，pid 不符则丢弃归属
  for (const w of list) {
    const rec = winRecs.get(w.hwnd);
    if (rec && rec.pid !== w.pid) {
      rememberProc(rec.pid, rec.owner, rec.exe);
      winRecs.delete(w.hwnd);
    }
  }
  // 记录见过的进程，找出"第一次出现"的进程（用于父进程继承查询）
  const freshPids = [];
  for (const w of list) {
    if (!pidsSeen.has(w.pid)) {
      pidsSeen.add(w.pid);
      if (!parentOfPid.has(w.pid)) freshPids.push(w.pid);
    }
  }
  if (freshPids.length) await queryParents(freshPids);

  // 登记新窗口；先按 pid/老进程软件/父进程归属，拿不准的普通窗口落到当前桌面
  // 工具窗口（WS_EX_TOOLWINDOW：提示条、下单弹窗、tooltip 等）不新开归属，
  // 跟不到归属的一律忽略——否则系统辅助窗口会被错误划给当前桌面、出现在每个桌面上。
  const newRecs = [];
  const pending = new Set();
  const pidExe = new Map(list.map(w => [w.pid, w.exe || '']));
  for (const w of list) {
    const rec = winRecs.get(w.hwnd);
    if (rec) {
      rec.title = w.title;
      rec.proc = w.proc;
      if (w.exe) rec.exe = w.exe;
      rec.tool = !!w.tool;
      rec.cloaked = !!w.cloaked;
      if (w.fg) lastFgWindow = { hwnd: w.hwnd, at: Date.now() };
      continue;
    }
    // 刚打开的网页：意图优先于"同进程/同软件跟随"——
    // 默认浏览器是在**已有进程**里开窗口的，不这样判就会被拽回原桌面藏起来
    const intent = claimByIntent(w);
    const decision = intent
      ? { owner: intent.owner, via: 'intent' }
      : ownerForWindow(w, pidExe);
    let owner = decision.owner;
    if (intent) {
      addLog('打开网页的窗口归到本桌面: ' + String(w.proc || '') +
        '「' + String(w.title || '').slice(0, 18) + '」', intent.owner);
    }
    if (owner === undefined) {
      // 无法跟随的工具窗口：不接管（多为系统/辅助窗口），也不能强行划给当前桌面
      if (w.tool) continue;
      owner = assignNewTo;  // 兜底：全新软件 → 就是当前所在的桌面
    }
    // 只在"落到当前桌面"这一支需要复核父进程（父进程查询可能晚于登记）
    if (owner === assignNewTo && owner !== null &&
        (decision.via === 'current' || decision.via === 'fg')) {
      pending.add(w.pid);
    }
    const nr = {
      hwnd: w.hwnd, pid: w.pid, proc: w.proc, exe: w.exe || '',
      title: w.title, owner, tool: !!w.tool, cloaked: !!w.cloaked
    };
    winRecs.set(w.hwnd, nr);
    rememberProc(nr.pid, nr.owner, nr.exe);
    if (w.fg) lastFgWindow = { hwnd: w.hwnd, at: Date.now() };
    newRecs.push({ nr, vis: w.vis, via: decision.via });
  }
  // 复核：新进程的父进程若属于某个项目，窗口跟过去（例如 wh6 主程序另起进程弹"下单大窗口"）
  if (pending.size) {
    await queryParents(Array.from(pending));
    for (const { nr, via } of newRecs) {
      // 用户刚点开的窗口（fg）已经按"当前桌面"定性，不再被父进程规则拽走
      if (nr.owner !== assignNewTo || via === 'fg') continue;
      const ppid = parentOfPid.get(nr.pid);
      if (ppid) {
        const po = ownerOfPid(ppid) ??
          ownerOfApp(appKey(pidExe.get(ppid) || ''));
        if (po && po !== assignNewTo) {
          nr.owner = po;
          rememberProc(nr.pid, po, nr.exe);
        }
      }
    }
  }
  const added = [];
  for (const { nr, vis } of newRecs) {
    if (vis) added.push({ ...nr, vis });
  }
  return added;
}

// 收起一批窗口：隐藏 → 复藏 → 最小化 → 移出屏幕（逐级兜底，应对会自我显示的软件）
// HIDE/MIN 走 ShowWindowAsync（非阻塞），目标程序卡死时助手也不会被拖住。
// 返回最终仍无法收起的窗口（通常是管理员权限程序，受 Windows 权限隔离限制）
async function hideWindows(hwnds) {
  if (!hwnds.length) return [];
  const still = (after, list) =>
    after.filter(w => w.vis && !w.iconic && list.includes(w.hwnd)).map(w => w.hwnd);

  await winCmd('HIDE|' + hwnds.join(','));
  await sleep(150);
  let after = await enumWindows();
  let stubborn = still(after, hwnds);
  if (!stubborn.length) return [];

  // 第二轮：补一次异步 HIDE + 请求最小化（不少软件会先自绘再响应隐藏，多补一轮能收住）
  await winCmd('HIDE|' + stubborn.join(','));
  await winCmd('MIN|' + stubborn.join(','));
  await sleep(180);
  after = await enumWindows();
  stubborn = still(after, hwnds);
  if (!stubborn.length) return [];

  // 最后一级：记录原坐标后搬到屏幕外，并再补一次隐藏
  const raw = await winCmd('RECT|' + stubborn.join(','));
  let rects = [];
  try {
    const parsed = JSON.parse(raw);
    rects = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  } catch (e) {}
  for (const r of rects) {
    const rec = winRecs.get(Number(r.hwnd));
    if (rec) rec.savedRect = { x: r.l, y: r.t };
  }
  for (const r of rects) await winCmd('MOVE|' + r.hwnd + '|-30000|-30000');
  await winCmd('HIDE|' + stubborn.join(','));

  // 检查是否真的搬走了
  await sleep(150);
  const final = await enumWindows();
  const failed = [];
  for (const h of stubborn) {
    const w = final.find(x => x.hwnd === h);
    const rec = winRecs.get(h);
    const moved = rec && rec.savedRect && w && Math.abs(w.x) > 20000;
    if (w && w.vis && !w.iconic && !moved) failed.push(h);
  }
  return failed;
}

// 收起一批窗口并记账：哪些是本软件藏的（hiddenByUs），哪些藏不掉（管理员权限程序）
async function concealBatch(items) {
  if (!items.length) return [];
  const hwnds = items.map(i => i.hwnd);
  const failed = await hideWindows(hwnds);
  const failedSet = new Set(failed);
  for (const it of items) {
    const rec = winRecs.get(it.hwnd);
    if (!rec) continue;
    if (failedSet.has(it.hwnd)) {
      if (!uncontrollable.has(it.hwnd)) {
        uncontrollable.add(it.hwnd);
        addLog('无法隐藏 ' + rec.proc + '「' + String(rec.title || '').slice(0, 18) +
          '」：该程序以管理员权限运行，需授予 FDE 管理员权限才能隔离', rec.owner);
      }
    } else {
      rec.hiddenByUs = true;
      rec.wasIconic = !!it.iconic;
    }
  }
  return failed;
}

/**
 * 把屏幕收敛到"当前桌面应该有"的状态。
 * @param {object} opts
 *   opts.forceShowOwned  显式切换桌面时调用：本桌面里"不可见"的窗口一律叫出来，
 *                        避免出现"设置里明明有、屏幕上/任务栏上都看不到"的情况。
 */
async function applyVisibility(opts) {
  const o = opts || {};
  let list = await enumWindows();

  // ---- 1) 把不属于当前桌面的窗口收起来 ----
  const toHide = [];
  const ownH = ownHwndSet();
  for (const w of list) {
    if (ownH.has(Number(w.hwnd))) continue;   // 自己的窗口一律不动
    const rec = winRecs.get(w.hwnd);
    if (!rec) continue;
    if (isVisibleOnTarget(rec)) { escapeCount.delete(w.hwnd); continue; }
    if (w.vis) {
      // 顽固窗口计数：连续多轮都收不住才写日志（会自我弹回的软件可从这里发现）
      const n = (escapeCount.get(w.hwnd) || 0) + 1;
      escapeCount.set(w.hwnd, n);
      if (n === 3 || (n > 3 && n % 25 === 0)) {
        addLog('窗口无法收起（已重试 ' + n + ' 次）: ' + rec.proc +
          '「' + String(rec.title || '').slice(0, 20) + '」' +
          (isAdmin ? '' : ' —— 可能需要管理员权限'), rec.owner);
      }
      toHide.push({ hwnd: w.hwnd, iconic: w.iconic });
    }
  }
  if (toHide.length) await concealBatch(toHide);

  // ---- 2) 把属于当前桌面的窗口放出来 ----
  list = toHide.length ? await enumWindows() : list;
  const union = displayUnion();
  const home = rescueHome();
  const show = [];
  const shownOk = new Set();
  const planById = new Map();
  for (const w of list) {
    const rec = winRecs.get(w.hwnd);
    if (!rec || !isVisibleOnTarget(rec)) continue;
    const plan = desktop.windowPlan({
      vis: w.vis,
      iconic: w.iconic,
      title: rec.title || w.title,
      x: w.x, y: w.y,
      hiddenByUs: !!rec.hiddenByUs,
      wasIconic: !!rec.wasIconic,
      savedRect: rec.savedRect || null,
      uncontrollable: uncontrollable.has(w.hwnd)
    }, { forceShowOwned: !!o.forceShowOwned, union, home });

    if (plan.act === 'none') {
      // 窗口本来就在屏幕上好好放着：无论它是否管理员权限，都不算"没显示"
      rec.hiddenByUs = false; rec.wasIconic = false; delete rec.savedRect; rec.lastWhy = '';
      continue;
    }
    if (plan.act === 'skip') {
      rec.lastWhy = plan.reason;
      continue;
    }
    // 先把被搬到屏幕外的窗口搬回来（没有存档坐标就用默认落点，否则"显示"了也看不见）
    if (plan.moveTo && (plan.act === 'move' || plan.act === 'move+show')) {
      await winCmd('MOVE|' + w.hwnd + '|' + Math.round(plan.moveTo.x) + '|' + Math.round(plan.moveTo.y));
      rec.savedRect = { x: Math.round(plan.moveTo.x), y: Math.round(plan.moveTo.y) };
      addLog('把屏幕外的窗口搬回来: ' + rec.proc + '「' + String(rec.title || '').slice(0, 18) + '」', rec.owner);
    }
    if (plan.act === 'show' || plan.act === 'move+show') {
      if (plan.reason === 'not-visible') {
        addLog('恢复显示: ' + rec.proc + '「' + String(rec.title || '').slice(0, 18) + '」', rec.owner);
      }
      show.push({ hwnd: w.hwnd, wasIconic: !!rec.wasIconic });
      planById.set(w.hwnd, plan);
    } else {
      shownOk.add(w.hwnd);   // 只是搬位置
    }
    rec.hiddenByUs = false;
    rec.wasIconic = false;
  }
  if (show.length) {
    const normal = show.filter(s => !s.wasIconic).map(s => s.hwnd);
    const mini = show.filter(s => s.wasIconic).map(s => s.hwnd);
    if (normal.length) await winCmd('SHOW|' + normal.join(','));
    if (mini.length) await winCmd('SHOWMIN|' + mini.join(','));
  }

  // 2.5) 核实：叫了 SHOW 却没出现的窗口，补一次还原（SW_RESTORE），仍不行就记原因。
  //      这一步是"窗口该显示却没显示"的兜底，也是诊断面板的数据来源。
  if (show.length) {
    await sleep(120);
    const after = await enumWindows();
    const stillHidden = [];
    for (const s of show) {
      const w = after.find(x => x.hwnd === s.hwnd);
      const rec = winRecs.get(s.hwnd);
      if (!rec) continue;
      if (!w) { rec.lastWhy = 'not-enumerated'; continue; }
      if (!w.vis || w.iconic) {
        stillHidden.push(s.hwnd);
        rec.lastWhy = w.iconic ? 'minimized' : 'show-failed';
      } else if (desktop.isOffscreen(w.x, w.y, union)) {
        rec.lastWhy = 'parked';
      } else {
        rec.lastWhy = '';
      }
    }
    if (stillHidden.length) {
      await winCmd('SHOW|' + stillHidden.join(','));
      await sleep(150);
      const again = await enumWindows();
      for (const h of stillHidden) {
        const w = again.find(x => x.hwnd === h);
        const rec = winRecs.get(h);
        if (!rec) continue;
        if (w && w.vis && !w.iconic) { rec.lastWhy = ''; rec.showFailLogged = false; }
        else if (w && w.cloaked) {
          // 被系统挂起（UWP / 在别的虚拟桌面上）：不是我们藏不掉，也不算失败
          rec.lastWhy = 'cloaked';
        } else {
          rec.lastWhy = 'show-failed';
          if (!rec.showFailLogged) {
            rec.showFailLogged = true;
            addLog('窗口叫不出来: ' + rec.proc + '「' + String(rec.title || '').slice(0, 18) + '」' +
              (isAdmin ? '（可能被该程序自身锁定为隐藏）' : '（可能是管理员权限程序，需授予 FDE 管理员权限）'), rec.owner);
          }
        }
      }
    }
  }

  // 本桌面"应该显示却没显示"的窗口（给面板/诊断用）
  // 只报"确实有问题"的：托盘里本来就收着的（not-visible）、用户自己最小化的（minimized）
  // 不算 —— 否则角标常年亮着，用户就不看了。
  const NOTICE_WHY = new Set(['parked', 'show-failed', 'uncontrollable', 'cloaked', 'hidden-by-us', 'not-enumerated']);
  lastMissing = [];
  for (const rec of winRecs.values()) {
    if (!isVisibleOnTarget(rec)) continue;
    if (!NOTICE_WHY.has(rec.lastWhy)) continue;
    lastMissing.push({ hwnd: rec.hwnd, proc: rec.proc, title: rec.title, why: rec.lastWhy });
  }

  // ---- 3) 窗口不要被左侧常驻面板挡住 ----
  // 面板是系统 AppBar，固定占用屏幕左侧 380px。有些程序启动时把窗口摆在 (0,0)，
  // 用户看到的就是"窗口跑到 FDE 面板后面去了"。这里把这类窗口整体右移到面板右边，
  // 每个窗口只纠正一次（之后尊重用户自己的摆放）。原电脑桌面不干预。
  if (activeId !== null && data.settings.dodgePanel !== false) {
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const leftPx = Math.round(APPBAR_WIDTH * sf);
    const dispW = Math.round(screen.getPrimaryDisplay().bounds.width * sf);
    const cand = [];
    for (const w of list) {
      const rec = winRecs.get(w.hwnd);
      if (!rec || !isVisibleOnTarget(rec)) continue;
      if (!w.vis || w.iconic) continue;
      if (String(rec.title || '').trim() === '') continue;
      if (rec.dodged) continue;
      if (desktop.isOffscreen(w.x, w.y, union)) continue;  // 已在屏幕外（我们自己搬走的）
      if (w.x >= leftPx - 4) continue;    // 本来就在面板右边，不用管
      cand.push(w.hwnd);
    }
    if (cand.length) {
      const raw = await winCmd('RECT|' + cand.join(','));
      let rects = [];
      try {
        const parsed = JSON.parse(raw);
        rects = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      } catch (e) {}
      for (const r of rects) {
        const rec = winRecs.get(Number(r.hwnd));
        if (!rec) continue;
        const ww = r.r - r.l, hh = r.b - r.t;
        if (!ww || !hh) continue;
        if (ww >= dispW * 0.96) { rec.dodged = true; continue; } // 最大化窗口交给系统工作区
        rec.dodged = true;
        const nx = leftPx + Math.round(12 * sf);
        await winCmd('SETRECT|' + r.hwnd + '|' + nx + '|' + r.t + '|' + ww + '|' + hh);
        addLog('窗口已右移避开左侧面板: ' + rec.proc + '「' + String(rec.title || '').slice(0, 18) + '」', rec.owner);
      }
    }
  }
  return { hidden: toHide.length, shown: show.length, failed: lastMissing.slice() };
}

/** 从屏幕外救回来的默认落点：面板右边的第一个空位 */
function rescueHome() {
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  return {
    x: Math.round(d.bounds.x * sf) + Math.round(APPBAR_WIDTH * sf) + Math.round(56 * sf),
    y: Math.round(d.bounds.y * sf) + Math.round(72 * sf)
  };
}

/**
 * 本桌面"应该显示却没显示"的窗口（applyVisibility 每轮更新）。
 * 面板上会提示"还有 N 个窗口没显示"，点一下就能看原因并修复。
 */
let lastMissing = [];

/**
 * 一键整理：把某个项目的窗口在本桌面右侧排成网格。
 * 用途是"窗口太多、分不清谁是谁"——排一次就形成固定的视觉位置（左上=主系统，右下=辅助）。
 * 最大化/接近全屏的窗口不动（那是用户故意的），它自己占一层。
 */
async function tileWindows(projectId = null) {
  const pid = projectId === undefined ? activeId : projectId;
  const sf = screen.getPrimaryDisplay().scaleFactor || 1;
  const disp = screen.getPrimaryDisplay();
  const wa = (await readWorkArea()) || {
    l: 0, t: 0,
    r: Math.round((disp.bounds.x + disp.bounds.width) * sf),
    b: Math.round((disp.bounds.y + disp.bounds.height) * sf)
  };
  const leftPx = Math.round(APPBAR_WIDTH * sf) + Math.round(14 * sf);
  const areaL = Math.max(wa.l, leftPx);
  const areaT = wa.t + Math.round(10 * sf);
  const areaW = Math.max(320, wa.r - areaL - Math.round(14 * sf));
  const areaH = Math.max(240, wa.b - areaT - Math.round(14 * sf));

  const list = await enumWindows();
  const cands = [];
  for (const w of list) {
    const rec = winRecs.get(w.hwnd);
    if (!rec || rec.owner !== pid) continue;
    if (!w.vis || w.iconic) continue;
    if (!String(w.title || '').trim()) continue;
    if (w.x < -10000) continue;
    cands.push({ hwnd: w.hwnd, rec });
  }
  // enumWindows 只给 x/y，宽高要用 RECT 批量取，顺便过滤掉接近整屏的窗口（多半是全屏看盘/看板）
  let rects = [];
  if (cands.length) {
    try {
      const raw = await winCmd('RECT|' + cands.map(c => c.hwnd).join(','));
      const parsed = JSON.parse(raw);
      rects = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {}
  }
  const dispW = Math.round(disp.bounds.width * sf);
  const dispH = Math.round(disp.bounds.height * sf);
  const targets = [];
  for (const r of rects) {
    const c = cands.find(x => x.hwnd === Number(r.hwnd));
    if (!c) continue;
    const ww = (r.r - r.l), hh = (r.b - r.t);
    if (!ww || !hh) continue;
    if (ww >= dispW * 0.94 && hh >= dispH * 0.9) continue;
    targets.push({ hwnd: c.hwnd, rec: c.rec });
  }
  if (!targets.length) return { ok: true, count: 0, msg: '当前桌面没有可排布的窗口' };

  const n = targets.length;
  const gap = Math.round(10 * sf);
  const minW = Math.round(520 * sf);
  const minH = Math.round(360 * sf);
  let cols = Math.max(1, Math.round(Math.sqrt(n * (areaW / Math.max(1, areaH)))));
  while (cols > 1 && (areaW - gap * (cols + 1)) / cols < minW) cols--;
  let rows = Math.ceil(n / cols);
  while (rows > 1 && (areaH - gap * (rows + 1)) / rows < minH) rows--;
  rows = Math.max(1, rows);
  if (cols * rows < n) cols = Math.ceil(n / rows);
  const cw = Math.floor((areaW - gap * (cols + 1)) / cols);
  const ch = Math.floor((areaH - gap * (rows + 1)) / rows);

  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols && i < targets.length; c++, i++) {
      const t = targets[i];
      const x = areaL + gap + c * (cw + gap);
      const y = areaT + gap + r * (ch + gap);
      await winCmd('SETRECT|' + t.hwnd + '|' + x + '|' + y + '|' + cw + '|' + ch, 6000);
      t.rec.dodged = true;
      t.rec.tiled = { x, y, w: cw, h: ch };
    }
  }
  addLog('已整理 ' + targets.length + ' 个窗口（' + cols + '×' + rows + ' 网格）', pid);
  return { ok: true, count: targets.length, cols, rows };
}

// ---------- 壁纸 ----------
function wallpaperFile(p) {
  return path.join(app.getPath('userData'), 'wallpapers', p.id + '.png');
}

function shade(hex, amt) {
  const c = String(hex || '#4f8cff').replace('#', '');
  let r = parseInt(c.slice(0, 2), 16) || 79;
  let g = parseInt(c.slice(2, 4), 16) || 140;
  let b = parseInt(c.slice(4, 6), 16) || 255;
  if (amt < 0) {
    r = Math.round(r * (1 + amt)); g = Math.round(g * (1 + amt)); b = Math.round(b * (1 + amt));
  } else {
    r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
  }
  const h = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

async function ensureWallpaper(p) {
  const dir = path.dirname(wallpaperFile(p));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = wallpaperFile(p);
  // 覆盖所有显示器的联合范围（多显示器下壁纸不再只按主屏裁剪）
  const displays = screen.getAllDisplays();
  let ul = Infinity, ut = Infinity, ur = -Infinity, ub = -Infinity;
  let maxSf = 1;
  for (const d of displays) {
    ul = Math.min(ul, d.bounds.x);
    ut = Math.min(ut, d.bounds.y);
    ur = Math.max(ur, d.bounds.x + d.bounds.width);
    ub = Math.max(ub, d.bounds.y + d.bounds.height);
    maxSf = Math.max(maxSf, d.scaleFactor || 1);
  }
  const w = Math.round((ur - ul) * maxSf);
  const h = Math.round((ub - ut) * maxSf);
  // 每块屏在图片里的位置：项目名会各自画在该屏正中，切完一眼知道在哪个项目
  const areas = displays.map(d => [
    Math.round((d.bounds.x - ul) * maxSf),
    Math.round((d.bounds.y - ut) * maxSf),
    Math.round(d.bounds.width * maxSf),
    Math.round(d.bounds.height * maxSf)
  ].join(','));
  const name = String(p.name || '').replace(/[\r\n]+/g, ' ').trim();
  // 名字 / 配色 / 屏幕布局任一变了就重画，避免改名后墙上还是旧名
  const sig = [name, String(p.color || ''), w, h, areas.join(';')].join('|');
  const metaFile = file + '.meta';
  let oldSig = '';
  try { oldSig = fs.readFileSync(metaFile, 'utf8'); } catch (e) { oldSig = ''; }
  if (fs.existsSync(file) && oldSig === sig) return file;
  // 名字写进 UTF-8 旁文件交给助手读（避免中文经 stdin 传参的编码坑）
  const textFile = file + '.txt';
  try { fs.writeFileSync(textFile, [name].concat(areas).join('\r\n'), 'utf8'); } catch (e) {}
  const c1 = shade(p.color, -0.86);
  const c2 = shade(p.color, -0.45);
  await winCmd('GENWALL|' + file + '|' + c1 + '|' + c2 + '|' + w + '|' + h + '|' + textFile, 25000);
  if (fs.existsSync(file)) {
    try { fs.writeFileSync(metaFile, sig, 'utf8'); } catch (e) {}
    return file;
  }
  return '';
}

async function applyWallpaper(p) {
  // 只有 Windows 有"按项目换壁纸"这条路（Win32 SPI_SETDESKWALLPAPER）。
  // macOS / Linux 不折腾用户桌面壁纸，直接跳过。
  if (!PLAT.wallpaper) return;
  if (data.settings.wallpaper === false) return;
  if (!p) {
    const orig = data.settings.originalWallpaper;
    if (orig && fs.existsSync(orig)) await winCmd('WALL|' + orig);
    return;
  }
  const file = await ensureWallpaper(p);
  if (file) await winCmd('WALL|' + file);
}

function captureOriginalWallpaper() {
  if (!PLAT.wallpaper) return Promise.resolve();
  if (data.settings.originalWallpaper) return Promise.resolve();
  return new Promise((resolve) => {
    const script = "(Get-ItemProperty 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        if (!err) {
          const p = String(stdout || '').trim();
          if (p && p.toLowerCase() !== 'null') {
            data.settings.originalWallpaper = p;
            saveData();
          }
        }
        resolve();
      });
  });
}

// ---------- 状态 / 桌面切换 ----------
let lastStatusSig = '';

function refreshStatuses(force) {
  const counts = new Map();
  for (const rec of winRecs.values()) {
    const key = rec.owner === null ? '__orig' : rec.owner;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let sig = String(activeId) + '|';
  for (const p of data.projects) sig += p.id + ':' + (counts.get(p.id) || 0) + ':' + (data.inbox[p.id] || []).length + ';';
  if (!force && sig === lastStatusSig) return false;
  lastStatusSig = sig;

  for (const p of data.projects) {
    const n = counts.get(p.id) || 0;
    const unread = (data.inbox[p.id] || []).length;
    p.windowsCount = n;
    if (p.status === 'error') continue;
    if (unread > 0) {
      p.status = 'task';
      p.statusMsg = '有 ' + unread + ' 条待处理提示';
    } else if (activeId === p.id) {
      p.status = 'running';
      p.statusMsg = '当前桌面 · ' + n + ' 个窗口';
    } else if (n > 0) {
      p.status = 'background';
      p.statusMsg = '后台保留 ' + n + ' 个窗口';
    } else {
      p.status = 'stopped';
      p.statusMsg = '空桌面';
    }
  }
  data.originalWindowsCount = counts.get('__orig') || 0;
  saveData();
  broadcast('fde:projects', data.projects);
  broadcast("fde:desktop", desktopPayload());
  return true;
}

/**
 * 切换桌面。target：项目 id，或 'original' / null 表示原电脑桌面。
 */
async function switchDesktop(target) {
  const t = (!target || target === 'original') ? null : target;
  if (t) {
    const p = data.projects.find(x => x.id === t);
    if (!p) return { ok: false, error: '项目不存在' };
  }
  // 先用旧桌面归属新出现的窗口，再切换
  await collect(activeId);
  // 快照：此刻还活着的进程视为"老进程"。
  // 之后才启动的进程（用户在新桌面里打开的软件、autorun 拉起的程序）一律归属新桌面，
  // 不会再被"跟随同目录软件"的规则错误划给旧桌面。
  pidsAtSwitch = new Set(pidsSeen);
  activeId = t;

  const p = t ? data.projects.find(x => x.id === t) : null;
  const isolate = p ? p.exclusive !== false : true;

  if (isolate) {
    await applyVisibility({ forceShowOwned: true });
  } else {
    // 不隔离：只把本桌面的窗口叫出来，不隐藏其它
    const list = await enumWindows();
    const toShow = list
      .filter(w => {
        const rec = winRecs.get(w.hwnd);
        return rec && rec.owner === t && (!w.vis || w.iconic);
      })
      .map(w => w.hwnd);
    for (const h of toShow) {
      const rec = winRecs.get(h);
      if (rec && rec.savedRect) {
        await winCmd('MOVE|' + h + '|' + rec.savedRect.x + '|' + rec.savedRect.y);
        delete rec.savedRect;
      }
    }
    if (toShow.length) await winCmd('SHOW|' + toShow.join(','));
  }

  await applyWallpaper(p);
  persistOwners();
  refreshStatuses(true);
  // 设置面板跟着桌面走：切换后屏幕上不能还留着"上一个项目"的设置
  syncProjectPanels(activeId);

  if (p && !autorunDone.has(p.id)) {
    autorunDone.add(p.id);
    runAutorun(p);
  }
  addLog(p ? '切换桌面: ' + p.name : '切换桌面: 原电脑桌面', p ? p.id : null);

  // 程序启动需要几秒才建窗口：切换后再补几轮收敛，确保新窗口归本桌面且看得见
  settleAfterSwitch();
  // 任何路径完成切换后，总览覆盖层自动关闭（避免盖在新桌面上"一直在"）
  // 例外：从工作流画布节点触发的切换要继续停留在画布上，方便连续执行流程
  if (!suppressSwitcherClose) closeSwitcher();
  rebuildTrayMenu();
  return { ok: true, activeId };
}

let settleTimer = null;
function settleAfterSwitch() {
  clearTimeout(settleTimer);
  const run = async () => {
    try {
      await collect(activeId);
      await applyVisibility();
      persistOwners();
      refreshStatuses(false);
    } catch (e) { /* 忽略瞬时错误 */ }
  };
  setTimeout(run, 1200);
  setTimeout(run, 3000);
  setTimeout(run, 6000);
}

// 启动项目配置的自动打开项（支持程序 / 脚本 / 网页，每项可设独立延迟秒数）
// 注意：FDE 以管理员权限运行时，直接 spawn 会让被启动的程序也变成管理员权限。
// 无参数时改用 explorer 代启，可让程序保持普通权限（更安全，也不影响它自己的提权清单）。
function runAutorun(p) {
  for (const a of (p.autorun || [])) {
    const delay = Math.max(0, Number(a.delay) || 0);
    if (delay > 0) addLog('「' + (a.name || a.path || a.url) + '」将在 ' + delay + ' 秒后启动', p.id);
    setTimeout(() => { try { launchAutorunItem(p, a); } catch (e) {} }, delay * 1000);
  }
}

function launchAutorunItem(p, a) {
  // 网页：可指定浏览器，未指定则用系统默认浏览器
  if (a.type === 'url') {
    openUrlOn(p.id, a.url, a.browserPath).then(r => {
      if (r && r.ok === false) { addLog('打开网页失败: ' + a.url + ' - ' + (r.error || ''), p.id); return; }
      const who = a.browserName
        ? '（' + a.browserName + '）'
        : (r && r.exe ? '（默认浏览器 ' + path.basename(r.exe) + '）' : '（默认浏览器）');
      addLog('打开网页: ' + a.url + who, p.id);
    }).catch(err => addLog('打开网页失败: ' + a.url + ' - ' + err.message, p.id));
    return;
  }
  try {
    const rawArgs = String(a.args || '').trim();
    const argsArr = rawArgs ? rawArgs.split(/\s+/) : [];
    const ext = String(a.path).toLowerCase().match(/\.[^.\\/]+$/);
    // 场景包里带的程序：这台机器没装就跳过，不要让整个项目变成"报错"状态
    if (a.optional && !fs.existsSync(a.path)) {
      addLog('跳过未安装的程序: ' + (a.name || a.path) + '（可在项目设置里改成自己的路径）', p.id);
      return;
    }
    const viaExplorer = IS_WIN && !rawArgs && ext && (ext[0] === '.exe' || ext[0] === '.lnk') && isAdmin;
    const child = viaExplorer
      ? spawn('explorer.exe', [a.path], { detached: true, stdio: 'ignore', windowsHide: true })
      : (IS_WIN
        ? spawn(a.path, argsArr, { detached: true, stdio: 'ignore', windowsHide: true })
        // macOS / Linux：可执行位不一定有、.app 是"目录"，统一交给系统壳打开最稳
        : (() => {
          const plan = platform.openPlan(a.path);
          return spawn(plan.cmd, plan.args.concat(argsArr), { detached: true, stdio: 'ignore' });
        })());
    child.on('error', (err) => {
      addLog('自动打开失败: ' + a.path + ' - ' + err.message, p.id);
      p.status = 'error';
      p.statusMsg = '自动打开失败: ' + a.path;
      saveData();
      broadcast('fde:projects', data.projects);
      rebuildTrayMenu();
    });
    child.unref();
    addLog('自动打开: ' + a.path, p.id);
  } catch (err) {
    addLog('自动打开失败: ' + a.path + ' - ' + err.message, p.id);
  }
}

/**
 * 运行项目里的脚本（脚本项配置了真实路径时）。
 * 按扩展名选择解释器：.ps1→PowerShell  .py→Python  .bat/.cmd→cmd  .js→Node。
 * 隐藏窗口后台执行，输出写进项目日志；退出码非 0 时项目状态变「报错」。
 */
function runScriptItem(p, item) {
  return new Promise((resolve) => {
    if (!item.path || !fs.existsSync(item.path)) {
      addLog('脚本没有可执行的文件路径: ' + item.name + '（请在设置里补上路径）', p.id);
      resolve({ ok: false, error: '该脚本没有配置文件路径' });
      return;
    }
    const ext = (item.path.toLowerCase().match(/\.[^.\\/]+$/) || [''])[0];
    // 解释器选择交给平台层：Windows 上 .ps1 走 PowerShell，macOS/Linux 上 .sh 走 /bin/sh，
    // .py 在类 Unix 上优先 python3（多数发行版只有 python3）
    const plan = platform.scriptPlan(item.path);
    if (!plan) {
      addLog('不支持的脚本类型 ' + ext + ': ' + item.name + '（本系统建议用 ' + PLAT.scriptExt + '）', p.id);
      resolve({ ok: false, error: '不支持 ' + ext + ' 脚本' });
      return;
    }
    const cmd = plan.cmd, args = plan.args;

    addLog('运行脚本: ' + item.name, p.id);
    p.status = 'task';
    p.statusMsg = '脚本运行中: ' + item.name;
    saveData();
    broadcast('fde:projects', data.projects);
    rebuildTrayMenu();

    let out = [];
    const push = (d) => {
      out.push(String(d));
      // 最多保留末尾 4000 字符，防止脚本输出刷爆内存/日志
      const joined = out.join('');
      if (joined.length > 4000) out = [joined.slice(-4000)];
    };
    let child;
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        cwd: path.dirname(item.path),
        env: plan.env ? Object.assign({}, process.env, plan.env) : process.env
      });
    } catch (err) {
      addLog('脚本启动失败: ' + item.name + ' - ' + err.message, p.id);
      p.status = 'error'; p.statusMsg = '脚本启动失败: ' + item.name;
      saveData(); broadcast('fde:projects', data.projects);
      resolve({ ok: false, error: err.message });
      return;
    }
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (err) => {
      addLog('脚本运行出错: ' + item.name + ' - ' + err.message, p.id);
      p.status = 'error'; p.statusMsg = '脚本运行出错: ' + item.name;
      saveData(); broadcast('fde:projects', data.projects); rebuildTrayMenu();
      resolve({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      const tail = out.join('').trim().slice(-1200);
      // 完整输出留在脚本项上：出问题时要能直接看，而不是只看到日志里那句摘要
      if ((p.items || []).includes(item)) {
        item.lastRun = {
          at: Date.now(),
          code: code === null ? -1 : code,
          output: out.join('').trim().slice(-8000)
        };
      }
      if (code === 0) {
        addLog('脚本完成: ' + item.name + (tail ? ' · 输出: ' + tail.replace(/\s+/g, ' ').slice(0, 300) : ''), p.id);
        p.status = (activeId === p.id) ? 'running' : 'background';
        p.statusMsg = '';
      } else {
        addLog('脚本失败(退出码 ' + code + '): ' + item.name + (tail ? ' · ' + tail.replace(/\s+/g, ' ').slice(0, 300) : ''), p.id);
        p.status = 'error';
        p.statusMsg = '脚本失败: ' + item.name;
      }
      saveData();
      broadcast('fde:projects', data.projects);
      refreshStatuses(true);
      rebuildTrayMenu();
      resolve({ ok: code === 0 });
    });
  });
}

/**
 * 重启项目：关闭本项目内的所有程序窗口（先优雅关闭，无响应的强制结束），
 * 然后按「自动打开」列表重新启动。
 *  - 若当前正在本项目桌面：立即重新自动打开；
 *  - 若在其它桌面：下次进入本项目时自动打开（autorunDone 已重置）。
 */
async function restartProject(id) {
  const p = data.projects.find(x => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  addLog('重启项目: 关闭本项目内所有程序 - ' + p.name, id);
  p.status = 'task';
  p.statusMsg = '正在重启…';
  saveData();
  broadcast('fde:projects', data.projects);

  await collect(activeId);
  const mineNow = () => Array.from(winRecs.values()).filter(r => r.owner === id);

  // 1) 优雅关闭：向所有窗口投递 WM_CLOSE，给程序保存数据的机会
  let items = mineNow();
  if (items.length) {
    await winCmd('CLOSE|' + items.map(i => i.hwnd).join(','));
    addLog('已请求关闭 ' + items.length + ' 个窗口，等待程序退出…', id);
    await sleep(3500);
    await collect(activeId);
  }

  // 2) 强制结束仍存活的项目进程（只按精确 PID，绝不带 /T，避免误杀进程树）
  items = mineNow();
  const pids = Array.from(new Set(items.map(i => i.pid).filter(Boolean)));
  if (pids.length) {
    for (const pid of pids) {
      const plan = platform.killPlan(pid);
      await new Promise(res => {
        execFile(plan.cmd, plan.args,
          { windowsHide: true, timeout: 8000 }, () => res());
      });
    }
    addLog('强制结束 ' + pids.length + ' 个无响应进程', id);
    await sleep(1200);
    await collect(activeId);
  }

  // 3) 重新自动打开
  autorunDone.delete(id);
  if (activeId === id) {
    p.status = 'running';
    p.statusMsg = '重启完成，正在自动打开应用';
    saveData();
    broadcast('fde:projects', data.projects);
    runAutorun(p);
    settleAfterSwitch();
  } else {
    p.status = 'stopped';
    p.statusMsg = '已重启 · 进入本项目时自动打开应用';
  }
  saveData();
  broadcast('fde:projects', data.projects);
  refreshStatuses(true);
  addLog('重启完成: ' + p.name, id);
  return { ok: true };
}

// ---------- 浏览器检测（让网页可以指定用某个浏览器打开） ----------
let browserCache = null;
function detectBrowsers() {
  // Windows 读注册表；macOS / Linux 直接扫安装目录（见 detectBrowsersUnix）
  if (!IS_WIN) return detectBrowsersUnix();
  return detectBrowsersWin();
}

/** Windows：注册表 StartMenuInternet + 常见路径兜底 */
function detectBrowsersWin() {
  if (!IS_WIN) return Promise.resolve([]);   // 防御：误在非 Windows 调用也不会去碰注册表
  return new Promise((resolve) => {
    const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @(
  'HKLM:\\SOFTWARE\\Clients\\StartMenuInternet',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet',
  'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet'
)
$res = @()
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  foreach ($k in (Get-ChildItem $r -ErrorAction SilentlyContinue)) {
    $disp = ''
    try { $disp = (Get-ItemProperty $k.PSPath -ErrorAction Stop).'(default)' } catch {}
    if (-not $disp) { $disp = $k.PSChildName }
    $cmd = ''
    try { $cmd = (Get-ItemProperty ($k.PSPath + '\\shell\\open\\command') -ErrorAction Stop).'(default)' } catch {}
    if (-not $cmd) { continue }
    $exe = $cmd.Trim()
    if ($exe.StartsWith('"')) {
      $i2 = $exe.IndexOf('"', 1)
      if ($i2 -gt 0) { $exe = $exe.Substring(1, $i2 - 1) }
    } else {
      $exe = ($exe -split ' ')[0]
    }
    if ($exe) { $res += [pscustomobject]@{ name = $disp; path = $exe } }
  }
}
$res | ConvertTo-Json -Compress -Depth 3
`.trim();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 12000 }, (err, stdout) => {
        const list = [];
        const seen = new Set();
        const push = (name, p) => {
          const key = String(p).toLowerCase();
          if (!p || seen.has(key)) return;
          try { if (!fs.existsSync(p)) return; } catch (e) { return; }
          seen.add(key);
          list.push({ name: String(name || path.basename(p)), path: p });
        };
        if (!err && stdout) {
          try {
            const parsed = JSON.parse(String(stdout).trim());
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const b of arr) if (b && b.path) push(b.name, b.path);
          } catch (e) {}
        }
        // 兜底：注册表里没有的常见浏览器
        const known = [
          ['Microsoft Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
          ['Microsoft Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
          ['Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
          ['Google Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
          ['Mozilla Firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'],
          ['Mozilla Firefox', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'],
          ['QQ浏览器', 'C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe'],
          ['360安全浏览器', 'C:\\Program Files (x86)\\360\\360se6\\Application\\360se.exe'],
          ['360极速浏览器', 'C:\\Users\\Public\\AppData\\Local\\360Chrome\\Chrome\\Application\\360chrome.exe']
        ];
        for (const [n, p] of known) push(n, p);
        resolve(list);
      });
  });
}

/**
 * macOS / Linux 的浏览器清单：不查注册表（也没有），
 * 直接看「标准安装位置 + /Applications」里究竟存在哪些。
 */
function detectBrowsersUnix() {
  const list = [];
  const seen = new Set();
  const push = (name, p) => {
    if (!p || seen.has(p)) return;
    try { if (!fs.existsSync(p)) return; } catch (e) { return; }
    seen.add(p);
    list.push({ name: name || path.basename(p), path: p });
  };
  for (const [n, p] of platform.knownBrowsers()) push(n, p);
  if (IS_MAC) {
    // 用户自己拖进 /Applications 的其它浏览器（Arc / Brave / Vivaldi / 夸克 …）
    const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        if (!/\.app$/i.test(n)) continue;
        if (!/chrome|edge|firefox|brave|arc|vivaldi|opera|browser|quark|safari|360/i.test(n)) continue;
        push(n.replace(/\.app$/i, ''), path.join(dir, n));
      }
    }
  }
  return Promise.resolve(list);
}

// 轮询：捕获新窗口归属，并每轮强制收敛（有些软件会自己把窗口弹回来）
let pollBusy = false;
async function pollTick() {
  if (pollBusy || !helperReady) return;
  pollBusy = true;
  try {
    const added = await collect(activeId);
    if (added.length) persistOwners();
    await applyVisibility();
    refreshStatuses(false);
  } catch (e) {
    console.error('轮询失败:', e.message);
  } finally {
    pollBusy = false;
  }
}

// ---------- AppBar：面板作为系统侧边栏 ----------
const APPBAR_WIDTH = 280;
let appBarHwnd = null;

/**
 * 「面板右侧」的可用区域。
 * FDE 自己的所有窗口（总览/工作流画布、项目设置面板）都必须落在这个区域里，
 * 否则会跑到常驻面板的后面去（面板 alwaysOnTop 且是系统 AppBar，用户点不到被遮住的窗口）。
 * 用 bounds 而不是 workArea：workArea 会被 AppBar 自身改变，可能来回抖动。
 */
function panelArea() {
  const d = screen.getPrimaryDisplay();
  const b = d.bounds;
  const w = Math.max(360, b.width - APPBAR_WIDTH);
  return { x: b.x + APPBAR_WIDTH, y: b.y, width: w, height: b.height };
}

// 把 FDE 自有窗口摆到面板右边（越界才纠正，避免窗口在用户拖动时"抢位置"）
function placeRightOfPanel(win, pref) {
  if (!win || win.isDestroyed()) return;
  const a = panelArea();
  const bounds = win.getBounds();
  let x = pref && pref.x !== undefined ? Math.round(a.x + pref.x) : bounds.x;
  let y = pref && pref.y !== undefined ? Math.round(a.y + pref.y) : bounds.y;
  const w = (pref && pref.width) || bounds.width;
  const h = (pref && pref.height) || bounds.height;
  // 贴右 / 居中默认放在面板右侧区域内
  if (x < a.x + 4) x = a.x + 12;
  if (x + w > a.x + a.width - 4) x = Math.max(a.x + 12, a.x + a.width - w - 12);
  if (y < a.y) y = a.y;
  if (y + h > a.y + a.height) y = Math.max(a.y, a.y + a.height - h);
  win.setBounds({ x, y, width: Math.min(w, a.width - 24), height: Math.min(h, a.height - 8) });
}

/**
 * FDE 自己的窗口句柄集合。
 * 这些窗口绝对不能进「桌面窗口管理」：一旦被当成别的桌面的窗口收起来，
 * Electron 内部还认为它可见，再 show() 就是空操作 —— 表现就是
 * 「任务里有个窗口，但屏幕上死活看不到」。所有枚举/隐藏都要先过这一关。
 */
function ownHwndSet() {
  const set = new Set();
  const add = (w) => {
    if (!w || (w.isDestroyed && w.isDestroyed())) return;
    const h = getHwndString(w);
    if (h) set.add(Number(h));
  };
  add(panelWin);
  add(switcherWin);
  add(appsWin);
  add(marketWin);
  add(envWin);
  add(trustWin);
  for (const w of projectPanels.values()) add(w);
  return set;
}

/**
 * 把 FDE 自有窗口真正弄到用户眼前。
 * 处理三种「窗口在、但看不见」：
 *  1) 最小化过：restore 而不是 show（show 不会还原最小化窗口）
 *  2) 位置跑到屏幕外/面板后面：按面板右侧区域重新摆
 *  3) Electron 与系统可见状态不一致（被外部 HideWindow 过）：先 show，再核对；
 *     仍不可见就用 Win32 层 SHOW 强制叫一次
 * 顺手补一次重绘（隐藏期间 requestAnimationFrame 不跑，画布/列表会留白）。
 */
/**
 * FDE 自己的功能窗口（能力 / 知识库 / 卖货台 / 项目设置 …）要不要浮在最前。
 *
 * 默认 **不置顶**。以前这些窗口全是 floating 置顶，用户打开浏览器去登录、
 * 去对照文档时，右侧一摞 FDE 窗口压在上面，底下什么都点不到。
 * 「打开时抬到前面」用 moveTop 就够了，不需要长期锁 z 序。
 * 确实想让它常浮着的（一边看网页一边填密钥），在面板「这台电脑」里勾一下即可。
 */
function winPinOn() {
  try { return !!(data && data.settings && data.settings.winPin); } catch (e) { return false; }
}

function applyWinPin(win) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return;
  try { win.setAlwaysOnTop(winPinOn(), 'floating'); } catch (e) {}
}

async function revealWindow(win, opts) {
  if (!win || win.isDestroyed()) return false;
  const o = opts || {};
  try { if (win.isMinimized()) win.restore(); } catch (e) {}
  try { if (o.pref || o.reposition !== false) placeRightOfPanel(win, o.pref); } catch (e) {}
  try { if (!win.isVisible()) win.show(); } catch (e) {}
  // 只在「打开/唤起这一下」抬到前面；是否长期置顶由用户的偏好决定，默认不锁
  applyWinPin(win);
  try { win.moveTop(); } catch (e) {}
  if (o.focus !== false) { try { win.focus(); } catch (e) {} }
  try { win.webContents.send('fde:redraw'); } catch (e) {}
  await new Promise(r => setTimeout(r, 240));
  if (win.isDestroyed()) return false;
  if (!win.isVisible()) {
    const h = getHwndString(win);
    if (h) await winCmd('SHOW|' + h, 5000);
    try { win.show(); } catch (e) {}
    try { win.moveTop(); } catch (e) {}
  }
  return win.isVisible();
}

/**
 * 页面级兜底：加载失败/渲染进程挂掉时自动重载一次，并写日志。
 * 用户看到的「面板打开是空的」，多数就是这里被吞掉的一次崩溃。
 */
function guardWindowLoad(win, label, file, query) {
  if (!win || win.isDestroyed()) return;
  let reloads = 0;
  const reload = (why) => {
    if (win.isDestroyed() || reloads >= 2) return;
    reloads++;
    addLog('窗口「' + label + '」' + why + '，自动重载（第 ' + reloads + ' 次）');
    try { win.loadFile(file, query ? { query } : undefined); } catch (e) {}
  };
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // 主动中断（换页/关闭），不算失败
    slog('[窗口 ' + label + '] 加载失败 ' + code + ' ' + desc + ' ' + url);
    reload('加载失败(' + desc + ')');
  });
  win.webContents.on('render-process-gone', (e, details) => {
    slog('[窗口 ' + label + '] 渲染进程退出 ' + JSON.stringify(details));
    reload('渲染进程退出(' + (details && details.reason) + ')');
  });
  win.on('unresponsive', () => addLog('窗口「' + label + '」无响应，可重启软件恢复'));
}

const APPBAR_DEF = `
using System;
using System.Runtime.InteropServices;
public class AppBar {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left; public int top; public int right; public int bottom;
    public RECT(int l,int t,int r,int b){left=l;top=t;right=r;bottom=b;} }
  [StructLayout(LayoutKind.Sequential)]
  public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage;
    public uint uEdge; public RECT rc; public int lParam; }
  [DllImport("shell32.dll")] public static extern IntPtr SHAppBarMessage(uint msg, ref APPBARDATA data);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int w, int h, bool repaint);
}
`.trim();

function runPs(script, timeout = 15000) {
  // 只有 Windows 才有 PowerShell；其它平台上的调用方（AppBar）都已按能力跳过
  if (!IS_WIN) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err) console.error('AppBar 操作失败:', err.message, String(stderr || '').slice(0, 200));
        resolve(stdout || '');
      });
  });
}

function getHwndString(win) {
  try {
    const buf = win.getNativeWindowHandle();
    return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
  } catch (e) {
    return null;
  }
}

async function readRect(hwnd) {
  if (!helperReady) return null;
  const raw = await winCmd('RECT|' + hwnd, 6000);
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : [j];
    if (arr.length && arr[0] && typeof arr[0].l === 'number') return arr[0];
  } catch (e) {}
  return null;
}

async function readWorkArea() {
  if (!helperReady) return null;
  const raw = await winCmd('WORK', 6000);
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.l === 'number') return j;
  } catch (e) {}
  return null;
}

// 等常驻助手就绪（没就绪时 SETRECT/WORK 这些命令没人执行，会导致面板贴不上左缘）
function waitHelper(timeout = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (helperReady && (helperProc || !IS_WIN)) return resolve(true);
      if (Date.now() - t0 > timeout) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * 把面板精确摆到屏幕最左侧。
 * Windows 上 Electron 无边框窗口的实际窗口矩形会比 setBounds 多出 1~2px 的不可见边框，
 * 所以这里直接走 Win32 SetWindowPos，并读回校准，直到矩形正好是 [0, W]。
 */
async function placePanelWindow() {
  if (!panelWin || panelWin.isDestroyed()) return null;
  if (!PLAT.appBar) { dockPanelNative(); return null; }
  const hwnd = getHwndString(panelWin);
  if (!hwnd) return null;
  const disp = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const targetW = Math.round(APPBAR_WIDTH * sf);
  const wa = (await readWorkArea()) || {
    l: 0, t: Math.round(disp.workArea.y * sf),
    r: Math.round((disp.workArea.x + disp.workArea.width) * sf),
    b: Math.round((disp.workArea.y + disp.workArea.height) * sf)
  };
  const targetH = wa.b - wa.t;
  await winCmd('SETRECT|' + hwnd + '|0|' + wa.t + '|' + targetW + '|' + targetH, 6000);
  for (let i = 0; i < 3; i++) {
    const r = await readRect(hwnd);
    if (!r) break;
    const dLeft = 0 - r.l;
    const dTop = wa.t - r.t;
    const dW = targetW - (r.r - r.l);
    if (!dLeft && !dTop && !dW) break;
    await winCmd('SETRECT|' + hwnd + '|' + (r.l + dLeft) + '|' + (r.t + dTop) + '|' +
      Math.round((r.r - r.l) + dW) + '|' + targetH, 6000);
  }
  return { hwnd, targetW, wa };
}

async function registerAppBar() {
  if (!panelWin || panelWin.isDestroyed()) return;
  // macOS / Linux 没有 AppBar（那是 Windows 外壳独有的"工作区让位"机制），
  // 退化成"贴左缘 + 永远置顶 + 所有工作区可见"，效果接近，但不会挤走系统工作区。
  if (!PLAT.appBar) { dockPanelNative(); return; }
  // 防重入：注册 AppBar 本身会改变系统工作区，可能再次触发"工作区变化"事件，
  // 不做保护就会变成 注册→事件→注册 的死循环（面板会被反复挪动）。
  if (registering) return;
  registering = true;
  try {
    await registerAppBarInner();
  } finally {
    registering = false;
  }
}

/** 非 Windows 的面板停靠：纯 Electron bounds，不碰系统工作区 */
function dockPanelNative() {
  if (!panelWin || panelWin.isDestroyed()) return;
  try {
    const b = screen.getPrimaryDisplay().workArea;
    panelWin.setBounds({
      x: Math.round(b.x), y: Math.round(b.y),
      width: APPBAR_WIDTH, height: Math.round(b.height)
    });
    if (IS_MAC) {
      try { panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
    }
  } catch (e) {}
}

let registering = false;
let lastDockLog = '';

async function registerAppBarInner() {
  const hwndStr = getHwndString(panelWin);
  if (!hwndStr) return;
  const disp = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const targetW = Math.round(APPBAR_WIDTH * sf);
  const wa = (await readWorkArea()) || {
    t: Math.round(disp.workArea.y * sf),
    b: Math.round((disp.workArea.y + disp.workArea.height) * sf),
    l: Math.round(disp.workArea.x * sf)
  };
  appBarHwnd = hwndStr;

  const script = `
$def = @'
${APPBAR_DEF}
'@
Add-Type -TypeDefinition $def
$hwnd = [IntPtr]([int64]${hwndStr})
$d = New-Object AppBar+APPBARDATA
$d.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AppBar+APPBARDATA])
$d.hWnd = $hwnd
$d.uCallbackMessage = 0x8F00
$d.uEdge = 0
# 先移除同名旧注册，避免上一次异常退出留下"占位残留"
[void][AppBar]::SHAppBarMessage(1, [ref]$d)
[void][AppBar]::SHAppBarMessage(0, [ref]$d)
$d.rc = New-Object AppBar+RECT -ArgumentList 0,${wa.t},${targetW},${wa.b}
[void][AppBar]::SHAppBarMessage(2, [ref]$d)   # ABM_QUERYPOS
[void][AppBar]::SHAppBarMessage(3, [ref]$d)   # ABM_SETPOS：系统据此从工作区里扣掉左侧 380px
$d.lParam = 2                                 # ABS_ALWAYSONTOP
[void][AppBar]::SHAppBarMessage(10, [ref]$d)  # ABM_SETSTATE
$d.rc | ConvertTo-Json -Compress
`.trim();

  for (let attempt = 0; attempt < 3; attempt++) {
    await runPs(script);
    const now = await readWorkArea();
    // 系统工作区左边界应该正好等于面板宽度，说明这块空间已被我们占住
    if (now && Math.abs(now.l - targetW) <= 1) {
      break;
    }
    await new Promise(r => setTimeout(r, 350));
  }

  await placePanelWindow();
  // Windows 外壳在收到 AppBar 注册后会「异步」再摆一次窗口（有时会把它摆到工作区起点 380 处），
  // 这里补几次延迟校正，确保最终贴在 0。
  for (const delay of [250, 800, 1800, 3000]) {
    setTimeout(() => { placePanelWindow(); }, delay);
  }
  const after = await readWorkArea();
  if (after) lastBarHeight = after.b - after.t;
  const sig = (after ? after.l : '?') + '|' + APPBAR_WIDTH;
  if (sig !== lastDockLog) {
    lastDockLog = sig;
    addLog('面板已贴齐屏幕左缘（宽度 ' + APPBAR_WIDTH + 'px，系统工作区左侧留白 ' +
      (after ? after.l : '?') + 'px）');
  }
}

// 位置守护：只要面板没贴在 x=0 / 工作区没让出 380，就立刻纠正
let lastAppBarFix = 0;
let lastBarHeight = 0;
async function ensurePanelDocked() {
  if (!panelWin || panelWin.isDestroyed() || !helperReady) return;
  if (!PLAT.appBar) { dockPanelNative(); return; }
  const disp = screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const targetW = Math.round(APPBAR_WIDTH * sf);
  const wa = await readWorkArea();
  if (!wa) return;
  const rec = await readRect(getHwndString(panelWin));
  const leftOk = rec ? Math.abs(rec.l) <= 1 : true;
  const widthOk = rec ? Math.abs((rec.r - rec.l) - targetW) <= 1 : true;
  if (leftOk && widthOk) {
    // 窗口位置没问题，再看：系统是否真的让出了左侧空间、栏高是否与当前分辨率一致
    const h = wa.b - wa.t;
    const needReg = Math.abs(wa.l - targetW) > 1 || (lastBarHeight && Math.abs(h - lastBarHeight) > 2);
    if (needReg && Date.now() - lastAppBarFix > 10000) {
      lastAppBarFix = Date.now();
      await registerAppBar();
    }
    return;
  }
  await placePanelWindow();
}

async function unregisterAppBar() {
  if (!appBarHwnd) return;
  const hwnd = appBarHwnd;
  appBarHwnd = null;
  const script = `
$def = @'
${APPBAR_DEF}
'@
Add-Type -TypeDefinition $def
$hwnd = [IntPtr]::new(${hwnd})
$d = New-Object AppBar+APPBARDATA
$d.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][AppBar+APPBARDATA])
$d.hWnd = $hwnd
[void][AppBar]::SHAppBarMessage(1, [ref]$d)
`.trim();
  await runPs(script, 6000);
}

// ---------- 窗口创建 ----------
function createPanel() {
  // 用 bounds（而不是 workArea）作基准：workArea 可能因为上一次的侧栏残留而偏右
  const b = screen.getPrimaryDisplay().bounds;
  panelWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: APPBAR_WIDTH,
    height: b.height,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#10131a',
    title: 'FDE 智能体 控制台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  panelWin.loadFile('panel.html');
  panelWin.on('closed', () => { panelWin = null; });
  // 面板永远压在最上层（比总览/项目设置窗口高一级），不会被任何 FDE 自己的窗口盖住
  try { panelWin.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
  panelWin.webContents.once('did-finish-load', async () => {
    await waitHelper(12000);
    await registerAppBar();
  });
  panelWin.on('show', () => { setTimeout(ensurePanelDocked, 600); });
}

// 让设置面板"闪两下"：窗口在屏幕右侧，点完按钮容易找不到它
function flashProjectPanel(win) {
  if (!win || win.isDestroyed()) return;
  const send = () => { try { win.webContents.send('panel:flash'); } catch (e) {} };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 140));
  else setTimeout(send, 140);
}

// 项目控制面板：小型浮动窗口（不再是全屏假桌面）
async function openProjectPanel(id) {
  const p = data.projects.find(x => x.id === id);
  if (!p) return { ok: false, error: '项目不存在' };
  let win = projectPanels.get(id);
  if (win && !win.isDestroyed()) {
    // 复用老窗口：可能被最小化、被搬到屏幕外，或者渲染进程已经挂了（表现为一片空白）
    const crashed = (() => {
      try { return win.webContents.isCrashed(); } catch (e) { return false; }
    })();
    if (crashed) {
      try { win.loadFile('project.html', { query: { id } }); } catch (e) {}
    }
    await revealWindow(win);
    flashProjectPanel(win);
    return { ok: true };
  }
  const a = panelArea();
  const w = Math.min(470, a.width - 40);
  const h = Math.min(680, a.height - 60);
  // 从画布点「设置」时贴着画布窗口出现，离点击的地方越近越不容易找不到
  let px = a.x + a.width - w - 26;
  let py = a.y + 30;
  try {
    if (switcherWin && !switcherWin.isDestroyed() && switcherWin.isVisible()) {
      const sb = switcherWin.getBounds();
      px = Math.round(sb.x + sb.width - w - 24);
      py = Math.round(sb.y + Math.max(20, (sb.height - h) / 3));
      px = Math.max(a.x + 12, Math.min(px, a.x + a.width - w - 12));
      py = Math.max(a.y + 8, Math.min(py, a.y + a.height - h - 8));
    }
  } catch (e) {}
  win = new BrowserWindow({
    width: w,
    height: h,
    x: px,
    y: py,
    show: false,               // 等内容渲染好再显示：避免"窗口出来了、里面是空的"
    frame: false,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: '#10131a',
    title: '项目 · ' + p.name,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 比常驻面板低一级；默认不置顶，免得盖住底下的浏览器/文档（面板自身始终在最上）
  applyWinPin(win);
  guardWindowLoad(win, '项目设置·' + p.name, 'project.html', { id });
  win.loadFile('project.html', { query: { id } });
  win.once('ready-to-show', () => { revealWindow(win, { focus: false }); });
  flashProjectPanel(win);
  win.on('closed', () => { projectPanels.delete(id); });
  projectPanels.set(id, win);
  return { ok: true };
}

function closeProjectPanel(id) {
  const win = projectPanels.get(id);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
}

/**
 * 桌面切换后同步项目设置面板。
 * 每个项目桌面各有一份设置，切换后屏幕上不该再留着别的项目的设置：
 *  - 回到原电脑桌面：把项目设置面板全部关掉
 *  - 切到项目 X：关掉 X 以外的面板；如果关掉的正是"刚离开的那个项目"的面板，
 *    就在原位置打开 X 的面板（看起来像是跟着你一起换过去了）
 */
function syncProjectPanels(newActiveId) {
  const ids = [];
  for (const [pid, win] of Array.from(projectPanels.entries())) {
    if (!win || win.isDestroyed()) { projectPanels.delete(pid); continue; }
    ids.push(pid);
  }
  const plan = panels.planPanelSync(ids, newActiveId);
  let lastBounds = null;
  for (const pid of plan.close) {
    const win = projectPanels.get(pid);
    if (!win || win.isDestroyed()) continue;
    try { if (!win.isMinimized()) lastBounds = win.getBounds(); } catch (e) {}
    try { win.close(); } catch (e) {}
  }
  if (!plan.open) return;
  openProjectPanel(plan.open);
  const win = projectPanels.get(plan.open);
  if (win && !win.isDestroyed() && lastBounds) {
    try {
      const a = panelArea();
      const w = Math.min(lastBounds.width, a.width - 24);
      const h = Math.min(lastBounds.height, a.height - 24);
      const x = Math.max(a.x + 8, Math.min(lastBounds.x, a.x + a.width - w - 8));
      const y = Math.max(a.y + 8, Math.min(lastBounds.y, a.y + a.height - h - 8));
      win.setBounds({ x, y, width: w, height: h });
    } catch (e) {}
  }
}

function openSwitcher(view, projectId) {
  const a = panelArea();
  if (switcherWin && !switcherWin.isDestroyed()) {
    try { switcherWin.webContents.send('fde:setview', view || 'canvas'); } catch (e) {}
    if (projectId) { try { switcherWin.webContents.send('fde:focus-project', projectId); } catch (e) {} }
    revealWindow(switcherWin);
    return { ok: true };
  }
  switcherWin = new BrowserWindow({
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    show: false,               // 渲染好再显示，避免黑屏/空白
    frame: false,
    backgroundColor: '#05070c',
    resizable: true,
    title: 'FDE 工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 关键：总览只占「面板右边」这块区域，不再全屏盖住左侧常驻面板
  try { switcherWin.setAlwaysOnTop(true, 'floating'); } catch (e) {}
  const q = { view: view || '' };
  if (projectId) q.proj = projectId;
  guardWindowLoad(switcherWin, '工作台', 'overview.html', q);
  switcherWin.loadFile('overview.html', { query: q });
  switcherWin.once('ready-to-show', () => { revealWindow(switcherWin, { focus: true, reposition: false }); });
  // 兜底：ready-to-show 只触发一次，若错过（隐藏期重载/事件丢失）窗口就永远 show:false ——
  // 用户看到的"画布打不开/点了没反应"多半是它。2.5 秒内没真正显示就强制拉出来。
  setTimeout(() => {
    if (!switcherWin || switcherWin.isDestroyed()) return;
    try {
      if (!switcherWin.isVisible() || switcherWin.isMinimized()) {
        __diagLog('switcher-force-show: ready-to-show 错过兜底拉起, visible=' + switcherWin.isVisible());
        revealWindow(switcherWin, { focus: true, reposition: false });
      }
    } catch (e) {}
  }, 2500);
  // 飞行记录仪：窗口显示/隐藏全程留痕 —— "看得见点不到/画布不见了"从此有据可查
  const tag = (ev) => __diagLog('switcher-' + ev + ' visible=' + (() => { try { return switcherWin.isVisible(); } catch (e) { return '?'; } })());
  ['show', 'hide', 'close', 'minimize', 'restore'].forEach(ev => {
    try { switcherWin.on(ev, () => tag(ev)); } catch (e) {}
  });
  // 看门狗：画布窗口不该一直藏着 —— 每隔几秒查一次，被谁悄悄藏了就拉回来并记日志
  switcherWatchdog = setInterval(() => {
    if (!switcherWin || switcherWin.isDestroyed()) return;
    try {
      if (!switcherWin.isVisible()) {
        __diagLog('switcher-watchdog: 发现窗口被隐藏，自动拉回');
        revealWindow(switcherWin, { focus: false, reposition: false });
      }
    } catch (e) {}
  }, 3000);
  switcherWin.on('closed', () => {
    if (switcherWatchdog) { clearInterval(switcherWatchdog); switcherWatchdog = null; }
    switcherWin = null;
  });
  return { ok: true };
}

function closeSwitcher() {
  if (switcherWin && !switcherWin.isDestroyed()) switcherWin.close();
}

// ---------- 系统托盘 ----------
let tray = null;
async function createTray() {
  if (tray) return;
  try {
    // Windows：用助手画一张 32x32 渐变图（和面板 logo 同配色）
    // macOS / Linux：用随包带的图标（.icns/.png 由 scripts/make-icons.js 生成）
    let iconPath = path.join(app.getPath('userData'), 'tray-icon.png');
    if (!IS_WIN) {
      iconPath = '';
      for (const c of platform.trayIconCandidates({ appDir: __dirname, resourcesPath: process.resourcesPath })) {
        if (fs.existsSync(c)) { iconPath = c; break; }
      }
    }
    if (IS_WIN && !fs.existsSync(iconPath)) {
      await winCmd('GENWALL|' + iconPath + '|#4f8cff|#a855f7|32|32', 20000);
    }
    const icon = iconPath && fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.on('click', () => {
      if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); }
    });
    rebuildTrayMenu();
  } catch (e) {
    console.error('创建托盘失败:', e.message);
  }
}

function rebuildTrayMenu() {
  if (!tray) return;
  try {
    const cur = activeId ? data.projects.find(p => p.id === activeId) : null;
    tray.setToolTip('FDE 智能体 控制台 · 当前: ' + (cur ? cur.name : '原电脑桌面'));
    const items = [];
    data.projects.forEach((p, i) => {
      items.push({
        label: (i < 9 ? (i + 1) + '. ' : '') + p.name + (activeId === p.id ? '   ●' : ''),
        click: () => switchDesktop(p.id)
      });
    });
    if (data.projects.length) items.push({ type: 'separator' });
    items.push({ label: '原电脑桌面' + (activeId === null ? '   ●' : ''), click: () => switchDesktop('original') });
    items.push({ label: '桌面总览', click: () => openSwitcher('cards') });
    items.push({ label: '工作流画布', click: () => openSwitcher('canvas') });
    items.push({ label: '场景市场', click: () => openMarket() });
    items.push({ label: '应用功能（能力 / 知识库）', click: () => openApps() });
    items.push({ label: '显示主面板', click: () => { if (panelWin && !panelWin.isDestroyed()) { panelWin.show(); panelWin.focus(); } } });
    items.push({ type: 'separator' });
    items.push({ label: '退出（窗口全部恢复显示）', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  } catch (e) {}
}

// ---------- 全局热键 ----------
function rebuildShortcuts() {
  try {
    globalShortcut.unregisterAll();
    // Windows/Linux: Ctrl+Alt+0 回原桌面，Ctrl+Alt+O 总览，ctrl+alt+1..9 切项目
    // macOS: 同样位置换成 Cmd+Alt（Ctrl 在 mac 上常被输入法占用）
    const accel = (k) => platform.shortcutAccel(k);
    globalShortcut.register(accel('0'), () => switchDesktop('original'));
    globalShortcut.register(accel('O'), () => {
      if (switcherWin && !switcherWin.isDestroyed()) closeSwitcher();
      else openSwitcher();
    });
    data.projects.forEach((p, i) => {
      if (i >= 9) return;
      globalShortcut.register(accel(String(i + 1)), () => switchDesktop(p.id));
    });
  } catch (e) {}
}

// ---------- 开机自启 ----------
// Windows：启动文件夹放一个指向「启动 FDE.vbs」的快捷方式；
// macOS：~/Library/LaunchAgents/com.fde.manager.plist；
// Linux：~/.config/autostart/fde-manager.desktop。
function startupLnk() {
  return platform.autostartPath({ appName: 'FDE Manager' });
}
function isAutostartOn() {
  try { return fs.existsSync(startupLnk()); } catch (e) { return false; }
}
function setAutostart(val) {
  const lnk = startupLnk();
  if (!val) {
    try { if (fs.existsSync(lnk)) fs.unlinkSync(lnk); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, enabled: false };
  }
  if (!IS_WIN) {
    try {
      const args = app.isPackaged ? [] : [app.getAppPath()];
      const content = platform.autostartContent({ exe: process.execPath, args });
      fs.mkdirSync(path.dirname(lnk), { recursive: true });
      fs.writeFileSync(lnk, content, 'utf8');
      if (IS_LINUX) { try { fs.chmodSync(lnk, 0o644); } catch (e) {} }
      return { ok: true, enabled: isAutostartOn() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  const vbs = unpackedPath(path.join(__dirname, '启动 FDE.vbs'));
  if (!fs.existsSync(vbs)) return { ok: false, error: '找不到「启动 FDE.vbs」，请勿移动软件目录' };
  const q = (s) => String(s).replace(/'/g, "''");
  const script = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + q(lnk) + "');" +
    "$s.TargetPath='" + q(vbs) + "';" +
    "$s.WorkingDirectory='" + q(__dirname) + "';" +
    "$s.Description='FDE 管理软件（管理员权限启动）';" +
    "$s.Save()";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000 }, (err) => {
        if (err) { resolve({ ok: false, error: err.message }); return; }
        resolve({ ok: true, enabled: isAutostartOn() });
      });
  });
}

// ---------- 工作流画布（上下文编排引擎） ----------
/**
 * 画布不是"好看的图"，而是可执行的工作上下文：
 *  - 每个节点绑定一个真实资源（项目桌面 / 应用窗口 / 网页 / 脚本 / 文件 / 笔记）
 *  - 连线代表"依赖 / 先后顺序"，▶ 运行会按拓扑顺序依次激活这些资源
 *  - AI 节点会把所有上游节点的上下文汇总成一段结构化提示词（复制到剪贴板）
 *    这样"进入某个客户场景"就变成一次点击，而不用重新回忆要开什么、要贴什么资料。
 */

function canvasNode(id) {
  return (data.canvas.nodes || []).find(n => n.id === id);
}

/**
 * 把旧的「流程联动」搬进画布，变成项目节点之间的交接连线。
 * 以前项目间关系维护两份（面板配流程、画布拉连线），容易对不上；
 * 现在只认画布：连线即关系，连线上能直接发提示。
 * 幂等：flows 空了就什么都不做。
 */
function migrateFlowsToCanvas() {
  const flows = data.flows || [];
  if (!flows.length) return 0;
  const c = data.canvas;
  let baseY = 0;
  for (const n of c.nodes) baseY = Math.max(baseY, (Number(n.y) || 0) + 220);
  let seq = 0;
  const ensure = (pid) => {
    const exist = c.nodes.find(n => n.type === 'project' && n.ref && n.ref.projectId === pid);
    if (exist) return exist;
    const p = data.projects.find(x => x.id === pid);
    if (!p) return null;
    const node = {
      id: 'n' + Math.random().toString(36).slice(2, 9),
      type: 'project', title: p.name, note: '',
      x: 80 + (seq % 5) * 300, y: baseY + 60 + Math.floor(seq / 5) * 200,
      w: 240, h: 0, color: p.color || '', ref: { projectId: pid },
      collapsed: false, locked: false, tags: [], z: 0
    };
    seq++;
    c.nodes.push(node);
    return node;
  };
  let added = 0;
  for (const f of flows) {
    const a = ensure(f.from);
    const b = ensure(f.to);
    if (!a || !b) continue;
    if (c.edges.some(e => e.from === a.id && e.to === b.id)) continue;
    c.edges.push({
      id: 'e' + Math.random().toString(36).slice(2, 9),
      from: a.id, to: b.id, label: f.label || '交接', kind: 'handoff', dashed: false
    });
    added++;
  }
  data.flows = [];
  saveData();
  if (added) {
    addLog('已把 ' + added + ' 条「流程联动」搬进工作流画布（交接连线），面板上的旧入口已移除', null);
    try { broadcast('fde:canvas', data.canvas); } catch (e) {}
  }
  return added;
}

// 上游节点（沿入边反向遍历，去重、保持拓扑近似顺序）
function upstreamOf(id) {
  const byTo = new Map();
  for (const e of data.canvas.edges) {
    if (!byTo.has(e.to)) byTo.set(e.to, []);
    byTo.get(e.to).push(e.from);
  }
  const seen = new Set();
  const order = [];
  const walk = (nid, depth) => {
    if (depth > 24) return;
    for (const f of (byTo.get(nid) || [])) {
      if (seen.has(f)) continue;
      seen.add(f);
      walk(f, depth + 1);
      order.push(f);
    }
  };
  walk(id, 0);
  return order.map(canvasNode).filter(Boolean);
}

// 组（泳道/分组框）里包含哪些节点：按几何包含判断，包含后随组一起移动
function groupMembers(group, all) {
  const list = all || data.canvas.nodes;
  return list.filter(n => {
    if (n.id === group.id) return false;
    if (n.type === 'group') return false;
    const cx = n.x + (n.w || 240) / 2;
    const cy = n.y + 40;
    return cx >= group.x && cx <= group.x + (group.w || 420) &&
           cy >= group.y && cy <= group.y + (group.h || 300);
  });
}

// 从起点沿出边做 BFS，得到执行序列（只含可执行类型）
// kind === 'ref'（仅参考）的连线不参与执行
function flowOrder(startId) {
  const byFrom = new Map();
  for (const e of data.canvas.edges) {
    if (e.kind === 'ref') continue;
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e.to);
  }
  const seen = new Set();
  const list = [];
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = canvasNode(id);
    if (n) list.push(n);
    for (const t of (byFrom.get(id) || [])) if (!seen.has(t)) queue.push(t);
  }
  return list;
}

// 整张画布的执行顺序：从所有入度为 0 的节点开始做拓扑（BFS），无入边的孤立节点按坐标从左到右
function fullFlowOrder() {
  const edges = data.canvas.edges.filter(e => e.kind !== 'ref');
  const indeg = new Map(data.canvas.nodes.map(n => [n.id, 0]));
  for (const e of edges) if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to) + 1);
  const roots = data.canvas.nodes
    .filter(n => (indeg.get(n.id) || 0) === 0)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const seen = new Set();
  const out = [];
  for (const r of roots) {
    for (const n of flowOrder(r.id)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  // 剩下的（处在环里的）也不能丢
  for (const n of data.canvas.nodes) if (!seen.has(n.id)) out.push(n);
  return out;
}

function projectOf(node) {
  const pid = node.ref && node.ref.projectId;
  return data.projects.find(p => p.id === pid) || null;
}

// 画布节点触发桌面切换时，不要顺手把画布关掉
let suppressSwitcherClose = false;
async function switchFromCanvas(pid) {
  suppressSwitcherClose = true;
  try { return await switchDesktop(pid); }
  finally { suppressSwitcherClose = false; }
}

// 执行单个节点，返回 { ok, msg }
async function runCanvasNode(node, silent) {
  const say = (t) => { if (!silent) addLog('[画布] ' + t, node.ref && node.ref.projectId || null); };
  switch (node.type) {
    case 'project': {
      const p = projectOf(node);
      if (!p) return { ok: false, msg: '节点未绑定项目' };
      say('进入桌面: ' + p.name);
      const r = await switchFromCanvas(p.id);
      if (node.ref && node.ref.autoRun) {
        await sleep(500);
        runAutorun(p);
        say('已按「自动打开」列表启动 ' + (p.autorun || []).length + ' 项');
      }
      return r || { ok: true };
    }
    case 'window': {
      const p = projectOf(node);
      if (!p) return { ok: false, msg: '节点未绑定项目' };
      await switchFromCanvas(p.id);
      await sleep(600);
      const kw = String((node.ref && node.ref.match) || node.title || '').toLowerCase().trim();
      const list = await enumWindows();
      const pool = list.filter(w => w.vis && winRecs.get(w.hwnd) && winRecs.get(w.hwnd).owner === p.id);
      const hit = kw
        ? pool.find(w => (w.title || '').toLowerCase().includes(kw) || (w.proc || '').toLowerCase().includes(kw))
        : pool[0];
      if (!hit) return { ok: false, msg: '没有找到匹配的窗口: ' + (kw || '(任意)') };
      await winCmd('FOCUS|' + hit.hwnd);
      say('前置窗口: ' + hit.title);
      return { ok: true, msg: hit.title };
    }
    case 'url': {
      const url = node.ref && node.ref.url;
      if (!url) return { ok: false, msg: '节点未填网址' };
      const np = projectOf(node);
      const r = await openUrlOn(np ? np.id : activeId, url, node.ref.browserPath);
      if (!r || r.ok === false) return { ok: false, msg: (r && r.error) || '打开失败' };
      say('打开网页: ' + url);
      return { ok: true };
    }
    case 'script': {
      const p = projectOf(node);
      const target = node.ref && node.ref.path;
      if (p && node.ref && node.ref.itemId) {
        const it = (p.items || []).find(i => i.id === node.ref.itemId);
        if (it) return await runScriptItem(p, it);
      }
      if (p && target) {
        const tmp = { name: node.title, path: target };
        return await runScriptItem(p, tmp);
      }
      return { ok: false, msg: '脚本节点未绑定脚本' };
    }
    case 'file':
    case 'folder': {
      const f = node.ref && node.ref.path;
      if (!f || !fs.existsSync(f)) return { ok: false, msg: '路径不存在: ' + (f || '(空)') };
      const err = await shell.openPath(f);
      say('打开: ' + f);
      return err ? { ok: false, msg: err } : { ok: true };
    }
    case 'ai': {
      const r = promptForNode(node.id, true);
      const cfg = aiConfig();
      // 没接算力时保留老行为（复制提示词），但把"下一步该干什么"说清楚
      if (!cfg.apiKey) {
        clipboard.writeText(r.text);
        say('提示词 ' + r.chars + ' 字 ≈ ' + r.tokens + ' token，已复制（还没接算力，去「应用功能 → ⚡ 模型设置」填密钥）');
        return { ok: false, msg: '还没接算力：提示词已复制，去「应用功能 → ⚡ 模型设置」填密钥就能直接跑' };
      }
      // 模型优先级：节点上勾选的多个模型（对比）> 节点单独选的 > 全局默认 > 自动
      const models = (Array.isArray(node.models) && node.models.length)
        ? node.models.slice(0, 6)
        : [String(node.model || cfg.model || 'auto').trim() || 'auto'];
      const blocks = [];
      const multi = models.length > 1;
      const stamp0 = '── 模型输出 · ' + (multi ? models.length + ' 个模型（对比）' : (models[0] === 'auto' ? '自动挑模型' : models[0])) +
        ' · ' + new Date().toLocaleString('zh-CN') + ' ──';
      let totalTokens = 0, okCount = 0;
      for (const m of models) {
        say('用 ' + (m === 'auto' ? '自动挑的模型' : m) + ' 执行「' + node.title + '」…');
        const res = await aiChatCounted(cfg, {
          model: m,
          purpose: 'canvas',
          messages: [
            { role: 'system', content: '你是 FDE 工作流里的执行助手。按上下文里的材料直接给结论和成品，不要复述材料，不要问问题。' },
            { role: 'user', content: r.text }
          ],
          maxTokens: 2000
        }, { timeout: 120000 });
        const label = (res && (res.picked || m)) || m;
        if (!res.ok) {
          blocks.push('【' + label + '】失败：' + res.error);
          continue;
        }
        okCount++;
        if (res.usage && res.usage.total_tokens) totalTokens += res.usage.total_tokens;
        const how = (m === 'auto' || res.switched) ? '（自动' + (res.switched ? '切换' : '挑选') + '：' + label + '）' : '';
        blocks.push('【' + label + '】' + how + res.text.slice(0, 3000));
      }
      if (!okCount) {
        say('模型调用失败：' + blocks.join('；'));
        return { ok: false, msg: '模型调用失败：' + blocks.join('；').slice(0, 200) };
      }
      node.note = String(node.note || '').slice(0, 12000) + '\n\n' + stamp0 + '\n' + blocks.join('\n\n').slice(0, 6000);
      saveData();
      broadcast('fde:canvas', data.canvas);
      const used = totalTokens ? ' · ' + totalTokens + ' token' : '';
      say(okCount + '/' + models.length + ' 个模型返回，已写进节点' + used);
      return { ok: true, msg: okCount + '/' + models.length + ' 个模型返回，已写进节点' };
    }
    case 'gen': {
      // 图片 / 视频 / 音乐节点：提交异步任务 → 每 3 秒查进度 → 结果写回节点
      const ref = node.ref || (node.ref = {});
      if (!modelsLib.MEDIA_TYPES.includes(ref.modal)) ref.modal = 'image';
      const cfg = aiConfig();
      const up = (() => {
        try { return promptForNode(node.id, true).text || ''; } catch (e) { return ''; }
      })();
      const own = String(ref.prompt || '').trim();
      // 自己没写提示词就用上游上下文（连了线就能跑）
      const prompt = own || up;
      // 按这个模型的真实参数定义校验：少传必填素材（参考图/参考音频）就先告诉用户缺哪个
      const sch = await modelDetailOf(cfg, ref.model);
      const prep = modelsLib.prepareRun({ ref: Object.assign({}, ref, { prompt }) }, cfg, '', sch.ok ? sch.params : null);
      if (!prep.ok) {
        say(prep.error);
        return { ok: false, msg: prep.error, fieldErrors: prep.fieldErrors || [] };
      }
      say('「' + node.title + '」交给 ' + prep.model + '（' + (modelsLib.TYPE_META[prep.modal] || {}).name + '）…');
      const sub = await aiClient.mediaGenerate(cfg, prep.body, { timeout: 60000 });
      if (!sub.ok) {
        ref.status = '提交失败'; ref.error = sub.error;
        saveData();
        broadcast('fde:media', { id: node.id, error: sub.error, status: '提交失败' });
        return { ok: false, msg: '提交失败：' + sub.error };
      }
      const subInfo = modelsLib.parseSubmit(sub.json);
      if (!subInfo.ok) return { ok: false, msg: '提交失败：' + subInfo.error };
      ref.taskId = subInfo.taskId;
      ref.status = '排队中'; ref.progress = 0; ref.error = ''; ref.urls = []; ref.cost = 0;
      saveData();
      broadcast('fde:media', { id: node.id, taskId: ref.taskId, status: '排队中', progress: 0 });
      const deadline = Date.now() + 8 * 60 * 1000;   // 视频/音乐可能几分钟
      let st = null, misses = 0;
      while (Date.now() < deadline) {
        await sleep(3000);
        const r = await aiClient.mediaStatus(cfg, ref.taskId, { timeout: 20000 });
        if (!r.ok) {
          misses++;
          if (misses >= 6) { st = { failed: true, error: r.error || '查询状态连续失败' }; break; }
          continue;
        }
        misses = 0;
        st = modelsLib.parseStatus(r.json);
        ref.status = st.statusText;
        ref.progress = st.progress;
        broadcast('fde:media', { id: node.id, taskId: ref.taskId, status: st.statusText, progress: st.progress, state: st.state });
        if (st.done) break;
      }
      if (!st) st = { failed: true, error: '超时没等到结果（任务可能还在平台侧继续跑，稍后点运行旁边的刷新）' };
      ref.status = st.failed ? '失败' : (st.ok ? '完成' : '超时');
      ref.progress = st.ok ? 100 : (st.progress || ref.progress || 0);
      ref.urls = st.urls || [];
      ref.resultKind = modelsLib.resultKind(st, ref.modal);
      ref.cost = st.cost || 0;
      ref.error = st.error || '';
      ref.finishedAt = Date.now();
      const line = modelsLib.summarize(prep.model, st);
      node.note = String(node.note || '').slice(0, 9000) + '\n\n── ' + line + ' · ' + new Date().toLocaleString('zh-CN') + ' ──' +
        (st.urls && st.urls.length ? '\n' + st.urls.join('\n') : '');
      saveData();
      broadcast('fde:canvas', data.canvas);
      broadcast('fde:media', { id: node.id, taskId: ref.taskId, status: ref.status, progress: ref.progress, urls: ref.urls, error: ref.error, cost: ref.cost, kind: ref.resultKind });
      say(line);
      if (st.failed) return { ok: false, msg: line };
      return { ok: true, msg: line };
    }
    case 'note':
      return { ok: true, msg: '笔记节点无需执行' };
    case 'group':
      return { ok: true, msg: '分组节点无需执行' };
    default:
      return { ok: true };
  }
}

// 汇总节点及其上游的上下文，生成给 AI 的结构化提示词
// opts.lean（默认开）= 精简模式：上下文按相关性截断，只保留"能决定输出"的部分。
//   实测同一张画布，精简后进模型的量能降到 1/3，输出质量基本不变。
function buildContextPrompt(nodeId, opts = {}) {
  const lean = opts.lean !== false;
  const clip = (s, n) => {
    const t = String(s || '');
    if (!lean || t.length <= n) return t;
    return t.slice(0, n) + '…（已截断 ' + (t.length - n) + ' 字，需要时在项目上下文里看全文）';
  };
  const ctxLimit = lean ? 260 : 1200;
  const noteLimit = lean ? 400 : 2400;
  const node = canvasNode(nodeId);
  const ups = upstreamOf(nodeId);
  const lines = [];
  lines.push('# 工作上下文');
  lines.push('');
  const pids = new Set();
  for (const n of [node, ...ups]) {
    if (n && n.ref && n.ref.projectId) pids.add(n.ref.projectId);
  }
  // 项目上下文材料
  for (const pid of pids) {
    const p = data.projects.find(x => x.id === pid);
    if (!p) continue;
    lines.push('## 项目：' + p.name);
    if (p.desc) lines.push(clip(p.desc, lean ? 160 : 600));
    const ctx = p.context || [];
    if (ctx.length) {
      lines.push('');
      lines.push('### 上下文材料');
      for (const c of ctx) {
        lines.push('- [' + c.kind + '] **' + (c.title || c.value) + '**');
        if (c.value && c.value !== c.title) lines.push('  ' + clip(c.value, ctxLimit).replace(/\n/g, '\n  '));
        if (c.note) lines.push('  > ' + clip(c.note, ctxLimit).replace(/\n/g, '\n  > '));
      }
    }
  }
  lines.push('');
  lines.push('## 工作流节点');
  const all = [...ups, node].filter(Boolean);
  for (const n of all) {
    lines.push('### ' + n.title + '（' + n.type + '）');
    if (n.ref && n.ref.url) lines.push('链接: ' + n.ref.url);
    if (n.ref && n.ref.url === undefined && n.ref.path) lines.push('路径: ' + n.ref.path);
    if (n.ref && n.ref.match) lines.push('窗口匹配: ' + n.ref.match);
    if (n.note) lines.push(clip(n.note, noteLimit));
    lines.push('');
  }
  if (node && node.note) {
    lines.push('## 任务要求');
    lines.push(clip(node.note, lean ? 1200 : 6000));
  }
  return lines.join('\n').trim() + '\n';
}

/**
 * 生成提示词 + 算力账本。
 * 同样的输入第二次直接复用，不再让模型重读一遍；
 * 返回值里带 token 估算，超预算时调用方可以提示用户精简。
 */
function promptForNode(nodeId, lean = true) {
  const text = buildContextPrompt(nodeId, { lean });
  const tokens = runtime.estTokens(text);
  const key = 'p:' + runtime.fingerprint(String(nodeId) + '|' + lean + '|' + text);
  const cache = getAiCache();
  data.stats = data.stats || { aiCalls: 0, cacheHits: 0, tokensSaved: 0 };
  const hit = cache.get(key);
  let cached = false;
  if (hit && hit.value) {
    cached = true;
    data.stats.cacheHits += 1;
    data.stats.tokensSaved += tokens;
  } else {
    cache.set(key, { tokens });
    data.stats.aiCalls += 1;
  }
  saveData();
  return { text, tokens, cached, chars: text.length, budget: tokens > 12000 ? 'over' : (tokens > 6000 ? 'warn' : 'ok') };
}

// 项目上下文包（导出为 markdown，给 AI/文档/团队交接用）
function buildProjectContextPack(projectId) {
  const p = data.projects.find(x => x.id === projectId);
  if (!p) return null;
  const lines = ['# ' + p.name, ''];
  if (p.desc) lines.push(p.desc, '');
  lines.push('> 由 FDE Manager 导出 · ' + new Date().toLocaleString('zh-CN'));
  lines.push('');
  lines.push('## 运行环境');
  lines.push('- 自动打开：' + (p.autorun || []).length + ' 项');
  for (const a of (p.autorun || [])) {
    lines.push('  - ' + (a.name || a.path || a.url) + (a.delay ? '（延迟 ' + a.delay + 's）' : ''));
  }
  if ((p.items || []).length) {
    lines.push('- 脚本/模块：' + p.items.map(i => i.name).join('、'));
  }
  lines.push('');
  lines.push('## 上下文材料');
  if (!(p.context || []).length) lines.push('（暂无）');
  for (const c of (p.context || [])) {
    lines.push('### [' + c.kind + '] ' + (c.title || c.value));
    if (c.value && c.value !== c.title) lines.push('```', c.value, '```');
    if (c.note) lines.push(c.note);
    lines.push('');
  }
  // 画布中属于本项目的节点，也一并带上（工作流上下文）
  const nodes = data.canvas.nodes.filter(n => n.ref && n.ref.projectId === projectId);
  if (nodes.length) {
    lines.push('## 工作流');
    for (const n of nodes) {
      lines.push('- ' + n.title + '（' + n.type + '）' + (n.note ? '：' + n.note.replace(/\n/g, ' ') : ''));
    }
  }
  return lines.join('\n');
}

// ---------- 画布导出：Markdown 工作流说明书（给团队交接 / 贴给 AI）----------
function buildCanvasMarkdown() {
  const typeName = {
    project: '项目桌面', window: '应用窗口', url: '网页', script: '脚本',
    file: '文件', folder: '文件夹', note: '笔记', ai: 'AI 上下文', group: '分组/阶段'
  };
  const lines = ['# 工作流画布', ''];
  lines.push('> 由 FDE Manager 导出 · ' + new Date().toLocaleString('zh-CN'));
  lines.push('');
  const groups = data.canvas.nodes.filter(n => n.type === 'group');
  const loose = data.canvas.nodes.filter(n => n.type !== 'group' && !groups.some(g => groupMembers(g).some(m => m.id === n.id)));
  const projName = (n) => {
    const p = data.projects.find(x => x.id === (n.ref && n.ref.projectId));
    return p ? p.name : '';
  };
  const nodeLine = (n) => {
    const p = projName(n);
    let s = '- **' + n.title + '**（' + (typeName[n.type] || n.type) + '）';
    if (p) s += ' · 项目：' + p;
    if (n.ref && n.ref.url) s += ' · ' + n.ref.url;
    if (n.ref && n.ref.path) s += ' · `' + n.ref.path + '`';
    if (n.note) s += '\n  > ' + n.note.replace(/\n/g, ' ');
    return s;
  };
  for (const g of groups) {
    lines.push('## ' + g.title);
    if (g.note) lines.push(g.note, '');
    for (const m of groupMembers(g).sort((a, b) => a.x - b.x)) lines.push(nodeLine(m));
    lines.push('');
  }
  if (loose.length) {
    lines.push('## 其它节点');
    for (const n of loose) lines.push(nodeLine(n));
    lines.push('');
  }
  // 连线（含跨项目交接）
  const byId = new Map(data.canvas.nodes.map(n => [n.id, n]));
  const cross = [];
  for (const e of data.canvas.edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const pa = projName(a), pb = projName(b);
    if (pa && pb && pa !== pb) cross.push('**' + pa + '** → **' + pb + '**：' + a.title + ' → ' + b.title + (e.label ? '（' + e.label + '）' : ''));
  }
  if (cross.length) {
    lines.push('## 项目间交接');
    for (const c of cross) lines.push('- ' + c);
    lines.push('');
  }
  // 各项目上下文材料
  const pids = [...new Set(data.canvas.nodes.map(n => n.ref && n.ref.projectId).filter(Boolean))];
  if (pids.length) {
    lines.push('## 涉及的上下文材料');
    for (const pid of pids) {
      const p = data.projects.find(x => x.id === pid);
      if (!p) continue;
      lines.push('### ' + p.name);
      const ctx = p.context || [];
      if (!ctx.length) lines.push('（暂无）');
      for (const c of ctx) lines.push('- [' + c.kind + '] ' + (c.title || '') + (c.value ? '：' + c.value.replace(/\n/g, ' ') : ''));
      lines.push('');
    }
  }
  return lines.join('\n');
}

function stampName() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '-' + z(d.getHours()) + z(d.getMinutes());
}

// ---------- 场景包（Pack）：可安装、可分发的「能力插槽」 ----------
/**
 * 一个包 = 一个文件夹，唯一必需文件是 manifest.json：
 *   manifest.json   元数据 + 参数 + 权限声明
 *   autorun.json    自动打开清单（网页 / 程序，支持 {{参数}}，optional 表示没装就跳过）
 *   canvas.json     预置工作流（节点 + 连线，project 节点的 projectId 用 "$self"）
 *   context.json    上下文材料（口径 / 判断标准 / 入口）
 *   scripts/*       脚本（套用时复制到 userData/pack-scripts/<项目id>/ 再执行）
 *   README.md       说明
 *
 * 内置包在 程序目录/packs，用户导入与导出的包在 userData/packs。
 * 核心约束：包只是模板，套用生成的是「项目实例」；之后两者脱钩，包升级不会覆盖用户数据。
 */
const PACK_CONTEXT_KINDS = ['text', 'file', 'folder', 'url', 'sql', 'api'];

function packRoots() {
  return [
    { dir: path.join(__dirname, 'packs'), source: 'builtin' },
    { dir: path.join(app.getPath('userData'), 'packs'), source: 'user' }
  ];
}

let packCache = null;

function safeDirName(s) {
  return String(s || 'pack').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40) || 'pack';
}

function readJsonFile(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

// 包内文本里的 {{key}} 用参数替换
function tpl(str, params) {
  return String(str == null ? '' : str).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => {
    const v = params ? params[k] : undefined;
    return (v == null) ? '' : String(v);
  });
}

function scanPacks(force) {
  if (!force && packCache && Date.now() - packCache.at < 4000) return packCache.list;
  const seen = new Set();
  const list = [];
  for (const root of packRoots()) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch (e) { continue; }
    for (const name of dirs) {
      const dir = path.join(root.dir, name);
      const m = readJsonFile(path.join(dir, 'manifest.json'));
      if (!m || !m.id || !m.name) continue;
      if (seen.has(m.id)) continue;   // 同 id 以先扫到的为准（内置优先）
      seen.add(m.id);
      list.push({
        id: String(m.id),
        name: String(m.name),
        projectName: String(m.projectName || m.name),
        version: String(m.version || '1.0.0'),
        category: String(m.category || '未分类'),
        author: String(m.author || ''),
        desc: String(m.desc || ''),
        icon: String(m.icon || '🧩'),
        color: String(m.color || ''),
        tags: Array.isArray(m.tags) ? m.tags.slice(0, 8).map(String) : [],
        params: Array.isArray(m.params) ? m.params : [],
        permissions: Array.isArray(m.permissions) ? m.permissions : [],
        dir, source: root.source, broken: false
      });
    }
  }
  list.sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name, 'zh') : a.category.localeCompare(b.category, 'zh')));
  packCache = { at: Date.now(), list };
  return list;
}

function findPack(packId) {
  return scanPacks().find(p => p.id === packId) || null;
}

function loadPack(packId) {
  const info = findPack(packId);
  if (!info) return null;
  const manifest = readJsonFile(path.join(info.dir, 'manifest.json')) || {};
  const autorunRaw = readJsonFile(path.join(info.dir, 'autorun.json'));
  const canvasRaw = readJsonFile(path.join(info.dir, 'canvas.json'));
  const contextRaw = readJsonFile(path.join(info.dir, 'context.json'));
  let readme = '';
  try { readme = fs.readFileSync(path.join(info.dir, 'README.md'), 'utf8'); } catch (e) {}
  const arr = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
  return {
    ...info,
    manifest,
    autorun: arr(autorunRaw),
    canvas: (canvasRaw && typeof canvasRaw === 'object') ? canvasRaw : null,
    context: arr(contextRaw),
    items: arr(manifest.items),
    readme
  };
}

// 包里的脚本复制到项目自己的目录，避免多个项目共用一份被互相改动
function copyPackScript(pk, projectId, rel) {
  const clean = String(rel || '').replace(/^[./\\]+/, '');
  const src = path.join(pk.dir, clean);
  if (!fs.existsSync(src)) return '';
  try {
    const base = path.join(app.getPath('userData'), 'pack-scripts', projectId);
    fs.mkdirSync(base, { recursive: true });
    const dst = path.join(base, path.basename(clean));
    fs.copyFileSync(src, dst);
    return dst;
  } catch (e) {
    return src;
  }
}

// 把包里的画布挂到全局画布上：给这个项目单独开一条泳道，放在已有节点右侧
function addPackCanvasLane(p, pk, pms) {
  const C = data.canvas;
  if (!C || !Array.isArray(C.nodes)) return;
  let maxX = 0;
  for (const n of C.nodes) maxX = Math.max(maxX, Number(n.x) || 0);
  const startX = C.nodes.length ? maxX + 420 : 120;
  const startY = 140;
  const gapY = 118;
  const specs = pk.canvas.nodes.slice(0, 40);
  const idMap = new Map();

  specs.forEach((sn, i) => {
    if (!sn) return;
    const type = CANVAS_TYPES.has(sn.type) ? sn.type : 'note';
    const nid = 'n' + Date.now().toString(36) + i.toString(36);
    idMap.set(i, nid);
    const rawRef = (sn.ref && typeof sn.ref === 'object') ? sn.ref : {};
    const ref = {};
    for (const k of Object.keys(rawRef)) {
      ref[k] = typeof rawRef[k] === 'string' ? tpl(rawRef[k], pms) : rawRef[k];
    }
    // 泳道内所有节点都标记所属项目：这样「导出为场景包」才能把整条工作流带走
    ref.projectId = p.id;
    if (type === 'script' && rawRef.path) {
      const abs = copyPackScript(pk, p.id, tpl(rawRef.path, pms));
      if (abs) ref.path = abs; else delete ref.path;
    }
    C.nodes.push({
      id: nid, type,
      title: tpl(sn.title, pms) || '未命名',
      note: tpl(sn.note, pms),
      x: startX, y: startY + i * gapY,
      w: Math.max(200, Number(sn.w) || 286),
      h: 0,
      color: String(sn.color || ''),
      ref,
      tags: Array.isArray(sn.tags) ? sn.tags.slice(0, 6) : [],
      collapsed: false, locked: false, z: 0
    });
  });

  const edges = Array.isArray(pk.canvas.edges) ? pk.canvas.edges : [];
  edges.forEach((e, i) => {
    if (!e) return;
    const from = idMap.get(Number(e.from));
    const to = idMap.get(Number(e.to));
    if (!from || !to) return;
    C.edges.push({
      id: 'e' + Date.now().toString(36) + i.toString(36),
      from, to,
      label: tpl(e.label, pms),
      kind: EDGE_KINDS.has(e.kind) ? e.kind : 'flow',
      dashed: !!e.dashed
    });
  });

  // 泳道（分组节点）：把本项目的节点框起来，一眼看出这是哪个项目的工作流
  C.nodes.push({
    id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
    type: 'group',
    title: p.name,
    note: '场景包 · ' + pk.name,
    x: startX - 26, y: startY - 62,
    w: 356, h: specs.length * gapY + 46,
    color: p.color, ref: { projectId: p.id },
    tags: [], collapsed: false, locked: false, z: -1
  });
  C.view = C.view || { x: 0, y: 0, z: 1 };
}

/**
 * 套用一个场景包 → 生成一个项目实例。
 * 这是「市场」真正落地的动作：选一个包，填两个参数，就有一整套工作状态。
 */
async function applyPack(packId, params, opts) {
  const pk = loadPack(packId);
  if (!pk) return { ok: false, error: '场景包不存在或已损坏' };

  const pms = {};
  for (const d of pk.params) {
    if (!d || !d.key) continue;
    const given = params ? params[d.key] : undefined;
    pms[d.key] = (given === undefined || given === null || given === '') ? (d.default == null ? '' : String(d.default)) : String(given);
  }

  const pid = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const name = tpl(pk.projectName, pms) || pk.name;
  const p = {
    id: pid,
    name,
    color: pk.color || COLORS[data.projects.length % COLORS.length],
    status: 'stopped',
    statusMsg: '来自场景包 · 待启动',
    exclusive: true,
    approvals: {},
    items: [],
    autorun: [],
    windows: [],
    context: [],
    pack: { id: pk.id, version: pk.version, name: pk.name, params: pms, at: Date.now() }
  };

  // 自动打开清单
  for (const a of pk.autorun) {
    if (!a || !a.type) continue;
    if (a.type === 'url') {
      const url = tpl(a.url, pms);
      if (!url) continue;
      p.autorun.push({
        id: 'a' + Math.random().toString(36).slice(2, 9),
        type: 'url',
        url: /^[a-z][\w+.-]*:\/\//i.test(url) ? url : 'https://' + url,
        name: tpl(a.name, pms) || url.replace(/^https?:\/\//, ''),
        browserPath: '', browserName: '',
        delay: Math.max(0, Math.min(120, Number(a.delay) || 0))
      });
    } else if (a.type === 'app') {
      const ph = tpl(a.path, pms);
      if (!ph) continue;
      p.autorun.push({
        id: 'a' + Math.random().toString(36).slice(2, 9),
        type: 'app', path: ph,
        name: tpl(a.name, pms) || path.basename(ph).replace(/\.[^.]+$/, ''),
        args: tpl(a.args, pms),
        delay: Math.max(0, Math.min(120, Number(a.delay) || 0)),
        optional: !!a.optional
      });
    }
  }

  // 上下文材料
  for (const c of pk.context) {
    if (!c) continue;
    const value = tpl(c.value, pms);
    const title = tpl(c.title, pms) || value.slice(0, 40);
    if (!title && !value) continue;
    p.context.push({
      id: 'c' + Math.random().toString(36).slice(2, 9),
      kind: PACK_CONTEXT_KINDS.includes(c.kind) ? c.kind : 'text',
      title, value,
      note: tpl(c.note, pms),
      at: Date.now(),
      fromPack: true
    });
  }

  // 功能模块（可选）
  for (const it of pk.items) {
    if (!it || !it.name) continue;
    p.items.push({
      id: 'i' + Math.random().toString(36).slice(2, 9),
      kind: it.kind === 'script' ? 'script' : 'module',
      name: tpl(it.name, pms),
      path: it.path ? copyPackScript(pk, pid, tpl(it.path, pms)) : ''
    });
  }

  data.projects.push(p);
  if (pk.canvas && Array.isArray(pk.canvas.nodes) && pk.canvas.nodes.length) addPackCanvasLane(p, pk, pms);

  saveData();
  broadcast('fde:projects', data.projects);
  broadcast('fde:canvas', data.canvas);
  addLog('套用场景包「' + pk.name + '」→ 新建项目「' + p.name + '」（' +
    p.autorun.length + ' 个自动打开 / ' + p.context.length + ' 条上下文）', pid);
  refreshStatuses(true);

  const enter = !opts || opts.enter !== false;
  if (enter) {
    setTimeout(() => { switchDesktop(pid).catch(() => {}); }, 180);
  }
  return { ok: true, projectId: pid, name: p.name };
}

// 把一个项目反向导出成包：这是「FDE 自己写功能」的最低门槛（配置级）
async function exportProjectAsPack(projectId) {
  const p = data.projects.find(x => x.id === projectId);
  if (!p) return { ok: false, error: '项目不存在' };
  const dirName = safeDirName(p.name);
  const dir = path.join(app.getPath('userData'), 'packs', dirName);
  try {
    fs.mkdirSync(dir, { recursive: true });

    const manifest = {
      id: (p.pack && /^local\./.test(p.pack.id)) ? p.pack.id : ('local.' + Date.now().toString(36)),
      name: p.name,
      projectName: p.name,
      version: '1.0.0',
      category: '我做的包',
      author: 'me',
      icon: '📦',
      color: p.color || '',
      desc: '从项目「' + p.name + '」导出的工作状态：' +
        (p.autorun || []).length + ' 个自动打开、' + (p.context || []).length + ' 条上下文、' +
        '工作流节点若干。',
      tags: ['我的包'],
      permissions: ['autorun', 'context', 'canvas'],
      params: []
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const autorun = (p.autorun || []).map(a => a.type === 'url'
      ? { type: 'url', url: a.url, name: a.name || '', delay: a.delay || 0 }
      : { type: 'app', path: a.path, name: a.name || '', args: a.args || '', delay: a.delay || 0, optional: true });
    fs.writeFileSync(path.join(dir, 'autorun.json'), JSON.stringify(autorun, null, 2), 'utf8');

    const context = (p.context || []).map(c => ({ kind: c.kind, title: c.title, value: c.value, note: c.note || '' }));
    fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context, null, 2), 'utf8');

    // 只导出属于本项目的工作流节点，project 节点用 $self 指代
    const mine = (data.canvas.nodes || []).filter(n => n.type !== 'group' && n.ref && n.ref.projectId === p.id);
    const idx = new Map(mine.map((n, i) => [n.id, i]));
    const canvas = {
      nodes: mine.map(n => {
        const ref = {};
        for (const k of Object.keys(n.ref || {})) {
          if (k === 'projectId') continue;
          ref[k] = n.ref[k];
        }
        if (n.type === 'project') ref.projectId = '$self';
        return { type: n.type, title: n.title, note: n.note || '', w: n.w, color: n.color || '', ref };
      }),
      edges: (data.canvas.edges || [])
        .filter(e => idx.has(e.from) && idx.has(e.to))
        .map(e => ({ from: idx.get(e.from), to: idx.get(e.to), label: e.label || '', kind: e.kind || 'flow' }))
    };
    fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify(canvas, null, 2), 'utf8');

    const readme = [
      '# ' + p.name,
      '',
      '从 FDE 项目导出的场景包。',
      '',
      '## 包含内容',
      '',
      '- 自动打开：' + (p.autorun || []).length + ' 项',
      '- 上下文材料：' + (p.context || []).length + ' 条',
      '- 工作流节点：' + mine.length + ' 个',
      '',
      '## 需要注意',
      '',
      '- 程序路径是本机路径，换电脑后需要在项目设置里改。',
      '- URL 与上下文材料可以直接复用。',
      ''
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'README.md'), readme, 'utf8');

    packCache = null;
    broadcast('fde:packs');
    addLog('项目「' + p.name + '」已导出为场景包：' + dir, p.id);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function importPackFolder() {
  const r = await dialog.showOpenDialog({
    title: '选择场景包文件夹（里面要有 manifest.json）',
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  if (!fs.existsSync(path.join(src, 'manifest.json'))) {
    return { ok: false, error: '这个文件夹里没有 manifest.json，不是场景包' };
  }
  const m = readJsonFile(path.join(src, 'manifest.json'));
  if (!m || !m.id || !m.name) return { ok: false, error: 'manifest.json 内容不合法（至少要 id 和 name）' };
  const base = path.join(app.getPath('userData'), 'packs');
  const dst = path.join(base, safeDirName(m.name));
  try {
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    packCache = null;
    addLog('导入场景包：' + m.name);
    return { ok: true, id: m.id, dir: dst };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deletePack(packId) {
  const info = findPack(packId);
  if (!info) return { ok: false, error: '包不存在' };
  if (info.source !== 'user') return { ok: false, error: '内置包不能删除，可以把它导出后改造成自己的包' };
  try {
    // 只删包目录本身（连同包内文件），不触碰 userData/packs 之外的任何东西
    fs.rmSync(info.dir, { recursive: true, force: true });
    packCache = null;
    addLog('删除场景包：' + info.name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 环境 / 迁移（换电脑、换客户不再重搭） ----------
let pendingImport = null; // 已解析、还没落盘的环境快照

function envRoots() {
  return runtime.makeRoots({
    home: os.homedir(),
    desktop: app.getPath('desktop'),
    docs: app.getPath('documents'),
    downloads: app.getPath('downloads'),
    appData: process.env.APPDATA || '',
    localAppData: process.env.LOCALAPPDATA || '',
    programFiles: process.env.ProgramFiles || '',
    appDir: __dirname
  });
}

function userPacksDir() { return path.join(app.getPath('userData'), 'packs'); }
function userPackScriptsDir() { return path.join(app.getPath('userData'), 'pack-scripts'); }

function getAiCache() {
  if (!global.__fdeAiCache) {
    global.__fdeAiCache = new runtime.AiCache(path.join(app.getPath('userData'), 'ai-cache.json'));
  }
  return global.__fdeAiCache;
}

function envInfo() {
  return {
    ok: true,
    dataRoot: app.getPath('userData'),
    mode: DATA_ROOT.mode,
    source: DATA_ROOT.source,
    appDir: __dirname,
    version: app.getVersion(),
    portableConfig: path.join(__dirname, 'portable.json'),
    counts: {
      projects: data.projects.length,
      canvasNodes: (data.canvas.nodes || []).length,
      packs: scanPacks().length,
      scripts: data.projects.reduce((n, p) => n + (p.items || []).filter(i => i.path).length, 0),
      context: data.projects.reduce((n, p) => n + (p.context || []).length, 0)
    },
    ai: Object.assign(getAiCache().stats(), data.stats || {})
  };
}

/** 导出环境快照：一个文件带走整套工作台 */
async function exportSnapshot() {
  const d = new Date();
  const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
    '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  const r = await dialog.showSaveDialog(panelWin, {
    title: '导出环境快照（换电脑 / 给客户部署用这一个文件）',
    defaultPath: path.join(app.getPath('documents'), 'FDE-环境-' + stamp + '.fdeenv'),
    filters: [{ name: 'FDE 环境快照', extensions: ['fdeenv'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    const entries = runtime.snapshotEntries(data, {
      roots: envRoots(),
      packsDir: userPacksDir(),
      packScriptsDir: userPackScriptsDir(),
      appVersion: app.getVersion()
    });
    const buf = runtime.zip(entries);
    fs.writeFileSync(r.filePath, buf);
    addLog('已导出环境快照：' + path.basename(r.filePath) + '（' + entries.length + ' 个文件，' + Math.round(buf.length / 1024) + ' KB）', null);
    return { ok: true, path: r.filePath, size: buf.length, files: entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 选一个快照并预演：先不写盘，让用户看清里面有什么、这台机器缺什么 */
async function pickSnapshot() {
  const r = await dialog.showOpenDialog(panelWin, {
    title: '选择环境快照',
    properties: ['openFile'],
    filters: [{ name: 'FDE 环境快照', extensions: ['fdeenv', 'zip'] }]
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  try {
    const buf = fs.readFileSync(file);
    const parsed = runtime.parseSnapshot(buf);
    const restored = normalizeData(runtime.restorePaths(parsed.data, envRoots()));
    pendingImport = { file, data: restored, manifest: parsed.manifest, files: parsed.files };
    const check = await runtime.envCheck(restored, { dataRoot: app.getPath('userData'), appDir: __dirname });
    return {
      ok: true,
      file,
      size: buf.length,
      manifest: parsed.manifest,
      projects: restored.projects.map(p => ({
        name: p.name,
        autorun: (p.autorun || []).length,
        context: (p.context || []).length,
        items: (p.items || []).length
      })),
      canvasNodes: (restored.canvas.nodes || []).length,
      check
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function extractInto(files, prefix, destDir) {
  let n = 0;
  for (const [name, buf] of files) {
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(destDir, rel.split('/').join(path.sep));
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      n++;
    } catch (e) { /* 单个文件失败不阻塞 */ }
  }
  return n;
}

/** 落盘导入。mode: replace（整机还原）| merge（只补新项目） */
async function importSnapshot(mode = 'replace') {
  if (!pendingImport) return { ok: false, error: '请先选择快照文件' };
  const { data: incoming, files } = pendingImport;
  try {
    // 1) 现有数据先备份，任何情况下都能退回去
    const backup = path.join(app.getPath('userData'),
      'fde-data-备份-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');
    try { fs.copyFileSync(dataFile(), backup); } catch (e) {}

    const packCount = extractInto(files, 'packs/', userPacksDir());
    const scriptCount = extractInto(files, 'pack-scripts/', userPackScriptsDir());

    if (mode === 'merge') {
      const exist = new Set(data.projects.map(p => p.id));
      let added = 0;
      for (const p of incoming.projects) {
        if (exist.has(p.id)) continue;
        data.projects.push(p);
        exist.add(p.id);
        added++;
      }
      // 画布节点：按 id 去重后追加
      const nodeIds = new Set(data.canvas.nodes.map(n => n.id));
      for (const n of (incoming.canvas.nodes || [])) if (!nodeIds.has(n.id)) data.canvas.nodes.push(n);
      const edgeIds = new Set(data.canvas.edges.map(e => e.id));
      for (const e of (incoming.canvas.edges || [])) if (!edgeIds.has(e.id)) data.canvas.edges.push(e);
      const flowIds = new Set(data.flows.map(f => f.id));
      for (const f of (incoming.flows || [])) if (!flowIds.has(f.id)) data.flows.push(f);
      normalizeData(data);
      saveData();
      applyAfterImport();
      addLog('已合并环境快照：新增 ' + added + ' 个项目、' + packCount + ' 个场景包文件', null);
      return { ok: true, mode, projects: added, packs: packCount, scripts: scriptCount, backup };
    }

    // replace：整机还原
    const keepSettings = data.settings || {};
    data = normalizeData(incoming);
    // 本机的显示/权限偏好保留，别把上一台机器的分辨率设置带过来；
    // 原壁纸路径是快照机器的，本机要重新采集，否则退出时恢复不回来
    data.settings.wallpaper = keepSettings.wallpaper !== false;
    data.settings.needAdmin = keepSettings.needAdmin !== false;
    data.settings.dodgePanel = keepSettings.dodgePanel !== false;
    data.settings.originalWallpaper = '';
    saveData();
    applyAfterImport();
    addLog('已还原环境快照：' + data.projects.length + ' 个项目（原数据已备份）', null);
    return { ok: true, mode, projects: data.projects.length, packs: packCount, scripts: scriptCount, backup };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    pendingImport = null;
  }
}

/** 导入/切换数据目录之后，让界面和窗口归属跟上新数据 */
function applyAfterImport() {
  migrateFlowsToCanvas();
  const ids = new Set(data.projects.map(p => p.id));
  for (const [hwnd, rec] of winRecs) {
    if (rec.owner && !ids.has(rec.owner)) winRecs.delete(hwnd);
  }
  broadcast('fde:projects', data.projects);
  broadcast('fde:flows', data.flows);
  broadcast('fde:canvas', data.canvas);
  broadcast('fde:logs', data.logs.slice(0, 100));
  try { rebuildTrayMenu(); } catch (e) {}
  try { refreshStatuses(true); } catch (e) {}
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('fde:packs'); } catch (e) {}
  }
}

/** 批量改路径前缀：客户机器盘符/目录不一样时，一次改完所有项目 */
function rewritePaths(oldPrefix, newPrefix) {
  const from = String(oldPrefix || '').trim();
  const to = String(newPrefix || '').trim();
  if (!from) return { ok: false, error: '请填写原路径前缀' };
  let n = 0;
  const swap = (s) => {
    if (typeof s !== 'string') return s;
    const low = s.toLowerCase(), fl = from.toLowerCase();
    if (!low.startsWith(fl)) return s;
    n++;
    return to + s.slice(from.length);
  };
  data = runtime.mapPaths(data, swap);
  normalizeData(data);
  saveData();
  applyAfterImport();
  addLog('已把 ' + n + ' 处路径从「' + from + '」改为「' + to + '」', null);
  return { ok: true, changed: n };
}

/** 切换数据目录：把工作台搬到 U 盘 / 网盘 / 另一个分区 */
async function setDataRoot(target, { move = true } = {}) {
  const dir = path.resolve(String(target || '').trim());
  if (!dir) return { ok: false, error: '请填写目录' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (move) {
      const src = app.getPath('userData');
      if (path.resolve(src).toLowerCase() !== dir.toLowerCase()) {
        for (const f of ['fde-data.json', 'ai-cache.json', 'startup.log']) {
          const a = path.join(src, f);
          if (fs.existsSync(a)) fs.copyFileSync(a, path.join(dir, f));
        }
        for (const sub of ['packs', 'pack-scripts', 'wallpapers', 'apps']) {
          const a = path.join(src, sub);
          if (fs.existsSync(a)) {
            try { fs.cpSync(a, path.join(dir, sub), { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
    }
    // 写 portable.json：程序目录可写时最省事，双击即生效
    const cfg = path.join(__dirname, 'portable.json');
    fs.writeFileSync(cfg, JSON.stringify({ dataDir: dir, note: 'FDE 数据目录（绿色版）。删掉本文件即回到默认 %APPDATA%。' }, null, 2), 'utf8');
    return { ok: true, dir, config: cfg, needRestart: true };
  } catch (e) {
    return { ok: false, error: '写配置失败：' + e.message + '（程序目录可能需要管理员权限，可把整个 FDE 文件夹放到 D 盘再试）' };
  }
}

/** 打包成"绿色便携版"文件夹：拷到任何 Windows 机器，双击就能用 */
async function buildPortable() {
  const r = await dialog.showOpenDialog(panelWin, {
    title: '选择一个空文件夹（或新建文件夹）作为便携版目标',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const dest = r.filePaths[0];
  try {
    const appFiles = ['main.js', 'preload.js', 'runtime.js', 'package.json',
      'ai.js', 'apps.js', 'builder.js', 'desktop.js', 'panels.js', 'acks.js', 'adopt.js', 'trust.js', 'urlopen.js',
      'models.js', 'router.js', 'ecom.js', 'gbk.js', 'kb.js', 'platform.js', 'wmp.js',
      'panel.html', 'overview.html', 'project.html', 'market.html', 'env.html', 'apps.html', 'trust.html', 'ecom.html', 'kb.html',
      'winhelper.ps1', '启动 FDE.vbs', '启动 FDE.command', 'fde.sh'];
    for (const f of appFiles) {
      const src = path.join(__dirname, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
    }
    // 交付配置：带进便携版，但**默认剥掉密钥** —— 便携版是要给别人的，
    // 带着密钥就等于把这条 key 送出去（全团队烧同一个 key，还看不到是谁在用）。
    // 只有交付文件里写了 "shareKey": true（渠道统一买单）才原样带过去。
    const deliverySrc = path.join(__dirname, 'fde-delivery.json');
    let deliveryCopied = false, keyStripped = false;
    if (fs.existsSync(deliverySrc)) {
      try {
        const raw = JSON.parse(fs.readFileSync(deliverySrc, 'utf8')) || {};
        const clean = aiClient.sanitizeDelivery(raw);
        keyStripped = !!raw.apiKey && !clean.apiKey;
        fs.writeFileSync(path.join(dest, 'fde-delivery.json'), JSON.stringify(clean, null, 2), 'utf8');
        deliveryCopied = true;
      } catch (e) {
        try { fs.copyFileSync(deliverySrc, path.join(dest, 'fde-delivery.json')); deliveryCopied = true; } catch (e2) {}
      }
    }
    // 内置场景包
    const builtinPacks = path.join(__dirname, 'packs');
    if (fs.existsSync(builtinPacks)) fs.cpSync(builtinPacks, path.join(dest, 'packs'), { recursive: true, force: true });
    // Electron 运行时（有就带上，没有对方得自己 npm i）
    const dist = path.join(__dirname, 'node_modules', 'electron', 'dist');
    let runtimeCopied = false;
    if (fs.existsSync(dist)) {
      fs.mkdirSync(path.join(dest, 'node_modules', 'electron'), { recursive: true });
      fs.cpSync(dist, path.join(dest, 'node_modules', 'electron', 'dist'), { recursive: true, force: true });
      const pj = path.join(__dirname, 'node_modules', 'electron', 'package.json');
      if (fs.existsSync(pj)) fs.copyFileSync(pj, path.join(dest, 'node_modules', 'electron', 'package.json'));
      const pi = path.join(__dirname, 'node_modules', 'electron', 'path.txt');
      if (fs.existsSync(pi)) fs.copyFileSync(pi, path.join(dest, 'node_modules', 'electron', 'path.txt'));
      runtimeCopied = true;
    }
    // 数据：跟着走
    const dataDest = path.join(dest, 'fde-data');
    fs.mkdirSync(dataDest, { recursive: true });
    fs.writeFileSync(path.join(dataDest, 'fde-data.json'),
      JSON.stringify(runtime.mapPaths(JSON.parse(JSON.stringify(data)), s => runtime.toVars(s, envRoots())), null, 2), 'utf8');
    for (const sub of ['packs', 'pack-scripts', 'wallpapers', 'apps']) {
      const a = path.join(app.getPath('userData'), sub);
      if (fs.existsSync(a)) { try { fs.cpSync(a, path.join(dataDest, sub), { recursive: true, force: true }); } catch (e) {} }
    }
    fs.writeFileSync(path.join(dest, 'portable.json'),
      JSON.stringify({ dataDir: 'fde-data' }, null, 2), 'utf8');
    fs.writeFileSync(path.join(dest, '怎么用.txt'),
      ['FDE 便携版', '',
        '1. 整个文件夹拷贝到任意 Windows 电脑（D 盘、U 盘都行）',
        '2. 双击「启动 FDE.vbs」',
        '3. 数据在 fde-data 目录里，跟着文件夹走；换机器不用重新配',
        '',
        runtimeCopied ? '已内置 Electron 运行时，对方不需要装 Node。' : '未找到 Electron 运行时，对方需要先在本目录执行 npm i。',
        '如果某台机器上的程序装在别的路径，打开「环境 / 迁移」→「批量改路径」一次改完。'
      ].join('\r\n'), 'utf8');
    return { ok: true, dest, runtimeCopied, deliveryCopied, keyStripped };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- AI 算力对接（api.lk888.ai；ai.my10086.cn 是网页控制台） ----------
// 密钥单独存一个文件，不进 fde-data.json：这样导快照 / 做便携版不会把密钥带出去。
const aiClient = require('./ai');
const modelsLib = require('./models');
const router = require('./router');
let modelsCache = null;   // { key, at, value } 模型目录缓存（10 分钟）
const detailCache = new Map();   // 模型参数定义缓存：key → { at, params, fields, ... }（30 分钟）

/**
 * 单个模型的参数定义（每个模型能传图/视频/音频、能调比例/秒数/质量都在这里）。
 * 目录接口只给"有哪些模型"，参数要单独查 /v1/skills/models/<name>，所以要缓存，
 * 否则每开一个节点都要多一次网络请求。
 */
async function modelDetailOf(cfg, name) {
  const model = String(name || '').trim();
  if (!model) return { ok: false, error: '没给模型名' };
  const c = cfg || aiConfig();
  if (!c.apiKey) return { ok: false, error: '还没接算力：去「应用功能 → ⚡ 模型设置」填密钥', kind: 'nokey' };
  const key = String(c.baseUrl || '') + '|' + aiClient.maskKey(c.apiKey) + '|' + model;
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return Object.assign({ ok: true, cached: true }, hit.value);
  const r = await aiClient.modelDetail(c, model);
  if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
  const raw = r.model || {};
  const params = modelsLib.normalizeParams(raw.params);
  const fields = modelsLib.fieldsOf(params);
  const value = {
    name: model,
    displayName: String(raw.display_name || ''),
    type: String(raw.type || ''),
    params,
    fields,
    defaults: modelsLib.defaultsFor(params),
    caps: modelsLib.capabilities(fields),
    note: String(raw.params_note || ''),
    constraints: Array.isArray(raw.channel_constraints) ? raw.channel_constraints.map(x => String(x)).slice(0, 4) : [],
    at: Date.now()
  };
  detailCache.set(key, { at: Date.now(), value });
  // 顺手补回目录缓存：画布/模型库同一个模型对象立刻就有参数了
  if (modelsCache && modelsCache.value && Array.isArray(modelsCache.value.models)) {
    const m = modelsCache.value.models.find(x => x.name === model);
    if (m) { m.params = params; m.caps = value.caps; }
    broadcast('fde:models', modelsCache.value);
  }
  return Object.assign({ ok: true, cached: false }, value);
}

function aiFilePath() { return path.join(app.getPath('userData'), 'ai.json'); }

function aiConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(aiFilePath(), 'utf8')) || {}; } catch (e) { saved = {}; }
  const baseUrl = aiClient.normalizeBase(saved.baseUrl || '');
  // models 统一归一成 {id,name} 对象：渠道预置(seedDelivery)存的是字符串数组，
  // 直接透传给界面会渲染出一排"空白选项"，看起来就是"其它模型不显示、选不了"
  const modelsRaw = Array.isArray(saved.models) ? saved.models.slice(0, 300) : [];
  const models = modelsRaw.map((m) => {
    if (typeof m === 'string') return m.trim() ? { id: m.trim(), name: m.trim() } : null;
    if (m && m.id) return { id: String(m.id), name: String(m.name || m.id) };
    return null;
  }).filter(Boolean);
  return {
    baseUrl,
    apiKey: String(saved.apiKey || ''),
    model: String(saved.model || ''),
    models,
    protocol: saved.protocol === 'site' ? 'site' : 'openai',
    delivered: !!saved.delivered,
    deliveredLabel: String(saved.deliveredLabel || ''),
    providers: aiClient.sanitizeProviders(saved.providers),
    autoSwitch: saved.autoSwitch !== false,   // 模型失败/不稳时自动换一个（默认开）
    updatedAt: saved.updatedAt || 0,
    defaults: {
      baseUrl: aiClient.DEFAULT_BASE,
      console: aiClient.CONSOLE.console,
      skill: aiClient.CONSOLE.skill,
      home: aiClient.CONSOLE.home
    }
  };
}

/** 交付配置：装机时把 fde-delivery.json 放进软件目录，启动即自动种入渠道密钥 */
function deliveryFilePaths() {
  const list = [path.join(__dirname, 'fde-delivery.json')];
  try { if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'fde-delivery.json')); } catch (e) {}
  return list;
}
function seedDeliveryKey() {
  for (const p of deliveryFilePaths()) {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(aiFilePath(), 'utf8')) || {}; } catch (e) { saved = {}; }
    const r = aiClient.seedDelivery(saved, d);
    if (r.ok) {
      try {
        fs.mkdirSync(path.dirname(aiFilePath()), { recursive: true });
        fs.writeFileSync(aiFilePath(), JSON.stringify(r.config, null, 2), 'utf8');
        say(r.keySeeded
          ? ('已自动接入渠道算力（' + r.config.deliveredLabel + '），开箱即用')
          : '已预置接口地址和模型清单；密钥请各自在「模型设置」里填自己的');
        return true;
      } catch (e) { return false; }
    }
    if (r.reason === '已配置过，不覆盖') return false; // 找到交付文件但无需种入
  }
  return false;
}

// ---------- 用量记账：每次模型调用累计 token（按日/按模型），给界面看消耗 ----------
function usageFilePath() { return path.join(app.getPath('userData'), 'ai-usage.json'); }
function usageRead() {
  try { return JSON.parse(fs.readFileSync(usageFilePath(), 'utf8')) || {}; } catch (e) { return {}; }
}
function usageAdd(model, usage) {
  const u = usage || {};
  const tokens = Number(u.total_tokens || 0);
  if (!tokens) return;
  const st = usageRead();
  const day = new Date().toISOString().slice(0, 10);
  const bump = (o) => { o.tokens = (o.tokens || 0) + tokens; o.calls = (o.calls || 0) + 1; };
  st.total = st.total || { tokens: 0, calls: 0 };
  st.days = st.days || {};
  st.days[day] = st.days[day] || { tokens: 0, calls: 0 };
  st.byModel = st.byModel || {};
  st.byModel[model] = st.byModel[model] || { tokens: 0, calls: 0 };
  bump(st.total); bump(st.days[day]); bump(st.byModel[model]);
  // 只留最近 30 天
  const keys = Object.keys(st.days).sort();
  while (keys.length > 30) delete st.days[keys.shift()];
  try { fs.writeFileSync(usageFilePath(), JSON.stringify(st, null, 2), 'utf8'); } catch (e) {}
}
function usageSummary() {
  const st = usageRead();
  const day = new Date().toISOString().slice(0, 10);
  const today = (st.days && st.days[day]) || { tokens: 0, calls: 0 };
  const byModel = Object.entries(st.byModel || {})
    .sort((a, b) => (b[1].tokens || 0) - (a[1].tokens || 0)).slice(0, 5)
    .map(([model, v]) => ({ model, tokens: v.tokens || 0, calls: v.calls || 0 }));
  return { today, total: st.total || { tokens: 0, calls: 0 }, byModel };
}
/** 带记账的模型调用：所有走算力的地方都从这里过 */
/** 能参与自动挑选的聊天模型名（优先用模型目录的 chat 组，没有就退回配置里的模型列表） */
function chatModelNames(cfg) {
  const cat = modelsCache && modelsCache.value && modelsCache.value.groups && modelsCache.value.groups.chat;
  if (Array.isArray(cat) && cat.length) return cat.map(m => m.name || m.id).filter(Boolean);
  // 配置里的 models 已归一成 {id,name} 对象（老文件可能是字符串），都兼容
  return (cfg.models || []).map(x => typeof x === 'string' ? x : (x && x.id) || '').filter(Boolean);
}

/** 从这次请求推任务画像：带图 / 材料多长 / 干什么活 */
function taskOfPayload(payload) {
  const p = payload || {};
  let text = '';
  let hasImages = !!(p.images && p.images.length);
  for (const m of (Array.isArray(p.messages) ? p.messages : [])) {
    if (!m) continue;
    if (typeof m.content === 'string') { text += m.content + '\n'; continue; }
    if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (!c) continue;
        if (c.type === 'text') text += String(c.text || '') + '\n';
        if (c.type === 'image_url') hasImages = true;
      }
    }
  }
  return { purpose: String(p.purpose || 'chat'), hasImages, chars: text.length, needQuality: !!p.needQuality };
}

/**
 * 统一出口：按任务挑模型（auto）+ 失败自动换下一个。
 * payload.model：
 *   'auto' / 空   → 按任务自动挑，失败沿候选链换（最多 4 个）
 *   具体模型名    → 先试它；失败且 autoSwitch 开着，再换备胎（最多 3 次）
 */
async function aiChatCounted(cfg, payload, opts) {
  const p = Object.assign({}, payload || {});
  const wanted = String(p.model || cfg.model || '').trim();
  const task = taskOfPayload(p);
  const plan = router.plan({ preferred: wanted, task, chatModels: chatModelNames(cfg) });
  const chain = plan.chain.length ? plan.chain : [wanted].filter(Boolean);
  if (!chain.length) return { ok: false, error: '还没选模型：去「应用功能 → ⚡ 模型设置」选一个，或选「🪄 自动」', kind: 'nomodel' };
  const canSwitch = plan.auto || cfg.autoSwitch !== false;
  const run = await router.runWithFallback({
    chain,
    canSwitch,
    maxTries: 4,
    chat: (model) => aiClient.chat(cfg, Object.assign({}, p, { model }), opts),
    onSwitch: (prev, next) => say('「' + prev + '」不行，自动换 ' + next + ' 再试…')
  });
  if (run.ok) {
    const r = run.result;
    const model = run.tried[run.tried.length - 1];
    if (r.usage) usageAdd(r.model || model, r.usage);
    broadcast('fde:ai', aiPublic());
    if (run.tried.length > 1) { try { addLog('模型自动切换：' + run.tried.join(' → ')); } catch (e) {} }
    return Object.assign(r, {
      auto: !!plan.auto, picked: r.model || model, reason: plan.reason,
      tried: run.tried, switched: run.tried.length > 1
    });
  }
  // 全挂了：把试过哪些模型一起带回去，方便定位
  const last = run.last || {};
  return Object.assign({}, last, {
    ok: false,
    error: last.error || '模型调用失败',
    auto: !!plan.auto, plan: plan.picked, tried: run.tried
  });
}

/** 给界面看的配置：密钥打码，不原样回传 */
function aiPublic() {
  const c = aiConfig();
  return {
    ok: true,
    baseUrl: c.baseUrl,
    // 只给"有没有"，不给任何密钥片段：别人在这台机器上打开界面/看源码也读不到 key
    keyMask: c.apiKey ? 'sk-****' : '',
    hasKey: !!c.apiKey,
    model: c.model,
    models: c.models,
    protocol: c.protocol,
    autoSwitch: c.autoSwitch,
    autoModel: router.isAuto(c.model),
    delivered: c.delivered,
    deliveredLabel: c.deliveredLabel,
    providers: (c.providers || []).map(p => ({
      id: p.id, name: p.name, baseUrl: p.baseUrl,
      keyMask: p.apiKey ? aiClient.maskKey(p.apiKey) : '',
      hasKey: !!p.apiKey,
      models: p.models, local: !!p.local
    })),
    usage: usageSummary(),
    updatedAt: c.updatedAt,
    status: aiClient.status(c),
    defaults: c.defaults
  };
}

function aiSave(patch) {
  const cur = aiConfig();
  const next = {
    baseUrl: aiClient.normalizeBase((patch && patch.baseUrl) || cur.baseUrl),
    apiKey: (patch && typeof patch.apiKey === 'string' && patch.apiKey.trim()) ? patch.apiKey.trim() : cur.apiKey,
    model: (patch && typeof patch.model === 'string') ? patch.model.trim() : cur.model,
    models: Array.isArray(patch && patch.models) ? patch.models.slice(0, 300) : cur.models,
    protocol: (patch && patch.protocol === 'site') || (!patch && cur.protocol === 'site') ? 'site' : 'openai',
    delivered: cur.delivered,
    deliveredLabel: cur.deliveredLabel,
    providers: Array.isArray(patch && patch.providers) ? aiClient.sanitizeProviders(patch.providers) : cur.providers,
    autoSwitch: (patch && typeof patch.autoSwitch === 'boolean') ? patch.autoSwitch : cur.autoSwitch,
    updatedAt: Date.now()
  };
  if (patch && patch.clearKey) { next.apiKey = ''; next.delivered = false; next.deliveredLabel = ''; }
  try {
    fs.mkdirSync(path.dirname(aiFilePath()), { recursive: true });
    fs.writeFileSync(aiFilePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: '保存失败：' + e.message };
  }
  if (appsWin && !appsWin.isDestroyed()) { try { appsWin.webContents.send('fde:ai', aiPublic()); } catch (e) {} }
  if (switcherWin && !switcherWin.isDestroyed()) { try { switcherWin.webContents.send('fde:ai', aiPublic()); } catch (e) {} }
  return aiPublic();
}


// ---------- 应用功能（专家 / 技能 / 连接器 / 资料库） ----------
// 相当于 FDE 自己的"能力仓"：一份份小资产，存在数据目录 apps/ 下，跟着数据走。
const appsStore = require('./apps');
const builder = require('./builder');

function appsRoot() { return path.join(app.getPath('userData'), 'apps'); }

let appsWin = null;
let appsScanCache = { at: 0, items: [] };

function appsPayload() {
  const root = appsRoot();
  let items = [], trash = [];
  try { items = appsStore.list(root); } catch (e) { items = []; }
  try { trash = appsStore.listTrash(root).map(t => ({
    key: path.basename(t.dir), name: t.name, kind: t.kind, deletedAt: t.deletedAt
  })); } catch (e) { trash = []; }
  const slim = items.map(x => {
    const c = Object.assign({}, x);
    delete c.dir;
    return c;
  });
  return {
    ok: true, items: slim, trash,
    kinds: appsStore.KINDS, stats: appsStore.stats(items),
    root
  };
}

function appsBroadcast() {
  const p = appsPayload();
  if (appsWin && !appsWin.isDestroyed()) { try { appsWin.webContents.send('fde:apps', p); } catch (e) {} }
  return p;
}

function openApps(tab) {
  const a = panelArea();
  const want = String(tab || '').trim();
  if (appsWin && !appsWin.isDestroyed()) {
    revealWindow(appsWin);
    appsBroadcast();
    // 窗口已经开着：直接让它切到知识库那一档，而不是再开一个
    if (want) { try { appsWin.webContents.send('apps:tab', want); } catch (e) {} }
    return { ok: true };
  }
  const w = Math.min(1240, a.width - 60);
  const h = Math.min(900, a.height - 60);
  appsWin = new BrowserWindow({
    x: a.x + Math.round((a.width - w) / 2),
    y: a.y + Math.round((a.height - h) / 2),
    width: w, height: h,
    show: false,
    frame: false,
    backgroundColor: '#0b0f17',
    resizable: true,
    title: '应用功能',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 应用功能里内嵌知识库（iframe），子框架也要拿到 preload 才能调 IPC
      nodeIntegrationInSubFrames: true
    }
  });
  applyWinPin(appsWin);
  guardWindowLoad(appsWin, '应用功能', 'apps.html');
  if (want) appsWin.loadFile('apps.html', { query: { tab: want } });
  else appsWin.loadFile('apps.html');
  appsWin.once('ready-to-show', () => { revealWindow(appsWin, { focus: false }); });
  appsWin.on('closed', () => { appsWin = null; });
  return { ok: true };
}

/** 把一份资产变成画布上的一个节点：专家/技能 → AI 上下文，连接器 → 网页，资料库 → 文件 */
function appToCanvas(id) {
  const item = appsStore.get(appsRoot(), id);
  if (!item) return { ok: false, error: '找不到这一项' };
  const C = data.canvas;
  let x = 120, y = 140;
  if (C.nodes.length) {
    let maxR = -Infinity, minY = Infinity;
    for (const n of C.nodes) {
      maxR = Math.max(maxR, (Number(n.x) || 0) + (Number(n.w) || 240));
      minY = Math.min(minY, Number(n.y) || 0);
    }
    x = Math.round(maxR + 70);
    y = Math.round(Number.isFinite(minY) ? minY : 140);
  }
  const url = (item.connector && item.connector.url) || '';
  const type = item.kind === 'connector' ? (url ? 'url' : 'ai') : (item.kind === 'library' ? 'file' : 'ai');
  const note = appsStore.promptOf(item).slice(0, 4000);
  const ref = { appId: item.id, appKind: item.kind };
  if (type === 'url') ref.url = url;
  if (type === 'file') ref.path = (item.library && item.library.path) || '';
  const n = {
    id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    type,
    title: item.name,
    note,
    x, y, w: 270, h: 0,
    color: item.kind === 'expert' ? '#7c3aed' : item.kind === 'skill' ? '#2563eb' : item.kind === 'connector' ? '#0ea5e9' : '#64748b',
    ref,
    tags: (item.tags || []).slice(0, 4),
    collapsed: false, locked: false, z: 0
  };
  C.nodes.push(n);
  saveData();
  broadcast('fde:canvas', C);
  return { ok: true, nodeId: n.id };
}

// ---------- 场景市场窗口 ----------
let marketWin = null;
function openMarket() {
  const a = panelArea();
  if (marketWin && !marketWin.isDestroyed()) {
    revealWindow(marketWin);
    try { marketWin.webContents.send('fde:packs'); } catch (e) {}
    return { ok: true };
  }
  const w = Math.min(1200, a.width - 60);
  const h = Math.min(880, a.height - 70);
  marketWin = new BrowserWindow({
    x: a.x + Math.round((a.width - w) / 2),
    y: a.y + Math.round((a.height - h) / 2),
    width: w, height: h,
    show: false,
    frame: false,
    backgroundColor: '#0b0f17',
    resizable: true,
    title: '场景市场',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWinPin(marketWin);
  guardWindowLoad(marketWin, '场景市场', 'market.html');
  marketWin.loadFile('market.html');
  marketWin.once('ready-to-show', () => { revealWindow(marketWin, { focus: false }); });
  marketWin.on('closed', () => { marketWin = null; });
  return { ok: true };
}

// ---------- 知识库窗口（建库 → 导入文件夹 → 检索 → 问答） ----------
let kbWin = null;
function openKb() {
  const a = panelArea();
  if (kbWin && !kbWin.isDestroyed()) {
    revealWindow(kbWin);
    return { ok: true };
  }
  const w = Math.min(1240, a.width - 60);
  const h = Math.min(900, a.height - 70);
  kbWin = new BrowserWindow({
    x: a.x + Math.round((a.width - w) / 2),
    y: a.y + Math.round((a.height - h) / 2),
    width: w, height: h,
    show: false,
    frame: false,
    backgroundColor: '#0b0f17',
    resizable: true,
    title: '知识库',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWinPin(kbWin);
  guardWindowLoad(kbWin, '知识库', 'kb.html');
  kbWin.loadFile('kb.html');
  kbWin.once('ready-to-show', () => { revealWindow(kbWin, { focus: true }); });
  kbWin.on('closed', () => { kbWin = null; });
  return { ok: true };
}

// ---------- 卖货台窗口（选品 → 文案 → 发布 → 复盘） ----------
let ecomWin = null;
function openEcom() {
  const a = panelArea();
  if (ecomWin && !ecomWin.isDestroyed()) {
    revealWindow(ecomWin);
    return { ok: true };
  }
  const w = Math.min(1180, a.width - 60);
  const h = Math.min(880, a.height - 70);
  ecomWin = new BrowserWindow({
    x: a.x + Math.round((a.width - w) / 2),
    y: a.y + Math.round((a.height - h) / 2),
    width: w, height: h,
    show: false,
    frame: false,
    backgroundColor: '#0b0f17',
    resizable: true,
    title: '卖货台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWinPin(ecomWin);
  guardWindowLoad(ecomWin, '卖货台', 'ecom.html');
  ecomWin.loadFile('ecom.html');
  ecomWin.once('ready-to-show', () => { revealWindow(ecomWin, { focus: true }); });
  ecomWin.on('closed', () => { ecomWin = null; });
  return { ok: true };
}

// ---------- 环境 / 迁移窗口 ----------
let envWin = null;
function openEnv() {
  const a = panelArea();
  if (envWin && !envWin.isDestroyed()) {
    revealWindow(envWin);
    return { ok: true };
  }
  const w = Math.min(1080, a.width - 60);
  const h = Math.min(860, a.height - 70);
  envWin = new BrowserWindow({
    x: a.x + Math.round((a.width - w) / 2),
    y: a.y + Math.round((a.height - h) / 2),
    width: w, height: h,
    show: false,
    frame: false,
    backgroundColor: '#0b0f17',
    resizable: true,
    title: '环境与迁移',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWinPin(envWin);
  // 环境页出错要能在 startup.log 里看到（这台机器导入快照后跑不起来时，排障全靠它）
  envWin.webContents.on('console-message', (e, level, message) => {
    if (level >= 1 && !/Electron Security Warning/.test(message)) slog('[env页] ' + message);
  });
  guardWindowLoad(envWin, '环境与迁移', 'env.html');
  envWin.loadFile('env.html');
  envWin.once('ready-to-show', () => { revealWindow(envWin, { focus: false }); });
  envWin.on('closed', () => { envWin = null; });
  return { ok: true };
}

// ---------- 信任中心（双方共用的台面：确认 / 验收 / 人 / 安全 / 案例 / 条款） ----------

let trustWin = null;

/** 深链：--trust-tab=home/people/evidence/security/case/terms/qa，测试与面板直达都用它 */
function trustHash() {
  const a = process.argv.find(x => x.startsWith('--trust-tab='));
  if (!a) return '';
  const tab = a.slice('--trust-tab='.length);
  // biz 是旧名字，保留兼容
  const fixed = tab === 'biz' ? 'terms' : tab;
  return ['home', 'people', 'evidence', 'security', 'case', 'terms', 'qa'].includes(fixed) ? fixed : '';
}

/**
 * 打开信任中心。tab 可以是页签名，也可以是 { view: 'fde' } 里的视角。
 * 客户和服务方用的是同一个窗口、同一份数据，只是进来看的重点不同。
 */
function openTrust(tab) {
  const a = panelArea();
  if (trustWin && !trustWin.isDestroyed()) {
    const go = tab || trustHash();
    if (go) { try { trustWin.webContents.executeJavaScript('location.hash = ' + JSON.stringify('#' + go)); } catch (e) {} }
    revealWindow(trustWin);
    return { ok: true };
  }
  const w = Math.min(1120, a.width - 50);
  const h = Math.min(880, a.height - 60);
  trustWin = new BrowserWindow({
    x: a.x + Math.round((a.width - w) / 2),
    y: a.y + Math.round((a.height - h) / 2),
    width: w, height: h,
    show: false,
    frame: false,
    backgroundColor: '#0b0f17',
    resizable: true,
    title: '信任中心',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  applyWinPin(trustWin);
  trustWin.webContents.on('console-message', (e, level, message) => {
    if (level >= 1 && !/Electron Security Warning/.test(message)) slog('[trust页] ' + message);
  });
  // 演示/交付用：--trust-role=boss 直接以客户方某个身份的视角打开
  const roleArg = process.argv.find(x => x.startsWith('--trust-role='));
  const role = roleArg ? roleArg.slice('--trust-role='.length) : '';
  const _hash = tab || trustHash();
  const _opts = {};
  if (_hash) _opts.hash = _hash;
  if (['fde', 'boss', 'operator', 'reviewer', 'it', 'finance'].includes(role)) _opts.query = { role };
  guardWindowLoad(trustWin, '信任中心', 'trust.html', _opts.query);
  trustWin.loadFile('trust.html', _opts);
  trustWin.once('ready-to-show', () => { revealWindow(trustWin, { focus: false }); });
  trustWin.on('closed', () => { trustWin = null; });
  return { ok: true };
}

/** 把一段 HTML 渲染成 PDF（离屏窗口 + printToPDF），给客户的东西要是 PDF 才正式 */
async function htmlToPdf(html, filePath) {
  const tmp = path.join(app.getPath('userData'), '.report-' + Date.now() + '.html');
  fs.writeFileSync(tmp, html, 'utf8');
  let win = null;
  try {
    win = new BrowserWindow({
      show: false,
      width: 900, height: 1200,
      webPreferences: { offscreen: true, javascript: false, contextIsolation: true, nodeIntegration: false }
    });
    await win.loadFile(tmp);
    await new Promise(r => setTimeout(r, 260)); // 等字体/布局稳定，否则中文有时只渲一半
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath, size: buf.length };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

async function pickSavePath(title, defaultName, filters) {
  const r = await dialog.showSaveDialog(panelWin, {
    title,
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
}

function stampName() {
  const d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
}
function pad2(n) { return String(n).padStart(2, '0'); }

/** 报告/案例/安全说明的统一导出：先选 pdf 或 html，再落盘 */
async function exportTrustDoc(kind, projectId, meta) {
  const facts = trust.securityFacts(data, {
    dataRoot: app.getPath('userData'),
    dataFile: dataFile(),
    dataSize: (() => { try { return fs.statSync(dataFile()).size; } catch (e) { return 0; } })(),
    mode: DATA_ROOT.mode,
    source: DATA_ROOT.source,
    appDir: __dirname,
    version: app.getVersion(),
    isAdmin: !!isAdmin
  });

  let html = '', base = '', title = '';
  if (kind === 'security') {
    html = trust.renderSecurityHtml(facts, data);
    base = 'FDE-数据处理说明-' + stampName();
    title = '导出数据处理说明（给客户 IT / 法务）';
  } else {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const ev = trust.collectEvidence(data, projectId, meta && meta.range ? meta.range : {});
    if (!ev) return { ok: false, error: '没有可用的项目数据' };
    if (kind === 'report') {
      const _l = acks.acksOf(p);
      html = trust.renderReportHtml(ev, Object.assign({
        isAdmin: !!isAdmin,
        acks: _l,
        ackStats: acks.ackStats(_l)
      }, meta || {}));
      base = 'FDE-验收报告-' + p.name.replace(/[\\/:*?"<>|]/g, '_') + '-' + stampName();
      title = '导出交付与验收报告（客户签字用）';
    } else if (kind === 'case') {
      html = trust.renderCaseHtml(ev, meta || {});
      base = 'FDE-案例-' + p.name.replace(/[\\/:*?"<>|]/g, '_') + '-' + stampName();
      title = '导出案例卡（脱敏后对外）';
    } else {
      return { ok: false, error: '未知的文档类型' };
    }
  }

  const filePath = await pickSavePath(title, base + '.pdf', [
    { name: 'PDF 文档', extensions: ['pdf'] },
    { name: '网页（可在浏览器打开/打印）', extensions: ['html'] }
  ]);
  if (!filePath) return { ok: false, canceled: true };

  try {
    if (/\.html?$/i.test(filePath)) {
      fs.writeFileSync(filePath, html, 'utf8');
      addLog('已导出文档：' + path.basename(filePath), projectId || null);
      return { ok: true, path: filePath, type: 'html' };
    }
    const r = await htmlToPdf(html, filePath);
    addLog('已导出文档：' + path.basename(filePath) + '（' + Math.round(r.size / 1024) + ' KB）', projectId || null);
    return Object.assign({ type: 'pdf' }, r);
  } catch (e) {
    slog('[导出失败] ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ---------- 推进（人）：已并入信任中心「人与角色」页 ----------
// 以前这里是独立窗口。但客户和服务方看的是同一批人、同一份口径、同一套文件，
// 分两个窗口维护会立刻出现两份真相。现在只保留一个入口，转发到信任中心。

function openAdopt() {
  return openTrust('people');
}

function adoptRender(kind, projectId) {
  const p = data.projects.find(x => x.id === projectId);
  if (!p) return null;
  const ev = trust.collectEvidence(data, projectId, {});
  const calc = adopt.computeAdoption(ev, p.adoption || {});
  if (kind === 'boss') return adopt.renderBossBrief(ev, p.adoption || {}, calc);
  if (kind === 'operator') return adopt.renderOperatorBrief(ev, p.adoption || {}, calc);
  if (kind === 'reviewer') return adopt.renderReviewerNote(ev, p.adoption || {}, calc);
  return null;
}

async function exportAdoptDoc(kind, projectId) {
  const p = data.projects.find(x => x.id === projectId);
  if (!p) return { ok: false, error: '项目不存在' };
  const html = adoptRender(kind, projectId);
  if (!html) return { ok: false, error: '未知文档类型' };
  const label = { boss: '决策简报', operator: '操作员说明', reviewer: '审核清单' }[kind] || kind;
  const safe = p.name.replace(/[\\/:*?"<>|]/g, '_');
  const filePath = await pickSavePath('导出' + label + '（给' + ({ boss: '老板', operator: '操作员', reviewer: '审核员' }[kind] || '对方') + '看的）',
    'FDE-' + label + '-' + safe + '-' + stampName() + '.pdf', [
    { name: 'PDF 文档', extensions: ['pdf'] },
    { name: '网页（可编辑后打印）', extensions: ['html'] }
  ]);
  if (!filePath) return { ok: false, canceled: true };
  try {
    if (/\.html?$/i.test(filePath)) {
      fs.writeFileSync(filePath, html, 'utf8');
      addLog('已导出' + label + '：' + path.basename(filePath), projectId);
      return { ok: true, path: filePath, type: 'html' };
    }
    const r = await htmlToPdf(html, filePath);
    addLog('已导出' + label + '：' + path.basename(filePath), projectId);
    return Object.assign({ type: 'pdf' }, r);
  } catch (e) {
    slog('[导出失败] ' + e.message);
    return { ok: false, error: e.message };
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('data:get', () => snapshot());

  // 通用复制：生僻字、特殊符号在输入法里打不出来时，用复制代替手打
  ipcMain.handle('app:copy-text', (e, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  // 飞行记录仪：渲染进程把关键事件（脚本是否跑完/报错/点击有没有进来）落盘。
  // 真机上"点了没反应"这类问题，页面看上去正常但 JS 可能根本没跑 —— 靠它拿到第一手证据。
  ipcMain.handle('diag:log', (e, text) => {
    try {
      const src = e && e.sender ? (e.sender.getURL() || '').split('/').pop() : 'unknown';
      const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] [' + src + '] ' + String(text == null ? '' : text).slice(0, 400);
      fs.appendFileSync(path.join(app.getPath('userData'), 'renderer.log'), line + '\n');
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // 读剪贴板：密钥这类长串，不让用户手打
  ipcMain.handle('app:paste-text', () => {
    try { return { ok: true, text: clipboard.readText() || '' }; } catch (e) { return { ok: false, error: e.message }; }
  });
  // ---- 工作流画布 ----
  ipcMain.handle('canvas:get', async () => {
    const list = await enumWindows();
    const wins = [];
    for (const w of list) {
      const rec = winRecs.get(w.hwnd);
      if (!rec) continue;
      if (!w.vis && !w.iconic) continue;
      wins.push({ hwnd: w.hwnd, title: w.title, proc: w.proc, owner: rec.owner });
    }
    return {
      ok: true,
      canvas: data.canvas,
      windows: wins.slice(0, 200),
      projects: data.projects.map(p => ({
        id: p.id, name: p.name, color: p.color, status: p.status,
        windowsCount: p.windowsCount || 0,
        autorun: (p.autorun || []).length,
        context: (p.context || []).length,
        items: (p.items || []).map(i => ({ id: i.id, name: i.name, path: i.path || '' }))
      })),
      activeId
    };
  });

  ipcMain.handle('canvas:save', (e, payload) => {
    try {
      data.canvas = normalizeCanvas(payload || {});
      saveData();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('canvas:run-node', async (e, nodeId) => {
    const n = canvasNode(nodeId);
    if (!n) return { ok: false, error: '节点不存在' };
    try {
      const r = await runCanvasNode(n);
      return { ok: r.ok !== false, msg: r.msg || '', error: r.ok === false ? (r.msg || '执行失败') : '' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('canvas:run-flow', async (e, nodeId) => {
    let seq;
    if (nodeId === '__all__') {
      seq = fullFlowOrder();
    } else {
      const n = canvasNode(nodeId);
      if (!n) return { ok: false, error: '节点不存在' };
      if (n.type === 'group') {
        // 分组当作"阶段"：组内节点按从左到右、从上到下的顺序执行，再顺着出边继续
        const inner = groupMembers(n).sort((a, b) => (a.x - b.x) || (a.y - b.y));
        const tail = flowOrder(nodeId).filter(x => x.id !== nodeId && !inner.some(i => i.id === x.id));
        seq = [...inner, ...tail];
      } else {
        seq = flowOrder(nodeId);
      }
    }
    if (!seq.length) return { ok: false, error: '没有可执行的节点' };
    const results = [];
    for (const item of seq) {
      if (item.type === 'note' || item.type === 'group') { results.push({ id: item.id, ok: true, skipped: true }); continue; }
      broadcast('fde:canvas-run', { id: item.id, status: 'run' });
      let r = { ok: false, msg: '' };
      try { r = await runCanvasNode(item); } catch (err) { r = { ok: false, msg: err.message }; }
      results.push({ id: item.id, ok: r.ok !== false, msg: r.msg || '', title: item.title });
      broadcast('fde:canvas-run', { id: item.id, status: r.ok === false ? 'err' : 'ok', msg: r.msg || '' });
      const keepGoing = item.ref && item.ref.continueOnError;
      if (r.ok === false && !keepGoing) break;
      await sleep(400);
    }
    // 若流程里含 AI 节点，自动汇总上下文（取最靠后的那个）
    const aiNodes = seq.filter(x => x.type === 'ai');
    const last = aiNodes[aiNodes.length - 1];
    if (last) {
      clipboard.writeText(buildContextPrompt(last.id));
      broadcast('fde:canvas-run', { id: last.id, status: 'ok', msg: '提示词已复制到剪贴板' });
    }
    addLog('[画布] 流程执行完成：' + results.filter(r => !r.skipped).length + ' 步，失败 ' +
      results.filter(r => !r.ok).length + ' 步', (canvasNode(nodeId) || {}).ref && canvasNode(nodeId).ref.projectId);
    return { ok: results.every(r => r.ok), results };
  });

  ipcMain.handle('canvas:prompt', (e, nodeId) => {
    try {
      const r = promptForNode(nodeId, true);
      clipboard.writeText(r.text);
      addLog('[画布] 已复制工作上下文 · ' + r.chars + ' 字 ≈ ' + r.tokens + ' token' +
        (r.cached ? '（缓存命中）' : ''), (canvasNode(nodeId) || {}).ref && canvasNode(nodeId).ref.projectId);
      return { ok: true, length: r.chars, text: r.text, tokens: r.tokens, cached: r.cached, budget: r.budget };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 预估某个节点交给模型要花多少：不改任何东西，只算账
  ipcMain.handle('canvas:budget', (e, nodeId) => {
    try {
      const text = buildContextPrompt(nodeId, { lean: true });
      const full = buildContextPrompt(nodeId, { lean: false });
      return {
        ok: true,
        lean: { chars: text.length, tokens: runtime.estTokens(text) },
        full: { chars: full.length, tokens: runtime.estTokens(full) }
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('canvas:pick', async (e, kind) => {
    const props = kind === 'folder' ? ['openDirectory'] : ['openFile'];
    const r = await dialog.showOpenDialog({
      title: '选择' + (kind === 'folder' ? '文件夹' : '文件'),
      properties: props.concat(['showHiddenFiles'])
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  });

  // ---- 画布导出 / 导入（换电脑、备份、团队共享）----
  ipcMain.handle('canvas:export-json', async () => {
    const r = await dialog.showSaveDialog({
      title: '导出工作流画布',
      defaultPath: path.join(app.getPath('documents'), 'FDE-工作流-' + stampName() + '.json'),
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify({
        app: 'FDE Manager', kind: 'canvas', version: 1,
        exportedAt: new Date().toISOString(), canvas: data.canvas
      }, null, 2), 'utf8');
      addLog('[画布] 已导出: ' + r.filePath);
      return { ok: true, path: r.filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('canvas:export-md', async () => {
    const r = await dialog.showSaveDialog({
      title: '导出工作流说明（Markdown）',
      defaultPath: path.join(app.getPath('documents'), 'FDE-工作流说明-' + stampName() + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try {
      const md = buildCanvasMarkdown();
      fs.writeFileSync(r.filePath, md, 'utf8');
      clipboard.writeText(md);
      addLog('[画布] 已导出说明文档（同时复制到剪贴板）: ' + r.filePath);
      return { ok: true, path: r.filePath };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('canvas:import-json', async (e, mode) => {
    const r = await dialog.showOpenDialog({
      title: '导入工作流画布',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try {
      const parsed = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const inc = normalizeCanvas(parsed && parsed.canvas ? parsed.canvas : parsed);
      if (!inc.nodes.length) return { ok: false, error: '文件里没有节点' };
      if (mode === 'replace') {
        data.canvas = inc;
      } else {
        const uid = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 10000);
        const map = new Map();
        const off = 60 + (data.canvas.nodes.length ? 40 : 0);
        for (const n of inc.nodes) {
          const nid = uid('n');
          map.set(n.id, nid);
          data.canvas.nodes.push(Object.assign({}, n, { id: nid, x: n.x + off, y: n.y + 40 }));
        }
        for (const ed of inc.edges) {
          if (!map.has(ed.from) || !map.has(ed.to)) continue;
          data.canvas.edges.push(Object.assign({}, ed, { id: uid('e'), from: map.get(ed.from), to: map.get(ed.to) }));
        }
      }
      saveData();
      broadcast('fde:canvas', data.canvas);
      return { ok: true, count: inc.nodes.length };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('canvas:clear', () => {
    data.canvas = emptyCanvas();
    saveData();
    broadcast('fde:canvas', data.canvas);
    return { ok: true };
  });

  // ---- 项目上下文 ----
  ipcMain.handle('ctx:add', (e, { projectId, ctx }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const kind = String(ctx && ctx.kind || 'text');
    const title = String(ctx && ctx.title || '').trim();
    const value = String(ctx && ctx.value || '').trim();
    if (!title && !value) return { ok: false, error: '标题和内容不能都为空' };
    const item = {
      id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      kind, title: title || value.slice(0, 40), value,
      note: String(ctx && ctx.note || ''),
      at: Date.now()
    };
    p.context.push(item);
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true, item };
  });

  ipcMain.handle('ctx:remove', (e, { projectId, id }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.context = (p.context || []).filter(c => c.id !== id);
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true };
  });

  ipcMain.handle('ctx:update', (e, { projectId, id, patch }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const c = (p.context || []).find(x => x.id === id);
    if (!c) return { ok: false, error: '材料不存在' };
    Object.assign(c, patch || {});
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true };
  });

  ipcMain.handle('ctx:pack', (e, projectId) => {
    const text = buildProjectContextPack(projectId);
    if (text === null) return { ok: false, error: '项目不存在' };
    clipboard.writeText(text);
    addLog('[上下文] 已导出上下文包到剪贴板（' + text.length + ' 字）', projectId);
    return { ok: true, length: text.length, text };
  });

  ipcMain.handle('panel:toggle-pin', () => {
    if (!panelWin) return { ok: false };
    const next = !panelWin.isAlwaysOnTop();
    panelWin.setAlwaysOnTop(next);
    return { ok: true, pinned: next };
  });

  // 功能窗口（能力 / 知识库 / 卖货台 / 项目设置 / 内置网页）是否浮在最前，默认关
  ipcMain.handle('win:pin-get', () => ({ ok: true, pinned: winPinOn() }));
  ipcMain.handle('win:pin-set', (e, val) => {
    data.settings.winPin = !!val;
    saveData();
    const all = [appsWin, marketWin, kbWin, ecomWin, envWin, trustWin, siteWin];
    for (const w of projectPanels.values()) all.push(w);
    for (const w of all) applyWinPin(w);
    addLog(data.settings.winPin ? '功能窗口已设为置顶（会挡住下面的页面，可再关掉）' : '功能窗口已取消置顶，可以和浏览器等其它窗口正常切换');
    return { ok: true, pinned: winPinOn() };
  });
  ipcMain.handle('panel:minimize', () => { if (panelWin) panelWin.minimize(); return { ok: true }; });
  ipcMain.handle('panel:quit', () => { app.quit(); return { ok: true }; });

  // 以管理员身份重启（用于隔离管理员权限的程序）
  ipcMain.handle('app:relaunch-admin', async () => {
    addLog('请求以管理员身份重启（等待 UAC 确认）');
    const r = await relaunchElevated();
    if (r.ok) {
      setTimeout(() => app.quit(), 600);
      return { ok: true };
    }
    addLog('管理员权限获取失败: ' + (r.error || '已取消'));
    return { ok: false, error: r.error || '已取消' };
  });

  ipcMain.handle('app:admin-state', () => ({ isAdmin }));

  ipcMain.handle('settings:admin-auto', (e, val) => {
    data.settings.needAdmin = !!val;
    saveData();
    return { ok: true, needAdmin: data.settings.needAdmin };
  });

  // 桌面切换（真实切换：隐藏/显示窗口 + 换壁纸）
  ipcMain.handle('desktop:switch', async (e, { target }) => {
    try {
      return await switchDesktop(target);
    } catch (err) {
      console.error('切换桌面异常:', err);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('desktop:original', () => switchDesktop('original'));
  ipcMain.handle('desktop:current', () => ({ activeId }));

  ipcMain.handle('overview:open', (e, payload) => openSwitcher(
    (payload && payload.view) || '',
    (payload && payload.projectId) || ''
  ));
  ipcMain.handle('overview:close', () => { closeSwitcher(); return { ok: true }; });

  // 项目窗口归属
  ipcMain.handle('windows:list', async (e, projectId) => {
    await collect(activeId);
    persistOwners();
    const live = await enumWindows();
    const visMap = new Map(live.map(w => [w.hwnd, !!(w.vis && !w.iconic)]));
    const mine = [];
    const others = [];
    for (const rec of winRecs.values()) {
      const item = {
        hwnd: rec.hwnd, proc: rec.proc, title: rec.title,
        owner: rec.owner, exe: rec.exe || '',
        vis: !!visMap.get(rec.hwnd),
        onCurrentDesktop: isVisibleOnTarget(rec)
      };
      if (rec.owner === projectId) mine.push(item);
      else others.push(item);
    }
    return { ok: true, mine, others };
  });

  // 找回本桌面的窗口：把"属于当前桌面却没显示"的窗口强制叫出来
  ipcMain.handle('desktop:reshow', async () => {
    const r = await applyVisibility({ forceShowOwned: true });
    refreshStatuses(true);
    addLog('找回本桌面窗口：显示 ' + r.shown + ' 个' +
      (lastMissing.length ? '，仍有 ' + lastMissing.length + ' 个没出来（点「为什么没显示」看原因）' : ''), activeId);
    broadcast('fde:desktop', desktopPayload());
    return { ok: true, shown: r.shown, hidden: r.hidden, missing: lastMissing.length };
  });

  // 诊断：本桌面"应该显示却没显示"的窗口，逐个给原因（不是只有一句"失败了"）
  // 截屏：抓鼠标所在屏幕，JPEG 压缩后回 dataURL（搭台对话发图用）
  ipcMain.handle('screen:capture', async () => {
    try {
      const cur = screen.getCursorScreenPoint();
      const disp = screen.getDisplayNearestPoint(cur);
      const scale = disp.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(disp.size.width * scale), height: Math.round(disp.size.height * scale) }
      });
      if (!sources.length) return { ok: false, error: '没找到可截的屏幕' };
      let src = sources.find(x => String(x.display_id || '') === String(disp.id || '')) || sources[0];
      const img = src.thumbnail;
      if (!img || img.isEmpty()) return { ok: false, error: '截图内容为空' };
      const dataUrl = img.toJPEG(80).toString('base64');
      return { ok: true, dataUrl: 'data:image/jpeg;base64,' + dataUrl, bytes: img.toJPEG(80).length };
    } catch (e) {
      return { ok: false, error: '截图失败：' + e.message };
    }
  });
  ipcMain.handle('diag:stats', () => {
    const whyCount = {};
    for (const rec of winRecs.values()) {
      const k = rec.lastWhy || 'ok';
      whyCount[k] = (whyCount[k] || 0) + 1;
    }
    const errLogs = (data.logs || []).filter(l => /失败|错误|叫不出来|异常|err:/i.test(l.text || '')).slice(0, 20);
    let crash = '';
    try { crash = fs.readFileSync(path.join(app.getPath('userData'), 'logs', 'main-error.log'), 'utf8').slice(-2000); } catch (e) {}
    return {
      ok: true,
      uptime: Math.round(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
      version: app.getVersion ? (() => { try { return app.getVersion(); } catch (e) { return ''; } })() : '',
      windows: { total: winRecs.size, whyCount },
      uncontrolled: uncontrollable.size,
      errLogs,
      crash
    };
  });
  ipcMain.handle('desktop:diag', async () => {
    await collect(activeId);
    const list = await enumWindows();
    const union = displayUnion();
    const byHwnd = new Map(list.map(w => [w.hwnd, w]));
    const rows = [];
    for (const rec of winRecs.values()) {
      if (!isVisibleOnTarget(rec)) continue;
      const w = byHwnd.get(rec.hwnd);
      let reason = 'ok';
      if (!w) reason = 'not-enumerated';
      else if (uncontrollable.has(rec.hwnd)) reason = 'uncontrollable';
      else if (desktop.isOffscreen(w.x, w.y, union)) reason = 'parked';
      else if (!w.vis && w.cloaked) reason = 'cloaked';
      else if (!w.vis) reason = rec.lastWhy || 'not-visible';
      else if (w.iconic) reason = 'minimized';
      rows.push({
        hwnd: rec.hwnd, proc: rec.proc, title: rec.title, owner: rec.owner,
        reason, vis: !!w && w.vis, iconic: !!w && w.iconic,
        hiddenByUs: !!rec.hiddenByUs
      });
    }
    const NOTICE = new Set(['parked', 'show-failed', 'uncontrollable', 'cloaked', 'hidden-by-us', 'not-enumerated']);
    return {
      ok: true, activeId,
      total: rows.length,
      rows,
      missing: rows.filter(r => NOTICE.has(r.reason))
    };
  });

  // 一键修复：把本桌面在屏幕外的窗口搬回来 + 强制显示（含托盘隐藏/被别处抢走焦点的）
  ipcMain.handle('desktop:repair', async () => {
    const list = await enumWindows();
    const union = displayUnion();
    const home = rescueHome();
    let moved = 0;
    for (const w of list) {
      const rec = winRecs.get(w.hwnd);
      if (!rec || !isVisibleOnTarget(rec)) continue;
      if (uncontrollable.has(w.hwnd)) continue;
      if (!desktop.isOffscreen(w.x, w.y, union)) continue;
      const to = rec.savedRect || home;
      await winCmd('MOVE|' + w.hwnd + '|' + Math.round(to.x) + '|' + Math.round(to.y));
      rec.savedRect = { x: Math.round(to.x), y: Math.round(to.y) };
      moved++;
    }
    const r = await applyVisibility({ forceShowOwned: true });
    await collect(activeId);
    persistOwners();
    refreshStatuses(true);
    broadcast('fde:desktop', desktopPayload());
    addLog('修复本桌面窗口：搬回 ' + moved + ' 个，显示 ' + r.shown + ' 个' +
      (lastMissing.length ? '，仍有 ' + lastMissing.length + ' 个没出来' : ''), activeId);
    return { ok: true, moved, shown: r.shown, missing: lastMissing.length };
  });

  ipcMain.handle('windows:assign', async (e, { projectId, hwnd }) => {
    const rec = winRecs.get(Number(hwnd));
    if (!rec) return { ok: false, error: '窗口已关闭，请刷新' };
    const target = projectId === '__orig' ? null : projectId;
    // 同一个软件的所有进程/窗口一起搬家（这是"自动分析"而不是逐个窗口手动指定）
    moveAppTo(rec, target);
    persistOwners();
    await applyVisibility({ forceShowOwned: true });
    refreshStatuses(true);
    const p = data.projects.find(x => x.id === target);
    addLog('窗口归属 [' + (p ? p.name : '原电脑桌面') + '] ← ' + rec.proc +
      ' · ' + String(rec.title || '').slice(0, 40), target);
    return { ok: true };
  });

  ipcMain.handle('windows:rescan', async () => {
    const added = await collect(activeId);
    persistOwners();
    refreshStatuses(true);
    return { ok: true, added: added.length };
  });

  // 壁纸
  ipcMain.handle('wallpaper:regen', async (e, projectId) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const f = wallpaperFile(p);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (err) {}
    const file = await ensureWallpaper(p);
    if (activeId === projectId) await applyWallpaper(p);
    return { ok: !!file };
  });
  ipcMain.handle('wallpaper:toggle', (e, val) => {
    data.settings.wallpaper = !!val;
    saveData();
    broadcast("fde:desktop", desktopPayload());
    return { ok: true };
  });

  // 项目 CRUD
  ipcMain.handle('project:add', (e, payload) => {
    // 兼容两种调用：旧的面板传字符串；新向导传 { name, opts:{ direction } }
    const isObj = payload && typeof payload === 'object';
    const n = String((isObj ? payload.name : payload) || '').trim();
    const opts = (isObj && payload.opts) || {};
    if (!n) return { ok: false, error: '项目名不能为空' };
    if (data.projects.some(p => p.name === n)) return { ok: false, error: '已经有同名项目了' };
    const p = {
      id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      name: n,
      direction: String(opts.direction || '').trim().slice(0, 500),
      color: COLORS[data.projects.length % COLORS.length],
      status: 'stopped',
      statusMsg: '空桌面',
      exclusive: true,
      approvals: {},
      items: [],
      autorun: [],
      windows: []
    };
    data.projects.push(p);
    saveData();
    broadcast('fde:projects', data.projects);
    addLog('新建项目: ' + n + (p.direction ? '（方向：' + p.direction.slice(0, 40) + '）' : ''));
    return { ok: true, project: p };
  });

  // 项目方向：这个项目要做什么。AI 搭能力、画布 AI 节点都靠它当上下文
  ipcMain.handle('project:set-direction', (e, payload) => {
    const p = data.projects.find(x => x.id === (payload && payload.id));
    if (!p) return { ok: false, error: '项目不存在' };
    p.direction = String((payload && payload.text) || '').trim().slice(0, 500);
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true, direction: p.direction };
  });

  /**
   * 按这个项目的方向搭能力：只产出画布节点（AI 智能体 / 网页 / 笔记），
   * 绝不新建项目、不动别的项目 —— 项目设置里点一下就能长出这条流水线。
   */
  ipcMain.handle('project:build-agents', async (e, payload) => {
    const p = data.projects.find(x => x.id === (payload && payload.id));
    if (!p) return { ok: false, error: '项目不存在' };
    const requirement = String((payload && payload.requirement) || '').trim() || String(p.direction || '').trim();
    if (!requirement) return { ok: false, error: '先写一句这个项目的方向（要做什么），再让 AI 搭' };
    const cfg = aiConfig();
    if (!cfg.apiKey || !cfg.model) {
      return { ok: false, error: '还没接算力：先去「应用功能 → ⚡ 模型设置」填密钥' };
    }
    const req = [
      '只给下面这一个项目搭能力，不要新建任何项目（“项目”数组必须是空数组 []）。',
      '项目名：' + p.name,
      '项目方向：' + requirement,
      '要求：节点只允许 AI / 网页 / 笔记 三种，最多 6 个；每个节点的“项目名”都写「' + p.name + '」；',
      'AI 节点是这个项目里能干活的智能体（例如“订单日报分析”），说明里写清输入、处理、输出；',
      '网页节点放这个项目真正要用的系统；连线按 取数 → 加工 → 产出 的顺序。'
    ].join('\n');
    const msgs = builder.buildPrompt([p], data.canvas, req);
    say('按方向给「' + p.name + '」搭能力…');
    const res = await aiChatCounted(cfg, { messages: msgs, maxTokens: 2600, temperature: 0.3, purpose: 'build' }, { timeout: 150000 });
    if (!res.ok) return { ok: false, error: '模型调用失败：' + res.error };
    const parsed = builder.parsePlan(res.text);
    if (!parsed.ok) return { ok: false, error: parsed.error, raw: res.text.slice(0, 300) };
    const plan = parsed.plan;
    plan.项目 = [];
    plan.脚本 = [];
    if (Array.isArray(plan.节点)) {
      plan.节点 = plan.节点.slice(0, 6)
        .filter(n => n && ['AI', '网页', '笔记'].includes(String(n.类型 || '').trim()))
        .map(n => Object.assign({}, n, { 项目名: p.name }));
    }
    const r = builder.applyPlan(data, plan, { scriptRoot: userPackScriptsDir() });
    saveData();
    broadcast('fde:projects', data.projects);
    broadcast('fde:canvas', data.canvas);
    const summary = builder.summarize(r);
    say(summary);
    return {
      ok: true, summary, created: r.created, errors: r.errors,
      note: String(plan.说明 || '').slice(0, 200),
      tokens: ((res.usage || {}).total_tokens) || 0
    };
  });

  ipcMain.handle('project:copy', (e, id) => {
    const src = data.projects.find(x => x.id === id);
    if (!src) return { ok: false, error: '项目不存在' };
    const p = JSON.parse(JSON.stringify(src));
    p.id = 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    p.name = src.name + ' - 副本';
    p.color = COLORS[data.projects.length % COLORS.length];
    p.status = 'stopped';
    p.statusMsg = '空桌面';
    p.windows = [];
    data.projects.push(p);
    saveData();
    broadcast('fde:projects', data.projects);
    addLog('复制项目: ' + src.name + ' → ' + p.name, p.id);
    return { ok: true, project: p };
  });

  ipcMain.handle('project:remove', (e, { id, verify }) => {
    const p = data.projects.find(x => x.id === id);
    if (!p) return { ok: false, error: '项目不存在' };
    if (String(verify || '').trim() !== p.name) {
      return { ok: false, error: '验证信息不正确：请输入项目名「' + p.name + '」' };
    }
    // 释放它的窗口（放回原电脑桌面）
    for (const rec of winRecs.values()) if (rec.owner === id) rec.owner = null;
    closeProjectPanel(id);
    if (activeId === id) activeId = null;
    data.projects = data.projects.filter(x => x.id !== id);
    data.flows = data.flows.filter(f => f.from !== id && f.to !== id);
    delete data.inbox[id];
    data.trash.unshift({ project: p, deletedAt: Date.now() });
    if (data.trash.length > 50) data.trash = data.trash.slice(0, 50);
    persistOwners();
    saveData();
    broadcast('fde:projects', data.projects);
    broadcast('fde:trash', data.trash);
    broadcast('fde:flows', data.flows);
    applyVisibility().then(() => refreshStatuses(true));
    addLog('项目已移入回收站: ' + p.name);
    return { ok: true };
  });

  // 打开项目 = 切换到该项目桌面；同时可打开控制面板
  ipcMain.handle('project:open', async (e, id) => {
    try {
      const r = await switchDesktop(id);
      if (r.ok) openProjectPanel(id);
      return r;
    } catch (err) {
      console.error('project:open 异常:', err);
      addLog('打开项目异常: ' + err.message);
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('project:open-panel', (e, id) => openProjectPanel(id));
  ipcMain.handle('project:close-panel', (e, id) => closeProjectPanel(id));

  // 自动打开：支持「程序/脚本」和「网页」
  ipcMain.handle('autorun:add', (e, payload) => {
    const p = data.projects.find(x => x.id === (payload && payload.projectId));
    if (!p) return { ok: false, error: '项目不存在' };

    if (payload.type === 'url') {
      let url = String(payload.url || '').trim();
      if (!url) return { ok: false, error: '网址不能为空' };
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = 'https://' + url;
      const it = {
        id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
        type: 'url',
        url,
        browserPath: String(payload.browserPath || ''),
        browserName: String(payload.browserName || ''),
        name: String(payload.name || '').trim() || url.replace(/^https?:\/\//, '')
      };
      p.autorun.push(it);
      saveData();
      broadcast('fde:projects', data.projects);
      addLog('添加网页: [' + p.name + '] ' + url +
        (it.browserName ? '（' + it.browserName + '）' : '（默认浏览器）'), p.id);
      return { ok: true, item: it };
    }

    const ph = String(payload.path || '').trim();
    if (!ph) return { ok: false, error: '程序路径不能为空' };
    const it = {
      id: 'a' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      type: 'app',
      path: ph,
      name: path.basename(ph).replace(/\.[^.]+$/, ''),
      args: String(payload.args || '').trim()
    };
    p.autorun.push(it);
    saveData();
    broadcast('fde:projects', data.projects);
    addLog('添加自动打开: [' + p.name + '] ' + ph, p.id);
    return { ok: true, item: it };
  });

  ipcMain.handle('browsers:list', async () => {
    if (!browserCache || Date.now() - browserCache.at > 120000) {
      const list = await detectBrowsers();
      browserCache = { at: Date.now(), list };
    }
    return { ok: true, list: browserCache.list };
  });

  ipcMain.handle('autorun:remove', (e, { projectId, itemId }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.autorun = p.autorun.filter(i => i.id !== itemId);
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true };
  });

  ipcMain.handle('autorun:run', (e, projectId) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    runAutorun(p);
    return { ok: true };
  });

  // 重启项目：关闭项目内所有程序并按「自动打开」重新启动
  ipcMain.handle('project:restart', async (e, projectId) => {
    try {
      return await restartProject(projectId);
    } catch (err) {
      console.error('重启项目异常:', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('autorun:browse', async () => {
    const r = await dialog.showOpenDialog(panelWin, {
      title: '选择要自动打开的程序或脚本',
      properties: ['openFile'],
      filters: [{ name: '程序与脚本', extensions: ['exe', 'bat', 'cmd', 'ps1', 'py', 'lnk', '*'] }, { name: '所有文件', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('exclusive:set', (e, { projectId, val }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.exclusive = !!val;
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true };
  });

  // 回收站
  ipcMain.handle('trash:restore', (e, id) => {
    const idx = data.trash.findIndex(t => t.project.id === id);
    if (idx < 0) return { ok: false, error: '回收站中不存在该项目' };
    const p = data.trash[idx].project;
    data.trash.splice(idx, 1);
    p.status = 'stopped';
    p.statusMsg = '空桌面';
    data.projects.push(p);
    saveData();
    broadcast('fde:projects', data.projects);
    broadcast('fde:trash', data.trash);
    addLog('从回收站恢复项目: ' + p.name + '（原流程联动需重新建立）');
    return { ok: true };
  });

  ipcMain.handle('trash:purge', (e, id) => {
    const idx = data.trash.findIndex(t => t.project.id === id);
    if (idx < 0) return { ok: false, error: '回收站中不存在该项目' };
    const name = data.trash[idx].project.name;
    data.trash.splice(idx, 1);
    saveData();
    broadcast('fde:trash', data.trash);
    addLog('已彻底删除项目: ' + name);
    return { ok: true };
  });

  // 流程联动 + 提示（存在数据里的收件箱，不依赖窗口是否打开）
  ipcMain.handle('flow:add', (e, { from, to, label }) => {
    if (from === to) return { ok: false, error: '不能指向同一个项目' };
    const a = data.projects.find(p => p.id === from);
    const b = data.projects.find(p => p.id === to);
    if (!a || !b) return { ok: false, error: '项目不存在' };
    const flow = { id: 'f' + Date.now().toString(36), from, to, label: String(label || '联动').trim() || '联动' };
    data.flows.push(flow);
    saveData();
    broadcast('fde:flows', data.flows);
    addLog('建立流程: ' + a.name + ' → ' + b.name + ' (' + flow.label + ')');
    return { ok: true, flow };
  });

  ipcMain.handle('flow:remove', (e, id) => {
    data.flows = data.flows.filter(f => f.id !== id);
    saveData();
    broadcast('fde:flows', data.flows);
    return { ok: true };
  });

  ipcMain.handle('hint:send', (e, { fromId, flowId, text }) => {
    // flowId 可以是旧的「流程联动」id，也可以直接是目标项目 id（画布交接线用这种）
    const flow = data.flows.find(f => f.id === flowId);
    const toId = flow ? flow.to : (data.projects.some(p => p.id === flowId) ? flowId : null);
    if (!toId) return { ok: false, error: '目标项目不存在（连线的目标节点要绑定项目）' };
    if (flow && fromId && flow.from !== fromId) return { ok: false, error: '没有授权的流程，无法发送' };
    if (fromId && toId === fromId) return { ok: false, error: '不能发给自己' };
    const fromP = data.projects.find(p => p.id === fromId);
    const toP = data.projects.find(p => p.id === toId);
    if (!toP) return { ok: false, error: '目标项目不存在' };
    const msg = {
      fromName: fromP ? fromP.name : '工作流画布',
      fromId: fromId || null,
      flowLabel: flow ? flow.label : '画布交接',
      text: String(text || ''),
      time: Date.now()
    };
    if (!data.inbox[toId]) data.inbox[toId] = [];
    data.inbox[toId].unshift(msg);
    if (data.inbox[toId].length > 50) data.inbox[toId] = data.inbox[toId].slice(0, 50);
    if (fromP) {
      fromP.status = 'task';
      fromP.statusMsg = '任务中：已发送提示待响应';
    }
    saveData();
    broadcast('fde:projects', data.projects);
    broadcast('fde:inbox', { projectId: toId, msgs: data.inbox[toId] });
    addLog('提示: ' + (fromP ? fromP.name : '画布') + ' → ' + toP.name + ' : ' + msg.text.slice(0, 60), fromId || null);
    return { ok: true };
  });

  ipcMain.handle('inbox:clear', (e, { projectId, time }) => {
    const list = data.inbox[projectId] || [];
    data.inbox[projectId] = time ? list.filter(m => m.time !== time) : [];
    const p = data.projects.find(x => x.id === projectId);
    if (p && p.status === 'task' && !(data.inbox[projectId] || []).length) {
      p.status = 'stopped';
      p.statusMsg = '';
    }
    saveData();
    refreshStatuses(true);
    broadcast('fde:inbox', { projectId, msgs: data.inbox[projectId] || [] });
    return { ok: true };
  });

  ipcMain.handle('project:set-status', (e, { projectId, status, msg }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const allowed = ['running', 'task', 'error', 'stopped', 'background'];
    if (!allowed.includes(status)) return { ok: false, error: '无效状态: ' + status };
    p.status = status;
    p.statusMsg = String(msg || '');
    saveData();
    broadcast('fde:projects', data.projects);
    addLog('状态变更: [' + p.name + '] ' + status + (p.statusMsg ? ' - ' + p.statusMsg : ''), projectId);
    return { ok: true };
  });

  // 功能模块 / 脚本占位
  ipcMain.handle('item:add', (e, { projectId, item }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const kind = item && item.kind === 'script' ? 'script' : 'module';
    const name = String(item && item.name || '').trim();
    if (!name) return { ok: false, error: '名称不能为空' };
    const it = { id: 'i' + Date.now().toString(36) + Math.floor(Math.random() * 1000), kind, name };
    // 脚本可绑定真实文件路径（.ps1 / .py / .bat / .cmd / .js）
    if (kind === 'script' && item.path) it.path = String(item.path);
    p.items.push(it);
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true, item: it };
  });

  ipcMain.handle('item:remove', (e, { projectId, itemId }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.items = p.items.filter(i => i.id !== itemId);
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true };
  });

  // 运行脚本项（真实执行，输出写项目日志）
  ipcMain.handle('item:run', async (e, { projectId, itemId }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const it = (p.items || []).find(i => i.id === itemId);
    if (!it) return { ok: false, error: '找不到该模块/脚本' };
    if (it.kind !== 'script') return { ok: false, error: '功能模块暂不支持运行（请添加脚本）' };
    return runScriptItem(p, it);
  });

  // 自动打开项：网页换浏览器（不用删掉重加）
  ipcMain.handle('autorun:setbrowser', (e, { projectId, itemId, browserPath, browserName }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const a = (p.autorun || []).find(i => i.id === itemId);
    if (!a) return { ok: false, error: '找不到自动打开项' };
    if (a.type !== 'url') return { ok: false, error: '只有网页项能指定浏览器' };
    const bp = String(browserPath || '');
    if (bp) {
      let exists = false;
      try { exists = fs.existsSync(bp); } catch (err) {}
      if (!exists) return { ok: false, error: '这个浏览器找不到了：' + bp };
    }
    a.browserPath = bp;
    a.browserName = bp ? String(browserName || path.basename(bp)) : '';
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true, browserPath: a.browserPath, browserName: a.browserName };
  });

  // 自动打开项：设置延迟秒数
  ipcMain.handle('autorun:setdelay', (e, { projectId, itemId, delay }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const a = (p.autorun || []).find(i => i.id === itemId);
    if (!a) return { ok: false, error: '找不到自动打开项' };
    a.delay = Math.max(0, Math.min(600, Number(delay) || 0));
    saveData();
    return { ok: true, delay: a.delay };
  });

  // 开机自启（启动文件夹放「启动 FDE.vbs」的快捷方式）
  ipcMain.handle('autostart:get', () => ({ ok: true, enabled: isAutostartOn() }));
  ipcMain.handle('autostart:set', async (e, val) => setAutostart(!!val));

  // ---- 场景包 / 场景市场 ----
  ipcMain.handle('pack:list', () => scanPacks(true));
  ipcMain.handle('pack:detail', (e, id) => loadPack(id));
  ipcMain.handle('pack:apply', (e, { packId, params, enter }) => applyPack(packId, params, { enter }));
  ipcMain.handle('pack:export', (e, projectId) => exportProjectAsPack(projectId));
  ipcMain.handle('pack:import', () => importPackFolder());
  ipcMain.handle('pack:delete', (e, id) => deletePack(id));
  ipcMain.handle('pack:open-dir', async () => {
    const dir = path.join(app.getPath('userData'), 'packs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {}
    await shell.openPath(dir);
    return { ok: true, dir };
  });
  ipcMain.handle('pack:open-folder', async (e, id) => {
    const info = findPack(id);
    if (!info) return { ok: false, error: '包不存在' };
    await shell.openPath(info.dir);
    return { ok: true };
  });
  // ---- AI 算力（模型与密钥） ----
  // 打开外部链接（生成出来的图片/视频/音乐地址直接点开看）
  ipcMain.handle('app:open-url', async (e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只支持 http/https 地址' };
    try { await shell.openExternal(u); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });

  /**
   * 货源搜索：平台 + 中文关键词 → 正确编码的搜索地址，用系统浏览器打开。
   * 1688 是 GBK 页面，UTF-8 关键词会在搜索框里变乱码（"椹《璧疯韩鎵舵墜"），
   * 所以这里统一走 gbk.js 换编码；淘宝是 UTF-8，用来比零售价。
   */
  ipcMain.handle('search:open', async (e, payload) => {
    const p = payload || {};
    const kw = String(p.keyword || '').trim();
    if (!kw) return { ok: false, error: '没有关键词' };
    const platform = p.platform === 'taobao' ? 'taobao' : '1688';
    const url = gbk.searchUrl(platform, kw);
    try {
      await shell.openExternal(url);
      return { ok: true, platform, keyword: kw, url };
    } catch (err) {
      return { ok: false, error: err.message, url };
    }
  });
  ipcMain.handle('ai:get', () => aiPublic());
  ipcMain.handle('ai:save', (e, patch) => aiSave(patch || {}));
  ipcMain.handle('ai:detect', async (e, patch) => {
    const cur = aiConfig();
    const key = (patch && patch.apiKey) ? String(patch.apiKey).trim() : cur.apiKey;
    const baseUrl = (patch && patch.baseUrl) || cur.baseUrl;
    const r = await aiClient.detect({ baseUrl, apiKey: key });
    if (!r.ok) return { ok: false, error: r.error, tries: r.tries || [] };
    aiSave({ baseUrl: r.base, apiKey: key, models: r.models, protocol: r.protocol });
    return { ok: true, baseUrl: r.base, models: r.models, count: r.models.length, protocol: r.protocol };
  });
  ipcMain.handle('ai:models', async (e, patch) => {
    const cur = aiConfig();
    const cfg = {
      baseUrl: (patch && patch.baseUrl) || cur.baseUrl,
      apiKey: (patch && typeof patch.apiKey === 'string') ? patch.apiKey.trim() : cur.apiKey,
      protocol: (patch && patch.protocol) || cur.protocol
    };
    const r = await aiClient.listModels(cfg);
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
    // noSave：给自定义/本地供应商「拉模型」用，不动当前启用的配置
    if (!(patch && patch.noSave)) aiSave({ baseUrl: r.base, models: r.models, protocol: r.protocol || cfg.protocol });
    return { ok: true, models: r.models, baseUrl: r.base, protocol: r.protocol || cfg.protocol };
  });
  ipcMain.handle('ai:test', async (e, patch) => {
    const cur = aiConfig();
    const cfg = {
      baseUrl: (patch && patch.baseUrl) || cur.baseUrl,
      apiKey: (patch && patch.apiKey) ? String(patch.apiKey).trim() : cur.apiKey,
      model: (patch && patch.model) || cur.model
    };
    if (!cfg.model) {
      // 没选模型时先拉一把，拿第一个来试
      const lm = await aiClient.listModels(cfg);
      if (!lm.ok) return { ok: false, error: lm.error, kind: lm.kind };
      cfg.model = (lm.models[0] || {}).id || '';
      aiSave({ baseUrl: lm.base, models: lm.models, model: cfg.model });
    }
    const t0 = Date.now();
    const r = await aiChatCounted(cfg, {
      messages: [{ role: 'user', content: '只回四个字：连接正常' }],
      maxTokens: 32,
      purpose: 'quick'
    }, { timeout: 45000 });
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind, ms: Date.now() - t0 };
    return { ok: true, text: r.text, model: r.model, ms: Date.now() - t0, usage: r.usage };
  });
  ipcMain.handle('ai:chat', async (e, payload) => {
    const cfg = aiConfig();
    const r = await aiChatCounted(cfg, payload || {});
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
    return { ok: true, text: r.text, model: r.model, usage: r.usage };
  });

  /**
   * 模型目录：一次拿到 文本 / 图片 / 视频 / 音乐 四类模型（含参数定义）。
   * 画布的「＋图片 / ＋视频 / ＋音乐」和模型库都读这一份；10 分钟内复用缓存，
   * 避免每次开面板都打一次接口。
   */
  ipcMain.handle('models:catalog', async (e, payload) => {
    const cfg = aiConfig();
    const force = !!(payload && payload.refresh);
    const key = cfg.baseUrl + '|' + aiClient.maskKey(cfg.apiKey);
    const now = Date.now();
    if (!force && modelsCache && modelsCache.key === key && now - modelsCache.at < 10 * 60 * 1000) {
      return Object.assign({ ok: true, cached: true }, modelsCache.value);
    }
    if (!cfg.apiKey) {
      return { ok: false, error: '还没接算力：填一把密钥就能看到四类模型（聊天 / 图片 / 视频 / 音乐）' };
    }
    const r = await aiClient.catalog(cfg);
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
    const list = modelsLib.normalizeCatalog(r.raw);
    const value = {
      models: list,
      groups: modelsLib.group(list),
      counts: modelsLib.counts(list),
      types: modelsLib.TYPE_META,
      source: r.source || '',
      base: r.base || cfg.baseUrl
    };
    modelsCache = { key, at: now, value };
    broadcast('fde:models', value);
    return Object.assign({ ok: true, cached: false }, value);
  });

  // 单个模型的参数定义：画布选中模型时拉一次，按它画"这个模型自己的输入框"
  ipcMain.handle('models:detail', async (e, name) => modelDetailOf(aiConfig(), name));

  /**
   * 选本地素材 → 上传到平台换公网直链 → 返回给画布填进参数。
   * 平台不提供文件托管给外部用，但自己的 /v1/media/upload（multipart 字段 file）
   * 会回一个 COS/TOS 直链，图片/音频/视频都收 —— 这就是网站上"上传参考图"的真实做法。
   */
  ipcMain.handle('media:pick', async (e, payload) => {
    const opts = payload || {};
    const kind = ['image', 'audio', 'video', 'file'].includes(opts.kind) ? opts.kind : 'image';
    const exts = Array.isArray(opts.exts) && opts.exts.length
      ? opts.exts.map(x => String(x).replace(/^\./, '')).slice(0, 12)
      : (kind === 'image' ? ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']
        : kind === 'audio' ? ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg']
        : kind === 'video' ? ['mp4', 'mov', 'webm', 'mkv']
        : ['*']);
    const label = kind === 'image' ? '图片' : kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '文件';
    const win = (() => { try { return BrowserWindow.fromWebContents(e.sender); } catch (err) { return null; } })();
    const openOpts = {
      title: '选' + label + '（选完自动传到算力平台，变成可用的直链）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: label, extensions: exts }]
    };
    const picked = await (win ? dialog.showOpenDialog(win, openOpts) : dialog.showOpenDialog(openOpts))
      .catch(() => ({ canceled: true, filePaths: [] }));
    if (!picked || picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
    const cfg = aiConfig();
    const maxMB = kind === 'video' ? 200 : kind === 'audio' ? 50 : 30;
    const files = [], failed = [];
    for (const p of picked.filePaths.slice(0, 12)) {
      let st = null;
      try { st = fs.statSync(p); } catch (err) { failed.push({ name: path.basename(p), error: '读不到文件' }); continue; }
      if (st.size > maxMB * 1024 * 1024) {
        failed.push({ name: path.basename(p), error: (st.size / 1048576).toFixed(1) + 'MB 超过 ' + maxMB + 'MB' });
        continue;
      }
      const r = await aiClient.mediaUpload(cfg, p, { maxMB });
      if (!r.ok) { failed.push({ name: path.basename(p), error: r.error }); continue; }
      files.push({ name: r.name || path.basename(p), url: r.url, size: r.size || st.size, kind });
      addLog('[素材] 已上传 ' + path.basename(p) + ' → ' + r.url, null);
    }
    if (!files.length) return { ok: false, error: (failed[0] && failed[0].error) || '上传失败', failed };
    return { ok: true, files, failed, kind };
  });

  // 余额：跑图片/视频/音乐前先知道钱够不够
  ipcMain.handle('ai:balance', async () => {
    const r = await aiClient.balance(aiConfig());
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
    return { ok: true, data: r.json };
  });

  // 提交一个媒体生成任务（渲染端通常不用直接调，走画布节点的 run 即可）
  ipcMain.handle('media:generate', async (e, payload) => {
    const cfg = aiConfig();
    const body = modelsLib.buildGenerateBody(
      payload && payload.model,
      payload && payload.prompt,
      payload && payload.params
    );
    if (!body.model) return { ok: false, error: '没选模型' };
    if (!body.prompt) return { ok: false, error: '提示词不能为空' };
    const r = await aiClient.mediaGenerate(cfg, body);
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
    const sub = modelsLib.parseSubmit(r.json);
    if (!sub.ok) return { ok: false, error: sub.error, raw: sub.raw };
    return { ok: true, taskId: sub.taskId, body };
  });

  ipcMain.handle('media:status', async (e, taskId) => {
    const r = await aiClient.mediaStatus(aiConfig(), taskId);
    if (!r.ok) return { ok: false, error: r.error, kind: r.kind };
    return { ok: true, status: modelsLib.parseStatus(r.json), raw: r.json };
  });
  // 启用自定义/本地供应商：密钥留在主进程，不回传渲染端
  ipcMain.handle('ai:use-provider', (e, id) => {
    const p = (aiConfig().providers || []).find(x => x.id === String(id || '').slice(0, 24));
    if (!p) return { ok: false, error: '供应商不存在' };
    aiSave({ baseUrl: p.baseUrl, apiKey: p.apiKey || '', model: (p.models || [])[0] || '', models: p.models || [] });
    const c = aiPublic();
    if (appsWin && !appsWin.isDestroyed()) { try { appsWin.webContents.send('fde:ai', c); } catch (e2) {} }
    return { ok: true, model: c.model, baseUrl: c.baseUrl };
  });
  ipcMain.handle('ai:open', async (e, which) => {
    const c = aiClient.CONSOLE;
    // keys=密钥/费用页（看已使用⚡和限额），manage=接口管理（线路：综合最优/价格优先/速度优先/成功率优先）
    const url = which === 'skill' ? c.skill
      : which === 'home' ? c.home
      : which === 'keys' ? c.keys
      : c.console;
    const r = await openUserSite(url);
    if (!r.ok) addLog('打开官网失败：' + (r.error || '未知原因') + '（' + url + '）', null);
    return r;
  });
  // 从画布/面板点「模型」：把应用功能窗口打开并切到 AI 算力那一页
  ipcMain.handle('ai:open-settings', () => {
    openApps();
    if (appsWin && !appsWin.isDestroyed()) {
      const send = () => { try { appsWin.webContents.send('fde:ai-open'); } catch (e) {} };
      if (appsWin.webContents.isLoading()) appsWin.webContents.once('did-finish-load', () => setTimeout(send, 120));
      else setTimeout(send, 120);
    }
    return { ok: true };
  });

  // ---- 应用功能（专家 / 技能 / 连接器 / 资料库） ----
  ipcMain.handle('apps:get', () => appsPayload());
  ipcMain.handle('apps:open', (e, payload) => openApps(payload && payload.tab));
  ipcMain.handle('ecom:open', () => openEcom());

  // 打开发布包所在文件夹（导出后让用户一眼看到产物）
  ipcMain.handle('ecom:show', async (e, dir) => {
    const d = String(dir || '').trim();
    if (!d) return { ok: false, error: '没有目录' };
    if (!fs.existsSync(d)) return { ok: false, error: '目录不在了：' + d };
    const err = await shell.openPath(d);
    return err ? { ok: false, error: err } : { ok: true, dir: d };
  });

  /**
   * 卖货台导出发布包：把文案、首图、AI 配图落到一个文件夹里。
   * files 支持三种形态：{name,text} 文本 / {name,dataUrl} canvas 出的 PNG / {name,url} 远端图。
   * 图床链接有有效期，所以配图必须下载成本地文件，不能只存 URL。
   */
  ipcMain.handle('ecom:export', async (e, payload) => {
    const files = Array.isArray(payload && payload.files) ? payload.files.slice(0, 30) : [];
    if (!files.length) return { ok: false, error: '没有要保存的内容' };
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = String((payload && payload.slug) || '发布包').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
    let dir = String((payload && payload.dir) || '').trim();
    if (!dir) dir = path.join(app.getPath('userData'), 'ecom-out', stamp + '-' + slug);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) { return { ok: false, error: '建目录失败：' + err.message }; }
    const written = [];
    const failed = [];
    for (const f of files) {
      const name = path.basename(String(f.name || 'file.txt')).replace(/[\\/:*?"<>|]/g, '-');
      const target = path.join(dir, name);
      try {
        if (f.dataUrl) {
          const m = String(f.dataUrl).match(/^data:([^;]+);base64,([\s\S]*)$/);
          if (!m) { failed.push(name + '（图片格式不对）'); continue; }
          fs.writeFileSync(target, Buffer.from(m[2], 'base64'));
        } else if (f.url) {
          const res = await fetch(String(f.url), { timeout: 60000 });
          if (!res.ok) { failed.push(name + '（下载 HTTP ' + res.status + '）'); continue; }
          fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
        } else {
          fs.writeFileSync(target, String(f.text == null ? '' : f.text), 'utf8');
        }
        written.push(target);
      } catch (err) {
        failed.push(name + '（' + (err.message || err) + '）');
      }
    }
    if (payload && payload.open) { try { await shell.openPath(dir); } catch (err) {} }
    return { ok: written.length > 0, dir, files: written, failed };
  });

  /* ==================== 知识库 ====================
   * 元数据 kb/kb-data.json（小、可读）+ 正文 kb/text/<id>.txt（一篇一个文件）。
   * 真正的抽文本/切块/索引/检索在 kb.js 里，主进程只做窗口与 IPC 封装。
   */
  // 知识库不再单独开窗：它就是应用功能里的第一档
  ipcMain.handle('kb:open', () => openApps('kb'));

  let kbStore = null;
  function kbS() {
    if (!kbStore) kbStore = kbLib.createStore(path.join(app.getPath('userData'), 'kb'));
    return kbStore;
  }

  ipcMain.handle('kb:load', () => {
    const s = kbS();
    const st = s.load();
    return { ok: true, libs: st.libs, docs: st.docs, kinds: kbLib.KINDS, dir: s.root, version: kbLib.VERSION, stats: s.stats() };
  });

  ipcMain.handle('kb:save', (e, patch) => {
    const p = patch || {};
    const s = kbS();
    const st = s.load();
    if (Array.isArray(p.libs)) st.libs = p.libs;
    if (Array.isArray(p.docs)) st.docs = p.docs;
    try { s.save(st); return { ok: true, libs: st.libs.length, docs: st.docs.length }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('kb:pick-dir', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择要导入知识库的文件夹（会自动递归找文档）',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, dir: r.filePaths[0] };
  });

  ipcMain.handle('kb:pick-files', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文档', extensions: ['md', 'txt', 'csv', 'json', 'html', 'docx', 'xlsx', 'pptx', 'log', 'yml', 'yaml'] },
        { name: '全部', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const files = r.filePaths.map((fp) => {
      let size = 0;
      try { size = fs.statSync(fp).size; } catch (e) {}
      return { path: fp, rel: path.basename(fp), name: path.basename(fp), ext: path.extname(fp).toLowerCase(), size };
    });
    return { ok: true, files, root: path.dirname(r.filePaths[0]) };
  });

  /** 拖进来的路径：目录去扫描，文件直接进待导入列表 */
  ipcMain.handle('kb:paths', (e, payload) => {
    const list = (payload && payload.paths) || [];
    const dirs = [], files = [], bad = [];
    for (const fp of list.slice(0, 80)) {
      const one = String(fp || '').trim();
      if (!one) continue;
      try {
        const st = fs.statSync(one);
        if (st.isDirectory()) dirs.push(one);
        else files.push({ path: one, rel: path.basename(one), name: path.basename(one), ext: path.extname(one).toLowerCase(), size: st.size });
      } catch (err) { bad.push(one); }
    }
    return { ok: true, dirs, files, bad };
  });

  ipcMain.handle('kb:scan', (e, payload) => {
    const dir = String((payload && payload.dir) || '').trim();
    if (!dir) return { ok: false, error: '没有选目录' };
    if (!fs.existsSync(dir)) return { ok: false, error: '目录不在了：' + dir };
    const r = kbLib.scanDir(dir);
    const st = kbS().load();
    const seen = new Set(st.docs.map((d) => d.path + '|' + d.size));
    r.files = r.files.map((f) => Object.assign(f, { exist: seen.has(f.path + '|' + f.size) }));
    r.newCount = r.files.filter((f) => !f.exist).length;
    return Object.assign({ ok: true }, r);
  });

  ipcMain.handle('kb:add-docs', (e, payload) => {
    const p = payload || {};
    return kbS().addDocs(p.libId, p.files);
  });

  ipcMain.handle('kb:search', (e, payload) => {
    const p = payload || {};
    const q = String(p.q || '').trim();
    if (!q) return { ok: true, hits: [], total: 0 };
    try {
      const hits = kbS().search(q, p.libId || '', Number(p.limit) || 20);
      return { ok: true, hits, total: hits.length };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /** 问答：检索（BM25）→ 命中原文喂模型 → 要求标注 [资料 n]，答案可点回原文 */
  ipcMain.handle('kb:ask', async (e, payload) => {
    const p = payload || {};
    const q = String(p.q || '').trim();
    if (!q) return { ok: false, error: '先写一个问题' };
    const s = kbS();
    const hits = s.search(q, p.libId || '', 6);
    if (!hits.length) {
      return {
        ok: true,
        answer: '知识库里没找到和这个问题相关的内容。\n建议：先把相关文件夹导进来，或换个更具体的说法（带上品名 / 客户名 / 平台名）。',
        cites: [], hits: []
      };
    }
    const docs = hits.map((h) => ({ title: h.title, text: (s.textOf({ id: h.docId }) || '').slice(0, 3000) }));
    const prompt = kbLib.askPrompt(q, docs.map((d) => ({ doc: d })));
    const cfg = aiConfig();
    const r = await aiChatCounted(cfg, { messages: [{ role: 'user', content: prompt }], task: 'chat' }, { timeout: 120000 });
    const lightHits = hits.map((h) => ({ title: h.title, snippet: h.snippet, score: h.score, docId: h.docId }));
    if (!r.ok) return { ok: false, error: r.error || '模型没返回内容', kind: r.kind, hits: lightHits };
    const idx = kbLib.citations(r.text).filter((n) => n >= 1 && n <= hits.length);
    return {
      ok: true,
      answer: r.text,
      model: r.model,
      cites: idx.map((n) => ({ n, docId: hits[n - 1].docId, title: hits[n - 1].title, rel: hits[n - 1].rel })),
      hits: lightHits
    };
  });

  ipcMain.handle('kb:doc-remove', (e, payload) => {
    const ids = (payload && (payload.ids || (payload.id ? [payload.id] : []))) || [];
    return kbS().removeDocs(ids);
  });

  ipcMain.handle('kb:doc-text', (e, id) => {
    const s = kbS();
    const d = s.load().docs.find((x) => x.id === id);
    if (!d) return { ok: false, error: '文档不在库里' };
    const t = s.textOf(d);
    return { ok: true, doc: d, text: t.slice(0, 200000), truncated: t.length > 200000 };
  });

  // 在资源管理器里定位原文件；文件被移走了就打开所在目录
  ipcMain.handle('kb:reveal', async (e, p) => {
    const file = String(p || '').trim();
    if (!file) return { ok: false, error: '没有路径' };
    if (fs.existsSync(file)) { shell.showItemInFolder(file); return { ok: true }; }
    const dir = path.dirname(file);
    if (fs.existsSync(dir)) { await shell.openPath(dir); return { ok: true, dir }; }
    return { ok: false, error: '原文件已经不在了（可能被移动或删除）' };
  });

  ipcMain.handle('apps:close', () => {
    if (appsWin && !appsWin.isDestroyed()) appsWin.close();
    return { ok: true };
  });  ipcMain.handle('apps:save', (e, patch) => {
    const r = appsStore.save(appsRoot(), patch || {});
    if (!r.ok) return r;
    appsBroadcast();
    const item = Object.assign({}, r.item);
    delete item.dir;
    return { ok: true, item, created: !!r.created };
  });
  ipcMain.handle('apps:remove', (e, id) => {
    const r = appsStore.remove(appsRoot(), id);
    if (r.ok) appsBroadcast();
    return r;
  });
  ipcMain.handle('apps:restore', (e, key) => {
    const r = appsStore.restore(appsRoot(), key);
    if (r.ok) appsBroadcast();
    return r;
  });
  ipcMain.handle('apps:purge', (e, key) => {
    const r = appsStore.purge(appsRoot(), key);
    if (r.ok) appsBroadcast();
    return r;
  });
  ipcMain.handle('apps:duplicate', (e, id) => {
    const r = appsStore.duplicate(appsRoot(), id);
    if (r.ok) appsBroadcast();
    return r;
  });
  ipcMain.handle('apps:prompt', (e, id) => {
    const item = appsStore.get(appsRoot(), id);
    if (!item) return { ok: false, error: '找不到这一项' };
    return { ok: true, text: appsStore.promptOf(item) };
  });
  ipcMain.handle('apps:open-folder', async (e, id) => {
    const item = appsStore.get(appsRoot(), id);
    if (!item) return { ok: false, error: '找不到这一项' };
    await shell.openPath(item.dir);
    return { ok: true };
  });
  // 「用一下试试」：资料库打开文件/目录，连接器打开文档地址，专家技能复制提示词给下面的页面用
  ipcMain.handle('apps:open-target', async (e, id) => {
    const item = appsStore.get(appsRoot(), id);
    if (!item) return { ok: false, error: '找不到这一项' };
    const target = (item.kind === 'library' && item.library && item.library.path) ||
      (item.connector && item.connector.url) || '';
    if (!target) return { ok: false, error: '这一项没有可直接打开的位置' };
    if (/^https?:/i.test(target)) {
      const r = await openUserSite(target);
      return r || { ok: true };
    }
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('apps:export', async (e, id) => {
    const item = appsStore.get(appsRoot(), id);
    if (!item) return { ok: false, error: '找不到这一项' };
    const r = await dialog.showOpenDialog(appsWin || undefined, {
      title: '把「' + item.name + '」导出到哪个文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    return appsStore.exportTo(appsRoot(), id, r.filePaths[0]);
  });
  ipcMain.handle('apps:import', async () => {
    const r = await dialog.showOpenDialog(appsWin || undefined, {
      title: '导入能力：可以选文件夹、.md、.json 或 .zip',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [
        { name: '能力包', extensions: ['zip', 'md', 'markdown', 'txt', 'json', 'toml'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const done = [];
    for (const p of r.filePaths) {
      const one = appsStore.importFrom(appsRoot(), p);
      done.push({ path: p, ok: one.ok, name: one.ok ? one.item.name : '', error: one.error || '' });
    }
    appsBroadcast();
    return { ok: true, results: done };
  });
  ipcMain.handle('apps:scan', (e, force) => {
    const now = Date.now();
    if (!force && appsScanCache.items.length && now - appsScanCache.at < 10 * 60 * 1000) {
      return { ok: true, items: appsScanCache.items, cached: true };
    }
    const items = appsStore.scanSources(undefined, appsRoot()).map(c => ({
      key: c.key, source: c.source, kind: c.kind, name: c.name, desc: c.desc || '',
      path: c.path || '', group: c.group || '', extra: c.extra || '',
      installed: !!c.installed, catalog: !!c.catalog,
      inline: c.inline || null
    }));
    appsScanCache = { at: now, items };
    return { ok: true, items };
  });
  ipcMain.handle('apps:install', (e, cand) => {
    if (!cand || typeof cand !== 'object') return { ok: false, error: '参数不对' };
    if (!cand.inline && cand.path) {
      let st = null;
      try { st = fs.statSync(cand.path); } catch (err) { return { ok: false, error: '来源已经不存在了：' + cand.path }; }
      if (!st) return { ok: false, error: '来源已经不存在了：' + cand.path };
    }
    const r = appsStore.installCandidate(appsRoot(), cand);
    if (r.ok) appsBroadcast();
    return r;
  });
  ipcMain.handle('apps:to-canvas', (e, id) => {
    const r = appToCanvas(id);
    if (r.ok) {
      try { openSwitcher('canvas'); } catch (err) {}
    }
    return r;
  });


  // ---- 搭台 Agent：一句话让模型自动搭项目/脚本/画布 ----
  ipcMain.handle('builder:chat', async (e, payload) => {
    const request = String((payload && payload.request) || '').trim();
    const images = Array.isArray(payload && payload.images) ? payload.images : [];
    if (!request && !images.length) return { ok: false, error: '先说说你想搭什么，或截一张图' };
    const cfg = aiConfig();
    if (!cfg.apiKey || !cfg.model) {
      return { ok: false, error: '还没接算力：先去「应用功能 → ⚡ 模型设置」填密钥，搭台助手要用模型来理解需求' };
    }
    const msgs = builder.toMultimodal(builder.buildPrompt(data.projects, data.canvas, request || '（看图说话：按截图里的内容搭）'), images);
    say('搭台助手思考中…');
    const res = await aiChatCounted(cfg, { messages: msgs, maxTokens: 3000, temperature: 0.3, purpose: 'build' }, { timeout: 150000 });
    if (!res.ok) return { ok: false, error: '模型调用失败：' + res.error };
    const plan = builder.parsePlan(res.text);
    if (!plan.ok) return { ok: false, error: plan.error, raw: res.text.slice(0, 400) };
    const r = builder.applyPlan(data, plan.plan, { scriptRoot: userPackScriptsDir() });
    saveData();
    broadcast('fde:projects', data.projects);
    broadcast('fde:canvas', data.canvas);
    const summary = builder.summarize(r);
    say(summary);
    const u = res.usage || {};
    return { ok: true, summary, created: r.created, errors: r.errors, aiNote: String(plan.plan.说明 || '').slice(0, 200), usage: { tokens: u.total_tokens || 0 }, raw: res.text };
  });
  // ---- 搭台：AI 把脚本骨架写成完整可跑的 .ps1 ----
  ipcMain.handle('builder:script', async (e, payload) => {
    const proj = String((payload && payload.project) || '').trim();
    const name = String((payload && payload.script) || '').trim();
    const need = String((payload && payload.requirement) || '').trim();
    if (!name || !need) return { ok: false, error: '缺脚本名或需求描述' };
    const cfg = aiConfig();
    if (!cfg.apiKey || !cfg.model) return { ok: false, error: '还没接算力：先去「应用功能 → ⚡ 模型设置」填密钥' };
    // 现有骨架内容（有就带给模型参考）
    const dir = path.join(userPackScriptsDir(), 'auto', builder.clampStrFor ? builder.clampStrFor(proj) : proj.replace(/[\\/:*?"<>|]/g, '_'));
    const file = path.join(dir, name.replace(/[\\/:*?"<>|]/g, '_') + '.ps1');
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch (e2) {}
    say('正在让 AI 写「' + name + '」的完整脚本…');
    const res = await aiChatCounted(cfg, { messages: builder.scriptPrompt(proj, name, need, current), maxTokens: 4000, temperature: 0.2, purpose: 'script' }, { timeout: 150000 });
    if (!res.ok) return { ok: false, error: '模型调用失败：' + res.error };
    const p = builder.parseScript(res.text);
    if (!p.ok) return { ok: false, error: p.error, raw: p.raw || res.text.slice(0, 300) };
    const out = builder.writeScript(userPackScriptsDir(), proj, name, p.script);
    const u2 = res.usage || {};
    say('脚本「' + name + '」已写好：' + out);
    broadcast('fde:projects', data.projects);
    return { ok: true, file: out, lines: p.script.split(/\r?\n/).length, tokens: u2.total_tokens || 0 };
  });
  ipcMain.handle('pack:open-market', () => openMarket());
  ipcMain.handle('pack:close-market', () => {
    if (marketWin && !marketWin.isDestroyed()) marketWin.close();
    return { ok: true };
  });

  // ---- 环境 / 迁移 ----
  ipcMain.handle('env:info', () => envInfo());
  ipcMain.handle('env:open', () => openEnv());
  ipcMain.handle('env:close', () => {
    if (envWin && !envWin.isDestroyed()) envWin.close();
    return { ok: true };
  });
  ipcMain.handle('env:check', async () => {
    return await runtime.envCheck(data, { dataRoot: app.getPath('userData'), appDir: __dirname });
  });
  ipcMain.handle('env:export', () => exportSnapshot());
  ipcMain.handle('env:pick', () => pickSnapshot());
  ipcMain.handle('env:import', (e, mode) => importSnapshot(mode === 'merge' ? 'merge' : 'replace'));
  ipcMain.handle('env:rewrite', (e, { from, to }) => rewritePaths(from, to));
  ipcMain.handle('env:set-dataroot', (e, { dir, move }) => setDataRoot(dir, { move: move !== false }));
  ipcMain.handle('env:build-portable', () => buildPortable());
  ipcMain.handle('env:open-dataroot', async () => {
    await shell.openPath(app.getPath('userData'));
    return { ok: true };
  });
  ipcMain.handle('env:browse-dir', async () => {
    const r = await dialog.showOpenDialog(panelWin, { title: '选择数据目录', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    return { ok: true, dir: r.filePaths[0] };
  });
  ipcMain.handle('env:relaunch', () => {
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
  ipcMain.handle('env:ai-clear', () => {
    getAiCache().clear();
    data.stats = { aiCalls: 0, cacheHits: 0, tokensSaved: 0 };
    saveData();
    return { ok: true };
  });

  // ---- 窗口整理 ----
  ipcMain.handle('win:tile', (e, projectId) => tileWindows(projectId === undefined ? activeId : projectId));

  // ---- 信任中心 ----
  ipcMain.handle('trust:open', (e, tab) => openTrust(typeof tab === 'string' ? tab : ''));
  ipcMain.handle('trust:close', () => { if (trustWin && !trustWin.isDestroyed()) trustWin.close(); return { ok: true }; });
  ipcMain.handle('trust:info', () => {
    const facts = trust.securityFacts(data, {
      dataRoot: app.getPath('userData'),
      dataFile: dataFile(),
      dataSize: (() => { try { return fs.statSync(dataFile()).size; } catch (e) { return 0; } })(),
      mode: DATA_ROOT.mode,
      source: DATA_ROOT.source,
      appDir: __dirname,
      version: app.getVersion(),
      isAdmin: !!isAdmin
    });
    return {
      ok: true,
      facts,
      roleDefs: adopt.ROLE_DEFS,
      attitudes: adopt.ATTITUDES,
      obstacles: adopt.OBSTACLES,
      mutual: adopt.MUTUAL,
      ackDefs: acks.ACK_DEFS.map(d => ({
        key: d.key, title: d.title, who: d.who, roles: d.roles,
        hint: d.hint, why: d.why, page: d.page
      })),
      projects: data.projects.map(p => {
        const ev = trust.collectEvidence(data, p.id, {});
        const list = acks.acksOf(p);
        const calc = adopt.computeAdoption(ev, p.adoption || {});
        const sts = (p.stakeholders || []).map(s => Object.assign({}, s, {
          roleName: (adopt.ROLE_DEFS[s.role] || {}).name || s.role,
          next: adopt.suggestNext(s.role, s.attitude)
        }));
        return {
          id: p.id, name: p.name, desc: p.desc || '', color: p.color,
          case: ev.case, counts: ev.counts, saved: ev.saved,
          adoption: p.adoption || {}, calc, stakeholders: sts,
          acks: list, ackStats: acks.ackStats(list),
          wait: acks.waitByRole(list),
          // 最近实际发生的事：中性描述，客户看了知道"这周真跑了什么"
          recent: (data.logs || []).filter(l => l.projectId === p.id).slice(0, 6)
            .map(l => ({ t: l.time, text: l.text })),
          blockers: sts.filter(s => s.attitude === 'resist').length,
          missing: !ev.case.client || !ev.case.pain || !ev.case.solution || !ev.saved.perRun
        };
      }).sort((a, b) =>
        // 有确认进度的排前面；其次看执行量。客户一进来就该看到"正在推进的那件事"
        (b.ackStats.ok + b.ackStats.object) - (a.ackStats.ok + a.ackStats.object) ||
        (b.counts.runs || 0) - (a.counts.runs || 0)
      ),
      templates: trust.BIZ_TEMPLATES.map(t => ({ id: t.id, name: t.name, desc: t.desc })),
      hasCase: data.projects.some(p => p.case && p.case.client && p.case.allowPublish)
    };
  });
  /**
   * 确认 / 提异议。谁点的、什么时候点的都记下来——这是双方共享凭证的意义所在。
   * state: 'ok' 确认 ｜ 'object' 有异议 ｜ 'pending' 撤回
   */
  ipcMain.handle('trust:ack', (e, { projectId, key, state, by, remark }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    // 校验与写入都在 acks 模块里，规则只有一份
    const r = acks.setAck(p, key, state, by, remark);
    if (!r.ok) return r;
    const def = acks.ACK_DEFS.find(d => d.key === key) || { title: key };
    const who = String(by || '').trim();
    const tag = state === 'ok' ? '确认' : state === 'object' ? '提出异议' : '撤回确认';
    addLog('[确认] ' + p.name + ' · ' + def.title + ' → ' + tag + (who ? '（' + who + '）' : ''), p.id);
    saveData();
    broadcast('fde:projects', data.projects);
    return r;
  });
  // 一段可复制的确认摘要：贴到微信、附在报告后面都行
  ipcMain.handle('trust:ack-digest', (e, projectId) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    const text = acks.ackDigest(p);
    clipboard.writeText(text);
    return { ok: true, text };
  });
  ipcMain.handle('trust:preview', (e, { kind, projectId, meta }) => {
    // 在页面里内联预览用：直接返回 HTML 字符串，不必落盘
    const facts = trust.securityFacts(data, {
      dataRoot: app.getPath('userData'), dataFile: dataFile(),
      dataSize: (() => { try { return fs.statSync(dataFile()).size; } catch (err) { return 0; } })(),
      mode: DATA_ROOT.mode, source: DATA_ROOT.source, appDir: __dirname,
      version: app.getVersion(), isAdmin: !!isAdmin
    });
    if (kind === 'security') return { ok: true, html: trust.renderSecurityHtml(facts, data) };
    const ev = trust.collectEvidence(data, projectId, (meta && meta.range) || {});
    if (!ev) return { ok: false, error: '项目不存在' };
    if (kind === 'report') {
      const _p = data.projects.find(x => x.id === projectId) || {};
      const _l = acks.acksOf(_p);
      return {
        ok: true,
        html: trust.renderReportHtml(ev, Object.assign({
          isAdmin: !!isAdmin,
          acks: _l,
          ackStats: acks.ackStats(_l)
        }, meta || {}))
      };
    }
    if (kind === 'case') return { ok: true, html: trust.renderCaseHtml(ev, meta || {}) };
    return { ok: false, error: '未知类型' };
  });
  ipcMain.handle('trust:export', (e, { kind, projectId, meta }) => exportTrustDoc(kind, projectId, meta));
  ipcMain.handle('trust:save-case', (e, { projectId, patch }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.case = Object.assign({
      client: '', industry: '', pain: '', solution: '', quote: '',
      allowPublish: false, manualMinutes: 0, hourlyRate: 0, since: 0,
      owner: '', contact: ''
    }, p.case || {}, patch || {});
    saveData();
    broadcast('fde:projects', data.projects);
    return { ok: true, case: p.case };
  });
  ipcMain.handle('trust:template', (e, id) => {
    const t = trust.BIZ_TEMPLATES.find(x => x.id === id);
    return t ? { ok: true, name: t.name, body: t.body } : { ok: false, error: '模板不存在' };
  });
  ipcMain.handle('trust:export-template', async (e, id) => {
    const t = trust.BIZ_TEMPLATES.find(x => x.id === id);
    if (!t) return { ok: false, error: '模板不存在' };
    const filePath = await pickSavePath('导出模板：' + t.name, 'FDE-' + t.name + '.md', [
      { name: 'Markdown（可直接改）', extensions: ['md'] },
      { name: '纯文本', extensions: ['txt'] }
    ]);
    if (!filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, t.body, 'utf8');
      addLog('已导出商务模板：' + t.name, null);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('trust:open-docs', async () => {
    const dir = path.join(app.getPath('documents'), 'FDE-交付文档');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    await shell.openPath(dir);
    return { ok: true, dir };
  });

  // ---- 推进（人） ----
  ipcMain.handle('adopt:open', () => openAdopt());
  ipcMain.handle('adopt:close', () => { if (trustWin && !trustWin.isDestroyed()) trustWin.close(); return { ok: true }; });
  ipcMain.handle('adopt:info', () => ({
    ok: true,
    roleDefs: adopt.ROLE_DEFS,
    attitudes: adopt.ATTITUDES,
    obstacles: adopt.OBSTACLES,
    projects: data.projects.map(p => {
      const ev = trust.collectEvidence(data, p.id, {});
      const calc = adopt.computeAdoption(ev, p.adoption || {});
      const sts = (p.stakeholders || []).map(s => Object.assign({}, s, {
        roleName: (adopt.ROLE_DEFS[s.role] || {}).name || s.role,
        next: adopt.suggestNext(s.role, s.attitude)
      }));
      return {
        id: p.id, name: p.name,
        case: ev.case,
        adoption: p.adoption || {},
        calc,
        stakeholders: sts,
        blockers: sts.filter(s => s.attitude === 'resist').length,
        noOne: !sts.length
      };
    }).sort((a, b) =>
      // 正在推进的排前面：有干系人的 > 有执行记录的
      (b.stakeholders.length - a.stakeholders.length) || ((b.calc.freq || 0) - (a.calc.freq || 0))
    )
  }));
  ipcMain.handle('adopt:save', (e, { projectId, patch }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.adoption = Object.assign({
      flowName: '', perRunMinutes: 0, reviewMinutes: 0, monthlyRuns: 0,
      hourlyRate: 0, monthlyFee: 0, operatorName: '', reviewerName: '',
      contact: '', sla: '', steps: [],
      sponsor: '', approvedBy: '', approvedAt: 0, scope: '', note: ''
    }, p.adoption || {}, patch || {});
    saveData();
    const ev = trust.collectEvidence(data, p.id, {});
    return { ok: true, adoption: p.adoption, calc: adopt.computeAdoption(ev, p.adoption) };
  });
  ipcMain.handle('adopt:save-stakeholder', (e, { projectId, st }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    if (!Array.isArray(p.stakeholders)) p.stakeholders = [];
    let rec = null;
    if (st.id) rec = p.stakeholders.find(x => x.id === st.id);
    if (!rec) {
      rec = { id: 'st' + Math.random().toString(36).slice(2, 8) };
      p.stakeholders.push(rec);
    }
    Object.assign(rec, {
      name: st.name || rec.name || '',
      role: st.role || rec.role || 'operator',
      power: Number(st.power || rec.power || 2),
      attitude: st.attitude || rec.attitude || 'unknown',
      worry: st.worry === undefined ? (rec.worry || '') : st.worry,
      action: st.action === undefined ? (rec.action || '') : st.action,
      done: st.done === undefined ? !!rec.done : !!st.done
    });
    saveData();
    return { ok: true, id: rec.id };
  });
  ipcMain.handle('adopt:del-stakeholder', (e, { projectId, id }) => {
    const p = data.projects.find(x => x.id === projectId);
    if (!p) return { ok: false, error: '项目不存在' };
    p.stakeholders = (p.stakeholders || []).filter(x => x.id !== id);
    saveData();
    return { ok: true };
  });
  ipcMain.handle('adopt:preview', (e, { kind, projectId }) => {
    const html = adoptRender(kind, projectId);
    return html ? { ok: true, html } : { ok: false, error: '生成失败' };
  });
  ipcMain.handle('adopt:export', (e, { kind, projectId }) => exportAdoptDoc(kind, projectId));
}

// ---------- 管理员权限 ----------
// 为什么必须要：Windows 的 UIPI 不允许普通权限进程隐藏 / 移动管理员权限程序（如交易软件、部分工具）的窗口。
let isAdmin = false;

function checkElevated() {
  // macOS / Linux 没有 UAC 提权概念：窗口操作能不能做，取决于系统授权
  // （macOS 辅助功能）或外部工具（Linux xdotool），由 wmp 那边给出结论。
  if (!IS_WIN) return Promise.resolve(false);
  return new Promise((resolve) => {
    const cmd = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 8000 }, (err, stdout) => {
        resolve(!err && String(stdout || '').trim().toLowerCase() === 'true');
      });
  });
}

function relaunchElevated() {
  if (!IS_WIN) return Promise.resolve({ ok: false, error: '当前系统不需要管理员权限' });
  return new Promise((resolve) => {
    try {
      const exe = process.execPath;
      const args = process.argv.slice(1).filter(a => a !== '--no-elevate');
      args.push('--elevated-launch');
      const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const argList = args.map(q).join(',');
      const cmd =
        'try { Start-Process -FilePath ' + q(exe) +
        ' -ArgumentList @(' + argList + ')' +
        ' -WorkingDirectory ' + q(process.cwd()) +
        ' -Verb RunAs -PassThru | Out-Null; "OK" } catch { "FAIL:" + $_.Exception.Message }';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { windowsHide: true, timeout: 90000 }, (err, stdout, stderr) => {
          const s = String(stdout || '').trim();
          if (s.startsWith('OK')) return resolve({ ok: true });
          resolve({ ok: false, error: (s.replace(/^FAIL:/, '') || String(stderr || err && err.message || '')).slice(0, 200) });
        });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ---------- 生命周期 ----------
let quitting = false;
process.on('unhandledRejection', (err) => console.error('未处理的异步错误:', err));
// 主进程崩溃写本地日志：客户机器出问题不用猜，诊断看板里能看到
function writeCrashLog(kind, err) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'main-error.log'),
      '[' + new Date().toISOString() + '] ' + kind + ': ' + (err && (err.stack || err.message) || String(err)) + '\n', 'utf8');
  } catch (e) {}
}
process.on('uncaughtException', (err) => { writeCrashLog('uncaughtException', err); console.error('主进程异常:', err); });
process.on('unhandledRejection', (err) => { writeCrashLog('unhandledRejection', err); });

/**
 * 唤醒已有实例的面板。
 * 双击 N 次启动器只应该有一个进程在跑：后来的进程拿不到单实例锁就退出，
 * 但退出前要让"已经在跑的那个"把面板亮出来（否则用户看到的就是"没反应"）。
 */
function wakePanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  try {
    if (panelWin.isMinimized()) panelWin.restore();
    // 强制摆回屏幕左缘：万一上次位置跑偏/在屏幕外，show() 也看不见
    const b = screen.getPrimaryDisplay().bounds;
    panelWin.setBounds({ x: b.x, y: b.y, width: APPBAR_WIDTH, height: b.height });
    panelWin.show();
    panelWin.setAlwaysOnTop(true);
    panelWin.focus();
    panelWin.moveTop();
    setTimeout(ensurePanelDocked, 300);
  } catch (e) {}
}

/**
 * 单实例锁必须在 app ready 之前获取。
 * 实测：放在 whenReady() 里面时，第二个实例照样能拿到锁，
 * 结果两个进程各注册一次左侧 AppBar、各接管一遍窗口，界面就开始打架。
 * 拿不到锁时也不能走正常退出流程（before-quit 会把隐藏的窗口全部放出来），
 * 必须 app.exit() 硬退，然后由已有实例收到 second-instance 亮出面板。
 */
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  slog('另一个实例已在运行 → 本进程直接退出，由已有实例亮出面板');
  app.exit(0);
}
app.on('second-instance', () => {
  slog('收到 second-instance：唤醒已有面板');
  wakePanel();
});

app.whenReady().then(async () => {
  seedDeliveryKey();
  if (!gotSingleLock) return;
  slog('--- whenReady ---');

  loadData();
  migrateFlowsToCanvas();

  // 【2】立刻把窗口建出来 —— 双击后 1 秒内必须看到界面。
  // 权限检查要起 PowerShell，冷启动（首次运行/杀软扫描）可能十几秒，绝不能挡在窗口前面。
  const cached = data.settings.lastIsAdmin;
  isAdmin = cached === true;
  slog('权限用缓存值: ' + String(cached) + '（后台校验中）');

  const skipElevate = process.argv.includes('--no-elevate');
  const elevatedLaunch = process.argv.includes('--elevated-launch');

  restoreOwnersFromDisk();
  registerIpc();
  createPanel();
  slog('面板窗口已创建');
  // 部署/排障用：启动后直接停在「环境与迁移」页，省得先点面板
  if (process.argv.includes('--open-env')) setTimeout(() => { try { openEnv(); } catch (e) {} }, 900);
  if (process.argv.includes('--open-trust')) setTimeout(() => { try { openTrust(); } catch (e) {} }, 900);
  if (process.argv.includes('--open-adopt')) setTimeout(() => { try { openAdopt(); } catch (e) {} }, 900);
  // 排障用：--shot=<前缀> 把所有窗口截一张图后退出（不碰用户桌面上的窗口）
  const shotArg = process.argv.find(a => a.startsWith('--shot='));
  if (shotArg) {
    const base = shotArg.slice('--shot='.length).replace(/\.png$/i, '');
    setTimeout(async () => {
      const wins = BrowserWindow.getAllWindows();
      let i = 0;
      for (const w of wins) {
        if (w.isDestroyed()) continue;
        try {
          const img = await w.webContents.capturePage();
          fs.writeFileSync(base + '-' + (i++) + '.png', img.toPNG());
        } catch (e) {}
      }
      try { fs.writeFileSync(base + '-count.txt', String(wins.length)); } catch (e) {}
      app.exit(0);
    }, 9000);
  }

  // 壁纸捕获也是 PowerShell，不阻塞主流程
  captureOriginalWallpaper().catch(() => {});

  // 助手启动 + 托盘 + 热键都放后台
  startHelper();
  setTimeout(async () => {
    await waitHelper(12000);
    await createTray();
    rebuildShortcuts();
  }, 1200);

  // 启动时把现有可见窗口登记为"原电脑桌面"，并做一次自愈
  // （同样不等权限检查，否则 UAC 卡住时窗口归属一直不生效）
  setTimeout(async () => {
    await waitHelper(12000);
    await collect(null);
    // 自愈：上次若被强制结束，属于原桌面的窗口可能还停在隐藏/屏幕外
    const list = await enumWindows();
    const toShow = [];
    for (const w of list) {
      const rec = winRecs.get(w.hwnd);
      if (!rec || rec.owner !== null) continue;
      if (rec.savedRect) {
        await winCmd('MOVE|' + w.hwnd + '|' + rec.savedRect.x + '|' + rec.savedRect.y);
        delete rec.savedRect;
      }
      if (!w.vis || w.iconic) toShow.push(w.hwnd);
      rec.hiddenByUs = false;
    }
    if (toShow.length) await winCmd('SHOW|' + toShow.join(','));
    await new Promise(r => setTimeout(r, 200));
    activeId = null;
    await applyVisibility();
    persistOwners();
    refreshStatuses(true);
    addLog('FDE 已启动 v' + app.getVersion() + ' · ' + PLAT.label + ' · ' +
      (IS_WIN ? '权限: ' + (isAdmin ? '管理员' : '普通') : platform.describe()) +
      ' · 已接管 ' + winRecs.size + ' 个窗口的桌面归属');
    if (!IS_WIN && helperDetail) addLog('窗口隔离: ' + helperDetail);
    await ensurePanelDocked();
  }, 1600);

  // macOS 上每条窗口命令都是一次 osascript 调用（几十到几百毫秒），
  // 轮询太密会白烧 CPU，放宽到 2.5 秒；Windows 保持 1.2 秒的灵敏度。
  setInterval(pollTick, IS_WIN ? 1200 : 2500);
  // 位置守护：面板必须始终贴住屏幕左缘（分辨率/缩放/外壳重排都可能让它跑偏）
  setInterval(ensurePanelDocked, 1500);

  let reRegTimer = null;
  screen.on('display-metrics-changed', () => {
    clearTimeout(reRegTimer);
    // 注意：注册 AppBar 会改变工作区，从而再次触发这个事件；
    // 这里只做幂等的对齐检查（内部有防重入 + 节流），绝不能再直接重新注册。
    reRegTimer = setTimeout(ensurePanelDocked, 1500);
  });

  // 【3】后台校验真实权限（与窗口创建并行，不阻塞首屏）
  const verified = await checkElevated();
  slog('权限校验完成: ' + (verified ? '管理员' : '普通权限'));
  const changed = (cached !== verified);
  isAdmin = verified;
  if (data.settings.lastIsAdmin !== verified) {
    data.settings.lastIsAdmin = verified;
    saveData();
  }
  if (changed) broadcast('fde:desktop', desktopPayload());

  // 【4】确实没权限才提权。--elevated-launch 时绝不再提权，否则 UAC 会无限弹
  // （仅 Windows：macOS/Linux 没有 UAC 这一套）
  if (IS_WIN && !verified && data.settings.needAdmin !== false && !skipElevate && !elevatedLaunch) {
    slog('请求提权…');
    addLog('请求管理员权限（当前普通权限）...');
    const r = await relaunchElevated();
    slog('提权结果: ' + JSON.stringify(r));
    if (r.ok) { app.exit(0); return; }
    addLog('提权未完成（可能取消了 UAC）：' + (r.error || ''));
    broadcast('fde:desktop', desktopPayload());
  }

  // 自检：npm start -- --fde-test-desk
  if (process.argv.includes('--fde-test-desk')) {
    const t = (s) => { console.log('[TD] ' + s); addLog('[测试] ' + s); };
    setTimeout(async () => {
      try {
        const p = data.projects[0];
        if (!p) { t('没有项目，无法测试'); return; }
        // 1) 面板是否贴齐左缘
        const wa1 = await readWorkArea();
        const r1 = await readRect(getHwndString(panelWin));
        t('面板矩形=' + JSON.stringify(r1) + ' 系统工作区=' + JSON.stringify(wa1));
        const bl = await detectBrowsers();
        t('检测到浏览器 ' + bl.length + ' 个: ' + bl.map(b => b.name).join(' / '));

        // 2) 切到项目桌面，在其中启动一个记事本（各系统用自带的文本编辑器）
        await switchDesktop(p.id);
        const testApp = IS_WIN
          ? { cmd: 'C:\\Windows\\System32\\notepad.exe', args: [], re: /notepad/i }
          : (IS_MAC
            ? { cmd: 'open', args: ['-a', 'TextEdit'], re: /textedit/i }
            : { cmd: 'xterm', args: [], re: /xterm/i });
        try {
          require('child_process').spawn(testApp.cmd, testApp.args, { detached: true, stdio: 'ignore' }).unref();
        } catch (e) { t('示例程序起不来: ' + testApp.cmd); }
        await new Promise(r => setTimeout(r, 4000));
        await collect(activeId);
        let list = await enumWindows();
        let np = list.filter(w => testApp.re.test(w.proc) || testApp.re.test(w.title));
        let rec = np.length ? winRecs.get(np[0].hwnd) : null;
        t('记事本窗口=' + JSON.stringify(np.map(w => ({ hwnd: w.hwnd, vis: w.vis, ic: w.iconic }))) +
          ' 归属=' + (rec ? rec.owner : '无') + ' 当前桌面=' + activeId);

        // 3) 回原桌面：记事本应被藏起来
        await switchDesktop('original');
        await new Promise(r => setTimeout(r, 1800));
        list = await enumWindows();
        np = list.filter(w => testApp.re.test(w.proc) || testApp.re.test(w.title));
        t('回原桌面后 记事本可见=' + (np.length ? np[0].vis : '窗口不存在'));

        // 4) 再切回项目：记事本应该重新出现
        await switchDesktop(p.id);
        await new Promise(r => setTimeout(r, 2200));
        list = await enumWindows();
        np = list.filter(w => testApp.re.test(w.proc) || testApp.re.test(w.title));
        t('切回项目后 记事本可见=' + (np.length ? np[0].vis : '窗口不存在') +
          ' 最小化=' + (np.length ? np[0].iconic : '-'));
        t('DONE');
        try {
          if (IS_WIN) {
            require('child_process').execFile('taskkill', ['/IM', 'notepad.exe', '/F'], { windowsHide: true }, () => {});
          } else if (np.length && np[0].pid) {
            const kp = platform.killPlan(np[0].pid);
            require('child_process').execFile(kp.cmd, kp.args, { windowsHide: true }, () => {});
          }
        } catch (e) {}
        setTimeout(() => { try { app.exit(0); } catch (e) {} }, 1500);
      } catch (e) {
        t('测试异常: ' + e.message);
      }
    }, 5000);
  }
  if (process.argv.includes('--fde-self-test')) {
    const t = (s) => { console.log('[selftest] ' + s); addLog('[自检] ' + s); };
    setTimeout(async () => {
      const target = data.projects[0];
      if (!target) { t('没有项目'); return; }
      t('权限=' + (isAdmin ? '管理员' : '普通') + ' · 切到项目: ' + target.name);
      const r1 = await switchDesktop(target.id);
      t('切换结果 ' + JSON.stringify(r1));
      setTimeout(async () => {
        const list = await enumWindows();
        t('项目桌面可见窗口: ' + list.filter(w => w.vis && !w.iconic)
          .map(w => w.proc + '「' + String(w.title).slice(0, 12) + '」').join(' , ') || '（无，干净）');
        t('无法隐藏: ' + uncontrollable.size + ' 个');
        const r2 = await switchDesktop('original');
        t('回原桌面 ' + JSON.stringify(r2));
        setTimeout(async () => {
          const list2 = await enumWindows();
          t('原桌面可见窗口: ' + list2.filter(w => w.vis && !w.iconic).length + ' 个');
          t('DONE');
        }, 1500);
      }, 2500);
    }, 3000);
  }
});

/* ---------- 平台相关：应用菜单 / Dock 唤醒 ---------- */
// macOS 的"应用菜单"是系统级的（窗口框架里没有菜单栏），
// 没有它连 Cmd+Q / Cmd+C 都没有；其它平台用无边框窗口，直接关掉默认菜单。
if (IS_MAC) {
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ]));
  } catch (e) {}
} else {
  try { Menu.setApplicationMenu(null); } catch (e) {}
}
app.on('activate', () => {
  // 点 Dock 图标：把面板亮出来（macOS 的常规交互）
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.show();
  panelWin.focus();
});

app.on('will-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  (async () => {
    try {
      // 退出前把所有被隐藏的窗口放出来，否则用户会以为软件丢了
      const all = Array.from(winRecs.keys());
      for (const rec of winRecs.values()) {
        if (rec.savedRect) await winCmd('MOVE|' + rec.hwnd + '|' + rec.savedRect.x + '|' + rec.savedRect.y, 3000);
      }
      if (all.length) await winCmd('SHOW|' + all.join(','), 4000);
      if (data.settings.originalWallpaper) await winCmd('WALL|' + data.settings.originalWallpaper, 4000);
      await winCmd('QUIT', 1500);
      await unregisterAppBar();
      try { globalShortcut.unregisterAll(); } catch (e) {}
      try { if (tray) { tray.destroy(); tray = null; } } catch (e) {}
    } catch (err) {
      console.error('退出清理失败:', err.message);
    }
    setTimeout(() => app.exit(0), 300);
  })();
});

app.on('window-all-closed', () => {
  app.quit();
});
