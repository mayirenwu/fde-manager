/**
 * 桌面归属 / 窗口显隐判定 单测：node test-desktop.js
 * 覆盖现场最容易踩的几类"窗口该在却不显示"：
 *   1. 同一个软件在原桌面开过，切到项目里再开窗口 → 必须留在当前项目
 *   2. 窗口记录瞬时消失（UWP 挂起 / 标题为空）→ 归属不能丢
 *   3. 窗口被搬到屏幕外（-30000）→ 切回来必须搬回来
 *   4. 显示器变化导致窗口留在不存在的区域 → 要求救回
 */
const d = require('./desktop');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  得到 ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want)));
  ok ? pass++ : fail++;
};
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (extra || '')));
  cond ? pass++ : fail++;
};

const EB = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TRADE = 'D:\\同花顺\\hexin.exe';

// 造一个 ctx：默认什么都不知道
function mkCtx(over) {
  return Object.assign({
    assignNewTo: 'pA',
    ownerOfPid: () => undefined,
    ownerOfProc: () => undefined,
    isOldProcess: () => false,
    ownerOfApp: () => undefined,
    parentOwner: () => undefined,
    parentAppOwner: () => undefined
  }, over || {});
}

console.log('\n[1] 基本归属');
{
  // 同一进程已有窗口 → 跟随进程
  const r = d.decideOwner({ pid: 10, exe: EB, vis: true }, mkCtx({ ownerOfPid: () => null }));
  eq('同进程窗口跟随原桌面', r, { owner: null, via: 'pid' });

  // 全新软件 → 当前桌面
  const r2 = d.decideOwner({ pid: 11, exe: 'D:\\foo\\bar.exe', vis: true }, mkCtx({}));
  eq('全新软件落到当前桌面', r2, { owner: 'pA', via: 'current' });

  // 无主工具窗口 → 不接管
  const r3 = d.decideOwner({ pid: 12, exe: 'C:\\x\\popup.exe', tool: true }, mkCtx({}));
  eq('无主工具窗口不接管', r3, { owner: undefined, via: 'skip' });
}

console.log('\n[2] 老进程 + 同软件（Chrome 在原桌面开过）');
{
  const ctx = mkCtx({
    isOldProcess: () => true,
    ownerOfApp: () => null
  });
  // 后台弹出的窗口（非前台）→ 跟随原桌面，保持软件窗口聚在同一桌面
  eq('后台窗口跟随同软件归属', d.decideOwner({ pid: 21, exe: EB, vis: true }, ctx), { owner: null, via: 'app' });
  // 用户在当前桌面刚点开的新窗口（前台）→ 必须留在当前桌面
  eq('用户在项目里新开的窗口留在项目', d.decideOwner({ pid: 21, exe: EB, vis: true, fg: true }, ctx), { owner: 'pA', via: 'fg' });
  // 已经在当前桌面的老进程，窗口不用搬家
  const ctx2 = mkCtx({ assignNewTo: 'pA', isOldProcess: () => true, ownerOfApp: () => 'pA' });
  eq('归属一致时不改写', d.decideOwner({ pid: 22, exe: EB, vis: true, fg: true }, ctx2), { owner: 'pA', via: 'app' });
  // 前台但不可见（系统偷偷创建）不享受覆盖
  eq('不可见的新窗口不按前台断言', d.decideOwner({ pid: 23, exe: EB, vis: false, fg: true }, ctx), { owner: null, via: 'app' });
  // 工具窗（提示条/气泡）不受前台规则影响，避免提示条被拽到别的桌面
  eq('工具窗不走前台覆盖', d.decideOwner({ pid: 24, exe: EB, vis: true, fg: true, tool: true }, ctx), { owner: null, via: 'app' });
}

console.log('\n[3] 进程级记忆（窗口记录消失也不丢归属）');
{
  // 窗口记录被清理后，同 pid 又出现新窗口：靠 proc 记忆找回项目
  const ctx = mkCtx({ ownerOfPid: () => undefined, ownerOfProc: () => 'pB' });
  eq('窗口记录消失后仍认回原项目', d.decideOwner({ pid: 31, exe: TRADE, vis: true }, ctx), { owner: 'pB', via: 'proc' });
  // 原电脑桌面的记忆同样有效
  const ctx2 = mkCtx({ ownerOfProc: () => null });
  eq('记忆是原桌面也生效', d.decideOwner({ pid: 32, exe: TRADE, vis: true }, ctx2), { owner: null, via: 'proc' });
  // 进程级记忆优先于"老进程同软件"的粗规则
  const ctx3 = mkCtx({ ownerOfProc: () => 'pC', isOldProcess: () => true, ownerOfApp: () => null });
  eq('记忆优先于软件级规则', d.decideOwner({ pid: 33, exe: TRADE, vis: true }, ctx3), { owner: 'pC', via: 'proc' });
}

