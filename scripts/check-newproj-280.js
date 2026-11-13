/**
 * 280px 面板：新建项目浮层（名字 + 方向 + 创建/AI搭能力）+ 项目卡上的画布入口
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-newproj-280.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const W = 280, H = 820;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let projects = [
  { id: 'p1', name: '亚马逊运营', color: '#4f8cff', status: 'running', statusMsg: '3 个窗口', direction: '每天看订单和库存', items: [], context: [], autorun: [], logs: [], inbox: {} }
];
const calls = [];

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({
    projects, flows: [], logs: [], inbox: {}, trash: [], activeId: 'p1',
    originalCount: 0, uncontrolled: 0, isAdmin: true, settings: { wallpaper: true }
  }));
  ipcMain.handle('project:add', (e, payload) => {
    calls.push(['project:add', payload]);
    const name = (payload && payload.name) || '';
    const p = { id: 'p9', name, direction: (payload && payload.opts && payload.opts.direction) || '', color: '#22c55e', status: 'stopped', statusMsg: '空桌面', items: [], context: [], autorun: [], logs: [], inbox: {} };
    projects.push(p);
    return { ok: true, project: p };
  });
  ipcMain.handle('project:build-agents', (e, payload) => {
    calls.push(['build-agents', payload]);
    return { ok: true, summary: '搭好了：3 个节点、2 条连线', created: { nodes: ['订单日报分析（ai）'], edges: ['a→b'], scripts: [], projects: [] }, errors: [] };
  });
  ipcMain.handle('overview:open', (e, payload) => { calls.push(['overview:open', payload]); return { ok: true }; });
  ipcMain.handle('diag:stats', () => ({ ok: true, uptime: 1, memory: 1, version: '7.18.2', windows: { total: 0, whyCount: {} }, uncontrolled: 0, errLogs: [], crash: '' }));

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(msg); });
  await win.loadFile(path.join(ROOT, 'panel.html'));
  await wait(800);

  const scan = () => win.webContents.executeJavaScript(`(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('#np *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      if (r.right > vw + 1) bad.push('RIGHT:' + (el.id || el.className || el.tagName) + ' ' + Math.round(r.right) + '>' + vw);
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) bad.push('HS:' + (el.id || el.className || el.tagName));
      if (['BUTTON', 'INPUT', 'TEXTAREA'].includes(el.tagName) && (r.height < 22 || r.width < 36)) bad.push('SMALL:' + (el.id || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    const np = document.getElementById('np');
    const card = np.querySelector('.wizcard').getBoundingClientRect();
    return { vw, npDisplay: getComputedStyle(np).display, cardW: Math.round(card.width), bad };
  })()`);

  // 1) 点「＋ 新建」→ 浮层
  await win.webContents.executeJavaScript(`document.getElementById('addProjectBtn').click(); 'ok'`);
  await wait(400);
  const r1 = await scan();
  console.log('OPEN', JSON.stringify(r1));
  let fail = 0;
  if (r1.bad.length) { fail++; console.log('FAIL 浮层溢出/过小：' + r1.bad.join(' | ')); }
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-newproj-280.png'), (await win.capturePage()).toPNG());

  // 2) 填名字+方向 → 创建
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('npName').value = '华南城供应商对账';
    document.getElementById('npDir').value = '每月把供应商账单和 ERP 对一遍，差异列出来';
    document.getElementById('npCreate').click();
    return 'ok';
  })()`);
  await wait(900);
  const afterCreate = await win.webContents.executeJavaScript(`(() => ({
    np: getComputedStyle(document.getElementById('np')).display,
    names: [...document.querySelectorAll('#projectList .name')].map(e => e.textContent)
  }))()`);
  console.log('CREATE', JSON.stringify(afterCreate), 'calls=' + JSON.stringify(calls));
  const add = calls.find(c => c[0] === 'project:add');
  if (!add || add[1].name !== '华南城供应商对账' || add[1].opts.direction === '') { fail++; console.log('FAIL 新建项目没带上名字/方向'); }
  if (afterCreate.np !== 'none') { fail++; console.log('FAIL 创建后浮层没关'); }
  if (!afterCreate.names.includes('华南城供应商对账')) { fail++; console.log('FAIL 列表没出现新项目'); }

  // 3) 项目卡的 🎨 → 打开画布并定位本项目
  await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('#projectList .ops button')];
    const cv = btns.find(b => b.textContent === '🎨');
    if (cv) cv.click();
    return cv ? 'ok' : 'missing';
  })()`);
  await wait(500);
  const ov = calls.find(c => c[0] === 'overview:open');
  console.log('CANVAS', JSON.stringify(ov));
  if (!ov || ov[1].projectId !== 'p1' || ov[1].view !== 'canvas') { fail++; console.log('FAIL 卡片画布入口参数不对'); }

  if (errs.length) { fail++; console.log('FAIL 控制台报错：' + errs.slice(0, 4).join(' | ')); }
  console.log(fail === 0 ? '\nALL OK' : '\nFAILED ' + fail);
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
