/**
 * 面板在 280px 宽下的渲染检查：截 3 张图（顶部/项目区/底部），看有没有挤压、截断、横向溢出。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-panel-280.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const projects = [
  { id: 'p1', name: '亚马逊·美国站运营', color: '#4f8cff', status: 'running', statusMsg: '3 个窗口', items: [], context: [], autorun: [], logs: [], inbox: {} },
  { id: 'p2', name: '华南城供应商对账', color: '#22c55e', status: 'background', items: [], context: [], autorun: [], logs: [], inbox: {} },
  { id: 'p3', name: '独立站投放', color: '#f59e0b', status: 'task', statusMsg: '2 条待处理', items: [], context: [], autorun: [], logs: [], inbox: {} },
  { id: 'p4', name: '老客户维护（超长名字测试用）', color: '#a855f7', status: 'stopped', items: [], context: [], autorun: [], logs: [], inbox: {} }
];

app.whenReady().then(async () => {
  ipcMain.handle('project:add', (e, name) => ({ ok: true, project: { id: 'pw', name: String(name), color: '#4f8cff', status: 'stopped', items: [], autorun: [], windows: [] } }));
  ipcMain.handle('diag:stats', () => ({ ok: true, uptime: 300, memory: 120, version: '7.18.0', windows: { total: 6, whyCount: { ok: 4, parked: 1, 'show-failed': 1 } }, uncontrolled: 0, errLogs: [], crash: '' }));
  ipcMain.handle('data:get', () => ({
    projects, flows: [], logs: [], inbox: {},
    trash: [{ project: { id: 'p9', name: '已删项目' }, deletedAt: Date.now() }],
    activeId: 'p1', originalCount: 0, uncontrolled: 0, isAdmin: true,
    settings: { wallpaper: true }
  }));

  const win = new BrowserWindow({
    width: 280, height: 820, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(ROOT, 'panel.html'));
  await wait(900);
  // 把四组都展开，让内容最多，检查最挤的情况
  await win.webContents.executeJavaScript(`document.querySelectorAll('.grp').forEach(g => { if (!g.classList.contains('open')) g.querySelector('.grphead').click(); }); 'ok'`);
  await wait(600);
  const overflow = await win.webContents.executeJavaScript(`(() => {
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > 281 || r.left < -1)) bad.push((el.className || el.tagName) + ':' + Math.round(r.left) + '-' + Math.round(r.right));
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) bad.push('SCROLL:' + (el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    });
    return { bodyScrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth, bad: bad.slice(0, 12) };
  })()`);
  console.log('OVERFLOW', JSON.stringify(overflow));

  const img = await win.capturePage();
  const out = path.join(os.tmpdir(), 'fde-panel-280.png');
  require('fs').writeFileSync(out, img.toPNG());
  console.log('SHOT', out);

  // 再截一张只留默认收起状态的（用户日常第一眼看到的）
  await win.webContents.executeJavaScript(`document.querySelectorAll('.grp.open').forEach(g => g.querySelector('.grphead').click()); 'ok'`);
  await wait(400);
  const img2 = await win.capturePage();
  const out2 = path.join(os.tmpdir(), 'fde-panel-280-collapsed.png');
  require('fs').writeFileSync(out2, img2.toPNG());
  console.log('SHOT2', out2);
  app.quit();
}).catch(e => { console.error('FAIL', e); app.quit(1); });
