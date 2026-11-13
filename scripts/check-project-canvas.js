/**
 * 项目设置窗口：新增「画布」页（方向 / 保存 / AI 搭能力 / 节点列表 / 在画布中查看）
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-project-canvas.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const project = {
  id: 'p1', name: '亚马逊美国站运营', color: '#4f8cff', status: 'running', statusMsg: '3 个窗口',
  direction: '每天看订单、库存和广告', exclusive: true, items: [], context: [], autorun: [], logs: [], inbox: {}
};
const canvas = {
  nodes: [
    { id: 'n1', type: 'project', title: '亚马逊美国站运营', note: '', x: 0, y: 0, ref: { projectId: 'p1' } },
    { id: 'n2', type: 'ai', title: '订单日报分析', note: '每天汇总异常订单', x: 320, y: 0, ref: { projectId: 'p1' } },
    { id: 'n3', type: 'url', title: '卖家后台', note: '', x: 640, y: 0, ref: { projectId: 'p1', url: 'https://sellercentral.amazon.com' } },
    { id: 'n4', type: 'ai', title: '别的项目智能体', note: '', x: 960, y: 0, ref: { projectId: 'p2' } }
  ],
  edges: [], view: { x: 0, y: 0, z: 1 }
};
const calls = [];

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({
    projects: [project], flows: [], logs: [], inbox: {}, trash: [],
    activeId: 'p1', originalCount: 0, uncontrolled: 0, isAdmin: true, settings: { wallpaper: true }
  }));
  ipcMain.handle('canvas:get', () => {
    calls.push('canvas:get');
    return { ok: true, canvas, projects: [project], windows: [], activeId: 'p1' };
  });
  ipcMain.handle('project:set-direction', (e, p) => {
    calls.push(['set-direction', p]);
    project.direction = p.text;
    return { ok: true, direction: p.text };
  });
  ipcMain.handle('project:build-agents', (e, p) => {
    calls.push(['build-agents', p]);
    canvas.nodes.push({ id: 'n5', type: 'ai', title: '库存预警智能体', note: '低于安全库存马上报', x: 100, y: 100, ref: { projectId: 'p1' } });
    return { ok: true, summary: '搭好了：1 个节点', created: { nodes: ['库存预警智能体（ai）'], edges: [], scripts: [], projects: [] }, errors: [] };
  });
  ipcMain.handle('overview:open', (e, p) => { calls.push(['overview:open', p]); return { ok: true }; });
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('listbrowsers', () => ({ ok: true, browsers: [] }));
  ipcMain.handle('wallpaper:get', () => ({ ok: true, on: true }));

  const win = new BrowserWindow({
    width: 470, height: 680, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(msg.slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'project.html'), { query: { id: 'p1' } });
  await wait(900);

  let fail = 0;
  // 1) 切到画布页
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.tabs div')].find(t => t.dataset.pane === 'canvas').click(); 'ok'`);
  await wait(500);
  const st = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('#cvList .cvitem .t1')].map(e => e.textContent);
    return {
      dir: document.getElementById('dirInput').value,
      items,
      tag: document.getElementById('cvCount').textContent
    };
  })()`);
  console.log('PANE', JSON.stringify(st));
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-project-canvas.png'), (await win.capturePage()).toPNG());
  if (st.dir !== '每天看订单、库存和广告') { fail++; console.log('FAIL 方向没回填'); }
  if (!st.items.includes('订单日报分析') || !st.items.includes('卖家后台')) { fail++; console.log('FAIL 本项目节点没列出来'); }
  if (st.items.includes('别的项目智能体')) { fail++; console.log('FAIL 混进了别的项目的节点'); }

  // 2) 保存方向
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('dirInput').value = '改成：每天看订单和广告';
    document.getElementById('dirSave').click();
    return 'ok';
  })()`);
  await wait(500);
  const sd = calls.find(c => c[0] === 'set-direction');
  console.log('SAVE', JSON.stringify(sd));
  if (!sd || sd[1].text !== '改成：每天看订单和广告') { fail++; console.log('FAIL 方向没保存'); }

  // 3) AI 搭能力
  await win.webContents.executeJavaScript(`document.getElementById('dirBuild').click(); 'ok'`);
  await wait(800);
  const ba = calls.find(c => c[0] === 'build-agents');
  const after = await win.webContents.executeJavaScript(`(() => ({
    items: [...document.querySelectorAll('#cvList .cvitem .t1')].map(e => e.textContent),
    status: document.getElementById('dirStatus').textContent
  }))()`);
  console.log('BUILD', JSON.stringify(ba), 'AFTER', JSON.stringify(after));
  if (!ba || ba[1].id !== 'p1') { fail++; console.log('FAIL 搭能力没调对'); }
  if (!after.items.includes('库存预警智能体')) { fail++; console.log('FAIL 搭完列表没刷新'); }
  if (!/搭好了/.test(after.status)) { fail++; console.log('FAIL 状态没提示：' + after.status); }

  // 4) 在画布中查看
  await win.webContents.executeJavaScript(`document.getElementById('cvOpen').click(); 'ok'`);
  await wait(400);
  const ov = calls.find(c => c[0] === 'overview:open');
  console.log('OPEN-CANVAS', JSON.stringify(ov));
  if (!ov || ov[1].projectId !== 'p1' || ov[1].view !== 'canvas') { fail++; console.log('FAIL 在画布中查看参数不对'); }

  if (errs.length) { fail++; console.log('FAIL 控制台报错：' + errs.join(' | ')); }
  console.log(fail === 0 ? '\nALL OK' : '\nFAILED ' + fail);
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
