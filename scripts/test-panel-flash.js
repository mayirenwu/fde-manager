/**
 * 设置面板「闪两下」回归测试。
 * 验证：panel:flash 到达渲染页后，窗口出现两轮描边闪光 + 顶部标签提示，1.8 秒后自动恢复。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/test-panel-flash.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({
    projects: [{
      id: 'p1', name: '亚马逊·美国站运营', color: '#4f8cff', status: 'running',
      items: [], context: [], autorun: [], logs: [], inbox: {}
    }],
    flows: [], logs: [], inbox: {}, stats: {}
  }));
  ipcMain.handle('browsers:list', () => ({ ok: true, list: [] }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));

  const win = new BrowserWindow({
    width: 470, height: 680, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });
  await win.loadFile(path.join(ROOT, 'project.html'), { query: { id: 'p1' } });
  await wait(600);

  const before = await win.webContents.executeJavaScript("document.body.className");

  // 第一次闪光：捕捉动画中间帧
  win.webContents.send('panel:flash');
  await wait(230);
  const mid = await win.webContents.executeJavaScript(`(() => ({
    cls: document.body.className,
    tip: document.getElementById('openedTip')?.textContent || '',
    tipOn: document.getElementById('openedTip')?.classList.contains('on') || false
  }))()`);
  const png1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-panel-flash.png'), png1.toPNG());

  await wait(360);
  const png2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-panel-flash2.png'), png2.toPNG());

  // 收尾：1.8s 后应恢复
  await wait(1500);
  const after = await win.webContents.executeJavaScript("document.body.className");

  const results = [
    { name: '触发 flash 类', ok: mid.cls.includes('flash2'), detail: `class="${mid.cls}"` },
    { name: '顶部标签出现', ok: mid.tipOn && mid.tip.includes('亚马逊'), detail: mid.tip || '(无)' },
    { name: '动画结束自动清除', ok: !after.includes('flash2'), detail: `class="${after}"` },
    { name: '初始状态干净', ok: !before.includes('flash2'), detail: `class="${before}"` }
  ];

  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log((r.ok ? '✓' : '✗') + ' ' + r.name + ' — ' + r.detail);
  }
  console.log('截图: ' + path.join(os.tmpdir(), 'fde-panel-flash.png'));
  win.destroy();
  app.exit(allOk ? 0 : 1);
});
