/**
 * 画布「从项目跳进来定位」：overview.html?proj=p1 应把视角对准该项目的节点并选中
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-canvas-focus.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const project = { id: 'p1', name: '亚马逊运营', color: '#4f8cff', status: 'stopped', statusMsg: '', items: [], context: [], autorun: [], logs: [], inbox: {} };
const canvas = {
  nodes: [
    { id: 'n1', type: 'project', title: '亚马逊运营', note: '', x: 800, y: 600, w: 240, h: 0, ref: { projectId: 'p1' }, collapsed: false, locked: false, tags: [], z: 0 },
    { id: 'n2', type: 'note', title: '别人的笔记', note: '', x: -500, y: -400, w: 240, h: 0, ref: {}, collapsed: false, locked: false, tags: [], z: 0 }
  ],
  edges: [], view: { x: 0, y: 0, z: 1 }
};

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({ projects: [project], flows: [], logs: [], inbox: {}, trash: [], activeId: 'p1', originalCount: 0, uncontrolled: 0, isAdmin: true, settings: {} }));
  ipcMain.handle('canvas:get', () => ({ ok: true, canvas, projects: [project], windows: [], activeId: 'p1' }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));

  const win = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(ROOT, 'overview.html'), { query: { view: 'canvas', proj: 'p1' } });
  await wait(1500);
  const r = await win.webContents.executeJavaScript(`(() => ({
    sel: [...sel],
    view: C.view,
    n1: (() => { const el = document.querySelector('[data-id="n1"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), vw: innerWidth, vh: innerHeight, vis: b.width > 0 }; })()
  }))()`);
  console.log('FOCUS', JSON.stringify(r));
  let fail = 0;
  if (!r.sel.includes('n1')) { fail++; console.log('FAIL 项目节点没被选中'); }
  const c = r.n1;
  if (!c || !c.vis) { fail++; console.log('FAIL 项目节点不可见'); }
  else if (Math.abs(c.x - c.vw / 2) > 120 || Math.abs(c.y - c.vh / 2) > 160) { fail++; console.log('FAIL 没居中：' + JSON.stringify(c)); }
  console.log(fail === 0 ? 'ALL OK：画布按项目定位成功' : 'FAILED ' + fail);
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
