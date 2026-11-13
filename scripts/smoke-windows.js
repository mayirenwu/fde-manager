/**
 * 发布门禁：把 FDE 的每一个窗口页面真开一遍。
 *
 * 为什么需要它：单元测试和 IPC 配对检查都过了，也可能有某个窗口一打开就白屏
 * （少个 preload 通道、某段内联脚本写错、DOM 选择器写偏）。
 * 用户装上之后第一眼看到的如果是个空窗口，前面所有卖点都白讲。
 *
 * 检查项（每个页面）：
 *   1. 加载成功，没有 did-fail-load
 *   2. 渲染进程没崩（render-process-gone）
 *   3. 页面里没有未捕获异常 / console error（过滤 Electron 安全提示）
 *   4. 关键 DOM 存在且可见（宽高 > 0）
 *   5. 正文有实际内容（不是一片空白）
 *
 * 跑法：npx electron scripts/smoke-windows.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-smoke-'));
app.setPath('userData', path.join(TMP, 'userdata'));

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' | ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---- 通用 IPC 兜底：preload 里声明的每个通道都给一个"宽松但有形状"的返回 ---- */
const WIDE = {
  ok: true, error: '', url: '', path: '', dir: '', text: '', name: '',
  items: [], list: [], libs: [], docs: [], projects: [], logs: [], flows: [], trash: [],
  packs: [], nodes: [], models: [], files: [], browsers: [], kinds: {}, stats: {}, settings: {},
  state: {}, info: {}, data: {}, hasKey: false, pinned: false, enabled: false, isAdmin: false
};
function wide() { return JSON.parse(JSON.stringify(WIDE)); }

/**
 * 少数通道的返回形状不是"对象里塞数组"，页面会直接迭代/读嵌套字段。
 * 这里按主进程真实返回值补齐（见 main.js 的 snapshot / envInfo / scanPacks），
 * 否则报出来的错是"测试数据不对"，不是产品坏了。
 */
const FAKE_PROJECT = {
  id: 'p1', name: '演示项目', desc: '冒烟测试用', color: '#4f8cff', status: 'stopped', statusMsg: '',
  items: [], autorun: [], windows: [], context: [], stakeholders: [], acks: {},
  case: {}, adoption: {}, approvals: {}, exclusive: true
};
const OVERRIDES = {
  'data:get': () => ({
    projects: [FAKE_PROJECT], flows: [], logs: [], trash: [], inbox: {},
    canvas: { nodes: [], edges: [] }, activeId: null, uncontrolled: 0, missing: 0,
    isAdmin: false, originalCount: 0, originalTitles: [], windowTitles: {}, autostart: false,
    settings: { wallpaper: true, needAdmin: false, winPin: false, dodgePanel: true },
    platformId: 'win32', platformLabel: 'Windows'
  }),
  'pack:list': () => [],
  'env:info': () => ({
    ok: true, dataRoot: TMP, mode: 'default', source: '', appDir: ROOT, version: '0.0.0-smoke',
    portableConfig: '', counts: { projects: 1, canvasNodes: 0, packs: 0, scripts: 0, context: 0 }, ai: {}
  }),
  'kb:load': () => ({ ok: true, libs: [], docs: [], kinds: {}, version: '1', stats: {} }),
  'ai:get': () => ({
    ok: true, hasKey: false, model: '', baseUrl: '', models: [], active: '',
    status: { level: 'off', text: '' }, providers: []
  }),
  'trust:info': () => ({ ok: true, facts: [], people: [], cases: [], terms: [], ack: [] }),
  'windows:list': () => ({ ok: true, mine: [], others: [], all: [] }),
  'env:check': () => ({ ok: true, summary: { ready: true, error: 0, warn: 0 }, items: [] })
};
const channels = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const set = new Set();
  const re = /ipcRenderer\.invoke\('([^']+)'/g;
  let m;
  while ((m = re.exec(src))) set.add(m[1]);
  return Array.from(set);
})();

