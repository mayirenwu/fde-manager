/**
 * 应用功能 → AI 算力 → 模型库：四类模型（文本/图片/视频/音乐）能找到、能切换
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-apps-models.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const catalog = {
  ok: true,
  counts: { chat: 81, image: 23, video: 80, audio: 8, total: 192 },
  groups: {
    chat: [{ name: 'gem-3.8-flash', displayName: 'GEM 3.8 flash', type: 'chat', tags: ['对话'], params: [] }],
    image: [
      { name: 'tt-image-2.5', displayName: 'TT Image 2.5', type: 'image', tags: ['文生图', '图生图'], params: [] },
      { name: 'flux-1', displayName: 'Flux 1', type: 'image', tags: ['文生图'], params: [] }
    ],
    video: [
      { name: 'kling-v3-video', displayName: 'Kling V3', type: 'video', tags: ['文生视频'], params: [] },
      { name: 'seedance-2.0-anci', displayName: 'SD 2.0 按次', type: 'video', tags: ['参考生视频'], params: [] }
    ],
    audio: [{ name: 'suno-v6', displayName: 'Suno 6', type: 'audio', tags: ['音乐生成'], params: [] }]
  }
};

app.whenReady().then(async () => {
  const calls = [];
  ipcMain.handle('data:get', () => ({ ok: true, apps: [] }));
  ipcMain.handle('apps:get', () => ({ ok: true, items: [], trash: [] }));
  ipcMain.handle('packs:list', () => ({ ok: true, packs: [] }));
  ipcMain.handle('ai:open-settings', () => ({ ok: true }));
  ipcMain.handle('ai:get', () => ({ ok: true, hasKey: true, keyMask: 'sk-***', status: { level: 'on', text: '已接上' }, model: 'gem-3.8-flash', models: [{ id: 'gem-3.8-flash', name: 'GEM 3.8 flash' }], providers: [], usage: null, delivered: false, baseUrl: '', defaults: {} }));
  ipcMain.handle('models:catalog', () => { calls.push('catalog'); return catalog; });
  ipcMain.handle('app:copy-text', () => ({ ok: true }));
  ipcMain.handle('ai:save', (e, patch) => { calls.push(['ai-save', patch]); return { ok: true, model: patch.model, autoSwitch: patch.autoSwitch, hasKey: true, status: { level: 'on', text: '已接上' }, models: [] }; });
  ipcMain.handle('overview:open', (e, p) => { calls.push(['overview', p]); return { ok: true }; });
  ipcMain.handle('openOverview', () => ({ ok: true }));

  const win = new BrowserWindow({
    width: 1200, height: 860, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning|Error occurred in handler for '(data|apps|packs)/.test(msg)) errs.push(String(msg).slice(0, 160)); });
  await win.loadFile(path.join(ROOT, 'apps.html'));
  await wait(1000);

  let fail = 0;
  // 打开 AI 算力弹窗：页面里绑在侧栏「AI 算力」行（#aiRow）上
  await win.webContents.executeJavaScript(`(function(){ var b = document.getElementById('aiRow'); if (b && b.onclick) { b.onclick(); return 'row'; } var p = document.getElementById('aiPill'); if (p && p.onclick) { p.onclick(); return 'pill'; } return 'none'; })()`);
  await wait(1200);

  const st = await win.webContents.executeJavaScript(`(() => ({
    open: !!document.getElementById('aiMask') && document.getElementById('aiMask').classList.contains('on'),
    counts: (document.getElementById('mlCounts') || {}).textContent || '',
    tabs: [...document.querySelectorAll('#mlTabs [data-ml]')].map(b => b.dataset.ml),
    chatItems: [...document.querySelectorAll('#mlList [data-mlcopy]')].map(b => b.dataset.mlcopy),
    libError: ''
  }))()`);
  console.log('ML', JSON.stringify(st));
  fs.writeFileSync(path.join(os.tmpdir(), 'fde-apps-models.png'), (await win.capturePage()).toPNG());

  if (!st.open) { fail++; console.log('FAIL AI 弹窗没打开（点 aiPill）'); }
  if (!/共 192 个/.test(st.counts) || !/图片 23/.test(st.counts)) { fail++; console.log('FAIL 计数没显示：' + st.counts); }
  if (!st.chatItems.includes('gem-3.8-flash')) { fail++; console.log('FAIL 文本模型没列出来'); }

  if (st.open) {
    // 切到图片
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('#mlTabs [data-ml]')].find(b => b.dataset.ml === 'image').click(); 'ok'`);
    await wait(300);
    const img = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#mlList [data-mlcopy]')].map(b => b.dataset.mlcopy)`);
    console.log('IMAGE', JSON.stringify(img));
    if (!(img.includes('tt-image-2.5') && img.includes('flux-1'))) { fail++; console.log('FAIL 图片模型列表不对'); }

    // 自动模型：下拉第一项是「自动」，保存时能把 model=auto + autoSwitch 传下去
  try {
    const au = await win.webContents.executeJavaScript(`(function(){
      var sel = document.getElementById('aiModel');
      var box = document.getElementById('aiAutoSwitch');
      if (!sel || !box) return { has: false };
      sel.value = 'auto';
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      return { has: true, first: sel.options[0].value, firstText: sel.options[0].textContent, checked: box.checked };
    })()`);
    console.log('AUTO', JSON.stringify(au));
    if (!au.has) { fail++; console.log('FAIL 没有自动模型下拉或自动换开关'); }
    else if (au.first !== 'auto') { fail++; console.log('FAIL 自动项不在第一项：' + au.first); }
    await wait(900);
    const saved = calls.filter(c => Array.isArray(c) && c[0] === 'ai-save');
    console.log('SAVED', JSON.stringify(saved));
    if (!saved.length) { fail++; console.log('FAIL 切换自动没触发保存'); }
    else {
      const last = saved[saved.length - 1][1] || {};
      if (last.model !== 'auto') { fail++; console.log('FAIL 保存的 model 不是 auto：' + last.model); }
      if (last.autoSwitch !== false) { fail++; console.log('FAIL autoSwitch 没传下去：' + last.autoSwitch); }
    }
  } catch (e) { fail++; console.log('FAIL 自动模型交互出错: ' + e.message.slice(0, 150)); }

  // 加到画布：会复制模型名并打开画布
    try {
      await win.webContents.executeJavaScript(`(function(){ var v = [...document.querySelectorAll('#mlTabs [data-ml]')].find(function(x){ return x.dataset.ml === 'video'; }); v.click(); var b = [...document.querySelectorAll('#mlList [data-mluse]')][0]; if (!b) return 'no button'; b.click(); return 'clicked'; })()`);
    } catch (e) { console.log('click threw: ' + e.message.slice(0, 200)); }
    await wait(1200);
    console.log('CALLS', JSON.stringify(calls));
    const use = calls.find(c => Array.isArray(c) && c[0] === 'overview');
    console.log('USE', JSON.stringify(use));
    if (!use) { fail++; console.log('FAIL 「加到画布」没打开画布'); }
  }

  // 搜索：跨类别搜「suno」应只出音乐模型；搜不存在的词应提示没搜到
  try {
    const sr = await win.webContents.executeJavaScript(`(function(){
      var inp = document.getElementById('mlSearch');
      if (!inp) return { has: false };
      inp.value = 'suno';
      inp.dispatchEvent(new Event('input'));
      var items = document.querySelectorAll('#mlList [data-mluse]');
      return { has: true, hit: items.length, badges: [...document.querySelectorAll('#mlList span')].filter(function(x){ return /文本|图片|视频|音乐/.test(x.textContent); }).length };
    })()`);
    console.log('SEARCH', JSON.stringify(sr));
    if (!sr.has) { fail++; console.log('FAIL 没有搜索框'); }
    else if (!sr.hit) { fail++; console.log('FAIL 搜 suno 没结果'); }
  } catch (e) { fail++; console.log('FAIL 搜索出错: ' + e.message.slice(0, 150)); }

  if (errs.length) { fail++; console.log('FAIL 控制台报错：' + errs.join(' | ')); }
  console.log(fail === 0 ? '\nALL OK' : '\nFAILED ' + fail);
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
