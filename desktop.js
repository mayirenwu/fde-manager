/**
 * 桌面归属 / 窗口显隐判定（纯函数，便于单测）
 *
 * 这里只做"判断"，不碰 Win32。main.js 负责真正去 HIDE/SHOW/MOVE。
 * 之所以单独拆出来：这两组规则是这个软件最容易出错的地方（窗口跑到别的桌面、
 * 切过来却看不见），必须有可回归的用例，而不是靠现场试。
 */

/** 可执行文件路径归一（Windows 不区分大小写） */
function exeKey(exe) {
  return String(exe || '').trim().toLowerCase();
}

/** 「同一个软件」的归并键：同一安装目录下的多个进程算一个软件 */
function appKey(exe) {
  const s = exeKey(exe);
  if (!s) return '';
  const dir = s.replace(/[\\/][^\\/]+$/, '');
  if (!dir || /^[a-z]:$/.test(dir)) return s;
  if (/[\\/]windows([\\/]|$)/.test(dir)) return s;
  if (/[\\/](desktop|downloads|temp|tmp)$/.test(dir)) return s;
  return 'dir:' + dir;
}

/**
 * 判断一个新窗口该归哪个桌面。
 *
 * @param {object} w        窗口：{ pid, exe, fg, vis, tool }
 * @param {object} ctx      环境：
 *   ownerOfPid(pid)        同一进程已有窗口的归属（undefined = 没有）
 *   ownerOfProc(pid, exe)  进程级归属记忆（窗口记录瞬时消失也不会丢）
 *   isOldProcess(pid)      切换桌面那一刻就已存在的进程
 *   ownerOfApp(key)        同一软件的归属（含用户手动指定）
 *   parentOwner(pid)       父进程的归属
 *   assignNewTo            拿不准时新窗口落到哪个桌面（当前桌面）
 * @returns {{owner:any, via:string}}  via: pid|proc|app|parent|fg|current|skip
 *          owner === undefined 表示"不接管"（无主的工具窗口）
 */
function decideOwner(w, ctx) {
  const pid = w && w.pid;
  const exe = w && w.exe;
  const cur = ctx.assignNewTo;

  // 1) 同一进程已有窗口 → 跟随该进程（多窗口软件的最强信号）
  const byPid = ctx.ownerOfPid(pid);
  if (byPid !== undefined) return { owner: byPid, via: 'pid' };

  // 2) 进程级记忆：窗口记录可能因为 cloaked/标题为空短暂消失，
  //    但"这个 pid 属于哪个桌面"不该丢，否则同程序新窗口会被当成新软件。
  const byProc = ctx.ownerOfProc(pid, exe);
  if (byProc !== undefined) return { owner: byProc, via: 'proc' };

  let guess;
  let via = 'current';

  // 3) 老进程 + 同一软件已有归属 → 跟随该软件
  if (ctx.isOldProcess(pid)) {
    const byApp = ctx.ownerOfApp(appKey(exe));
    if (byApp !== undefined) { guess = byApp; via = 'app'; }
  }

  // 4) 父进程归属继承（交易软件常"另起进程"弹下单窗/预警条）
  if (guess === undefined) {
    const po = ctx.parentOwner(pid);
    if (po !== undefined && po !== null) { guess = po; via = 'parent'; }
    else if (po === undefined) {
      // 父进程 exe 的软件归属兜底
      const pa = ctx.parentAppOwner ? ctx.parentAppOwner(pid) : undefined;
      if (pa !== undefined && pa !== null) { guess = pa; via = 'parent'; }
    }
  }

  // 5) 用户在当前桌面上"刚打开"的窗口（前台、可见、非工具窗）就留在当前桌面。
  //    没有这一条，浏览器 / Office 这类"原桌面已经开过一次"的软件，新窗口会被
  //    第 3 条搬回原桌面 —— 用户看到的就是"点了没反应 / 窗口不见了"。
  const userJustOpened = !!(w.fg && w.vis && !w.tool);
  if (userJustOpened && cur !== undefined && guess !== cur) {
    // 例外：本桌面自己的窗口已经在这儿了，不需要改写（只有"别的桌面"才改写）
    return { owner: cur, via: 'fg' };
  }

  if (guess !== undefined) return { owner: guess, via };

  // 6) 全新的普通软件 → 当前桌面；工具窗口无主 → 不接管（否则提示条会跑进每个桌面）
  if (w.tool) return { owner: undefined, via: 'skip' };
  return { owner: cur, via: 'current' };
}

