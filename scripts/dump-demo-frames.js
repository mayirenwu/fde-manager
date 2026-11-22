/** 抽三帧 PNG 用于人工检查 demo 动画 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640, height: 360, useContentSize: true,
    show: false, frame: false, backgroundColor: '#ffffff',
    webPreferences: { offscreen: true }
  });
  await win.loadFile(path.join(__dirname, 'demo-scene.html'));
  await new Promise(r => setTimeout(r, 500));
  for (const t of [0.05, 0.45, 0.80]) {
    await win.webContents.executeJavaScript('window.setT(' + t + ')');
    await new Promise(r => setTimeout(r, 60));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(os.tmpdir(), 'demo-t' + t + '.png'), img.toPNG());
    console.log('saved t=' + t);
  }
  app.quit();
});
