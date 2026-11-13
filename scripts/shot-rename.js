/**
 * 看一眼：标题改名、工作台按钮换位、应用功能侧栏「模型设置」置顶
 * 顺带断言 DOM 顺序，防止以后被人调回去。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-shot-'));
app.setPath('userData', path.join(TMP, 'ud'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (cond, label, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  ← ' + extra : ''));
  if (!cond) fail++;
};

app.whenReady().then(async () => {
  ipcMain.handle('apps:get', () => ({ items: [], trash: [], stats: { total: 0 }, kinds: {} }));
  ipcMain.handle('ai:get', () => ({ ok: true, hasKey: false, model: '', baseUrl: '', models: [], status: { level: 'off', text: '' } }));

  /* ---------- 面板 ---------- */
  const panel = new BrowserWindow({
    width: 360, height: 820, show: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true }
  });
  await panel.loadFile(path.join(__dirname, '..', 'panel.html'));
  await wait(900);

  // 新手向导弹层会挡住面板，能关就关（有跳过/关闭键就点，没有就直接藏）
  await panel.webContents.executeJavaScript(`(() => {
    const cand = ['#wizSkip', '#wizClose', '#wizX', '.wizard .x', '[id*="skip"]', '[id*="Skip"]'];
    for (const sel of cand) { const b = document.querySelector(sel); if (b) { b.click(); return sel; } }
    const w = document.querySelector('#wiz, .wizard, [class*="wiz"]');
    if (w) w.style.display = 'none';
    document.querySelectorAll('.mask').forEach(m => m.classList.remove('on'));
    return 'hidden';
  })()`).catch(() => {});
  await wait(400);

  const head = await panel.webContents.executeJavaScript(`(() => ({
    title: document.title,
    h1: (document.querySelector('header h1') || {}).textContent || '',
    clipped: (() => { const h = document.querySelector('header h1'); return h ? h.scrollWidth > h.clientWidth + 1 : false; })()
  }))()`);
  ok(head.title.indexOf('FDE 智能体 控制台') >= 0, '面板窗口标题已是「FDE 智能体 控制台」', head.title);
  ok(/FDE 智能体 控制台/.test(head.h1), '面板顶部大标题已改', head.h1);
  ok(!head.clipped, '窄面板下标题没被截断（超长会显示省略号）');

  await panel.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('[data-grp="work"]');
    const h = g && g.querySelector('.grphead');
    if (h && !g.classList.contains('open')) h.click();
    return 1;
  })()`);
  await wait(500);
  const btns = await panel.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-grp="work"] .origbtn')].map(b => b.textContent.trim())`);
  console.log('BTNS', JSON.stringify(btns));
  ok(/应用功能/.test(btns[0] || ''), '工作台第 1 个按钮是「应用功能」', btns[0]);
  ok(/工作流画布/.test(btns[3] || ''), '工作台第 4 个按钮是「工作流画布」（与上一行第 2 格对调）', btns[3]);

  const img1 = await panel.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'rename-panel.png'), img1.toPNG());

  /* ---------- 应用功能 ---------- */
  const win = new BrowserWindow({
    width: 1280, height: 900, show: false, paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, nodeIntegrationInSubFrames: true
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'apps.html'));
  await wait(1000);

  const rail = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('#rail .rrow')];
    return rows.map(r => ({ id: r.id, text: r.textContent.replace(/\\s+/g, ' ').trim() }));
  })()`);
  console.log('RAIL', JSON.stringify(rail.slice(0, 4)));
  ok(rail[0] && rail[0].id === 'aiRow' && /模型设置/.test(rail[0].text), '侧栏第 1 行是「模型设置」', rail[0] && rail[0].text);
  ok(rail[1] && rail[1].id === 'kbEntRow', '「知识库」紧跟在模型设置下面（第 2 行）', rail[1] && rail[1].text);
  ok(!rail.some(r => /AI 算力/.test(r.text)), '侧栏里不再出现旧名「AI 算力」');

  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'rename-apps.png'), img2.toPNG());

  // 点开模型设置：标题要对
  await win.webContents.executeJavaScript(`document.getElementById('aiRow').click(), 1`);
  await wait(900);
  const modal = await win.webContents.executeJavaScript(`(() => ({
    open: document.getElementById('aiMask').classList.contains('on'),
    title: (document.querySelector('#aiMask .mh .t') || {}).textContent || ''
  }))()`);
  ok(modal.open && /模型设置/.test(modal.title), '点「模型设置」打开的是同一个弹窗，标题已改名', modal.title);
  const img3 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(os.tmpdir(), 'rename-modal.png'), img3.toPNG());

  console.log(fail ? ('\n' + fail + ' 项失败') : '\nALL PASS');
  app.exit(fail ? 1 : 0);
});
