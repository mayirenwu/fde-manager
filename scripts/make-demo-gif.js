/**
 * 生成 README 顶部的演示动图 docs/demo.gif
 * 用离屏窗口加载 scripts/demo-scene.html，按时间参数逐帧抓图，gifenc 编码。
 * 运行：npx electron scripts/make-demo-gif.js
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const FRAMES = 60;      // 60 帧 × 80ms ≈ 4.8s 循环
const DELAY = 80;
const COLORS = 128;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640, height: 360, useContentSize: true,
    show: false, frame: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: true }
  });
  await win.loadFile(path.join(__dirname, 'demo-scene.html'));
  await new Promise(r => setTimeout(r, 600)); // 等字体/渲染稳定

  const gif = GIFEncoder();
  let size = { width: 0, height: 0 };
  for (let i = 0; i < FRAMES; i++) {
    const t = i / FRAMES;
    await win.webContents.executeJavaScript('window.setT(' + t.toFixed(4) + ')');
    await new Promise(r => setTimeout(r, 25));
    const img = await win.webContents.capturePage();
    size = img.getSize();
    const buf = img.toBitmap();              // BGRA（小端 Windows）
    const rgba = Buffer.alloc(buf.length);
    for (let p = 0; p < buf.length; p += 4) {
      rgba[p] = buf[p + 2]; rgba[p + 1] = buf[p + 1]; rgba[p + 2] = buf[p]; rgba[p + 3] = buf[p + 3];
    }
    const palette = quantize(rgba, COLORS);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, size.width, size.height, { palette, delay: DELAY });
    process.stdout.write('\r  帧 ' + (i + 1) + '/' + FRAMES + ' (' + size.width + 'x' + size.height + ')');
  }
  gif.finish();
  const out = path.join(__dirname, '..', 'docs', 'demo.gif');
  fs.writeFileSync(out, gif.bytes());
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log('\n  已生成 docs/demo.gif（' + kb + ' KB，' + size.width + 'x' + size.height + '）');
  app.quit();
}).catch(e => { console.error(e); process.exit(1); });
