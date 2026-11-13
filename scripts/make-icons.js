/**
 * 生成三平台图标：build/icon.png / icon.ico / icon.icns + Linux 多尺寸 + 托盘图标
 *
 * 为什么用 Electron 自己渲染：机器上不保证装了 sharp / ImageMagick，
 * 而 Electron 本来就在（我们要打包的就是它）。渲染一张 1024 的 HTML 再截图，
 * 然后用 nativeImage 缩放，最后按容器格式手写 ICO / ICNS —— 全平台都能跑。
 *
 * 跑法：electron scripts/make-icons.js
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const OUT_ICONS = path.join(BUILD, 'icons');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

const HTML = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;}
  .card{
    width:${size}px;height:${size}px;box-sizing:border-box;
    border-radius:${Math.round(size * 0.22)}px;
    background:linear-gradient(140deg,#4f8cff 0%,#6d6bf6 52%,#a855f7 100%);
    display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  }
  .t{color:#fff;font-weight:800;font-size:${Math.round(size * 0.30)}px;letter-spacing:${Math.round(size * 0.01)}px;
     text-shadow:0 ${Math.round(size*0.012)}px ${Math.round(size*0.03)}px rgba(0,0,0,.28);}
  .dot{position:absolute;width:${Math.round(size*0.14)}px;height:${Math.round(size*0.14)}px;border-radius:50%;
       background:rgba(255,255,255,.9);margin-top:${Math.round(size*0.26)}px;margin-left:${Math.round(size*0.30)}px;}
</style></head><body><div class="card"><div class="t">FDE</div></div></body></html>`;

// 托盘模板图：纯黑 + 透明（macOS 的 template image 会自动适配深浅菜单栏）
const TRAY_HTML = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;}
  .box{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-family:sans-serif;}
  .g{width:${Math.round(size*0.74)}px;height:${Math.round(size*0.74)}px;border:${Math.max(1,Math.round(size*0.09))}px solid #000;
     border-radius:${Math.round(size*0.18)}px;display:flex;align-items:center;justify-content:center;
     color:#000;font-weight:800;font-size:${Math.round(size*0.44)}px;letter-spacing:-0.5px;box-sizing:border-box;}
</style></head><body><div class="box"><div class="g">F</div></div></body></html>`;

let RWIN = null;
async function render(html, size) {
  // 注意：offscreen 窗口在当前 Electron 上不能"用完就销毁再建第二个"，
  // 第二次 loadURL 会 ERR_FAILED。这里复用一个窗口，改尺寸 + 重新加载即可。
  if (!RWIN || RWIN.isDestroyed()) {
    RWIN = new BrowserWindow({
      width: size, height: size,
      show: false, frame: false, transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { offscreen: true, contextIsolation: true }
    });
  }
  RWIN.setContentSize(size, size);
  await RWIN.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await wait(320);
  const img = await RWIN.webContents.capturePage();
  return img.toPNG();
}

/* ---------- ICO（PNG 内嵌，Vista+ 通用） ---------- */
function ico(entries) {
  // entries: [{size, png}]
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  const dir = [];
  let offset = 6 + entries.length * 16;
  for (const e of entries) {
    const b = Buffer.alloc(16);
    b.writeUInt8(e.size >= 256 ? 0 : e.size, 0);
    b.writeUInt8(e.size >= 256 ? 0 : e.size, 1);
    b.writeUInt8(0, 2);
    b.writeUInt8(0, 3);
    b.writeUInt16LE(1, 4);
    b.writeUInt16LE(32, 6);
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dir.push(b);
  }
  return Buffer.concat([head, ...dir, ...entries.map(e => e.png)]);
}

/* ---------- ICNS ---------- */
function icns(entries) {
  // entries: [{type:'ic09', png}]
  const chunks = entries.map(e => {
    const b = Buffer.alloc(8);
    b.write(e.type, 0, 4, 'ascii');
    b.writeUInt32BE(e.png.length + 8, 4);
    return Buffer.concat([b, e.png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function resize(png, size) {
  const img = nativeImage.createFromBuffer(png);
  return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_ICONS, { recursive: true });
  console.log('render main…');
  const master = await render(HTML(1024), 1024);
  console.log('main ok, bytes=' + master.length);
  fs.writeFileSync(path.join(BUILD, 'icon.png'), master);

  // 检查透明通道是否真的在（有些平台截透明窗口会丢 alpha，这里给出明确提示）
  try {
    const probe = nativeImage.createFromBuffer(master).toBitmap();
    const alpha = probe[3];
    console.log('icon.png alpha@(0,0) = ' + alpha + (alpha === 0 ? '（透明背景，正常）' : '（不透明，将使用方形底）'));
  } catch (e) {}

  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngs = {};
  for (const s of sizes) pngs[s] = s === 1024 ? master : resize(master, s);

  for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    fs.writeFileSync(path.join(OUT_ICONS, s + 'x' + s + '.png'), pngs[s]);
  }

  // Windows .ico：16/32/48/64/128/256
  fs.writeFileSync(path.join(BUILD, 'icon.ico'),
    ico([16, 32, 48, 64, 128, 256].map(s => ({ size: s, png: pngs[s] }))));

  // macOS .icns
  fs.writeFileSync(path.join(BUILD, 'icon.icns'), icns([
    { type: 'icp4', png: pngs[16] },
    { type: 'ic11', png: pngs[32] },
    { type: 'ic12', png: pngs[64] },
    { type: 'ic07', png: pngs[128] },
    { type: 'ic08', png: pngs[256] },
    { type: 'ic09', png: pngs[512] },
    { type: 'ic10', png: pngs[1024] }
  ]));

  // 托盘图标：Windows/Linux 用彩色小图，macOS 用黑色模板图
  const trayColor = resize(master, 32);
  fs.writeFileSync(path.join(BUILD, 'tray.png'), trayColor);
  fs.writeFileSync(path.join(BUILD, 'tray.ico'), ico([{ size: 16, png: pngs[16] }, { size: 32, png: trayColor }]));
  // 托盘模板图先按 256 渲染再缩（22px 的离屏窗口在部分平台会加载失败）
  console.log('render tray…');
  const tplBig = await render(TRAY_HTML(256), 256);
  console.log('tray ok, bytes=' + tplBig.length);
  const tpl = resize(tplBig, 22);
  fs.writeFileSync(path.join(BUILD, 'trayTemplate.png'), tpl);
  fs.writeFileSync(path.join(BUILD, 'trayTemplate@2x.png'), resize(tpl, 44));

  // 运行期也读 assets/ 下的图标（main.js 的 trayIconCandidates 会先看这里）
  const ASSETS = path.join(ROOT, 'assets');
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'tray.png'), trayColor);
  fs.writeFileSync(path.join(ASSETS, 'tray.ico'), fs.readFileSync(path.join(BUILD, 'tray.ico')));
  fs.writeFileSync(path.join(ASSETS, 'trayTemplate.png'), tpl);
  fs.writeFileSync(path.join(ASSETS, 'trayTemplate@2x.png'), resize(tpl, 44));
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), pngs[256]);

  console.log('OK 图标已生成：build/icon.png · icon.ico · icon.icns · icons/ · tray*');
  app.exit(0);
});
