/**
 * 画布生成节点：每个模型的输入项必须跟着模型变
 *  - 图片模型：能上传参考图、比例/分辨率/画质
 *  - 视频模型：生成模式（首尾帧/参考生）切换后，素材框跟着换，旧值不残留
 *  - 选文件 → media:pick 返回直链 → 缩略图 + 参数写入 → 卡片摘要
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-model-params.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const modelsLib = require(path.join(ROOT, 'models.js'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const RAW = {
  image: [
    { name: 'prompt', label: '提示词', type: 'textarea', required: true },
    { name: 'images', label: '参考图片', type: 'upload', required: false, description: '上传 1~16 张参考图，必须是公网直链', upload_limits: { 单文件MB: 30, 格式: ['jpg', 'png', 'webp'] } },
    { name: 'aspect_ratio', label: '图片比例', type: 'select', required: false, options: [{ value: 'auto', label: '自适应' }, { value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' }] },
    { name: 'quality', label: '画质', type: 'select', required: false, options: [{ value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }] },
    { name: 'size', label: '自定义尺寸', type: 'input', required: false, description: '如 1536x864 或 auto' }
  ],
  video: [
    { name: 'prompt', label: '提示词', type: 'textarea', required: true },
    { name: 'mode', label: '生成模式', type: 'segment', required: false, options: [{ value: 'shouweizhen', label: '首尾帧' }, { value: 'cankaosheng', label: '参考生' }] },
    { name: 'duration', label: '视频时长', type: 'select', required: true, options: [{ value: '4', label: '4秒' }, { value: '8', label: '8秒' }, { value: '15', label: '15秒' }] },
    { name: 'aspect_ratio', label: '宽高比', type: 'radio', required: false, options: [{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }] },
    { name: 'images', label: '首尾帧', type: 'upload', required: false, description: '上传 1~2 张图作为首帧 / 尾帧', available_when: { mode: ['shouweizhen'] }, upload_limits: { 单文件MB: 30, 格式: ['jpg', 'png'] } },
    { name: 'video_url', label: '参考视频', type: 'upload', required: false, description: '参考视频，最多 1 个', available_when: { mode: ['cankaosheng'] }, upload_limits: { 单文件MB: 200, 格式: ['mp4', 'mov'], 最长秒: 30 } },
    { name: 'audio_url', label: '参考音频', type: 'upload', required: false, description: '参考音频', available_when: { mode: ['cankaosheng'] }, upload_limits: { 单文件MB: 15, 格式: ['wav', 'mp3'], 最长秒: 30 } }
  ],
  audio: [
    { name: 'prompt', label: '提示词', type: 'textarea', required: true },
    { name: 'lyrics', label: '完整歌词', type: 'textarea', required: false },
    { name: 'quality', label: '质量', type: 'select', required: true, options: [{ value: 'standard', label: '标准' }, { value: 'hq', label: '高品质' }] }
  ]
};

const mkModel = (name, display, type) => {
  const params = modelsLib.normalizeParams(RAW[type]);
  return { name, displayName: display, type, tags: [], params, fields: modelsLib.fieldsOf(params), available: true };
};

const catalog = {
  ok: true,
  counts: { chat: 0, image: 1, video: 1, audio: 1, total: 3 },
  models: [mkModel('img-pro', 'Img Pro', 'image'), mkModel('vid-pro', 'Vid Pro', 'video'), mkModel('song-pro', 'Song Pro', 'audio')],
  groups: {
    chat: [],
    image: [mkModel('img-pro', 'Img Pro', 'image')],
    video: [mkModel('vid-pro', 'Vid Pro', 'video')],
    audio: [mkModel('song-pro', 'Song Pro', 'audio')]
  }
};

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({ projects: [], flows: [], logs: [], inbox: {}, trash: [], activeId: null, originalCount: 0, uncontrolled: 0, isAdmin: true, settings: {} }));
  ipcMain.handle('canvas:get', () => ({ ok: true, canvas: { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }, projects: [], windows: [], activeId: null }));
  ipcMain.handle('canvas:save', () => ({ ok: true }));
  ipcMain.handle('models:catalog', () => catalog);
  ipcMain.handle('models:detail', async (e, name) => {
    await wait(120);   // 模拟真机一次网络往返：先显示"正在读输入项"，再换成真实控件
    const mm = (catalog.models || []).find(x => x.name === name);
    if (!mm) return { ok: false, error: '没有这个模型' };
    return { ok: true, name, params: mm.params, fields: mm.fields, defaults: modelsLib.defaultsFor(mm.params), caps: modelsLib.capabilities(mm.fields) };
  });
  ipcMain.handle('media:pick', (e, opts) => {
    const kind = (opts && opts.kind) || 'image';
    const url = kind === 'image' ? 'https://cdn.test/ref-1.png' : kind === 'audio' ? 'https://cdn.test/a.wav' : 'https://cdn.test/v.mp4';
    return { ok: true, kind, files: [{ name: 'picked.' + (kind === 'image' ? 'png' : kind === 'audio' ? 'wav' : 'mp4'), url, size: 4096 }] };
  });
  ipcMain.handle('ai:get', () => ({ ok: true, status: { level: 'on', text: '已接上' }, model: 'gem', models: [] }));
  ipcMain.handle('canvas:run-node', () => ({ ok: true, msg: 'ok' }));
  ipcMain.handle('windows:list', () => ({ ok: true, mine: [], others: [] }));
  ipcMain.handle('app:open-url', () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(String(msg).slice(0, 200)); });
  await win.loadFile(path.join(ROOT, 'overview.html'), { query: { view: 'canvas' } });
  await wait(1200);

  let fail = 0;
  const ok = (cond, msg) => { if (cond) console.log('  ✓ ' + msg); else { fail++; console.log('  ✗ ' + msg); } };
  const addGen = async (modal) => {
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('.cbar [data-add="gen"]')].find(b => b.dataset.modal === '${modal}').click(); 'ok'`);
    await wait(700);
  };

  console.log('\n== 图片模型：参考图 + 比例 + 画质 ==');
  await addGen('image');
  const s1 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    const q = (x) => document.querySelector('#inspector ' + x);
    return {
      model: n.ref.model,
      pick: !!q('[data-gpick="images"]'),
      ratio: !!q('[data-gparam="aspect_ratio"]'),
      quality: !!q('[data-gparam="quality"]'),
      size: !!q('[data-f="gp:size"]'),
      caps: (q('.pcaps') || {}).textContent || '',
      cap1: [...document.querySelectorAll('#inspector .plabel .cap')].map(x => x.textContent).join(' | '),
      hint: (q('.phint') || {}).textContent || ''
    };
  })()`);
  console.log('IMG', JSON.stringify(s1));
  ok(s1.model === 'img-pro', '默认选中图片模型');
  ok(s1.pick, '有「＋ 选图片」上传按钮');
  ok(s1.ratio && s1.quality, '比例、画质按平台定义渲染出来');
  ok(s1.size, '自定义尺寸这类文本参数也有');
  ok(/可传图片/.test(s1.caps), '顶部能力徽标显示"可传图片"');
  ok(/0~16/.test(s1.cap1) && /30MB/.test(s1.cap1), '上传限制（张数/大小）跟着平台描述显示');
  ok(/公网直链/.test(s1.hint), '参数说明能展开看到');

  console.log('\n== 选文件 → 上传 → 写进参数 ==');
  await win.webContents.executeJavaScript(`document.querySelector('#inspector [data-gpick="images"]').click(); 'ok'`);
  await wait(700);
  const s2 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    return {
      val: n.ref.params.images,
      thumb: !!document.querySelector('#inspector .pref img'),
      card: (document.querySelector('.node .nparam') || {}).textContent || '',
      caps: (document.querySelector('#inspector .pcaps') || {}).textContent || ''
    };
  })()`);
  console.log('PICK', JSON.stringify(s2));
  ok(Array.isArray(s2.val) && s2.val[0] === 'https://cdn.test/ref-1.png', '素材直链写进 params.images（数组）');
  ok(s2.thumb, '检查器里显示缩略图');
  ok(/参考图片 1 张/.test(s2.card), '节点卡片显示参数摘要：' + s2.card);

  console.log('\n== 视频模型：模式切换决定出现哪些素材框 ==');
  await win.webContents.executeJavaScript(`document.querySelector('#inspector [data-gmodal="video"]').click(); 'ok'`);
  await wait(900);
  const s3 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    const names = [...document.querySelectorAll('#inspector [data-gpick]')].map(x => x.dataset.gpick);
    return { model: n.ref.model, mode: n.ref.params.mode, pickNames: names, duration: !!document.querySelector('#inspector [data-gparam="duration"]') };
  })()`);
  console.log('VIDEO', JSON.stringify(s3));
  ok(s3.model === 'vid-pro', '切到视频模型');
  ok(s3.mode === 'shouweizhen', '生成模式默认预选第一项');
  ok(s3.pickNames.includes('images') && !s3.pickNames.includes('video_url'), '首尾帧模式：只有首尾帧素材框');
  ok(s3.duration, '秒数选项渲染出来');

  await win.webContents.executeJavaScript(`[...document.querySelectorAll('#inspector [data-gparam="mode"]')].find(c => c.dataset.gval === 'cankaosheng').click(); 'ok'`);
  await wait(500);
  const s4 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    const names = [...document.querySelectorAll('#inspector [data-gpick]')].map(x => x.dataset.gpick);
    return { pickNames: names, hasImagesVal: 'images' in (n.ref.params || {}), card: (document.querySelector('.node .nparam') || {}).textContent || '' };
  })()`);
  console.log('MODE', JSON.stringify(s4));
  ok(s4.pickNames.includes('video_url') && s4.pickNames.includes('audio_url') && !s4.pickNames.includes('images'), '参考生模式：换成参考视频/参考音频');
  ok(!s4.hasImagesVal, '上一模式的素材值已清掉，不会误发');

  await win.webContents.executeJavaScript(`document.querySelector('#inspector [data-gpick="audio_url"]').click(); 'ok'`);
  await wait(700);
  const s5 = await win.webContents.executeJavaScript(`(() => {
    const n = C.nodes[0];
    return { val: n.ref.params.audio_url, icon: (document.querySelector('#inspector .pref .pico') || {}).textContent || '', card: (document.querySelector('.node .nparam') || {}).textContent || '' };
  })()`);
  console.log('AUDIO', JSON.stringify(s5));
  ok(s5.val === 'https://cdn.test/a.wav', '音频直链写进 params.audio_url');
  ok(s5.icon === '🎵', '音频素材显示音乐图标');
  ok(/参考音频 1 个/.test(s5.card), '卡片摘要包含音频：' + s5.card);

  console.log('\n== 音乐模型：歌词 / 音质 ==');
  await win.webContents.executeJavaScript(`document.querySelector('#inspector [data-gmodal="audio"]').click(); 'ok'`);
  await wait(900);
  const s6 = await win.webContents.executeJavaScript(`(() => ({
    lyrics: !!document.querySelector('#inspector textarea[data-f="gp:lyrics"]'),
    quality: [...document.querySelectorAll('#inspector [data-gparam="quality"]')].map(x => x.dataset.gval),
    title: (document.querySelector('#inspector h4 .htl') || {}).textContent || ''
  }))()`);
  console.log('AUDIOMODEL', JSON.stringify(s6));
  ok(s6.lyrics, '歌词是多行输入框，不是单行');
  ok(s6.quality.join(',') === 'standard,hq', '质量选项来自这个模型自己的定义');
  ok(s6.title === 'Song Pro', '节点标题跟着模型名');

  fs.writeFileSync(path.join(os.tmpdir(), 'fde-model-params.png'), (await win.capturePage()).toPNG());
  ok(errs.length === 0, '渲染进程无报错' + (errs.length ? '：' + errs.join(' / ') : ''));
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED ' + fail));
  app.exit(fail === 0 ? 0 : 1);
});
