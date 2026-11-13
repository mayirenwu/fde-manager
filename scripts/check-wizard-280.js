/**
 * 新手向导在 280px 窄面板下的渲染检查：
 *  1) 三步逐屏扫溢出（元素右边界 > 面板宽、横向滚动、文字被裁）
 *  2) 每屏的可点控件必须完整落在视口内，或在可滚动区域内（不允许被藏起来）
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-wizard-280.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const W = 280;
const H = 820;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const projects = [
  { id: 'p1', name: '亚马逊运营', color: '#4f8cff', status: 'running', statusMsg: '3 个窗口', items: [], context: [], autorun: [], logs: [], inbox: {} }
];

app.whenReady().then(async () => {
  ipcMain.handle('project:add', () => ({ ok: true, project: { id: 'pw', name: '亚马逊运营', color: '#4f8cff', status: 'stopped', items: [], autorun: [], windows: [] } }));
  ipcMain.handle('overview:open', () => ({ ok: true }));
  ipcMain.handle('diag:stats', () => ({ ok: true, uptime: 300, memory: 120, version: '7.18.1', windows: { total: 0, whyCount: {} }, uncontrolled: 0, errLogs: [], crash: '' }));
  ipcMain.handle('data:get', () => ({
    projects, flows: [], logs: [], inbox: {}, trash: [],
    activeId: 'p1', originalCount: 0, uncontrolled: 0, isAdmin: true,
    settings: { wallpaper: true }
  }));

  const win = new BrowserWindow({
    width: W, height: H, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'panel.html'));
  // 清掉「向导已完成」标记并重载，模拟首次运行
  await win.webContents.executeJavaScript(`try { localStorage.removeItem('fdeWizardDone.v1'); } catch (e) {} 'ok'`);
  await win.webContents.reload();
  await wait(900);

  const visible = await win.webContents.executeJavaScript(`(() => {
    const w = document.getElementById('wiz');
    return { display: getComputedStyle(w).display, step: document.getElementById('wizStepNo').textContent };
  })()`);
  console.log('WIZ', JSON.stringify(visible));

  const scan = () => win.webContents.executeJavaScript(`(() => {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const box = document.getElementById('wiz');
    const bad = [];
    // 纵向溢出：整层能滚就 OK；横向绝对不允许
    document.querySelectorAll('#wiz *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.right > vw + 1) bad.push('RIGHT:' + (el.id || el.className || el.tagName) + ' ' + Math.round(r.right) + '>' + vw);
      if (r.left < -1) bad.push('LEFT:' + (el.id || el.className || el.tagName) + ' ' + Math.round(r.left));
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) bad.push('HSCROLL:' + (el.id || el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    });
    // 可点控件是否可达：要么在视口内，要么整层可滚动到它
    const scrollable = box.scrollHeight > box.clientHeight + 2;
    const ctrls = [...document.querySelectorAll('#wiz button, #wiz input')].filter(el => el.offsetParent !== null);
    ctrls.forEach(el => {
      const r = el.getBoundingClientRect();
      const insideViewport = r.top >= -1 && r.bottom <= vh + 1;
      const tooSmall = r.height < 24 || r.width < 40;
      if (!insideViewport && !scrollable) bad.push('HIDDEN:' + (el.id || el.className) + ' top=' + Math.round(r.top) + ' bottom=' + Math.round(r.bottom) + ' vh=' + vh);
      if (tooSmall) bad.push('SMALL:' + (el.id || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    const card = document.querySelector('.wizcard').getBoundingClientRect();
    return {
      vw, vh, cardW: Math.round(card.width), cardH: Math.round(card.height),
      boxScroll: box.scrollHeight, boxClient: box.clientHeight, scrollable,
      docScrollW: document.documentElement.scrollWidth,
      ctrls: ctrls.map(el => (el.id || el.className) + '@' + Math.round(el.getBoundingClientRect().top)),
      bad
    };
  })()`);

  const steps = [
    { name: 'step1', js: `'step1'` },
    { name: 'step2', js: `document.getElementById('wizProjName').value = '亚马逊运营'; document.getElementById('wizCreate').click(); 'step2'` },
    { name: 'step3', js: `document.getElementById('wizNext3').click(); 'step3'` }
  ];

  let fail = 0;
  for (const s of steps) {
    await win.webContents.executeJavaScript(s.js);
    await wait(350);
    const r = await scan();
    console.log('\n=== ' + s.name + ' ===');
    console.log(JSON.stringify(r));
    if (r.bad.length) { fail++; console.log('FAIL ' + s.name + ' 溢出/不可达：' + r.bad.join(' | ')); }
    if (r.docScrollW > r.vw + 1) { fail++; console.log('FAIL ' + s.name + ' 文档横向滚动 ' + r.docScrollW + '>' + r.vw); }
    const img = await win.capturePage();
    const out = path.join(os.tmpdir(), 'fde-wizard-280-' + s.name + '.png');
    fs.writeFileSync(out, img.toPNG());
    console.log('SHOT ' + out);
  }

  // 极窄（240px）兜底
  win.setSize(240, 700);
  await wait(400);
  const narrow = await scan();
  console.log('\n=== narrow240 ===');
  console.log(JSON.stringify(narrow));
  if (narrow.bad.length) { fail++; console.log('FAIL narrow240：' + narrow.bad.join(' | ')); }

  console.log(fail === 0 ? '\nALL OK：向导三步在窄面板下无溢出、控件全部可达' : '\nFAILED ' + fail + ' 项');
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