/* ---- 待检页面：file / 关键 DOM / 说明 ---- */
const PAGES = [
  { file: 'panel.html', must: ['#nowName', 'header'], note: '左侧常驻面板' },
  { file: 'project.html', query: { id: 'p1' }, must: ['body'], note: '项目控制面板' },
  { file: 'apps.html', must: ['body'], note: '应用功能（能力 / 知识库）' },
  { file: 'market.html', must: ['body'], note: '场景市场' },
  { file: 'kb.html', must: ['body'], note: '知识库' },
  { file: 'ecom.html', must: ['body'], note: '卖货台' },
  { file: 'env.html', must: ['body'], note: '环境 / 迁移' },
  { file: 'trust.html', must: ['body'], note: '信任中心' },
  { file: 'overview.html', must: ['body'], note: '总览 / 工作流画布' }
];

app.whenReady().then(async () => {
  for (const ch of channels) {
    try { ipcMain.handle(ch, () => (OVERRIDES[ch] ? OVERRIDES[ch]() : wide())); } catch (e) {}
  }
  console.log('· 已为 ' + channels.length + ' 个 preload 通道注册兜底返回');

  // 复用同一个窗口轮流 loadURL：
  // Windows 上"销毁一个隐藏窗口、立刻建下一个"会 ERR_FAILED(-2)，
  // 和离线渲染图标踩的是同一个坑——那不是页面坏了，是窗口生命周期坏了。
  const win = new BrowserWindow({
    width: 1200, height: 820, show: false, frame: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true
    }
  });
  let errs = [];
  win.webContents.on('console-message', (e, level, message) => {
    if (level >= 3 && !/Electron Security Warning|Autofill/.test(message)) {
      errs.push('console: ' + String(message).slice(0, 200));
    }
  });
  win.webContents.on('preload-error', (e, fp, err) => errs.push('preload: ' + (err && err.message)));
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) errs.push('did-fail-load: ' + code + ' ' + desc);
  });
  win.webContents.on('render-process-gone', (e, d) => errs.push('render-gone: ' + (d && d.reason)));

  for (const p of PAGES) {
    errs = [];
    try {
      // 用 file URL（不用 loadFile）：带 query 时 loadFile 会把反斜杠原样塞进 URL
      const qs = p.query ? ('?' + new URLSearchParams(p.query).toString()) : '';
      const url = pathToFileURL(path.join(ROOT, p.file)).href + qs;
      await win.loadURL(url);
      await wait(1500);                      // 等首屏渲染 + 页面里的 await 落定

      const probe = await win.webContents.executeJavaScript(`(() => {
        const vis = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        return {
          must: ${JSON.stringify(p.must)}.map(s => [s, vis(s)]),
          textLen: (document.body && document.body.innerText || '').trim().length,
          title: document.title || ''
        };
      })()`);

      const missing = probe.must.filter(([, v]) => !v).map(([s]) => s);
      ok(missing.length === 0, p.note + '：关键元素都在', missing.length ? '缺 ' + missing.join(',') : '');
      ok(probe.textLen > 40, p.note + '：页面有实际内容', '正文 ' + probe.textLen + ' 字');

      // 截图留档，出问题时能直接看是哪一屏
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(TMP, p.file.replace('.html', '') + '.png'), img.toPNG());
        if (p === PAGES[0]) console.log('  · 截图目录 ' + TMP);
      } catch (e) {}

      const real = errs.filter(s => !/DevTools|Downloading the React|Extension server/i.test(s));
      ok(real.length === 0, p.note + '：无脚本错误', real.slice(0, 2).join(' ;; '));
    } catch (e) {
      ok(false, p.note + '：加载', e.message);
    }
  }
  try { win.destroy(); } catch (e) {}

  console.log('\n' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    fails.forEach(f => console.log('  ✗ ' + f));
    app.exit(1);
  } else {
    console.log('SMOKE ALL PASS');
    app.exit(0);
  }
}).catch(e => { console.error('SMOKE 崩了：', e); app.exit(1); });
