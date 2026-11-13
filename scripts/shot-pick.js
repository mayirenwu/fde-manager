const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  ipcMain.handle('app:open-url', () => ({ ok: true }));
  ipcMain.handle('search:open', () => ({ ok: true }));
  ipcMain.handle('app:copy-text', () => ({ ok: true }));
  ipcMain.handle('ai:open-settings', () => ({ ok: true }));
  const win = new BrowserWindow({ width: 1220, height: 880, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '..', 'ecom.html'));
  await wait(500);
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#agedBtn').click();
    document.querySelector('[data-step="pick"]').click();
    return 1;
  })()`);
  await wait(700);
  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(process.env.TEMP + '\\fde-ecom-pick.png', img.toPNG());
  console.log('SHOT done');
  app.exit(0);
});
