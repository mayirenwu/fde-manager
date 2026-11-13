// 截主显示器当前画面，看画布窗口的真实屏幕状态
const { app, desktopCapturer } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  const out = process.env.TEMP || process.env.TMP || require('os').tmpdir();
  sources.forEach((s, i) => {
    const f = path.join(out, 'fde-screen-' + i + '.png');
    fs.writeFileSync(f, s.thumbnail.toPNG());
    console.log('saved', f, s.thumbnail.getSize().width + 'x' + s.thumbnail.getSize().height);
  });
  app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
