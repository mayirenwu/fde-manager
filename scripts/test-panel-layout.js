/**
 * 左侧面板折叠布局测试。
 * 验证：分组默认收起、点击展开、展开状态在重新打开后仍保留、项目计数显示。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/test-panel-layout.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const projects = [
  { id: 'p1', name: '亚马逊·美国站运营', color: '#4f8cff', status: 'running', statusMsg: '3 个窗口', items: [], context: [], autorun: [], logs: [], inbox: {} },
  { id: 'p2', name: '华南城供应商对账', color: '#22c55e', status: 'background', items: [], context: [], autorun: [], logs: [], inbox: {} },
  { id: 'p3', name: '独立站投放', color: '#f59e0b', status: 'task', statusMsg: '2 条待处理', items: [], context: [], autorun: [], logs: [], inbox: {} },
  { id: 'p4', name: '老客户维护', color: '#a855f7', status: 'stopped', items: [], context: [], autorun: [], logs: [], inbox: {} }
];

app.whenReady().then(async () => {
  ipcMain.handle('project:add', (e, name) => ({ ok: true, project: { id: 'pw', name: String(name), color: '#4f8cff', status: 'stopped', items: [], autorun: [], windows: [] } }));
  ipcMain.handle('diag:stats', () => ({
    ok: true, uptime: 300, memory: 120, version: '7.16.0',
    windows: { total: 6, whyCount: { ok: 4, parked: 1, 'show-failed': 1 } },
    uncontrolled: 0,
    errLogs: [{ time: Date.now(), text: '窗口叫不出来: demo「测试」' }],
    crash: ''
  }));
  ipcMain.handle('data:get', () => ({
    projects,
    flows: [],
    logs: [],
    inbox: {},
    trash: [{ project: { id: 'p9', name: '已删项目' }, deletedAt: Date.now() }],
    activeId: 'p1',
    originalCount: 0,
    uncontrolled: 0,
    isAdmin: true,
    settings: { wallpaper: true }
  }));

  const win = new BrowserWindow({
    width: 380, height: 780, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await win.loadFile(path.join(ROOT, 'panel.html'));
  await wait(700);

  // 清掉上次运行残留的折叠状态，从干净基线开始
  await win.webContents.executeJavaScript(`localStorage.removeItem('fde.panel.groups'); 'ok'`);
  await win.reload();
  await wait(700);

  const shot1 = path.join(os.tmpdir(), 'fde-panel-collapsed.png');
  fs.writeFileSync(shot1, (await win.webContents.capturePage()).toPNG());

  const stateA = await win.webContents.executeJavaScript(`(() => ({
    groups: [...document.querySelectorAll('.grp')].map(g => ({ key: g.dataset.grp, open: g.classList.contains('open') })),
    projCount: document.getElementById('projCount').textContent,
    visibleHeight: document.querySelector('main').scrollHeight,
    clientHeight: document.querySelector('main').clientHeight
  }))()`);

  // 展开「工作台」
  await win.webContents.executeJavaScript(`document.querySelector('[data-grp="work"] .grphead').click(); 'ok'`);
  await wait(200);
  const stateB = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('[data-grp="work"]');
    return { open: g.classList.contains('open'), bodyVisible: g.querySelector('.grpbody').offsetHeight > 0 };
  })()`);
  const shot2 = path.join(os.tmpdir(), 'fde-panel-expanded.png');
  fs.writeFileSync(shot2, (await win.webContents.capturePage()).toPNG());

  // 重新加载，看是否记住
  await win.reload();
  await wait(700);
  const stateC = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('[data-grp="work"]');
    return { open: g.classList.contains('open') };
  })()`);

  // 折叠是否真的省空间：展开全部再对比内容高度
  await win.webContents.executeJavaScript(`document.querySelectorAll('.grp .grphead').forEach(h => h.click()); 'ok'`);
  await wait(250);
  const stateD = await win.webContents.executeJavaScript(`(() => {
    const openH = document.querySelector('main').scrollHeight;
    document.querySelectorAll('.grp .grphead').forEach(h => h.click());
    return openH;
  })()`);

  // ---------- 新手向导与诊断看板 ----------
  await win.webContents.executeJavaScript(`localStorage.removeItem('fdeWizardDone.v1'); 'ok'`);
  await win.reload();
  await wait(700);
  const wiz1 = await win.webContents.executeJavaScript(`(() => ({
    on: document.getElementById('wiz').style.display !== 'none' && document.getElementById('wiz').style.display !== '',
    step1: document.getElementById('wizStep1').style.display === 'block'
  }))()`);
  await win.webContents.executeJavaScript(`document.getElementById('wizProjName').value = '向导测试项目'; document.getElementById('wizCreate').click(); 'ok'`);
  await wait(400);
  const wiz2 = await win.webContents.executeJavaScript(`(() => ({
    step2: document.getElementById('wizStep2').style.display === 'block',
    stepNo: document.getElementById('wizStepNo').textContent
  }))()`);
  await win.webContents.executeJavaScript(`document.getElementById('wizNext3').click(); 'ok'`);
  await wait(200);
  const wiz3 = await win.webContents.executeJavaScript(`document.getElementById('wizStep3').style.display === 'block'`);
  await win.webContents.executeJavaScript(`document.getElementById('wizFinish').click(); 'ok'`);
  await wait(200);
  const wizClosed = await win.webContents.executeJavaScript(`document.getElementById('wiz').style.display === 'none'`);

  const diagState = await (async () => {
    await win.webContents.executeJavaScript(`document.getElementById('diagBtn').click(); 'ok'`);
    await wait(300);
    const st = await win.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('diagBoard');
      return { on: !!b, text: b ? b.textContent : '' };
    })()`);
    await win.webContents.executeJavaScript(`const b = document.getElementById('diagBoard'); if (b) b.remove(); 'ok'`);
    return st;
  })();

  const results = [
    { name: '向导首次启动出现', ok: wiz1.on && wiz1.step1, detail: JSON.stringify(wiz1) },
    { name: '向导建项目进第二步', ok: wiz2.step2 && /2/.test(wiz2.stepNo), detail: JSON.stringify(wiz2) },
    { name: '向导第三步可到并可跳过', ok: wiz3 && wizClosed, detail: `step3=${wiz3} closed=${wizClosed}` },
    { name: '诊断看板打开且有分布与异常', ok: diagState.on && diagState.text.indexOf('窗口状态分布') >= 0 && diagState.text.indexOf('叫不出来') >= 0 && diagState.text.indexOf('窗口叫不出来') >= 0, detail: (diagState.text || '').slice(0, 80) },
    { name: '四组默认收起', ok: stateA.groups.length === 4 && stateA.groups.every(g => !g.open), detail: JSON.stringify(stateA.groups) },
    { name: '项目数量显示', ok: /4/.test(stateA.projCount), detail: `h2 = "项目桌面 ${stateA.projCount}"` },
    { name: '点标题展开', ok: stateB.open && stateB.bodyVisible, detail: `open=${stateB.open} body=${stateB.bodyVisible}` },
    { name: '重开后记得展开', ok: stateC.open === true, detail: `work.open=${stateC.open}` },
    { name: '折叠确实省空间', ok: stateD - stateA.visibleHeight > 200, detail: `收起 ${stateA.visibleHeight}px → 全展开 ${stateD}px（省 ${stateD - stateA.visibleHeight}px）` }
  ];

  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log((r.ok ? '✓' : '✗') + ' ' + r.name + ' — ' + r.detail);
  }
  console.log('截图: ' + shot1 + ' · ' + shot2);
  win.destroy();
  app.exit(allOk ? 0 : 1);
});