/**
 * 显示器联合范围（物理像素）。用于识别"窗口在屏幕外"。
 * 坐标来自 Win32（物理像素），Electron 的 bounds 是 DIP，所以要乘缩放比。
 */
function unionOfDisplays(displays) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const d of displays || []) {
    const sf = d.scaleFactor || 1;
    const bx = d.bounds ? d.bounds.x : 0;
    const by = d.bounds ? d.bounds.y : 0;
    const bw = d.bounds ? d.bounds.width : 0;
    const bh = d.bounds ? d.bounds.height : 0;
    l = Math.min(l, Math.round(bx * sf));
    t = Math.min(t, Math.round(by * sf));
    r = Math.max(r, Math.round((bx + bw) * sf));
    b = Math.max(b, Math.round((by + bh) * sf));
  }
  if (!isFinite(l) || r <= l) return null;
  return { l, t, r, b };
}

/**
 * 窗口是否在屏幕外（看不见）。
 * 两种来源：我们自己把它搬到 (-30000,-30000)；或者显示器变化后窗口留在了不存在的区域。
 */
function isOffscreen(x, y, union) {
  const px = Number(x) || 0;
  const py = Number(y) || 0;
  if (px < -10000 || py < -10000) return true;
  if (!union) return false;
  if (px > union.r - 60) return true;      // 起点已越过右边界
  if (py > union.b - 40) return true;      // 起点已越过下边界
  if (px < union.l - 120) return true;     // 起点在左边界之外
  if (py < union.t - 120) return true;     // 起点在上边界之外
  return false;
}

/**
 * 决定一个属于当前桌面的窗口该怎么处理。
 *
 * @param {object} w { vis, iconic, title, x, y, hiddenByUs, wasIconic, savedRect, uncontrollable }
 * @param {object} o { forceShowOwned, union, home:{x,y} }
 * @returns {{act:string, moveTo:object|null, reason:string}}
 *   act: none | show | showmin | move | move+show | skip
 *   reason: ok | minimized | parked | hidden-by-us | not-visible | no-title | uncontrollable
 */
function windowPlan(w, o) {
  const opt = o || {};
  const titled = String(w.title || '').trim() !== '';
  const parked = isOffscreen(w.x, w.y, opt.union);
  const moveTo = w.savedRect || (parked ? (opt.home || null) : null);

  if (w.uncontrollable) {
    // 管理员权限程序：藏不掉也基本叫不动，明确报出来，不假装成功
    return { act: (w.vis && !w.iconic && !parked) ? 'none' : 'skip', moveTo: null, reason: 'uncontrollable' };
  }

  // 看得见、也没在屏幕外 → 不需要动
  if (w.vis && !w.iconic && !parked) return { act: 'none', moveTo: null, reason: 'ok' };

  // 在屏幕外：必须搬回来，否则"显示成功"了用户也看不见
  if (parked) {
    if (!moveTo) return { act: w.vis ? 'none' : 'skip', moveTo: null, reason: 'parked' };
    if (!w.vis) return { act: 'move+show', moveTo, reason: 'parked' };
    if (w.iconic) return { act: 'move+show', moveTo, reason: 'parked' };
    return { act: 'move', moveTo, reason: 'parked' };
  }

  // 最小化：我们自己最小化的（跟着隐藏时）要还原，用户自己最小化的保持不动
  if (w.vis && w.iconic) {
    if (w.hiddenByUs || w.wasIconic) return { act: 'show', moveTo: null, reason: 'hidden-by-us' };
    return { act: 'none', moveTo: null, reason: 'minimized' };
  }

  // 不可见
  if (w.hiddenByUs || w.savedRect) {
    if (!titled) return { act: 'show', moveTo: null, reason: 'hidden-by-us' };
    return { act: 'show', moveTo: null, reason: 'hidden-by-us' };
  }
  if (opt.forceShowOwned && titled) return { act: 'show', moveTo: null, reason: 'not-visible' };
  return { act: 'skip', moveTo: null, reason: titled ? 'not-visible' : 'no-title' };
}

module.exports = {
  exeKey, appKey, decideOwner, unionOfDisplays, isOffscreen, windowPlan
};
