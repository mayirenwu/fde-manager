/**
 * 聊天模型下拉：80+ 个模型能看全、能搜、能滚、能选
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-model-picker.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// 81 个聊天模型（和渠道清单同量级），混入用户要找的那几个
const HEAD = ['gem-3.8-flash', 'fb-5-2', 'gem-4-carbon', 'omni-flash-1.2', 'deepseek-v4-pro', 'kimi-k3', 'glm-5.3', 'op-5', 'tt-6.1', 'gk-4.7'];
const CHAT = HEAD.concat(Array.from({ length: 71 }, (_, i) => 'mock-chat-' + String(i + 1).padStart(2, '0')));
const MODELS = CHAT.map(id => ({ id, name: id }));

const wrap = (fn) => { try { return fn(); } catch (e) { return { ok: false, error: e.message }; } };

app.whenReady().then(async () => {
  ipcMain.handle('data:get', () => ({ ok: true, apps: [] }));
  ipcMain.handle('apps:get', () => ({ ok: true, items: [], trash: [] }));
  ipcMain.handle('packs:list', () => ({ ok: true, packs: [] }));
  ipcMain.handle('ai:open-settings', () => ({ ok: true }));
  ipcMain.handle('models:catalog', () => ({ ok: true, counts: { chat: 81, image: 23, video: 80, audio: 8, total: 192 }, groups: { chat: [], image: [], video: [], audio: [] } }));
  ipcMain.handle('app:copy-text', () => ({ ok: true }));
  ipcMain.handle('overview:open', () => ({ ok: true }));
  ipcMain.handle('openOverview', () => ({ ok: true }));
  const saved = [];
  ipcMain.handle('ai:save', (e, patch) => { saved.push(patch); return Object.assign({ ok: true, hasKey: true, status: { level: 'on', text: '已接上' } }, patch); });
  ipcMain.handle('ai:get', () => wrap(() => ({
    ok: true, hasKey: true, keyMask: 'sk-****',
    status: { level: 'on', text: '已接上 gem-3.8-flash' },
    baseUrl: 'https://api.lk888.ai/v1',
    model: 'gem-3.8-flash',
    models: MODELS,
    chatModels: MODELS,
    providers: [], usage: null, delivered: true, defaults: {}
  })));

  const win = new BrowserWindow({
    width: 1240, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(String(msg).slice(0, 160));
  });
  await win.loadFile(path.join(ROOT, 'apps.html'));
  await wait(900);

  let fail = 0;
  const ok = (cond, name, extra) => {
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '：' + extra : ''));
    if (!cond) fail++;
  };

  await win.webContents.executeJavaScript(`(function(){ var b = document.getElementById('aiRow'); if (b && b.onclick) b.onclick(); return 1; })()`);
  await wait(900);

  const base = await win.webContents.executeJavaScript(`(() => {
    var sel = document.getElementById('aiModel');
    return {
      open: !!document.getElementById('aiMask') && document.getElementById('aiMask').classList.contains('on'),
      options: sel ? sel.options.length : 0,
      count: (document.getElementById('aiModelCount') || {}).textContent || '',
      label: (document.getElementById('aiPickLabel') || {}).textContent || '',
      popHidden: document.getElementById('aiPickPop') ? document.getElementById('aiPickPop').hidden : null,
      hasBtn: !!document.getElementById('aiPickBtn')
    };
  })()`);
  ok(base.open, 'AI 设置抽屉能打开');
  ok(base.hasBtn, '有可搜索下拉按钮');
  ok(base.options === CHAT.length + 1, '下拉里有全部模型（含自动项）', base.options + ' 项');
  ok(/共 81 个/.test(base.count), '旁边显示总数', base.count);
  ok(/gem-3\.8-flash/.test(base.label), '按钮上显示当前模型', base.label);
  ok(base.popHidden === true, '浮层默认收起');

  // 点开
  await win.webContents.executeJavaScript(`document.getElementById('aiPickBtn').click(); 1`);
  await wait(250);
  const opened = await win.webContents.executeJavaScript(`(() => {
    var pop = document.getElementById('aiPickPop');
    var list = document.getElementById('aiPickList');
    return {
      hidden: pop.hidden,
      items: list.querySelectorAll('.pi').length,
      scrollable: list.scrollHeight > list.clientHeight + 4,
      maxH: getComputedStyle(list).maxHeight,
      overflow: getComputedStyle(list).overflowY,
      focused: document.activeElement && document.activeElement.id
    };
  })()`);
  ok(opened.hidden === false, '点一下能展开');
  ok(opened.items === CHAT.length + 1, '列表里是全部模型', opened.items + ' 项');
  ok(opened.scrollable, '列表可滚动（滚轮能翻）', 'maxHeight=' + opened.maxH + ' overflow=' + opened.overflow);
  ok(opened.focused === 'aiPickSearch', '展开后光标在搜索框，直接能打字');

  // 搜索
  const searched = await win.webContents.executeJavaScript(`(() => {
    var q = document.getElementById('aiPickSearch');
    q.value = 'fb-5';
    q.dispatchEvent(new Event('input'));
    var items = [...document.querySelectorAll('#aiPickList .pi')].map(x => x.dataset.v);
    return items;
  })()`);
  ok(searched.length === 1 && searched[0] === 'fb-5-2', '搜 "fb-5" 精确命中', JSON.stringify(searched));

  // 键盘回车选中
  await win.webContents.executeJavaScript(`(() => {
    var q = document.getElementById('aiPickSearch');
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  })()`);
  await wait(500);
  const picked = await win.webContents.executeJavaScript(`(() => ({
    value: document.getElementById('aiModel').value,
    label: document.getElementById('aiPickLabel').textContent,
    hidden: document.getElementById('aiPickPop').hidden
  }))()`);
  ok(picked.value === 'fb-5-2', '回车选中写回下拉', picked.value);
  ok(/fb-5-2/.test(picked.label), '按钮文案跟着变', picked.label);
  ok(picked.hidden === true, '选完自动收起');
  // 选择只改当前选中，落盘仍由「保存」按钮负责（原有行为，不在这次改动范围）

  // 搜不到
  await win.webContents.executeJavaScript(`document.getElementById('aiPickBtn').click(); 1`);
  await wait(200);
  const empty = await win.webContents.executeJavaScript(`(() => {
    var q = document.getElementById('aiPickSearch');
    q.value = 'zzz-not-exist';
    q.dispatchEvent(new Event('input'));
    return { items: document.querySelectorAll('#aiPickList .pi').length, text: document.getElementById('aiPickList').textContent.trim() };
  })()`);
  ok(empty.items === 0 && /没有匹配/.test(empty.text), '搜不到时有提示', empty.text);

  // 点外面关闭
  await win.webContents.executeJavaScript(`document.body.click(); 1`);
  await wait(200);
  const closed = await win.webContents.executeJavaScript(`document.getElementById('aiPickPop').hidden`);
  ok(closed === true, '点空白处关闭');

  // 可滚动实测：滚一下看位置变
  await win.webContents.executeJavaScript(`document.getElementById('aiPickBtn').click(); 1`);
  await wait(200);
  const scrolled = await win.webContents.executeJavaScript(`(() => {
    var l = document.getElementById('aiPickList');
    var before = l.scrollTop;
    l.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true }));
    l.scrollTop = 300;
    return { before, after: l.scrollTop, h: l.scrollHeight, c: l.clientHeight };
  })()`);
  ok(scrolled.after > scrolled.before, '列表能滚到底部内容', scrolled.after + '/' + scrolled.h);

  try {
    fs.writeFileSync(path.join(os.tmpdir(), 'fde-model-picker.png'), (await win.capturePage()).toPNG());
    console.log('  · 截图 ' + path.join(os.tmpdir(), 'fde-model-picker.png'));
  } catch (e) {}

  if (errs.length) { console.log('  ✗ 控制台报错：' + errs.join(' | ')); fail++; }
  console.log(fail === 0 ? '\nALL OK' : '\nFAILED ' + fail);
  app.exit(fail === 0 ? 0 : 1);
}).catch(e => { console.error('FAIL', e); app.exit(1); });
