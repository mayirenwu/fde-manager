/** 看一眼：应用功能默认停在「能力」、面板工作台两排按钮换了位置 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-shot-'));
app.setPath('userData', path.join(TMP, 'ud'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  ipcMain.handle('apps:get', () => ({ items: [], trash: [], stats: { total: 0 }, kinds: {} }));
  ipcMain.handle('ai:get', () => ({ ok: true, hasKey: false, model: '', baseUrl: '', models: [], status: { level: 'off', text: '' } }));
  const win = new BrowserWindow({
    width: 1280, height: 880, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegrationInSubFrames: true }
  });
  await win.loadFile(path.join(__dirname, '..', 'apps.html'));
  await wait(900);
  let img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'swap-apps-default.png'), img.toPNG());

  const panel = new BrowserWindow({
    width: 360, height: 780, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true }
  });
  await panel.loadFile(path.join(__dirname, '..', 'panel.html'));
  await wait(900);
  const order = await panel.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('[data-grp="work"]');
    const head = g && g.querySelector('.grphead');
    if (head && !g.classList.contains('open')) head.click();
    return 1;
  })()`).catch(e => String(e));
  await wait(500);
  const btns = await panel.webContents.executeJavaScript(`[...document.querySelectorAll('[data-grp="work"] .origbtn')].map(b => b.textContent.trim())`);
  console.log('BTNS', JSON.stringify(btns));
  img = await panel.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'swap-panel.png'), img.toPNG());
  console.log('SHOT ok');
  app.exit(0);
});
