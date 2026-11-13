/**
 * 模型设置 → 密钥安全：别人的 key 看不到、带不走；能一直保存，也能清空。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/check-key-safe.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  ← ' + String(extra).slice(0, 120) : ''));
  if (!cond) fail++;
};

// 一个"已经保存过密钥"的状态（模拟别人的电脑上已经配好、或刚交接过来）
const AI_ON = {
  ok: true, baseUrl: 'https://api.lk888.ai/v1', hasKey: true, keyMask: 'sk-****',
  model: 'gem-3.8-flash', models: [{ id: 'gem-3.8-flash', name: 'GEM 3.8 flash' }],
  protocol: 'openai', autoSwitch: true, delivered: false, deliveredLabel: '',
  providers: [], usage: null, status: { level: 'on', text: '已接上 gem-3.8-flash' },
  defaults: { baseUrl: 'https://api.lk888.ai/v1' }
};
const AI_EMPTY = Object.assign({}, AI_ON, {
  hasKey: false, keyMask: '', delivered: false,
  status: { level: 'off', text: '还没接算力：填密钥就能在画布里直接跑模型' }
});

app.whenReady().then(async () => {
  const calls = { save: [], open: [] };
  let cur = AI_ON;

  ipcMain.handle('data:get', () => ({ ok: true, apps: [] }));
  ipcMain.handle('apps:get', () => ({ ok: true, items: [], trash: [], stats: { total: 0 }, kinds: {} }));
  ipcMain.handle('packs:list', () => ({ ok: true, packs: [] }));
  ipcMain.handle('ai:open-settings', () => ({ ok: true }));
  ipcMain.handle('ai:get', () => cur);
  ipcMain.handle('models:catalog', () => ({ ok: true, counts: {}, groups: {} }));
  ipcMain.handle('app:copy-text', () => ({ ok: true }));
  ipcMain.handle('ai:open', (e, which) => { calls.open.push(which); return { ok: true }; });
  ipcMain.handle('ai:save', (e, patch) => {
    calls.save.push(patch);
    if (patch && patch.clearKey) cur = AI_EMPTY;
    else if (patch && patch.apiKey) cur = Object.assign({}, cur, { hasKey: true, keyMask: 'sk-****' });
    return cur;
  });

  const win = new BrowserWindow({
    width: 1200, height: 900, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  const errs = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2 && !/Electron Security Warning/.test(msg)) errs.push(String(msg).slice(0, 160));
  });
  await win.loadFile(path.join(ROOT, 'apps.html'));
  await wait(900);

  await win.webContents.executeJavaScript(`document.getElementById('aiRow').click(), 1`);
  await wait(700);

  /* ---- 1. 密钥框：默认空、只显示 *、不回填任何片段 ---- */
  const st = await win.webContents.executeJavaScript(`(() => {
    const k = document.getElementById('aiKey');
    const c = document.getElementById('aiClearKey');
    const pill = document.getElementById('aiPillText');
    return {
      type: k.type,
      value: k.value,
      placeholder: k.placeholder,
      clearVisible: !!c && c.style.display !== 'none' && c.offsetParent !== null,
      clearText: c ? c.textContent.trim() : '',
      hint: (document.getElementById('aiKeyHint') || {}).textContent || '',
      pill: pill ? pill.textContent : ''
    };
  })()`);
  ok(st.type === 'password', '密钥输入框是密码框（输入显示 *）', st.type);
  ok(st.value === '', '打开时密钥框是空的（不把已存的 key 回填）', JSON.stringify(st.value));
  ok(!/sk-[A-Za-z0-9]/.test(st.placeholder), '提示语里不含真实密钥片段', st.placeholder);
  ok(st.clearVisible && /清空/.test(st.clearText), '已存密钥时出现「清空」按钮', st.clearText);
  ok(/sk-\*\*\*\*/.test(st.hint) && !/sk-[0-9a-zA-Z]{4,}/.test(st.hint.replace(/sk-\*\*\*\*/g, '')), '提示只显示 sk-****，不给任何真实字符', st.hint);

  /* ---- 2. 旁边有官网链接，点了就打开 keys 页 ---- */
  const link = await win.webContents.executeJavaScript(`(() => {
    const a = document.getElementById('aiOpenKeyLink');
    return { text: a ? a.textContent.trim() : '', href: a ? (a.getAttribute('href') || '') : '' };
  })()`);
  ok(/ai\.my10086\.cn\/api\/console\/keys/.test(link.text), '旁边写着完整官网地址 ai.my10086.cn/api/console/keys', link.text);
  await win.webContents.executeJavaScript(`document.getElementById('aiOpenKeyLink').click(), 1`);
  await wait(250);
  ok(calls.open.indexOf('keys') >= 0, '点这个链接会打开 API 官网的密钥页', JSON.stringify(calls.open));

  const shot1 = path.join(os.tmpdir(), 'fde-key-safe.png');
  fs.writeFileSync(shot1, (await win.capturePage()).toPNG());

  /* ---- 3. 填了新密钥 → 保存后仍然清空输入框、只显示"已保存" ---- */
  await win.webContents.executeJavaScript(`(() => {
    const k = document.getElementById('aiKey');
    k.value = 'sk-newkey-abcdef123456';
    document.getElementById('aiSaveBtn').click();
    return 1;
  })()`);
  await wait(700);
  const afterSave = await win.webContents.executeJavaScript(`(() => ({
    saved: ${JSON.stringify(0)} === 0 ? true : false,
    input: document.getElementById('aiKey').value,
    hint: (document.getElementById('aiKeyHint') || {}).textContent || ''
  }))()`);
  ok(calls.save.length >= 1 && calls.save[calls.save.length - 1].apiKey === 'sk-newkey-abcdef123456', '填了密钥点保存，密钥确实交给主进程存起来', JSON.stringify(calls.save.map(s => Object.keys(s))));

  /* ---- 4. 清空：两下确认才真删，删完输入框空、按钮藏起来 ---- */
  const n0 = calls.save.length;
  await win.webContents.executeJavaScript(`document.getElementById('aiClearKey').click(), 1`);
  await wait(200);
  const armed = await win.webContents.executeJavaScript(`(() => ({
    text: document.getElementById('aiClearKey').textContent.trim(),
    saves: ${n0} + ${'0'}
  }))()`);
  ok(/确认/.test(armed.text) && calls.save.length === n0, '第一下只是"再点一次确认"，不会立刻删', armed.text);
  await win.webContents.executeJavaScript(`document.getElementById('aiClearKey').click(), 1`);
  await wait(700);
  const afterClear = await win.webContents.executeJavaScript(`(() => ({
    input: document.getElementById('aiKey').value,
    clearVisible: document.getElementById('aiClearKey').offsetParent !== null,
    hint: (document.getElementById('aiKeyHint') || {}).textContent || ''
  }))()`);
  const last = calls.save[calls.save.length - 1] || {};
  ok(last.clearKey === true, '第二下才真的调 clearKey 清空', JSON.stringify(last));
  ok(afterClear.input === '', '清空后输入框为空');
  ok(!afterClear.clearVisible, '清空后「清空」按钮自动隐藏（没密钥可清了）');
  ok(/已清空/.test(afterClear.hint), '清空后在界面上说清了', afterClear.hint.slice(0, 40));

  const shot2 = path.join(os.tmpdir(), 'fde-key-cleared.png');
  fs.writeFileSync(shot2, (await win.capturePage()).toPNG());

  ok(errs.length === 0, '页面无脚本报错', errs.join(' | '));
  console.log('\n截图: ' + shot1 + ' / ' + shot2);
  console.log(fail ? ('\nFAIL ' + fail + ' 项') : '\nALL PASS');
  app.exit(fail ? 1 : 0);
});