console.log('\n[4] 父进程继承');
{
  const ctx = mkCtx({ parentOwner: () => 'pD' });
  eq('跟随父进程桌面', d.decideOwner({ pid: 41, exe: 'C:\\t\\sub.exe', vis: true }, ctx), { owner: 'pD', via: 'parent' });
  // 父进程没有可见窗口，用父进程 exe 的软件归属兜底
  const ctx2 = mkCtx({ parentOwner: () => undefined, parentAppOwner: () => 'pE' });
  eq('父进程 exe 软件归属兜底', d.decideOwner({ pid: 42, exe: 'C:\\t\\sub2.exe', vis: true }, ctx2), { owner: 'pE', via: 'parent' });
  // 父进程属于原桌面时不继承（否则资源管理器拉起的程序会跑错桌面）
  const ctx3 = mkCtx({ parentOwner: () => null });
  eq('父进程在原桌面则不继承', d.decideOwner({ pid: 43, exe: 'C:\\t\\sub3.exe', vis: true }, ctx3), { owner: 'pA', via: 'current' });
}

console.log('\n[5] 屏幕外判定');
{
  const union = { l: 0, t: 0, r: 2560, b: 1440 };
  ok('我们自己搬走的 (-30000) 算屏幕外', d.isOffscreen(-30000, -30000, union));
  ok('超过右边界算屏幕外', d.isOffscreen(2550, 200, union));
  ok('超过下边界算屏幕外', d.isOffscreen(200, 1420, union));
  ok('左边界外很远算屏幕外', d.isOffscreen(-900, 100, union));
  ok('正常窗口不算', !d.isOffscreen(120, 90, union));
  ok('贴左边缘的窗口不算', !d.isOffscreen(-60, 90, union));
  // 双屏：副屏在左边，负坐标是合法的
  const u2 = { l: -1920, t: 0, r: 2560, b: 1440 };
  ok('副屏在左侧时负坐标不算屏幕外', !d.isOffscreen(-1800, 120, u2));
  // 显示器联合范围
  const u3 = d.unionOfDisplays([
    { bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 }
  ]);
  eq('联合范围覆盖两个屏', u3, { l: -1920, t: 0, r: 2560, b: 1440 });
}

console.log('\n[6] 显隐计划（切到项目桌面时该怎么动）');
{
  const union = { l: 0, t: 0, r: 2560, b: 1440 };
  const home = { x: 440, y: 80 };
  const P = (w) => d.windowPlan(Object.assign({ vis: true, iconic: false, title: '窗口', x: 100, y: 100 }, w), { forceShowOwned: true, union, home });

  eq('正常可见窗口不动', P({}), { act: 'none', moveTo: null, reason: 'ok' });
  eq('被我们藏起来的窗口要显示', P({ vis: false, hiddenByUs: true }), { act: 'show', moveTo: null, reason: 'hidden-by-us' });
  eq('托盘隐藏的窗口（不可见无记录）切换时也要叫出来', P({ vis: false }), { act: 'show', moveTo: null, reason: 'not-visible' });
  eq('搬到屏幕外的可见窗口要搬回来', P({ x: -30000, y: -30000, savedRect: { x: 320, y: 180 } }),
    { act: 'move', moveTo: { x: 320, y: 180 }, reason: 'parked' });
  eq('搬出去又被隐藏的窗口要搬回并显示', P({ x: -30000, y: -30000, vis: false, savedRect: { x: 300, y: 120 } }),
    { act: 'move+show', moveTo: { x: 300, y: 120 }, reason: 'parked' });
  eq('没有存档坐标时用默认落点', P({ x: -30000, y: -30000, vis: false }), { act: 'move+show', moveTo: home, reason: 'parked' });
  eq('用户自己最小化的窗口保持最小化', P({ vis: true, iconic: true }), { act: 'none', moveTo: null, reason: 'minimized' });
  eq('我们顺手最小化的窗口要还原', P({ vis: true, iconic: true, hiddenByUs: true }), { act: 'show', moveTo: null, reason: 'hidden-by-us' });
  eq('管理员权限窗口如实报出来', P({ vis: false, uncontrollable: true }), { act: 'skip', moveTo: null, reason: 'uncontrollable' });
  eq('管理员权限但正常显示的窗口不动也不报警', P({ uncontrollable: true }), { act: 'none', moveTo: null, reason: 'uncontrollable' });
  eq('非强制模式下不碰"自己不可见"的窗口', d.windowPlan({ vis: false, iconic: false, title: 'x', x: 100, y: 100 },
    { forceShowOwned: false, union, home }), { act: 'skip', moveTo: null, reason: 'not-visible' });
  eq('空标题窗口不强拉（避免闪一下系统辅助窗）', d.windowPlan({ vis: false, iconic: false, title: '  ', x: 100, y: 100 },
    { forceShowOwned: true, union, home }), { act: 'skip', moveTo: null, reason: 'no-title' });
}

console.log('\n' + (fail ? '✗ 失败 ' + fail + ' 项' : '✓ 全部通过') + '（通过 ' + pass + ' 项）');
process.exit(fail ? 1 : 0);
