/**
 * 画布生成节点：＋图片 / ＋视频 / ＋音乐 → 检查器里能选模型、填提示词、填参数、运行
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-canvas-gen.js
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
        name: 'tt-image-2.5', displayName: 'TT Image 2.5', type: 'image', tags: ['文生图'], desc: '图像模型', hint: '主体+场景',
        params: [
          { name: 'prompt', label: '提示词', type: 'textarea', required: true, options: [] },
          { name: 'version', label: '模型版本', type: 'select', required: true, options: [{ value: 'flare', label: '标准版' }, { value: 'sunburst', label: '增强版' }] },
          { name: 'aspect_ratio', label: '图片比例', type: 'select', required: false, options: [{ value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' }] }
        ]
      },
      { name: 'tt-image-2.5-token', displayName: 'TT Image 2.5 官转', type: 'image', tags: [], params: [] }
    ],
    video: [{
      name: 'kling-v3-video', displayName: 'Kling V3', type: 'video', tags: ['文生视频'], params: [
        { name: 'duration', label: '视频时长', type: 'select', required: true, options: [{ value: '5', label: '5 秒' }, { value: '10', label: '10 秒' }] }
      ]
    }],
    audio: [{
      name: 'suno-v6', displayName: 'Suno 6', type: 'audio', tags: ['音乐生成'], params: [
        { name: 'make_instrumental', label: '生成模式', type: 'select', required: false, options: [{ value: 'song', label: '歌曲' }, { value: 'instrumental', label: '纯音乐' }] }
      ]
    }]
  }
};

app.whenReady().then(async () => {
  const calls = [];
  ipcMain.handle('data:get', () => ({ projects: [], flows: [], logs: [], inbox: {}, trash: [], activeId: null, originalCount: 0, uncontrolled: 0, isAdmin: true, settings: {} }));
  ipcMain.handle('canvas:get', () => ({ ok: true, canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }, projects: [], windows: [], activeId: null }));
  ipcMain.handle('canvas:save', () => ({ ok: true }));
  ipcMain.handle('models:catalog', () => catalog);
  // 参数定义单独查（和真机一致：目录里不一定带 params）
  const modelsLib = require(path.join(ROOT, 'models.js'));
  const allModels = Object.values(catalog.groups).flat();
  ipcMain.handle('models:detail', (e, name) => {
    const mm = allModels.find(x => x.name === name);
    if (!mm) return { ok: false, error: '没有这个模型' };
    const params = modelsLib.normalizeParams(mm.params || []);
    const fields = modelsLib.fieldsOf(params);
    return { ok: true, name, params, fields, defaults: modelsLib.defaultsFor(params), caps: modelsLib.capabilities(fields) };
  });
  ipcMain.handle('media:pick', () => ({ ok: true, files: [{ name: 'ref.png', url: 'https://cdn.test/ref.png', size: 1234 }] }));
  ipcMain.handle('ai:get', () => ({ ok: true, status: { level: 'on', text: '已接上' }, model: 'gem-3.8-flash', models: [{ id: 'gem-3.8-flash', name: 'gem-3.8-flash' }, { id: 'gem-3.1-pro', name: 'gem-3.1-pro' }] }));
  ipcMain.handle('canvas:run-node', (e, id) => { calls.push(['run-node', id]); return { ok: true, msg: '跑了一下' }; });
  ipcMain.handle('canvas:run-flow', (e, id) => { calls.push(['run-flow', id]); return { ok: true, results: [] }; });
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('app:open-url', () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(String(msg).slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'overview.html'), { query: { view: 'canvas' } });
  await wait(1400);

  let fail = 0;
  const addBtn = (modal) => `[...document.querySelectorAll('.cbar [data-add="gen"]')].find(b => b.dataset.modal === '${modal}').click()`;

  // 1) ＋图片
  await win.webContents.executeJavaScript(addBtn('image') + `; 'ok'`);
  await wait(600);
  const s1 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    return {
      count: C.nodes.length, type: n && n.type, modal: n && n.ref.modal, model: n && n.ref.model,
      title: n && n.title,
      hasSelect: !!document.querySelector('#inspector select[data-f="genmodel"]'),
      opts: [...document.querySelectorAll('#inspector select[data-f="genmodel"] option')].map(o => o.value),
      prompt: !!document.querySelector('#inspector [data-f="genprompt"]'),
      params: [...document.querySelectorAll('#inspector [data-gparam], #inspector [data-f^="gp:"]')].length,
      paramText: (document.querySelector('#inspector') || {}).textContent || ''
    };
  })()`);
  console.log('IMG', JSON.stringify(s1));
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-canvas-gen.png'), (await win.capturePage()).toPNG());
  if (s1.count !== 1 || s1.type !== 'gen' || s1.modal !== 'image') { fail++; console.log('FAIL ＋图片没建出 image 生成节点'); }
  if (!s1.model || s1.model === 'tt-image-2.5-token') { fail++; console.log('FAIL 默认模型没避开官转：' + s1.model); }
  if (!s1.hasSelect || !s1.opts.includes('tt-image-2.5')) { fail++; console.log('FAIL 检查器没有模型下拉'); }
  if (!s1.prompt) { fail++; console.log('FAIL 没有提示词输入'); }
  if (s1.params < 2) { fail++; console.log('FAIL 参数控件没渲染：' + s1.params); }
  if (!/可用 2 个/.test(s1.paramText)) { fail++; console.log('FAIL 模型数量提示不对'); }

  // 2) 填提示词 + 选参数 + 运行
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('#inspector [data-f="genprompt"]');
    ta.value = '一只橘猫在窗台上晒太阳，胶片质感';
    ta.dispatchEvent(new Event('input'));
    const chip = [...document.querySelectorAll('#inspector [data-gparam="version"]')].find(c => c.dataset.gval === 'sunburst');
    chip.click();
    return 'ok';
  })()`);
  await wait(300);
  const s2 = await win.webContents.executeJavaScript(`(() => { const n = C.nodes[0]; return { prompt: n.ref.prompt, version: n.ref.params.version, chipOn: !!document.querySelector('#inspector .chip.on[data-gparam="version"]') }; })()`);
  console.log('FILL', JSON.stringify(s2));
  if (!/橘猫/.test(s2.prompt)) { fail++; console.log('FAIL 提示词没写进节点'); }
  if (s2.version !== 'sunburst') { fail++; console.log('FAIL 参数没写进节点：' + s2.version); }

  await win.webContents.executeJavaScript(`document.querySelector('#inspector [data-act="run"]').click(); 'ok'`);
  await wait(600);
  const ran = calls.find(c => c[0] === 'run-node');
  console.log('RUN', JSON.stringify(ran));
  if (!ran) { fail++; console.log('FAIL 运行没发出去'); }

  // 3) 切到视频：模型列表要换成视频模型
  await win.webContents.executeJavaScript(`document.querySelector('#inspector [data-gmodal="video"]').click(); 'ok'`);
  await wait(500);
  const s3 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    return {
      modal: n.ref.modal, model: n.ref.model,
      opts: [...document.querySelectorAll('#inspector select[data-f="genmodel"] option')].map(o => o.value),
      title: n.title
    };
  })()`);
  console.log('VIDEO', JSON.stringify(s3));
  if (s3.modal !== 'video' || s3.model !== 'kling-v3-video') { fail++; console.log('FAIL 切视频没换模型'); }
  if (s3.opts.join(',') !== 'kling-v3-video') { fail++; console.log('FAIL 视频下拉混进了别的模态'); }
  if (s3.title !== 'Kling V3') { fail++; console.log('FAIL 标题没跟着模型走'); }

  // 4) 音乐
  await win.webContents.executeJavaScript(addBtn('audio') + `; 'ok'`);
  await wait(500);
  const s4 = await win.webContents.executeJavaScript(`(() => { const n = C.nodes[C.nodes.length-1]; return { n: C.nodes.length, modal: n.ref.modal, model: n.ref.model }; })()`);
  console.log('AUDIO', JSON.stringify(s4));
  if (s4.n !== 2 || s4.modal !== 'audio' || s4.model !== 'suno-v6') { fail++; console.log('FAIL ＋音乐节点不对'); }

  // 5) 卡片上能显示结果缩略图（伪造一个已完成节点）
  await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    n.ref.urls = ['https://example.com/a.png'];
    n.ref.resultKind = 'image';
    n.ref.status = '完成';
    n.ref.progress = 100;
    renderNodes();
    return 'ok';
  })()`);
  await wait(300);
  const thumb = await win.webContents.executeJavaScript(`!!document.querySelector('.node .gthumb img')`);
  if (!thumb) { fail++; console.log('FAIL 卡片没显示结果缩略图'); }

  // 6) ＋聊天 节点：按钮文案是「聊天」，模型下拉里有「自动」
  const chatBtn = await win.webContents.executeJavaScript(`(function(){
    var b = [...document.querySelectorAll('.cbar [data-add="ai"]')].find(function(x){ return /聊天/.test(x.textContent); });
    if (!b) return { found: false };
    b.click();
    return { found: true, text: b.textContent };
  })()`);
  await wait(500);
  console.log('CHATBTN', JSON.stringify(chatBtn));
  if (!chatBtn.found) { fail++; console.log('FAIL 工具栏没有「＋聊天」按钮'); }
  const chatSel = await win.webContents.executeJavaScript(`(function(){
    var n = C.nodes[C.nodes.length - 1];
    var sel = document.querySelector('#inspector select[data-f="model"]');
    return {
      type: n && n.type,
      has: !!sel,
      values: sel ? [...sel.options].map(function(o){ return o.value; }) : [],
      txt: (document.querySelector('#inspector') || {}).textContent || ''
    };
  })()`);
  console.log('CHATSEL', JSON.stringify({ has: chatSel.has, values: chatSel.values.slice(0, 3), type: chatSel.type }));
  if (chatSel.type !== 'ai') { fail++; console.log('FAIL ＋聊天 建出来的不是 ai 节点'); }
  if (!chatSel.has || !chatSel.values.includes('auto')) { fail++; console.log('FAIL 聊天节点模型下拉没有「自动」：' + JSON.stringify(chatSel.values)); }
  if (!/聊天模型/.test(chatSel.txt)) { fail++; console.log('FAIL 检查器没显示「聊天模型」'); }

  if (errs.length) { fail++; console.log('FAIL 控制台报错：' + errs.join(' | ')); }
  console.log(fail === 0 ? '\nALL OK' : '\nFAILED ' + fail);
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
