/**
 * 空画布工具卡：点「文字生图片 / 导演台…」应自动摆好节点组合并连线。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-canvas-tools.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const catalog = {
  ok: true,
  counts: { chat: 1, image: 2, video: 1, audio: 1, total: 5 },
  groups: {
    chat: [{ name: 'gem-3.8-flash', displayName: 'GEM 3.8 flash', type: 'chat', tags: ['对话'], params: [] }],
    image: [
      {
        name: 'tt-image-2.5', displayName: 'TT Image 2.5', type: 'image', tags: ['文生图'], params: [
          { name: 'prompt', label: '提示词', type: 'textarea', required: true, options: [] },
          { name: 'image', label: '参考图', type: 'upload', required: false, options: [] }
        ]
      },
      { name: 'banana-pro', displayName: 'Banana Pro', type: 'image', tags: ['文生图'], params: [] }
    ],
    video: [{
      name: 'kling-v3-video', displayName: 'Kling V3', type: 'video', tags: ['文生视频'], params: [
        { name: 'image', label: '首帧图', type: 'upload', required: false, options: [] },
        { name: 'audio', label: '音频', type: 'upload', required: false, options: [] }
      ]
    }],
    audio: [{ name: 'suno-v6', displayName: 'Suno 6', type: 'audio', tags: ['音乐'], params: [] }]
  }
};

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({ projects: [], flows: [], logs: [], inbox: {}, trash: [], activeId: null, originalCount: 0, uncontrolled: 0, isAdmin: true, settings: {} }));
  ipcMain.handle('canvas:get', () => ({ ok: true, canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }, projects: [], windows: [], activeId: null }));
  ipcMain.handle('canvas:save', () => ({ ok: true }));
  ipcMain.handle('models:catalog', () => catalog);
  const modelsLib = require(path.join(ROOT, 'models.js'));
  const allModels = Object.values(catalog.groups).flat();
  ipcMain.handle('models:detail', (e, name) => {
    const mm = allModels.find(x => x.name === name);
    if (!mm) return { ok: false, error: '没有这个模型' };
    const params = modelsLib.normalizeParams(mm.params || []);
    const fields = modelsLib.fieldsOf(params);
    return { ok: true, name, params, fields, defaults: modelsLib.defaultsFor(params), caps: modelsLib.capabilities(fields) };
  });
  ipcMain.handle('ai:get', () => ({ ok: true, status: { level: 'on', text: '已接上' }, model: 'gem-3.8-flash', models: [] }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(String(msg).slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'overview.html'), { query: { view: 'canvas' } });
  await wait(1400);

  let fail = 0;
  const click = (tool) => `[...document.querySelectorAll('#toolGrid .toolcard')].find(c => c.dataset.tool === '${tool}').click(); 'ok'`;

  // 0) 空画布应显示 8 张工具卡
  const s0 = await win.webContents.executeJavaScript(`({ cards: document.querySelectorAll('#toolGrid .toolcard').length, visible: document.getElementById('emptyHint').style.display !== 'none' })`);
  console.log('GRID', JSON.stringify(s0));
  if (s0.cards !== 8 || !s0.visible) { fail++; console.log('FAIL 空画布工具卡没显示'); }

  // 1) 文字生图片 → 1 个 image 生成节点
  await win.webContents.executeJavaScript(click('t2i'));
  await wait(500);
  const s1 = await win.webContents.executeJavaScript(`({ n: C.nodes.length, e: C.edges.length, type: C.nodes[0] && C.nodes[0].type, modal: C.nodes[0] && C.nodes[0].ref.modal })`);
  console.log('T2I', JSON.stringify(s1));
  if (s1.n !== 1 || s1.type !== 'gen' || s1.modal !== 'image') { fail++; console.log('FAIL 文字生图片'); }
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-canvas-tools-t2i.png'), (await win.capturePage()).toPNG());

  // 2) 生图转视频 → 2 节点 1 连线（image → video）
  await win.webContents.executeJavaScript(`C.nodes = []; C.edges = []; renderAll(); 'ok'`);
  await win.webContents.executeJavaScript(click('i2v'));
  await wait(500);
  const s2 = await win.webContents.executeJavaScript(`({ n: C.nodes.length, e: C.edges.length, types: C.nodes.map(x => x.ref.modal), from: C.edges[0] && C.edges[0].from, to: C.edges[0] && C.edges[0].to })`);
  console.log('I2V', JSON.stringify(s2));
  if (s2.n !== 2 || s2.e !== 1 || !(s2.types.includes('image') && s2.types.includes('video'))) { fail++; console.log('FAIL 生图转视频'); }
  if (s2.e && (!s2.from || !s2.to || s2.from === s2.to)) { fail++; console.log('FAIL 连线两端不对'); }

  // 3) 导演台 → 4 节点 3 连线（AI → 3 个视频）
  await win.webContents.executeJavaScript(`C.nodes = []; C.edges = []; renderAll(); 'ok'`);
  await win.webContents.executeJavaScript(click('director'));
  await wait(500);
  const s3 = await win.webContents.executeJavaScript(`({ n: C.nodes.length, e: C.edges.length, ai: C.nodes.filter(x => x.type === 'ai').length, vids: C.nodes.filter(x => x.ref && x.ref.modal === 'video').length })`);
  console.log('DIR', JSON.stringify(s3));
  if (s3.n !== 4 || s3.e !== 3 || s3.ai !== 1 || s3.vids !== 3) { fail++; console.log('FAIL 导演台'); }
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-canvas-tools-director.png'), (await win.capturePage()).toPNG());

  // 4) 多图对比 → 3 个图片节点，模型互不相同
  await win.webContents.executeJavaScript(`C.nodes = []; C.edges = []; renderAll(); 'ok'`);
  await win.webContents.executeJavaScript(click('compare'));
  await wait(500);
  const s4 = await win.webContents.executeJavaScript(`({ n: C.nodes.length, models: C.nodes.map(x => x.ref.model) })`);
  console.log('CMP', JSON.stringify(s4));
  if (s4.n !== 3) { fail++; console.log('FAIL 多图对比（应 3 个节点）'); }
  if (new Set(s4.models).size < Math.min(3, catalog.groups.image.length)) { fail++; console.log('FAIL 多图对比没尽量用不同模型'); }

  // 5) 建完节点后空状态提示应消失
  const s5 = await win.webContents.executeJavaScript(`document.getElementById('emptyHint').style.display`);
  if (s5 !== 'none') { fail++; console.log('FAIL 有节点后空状态提示没隐藏'); }

  if (errs.length) { fail++; console.log('PAGE ERRORS', errs.slice(0, 3)); }
  console.log(fail ? 'FAIL ' + fail : 'ALL PASS');
  app.exit(fail ? 1 : 0);
});
