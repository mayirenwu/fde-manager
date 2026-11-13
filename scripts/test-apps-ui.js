/**
 * 应用功能页测试：四类能力（专家/技能/连接器/资料库）的列表、新建、改、下载、回收站。
 * 数据全部落在临时目录，不碰真实数据。
 * 跑法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/test-apps-ui.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'apps.js'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-apps-ui-'));
const results = [];
let canvasCalls = 0, copyCalls = 0, aiTestFail = false;
const AISTATE = { baseUrl: 'https://ai.my10086.cn/v1', apiKey: '', model: '', models: [] };
function aiPub() {
  const hasKey = !!AISTATE.apiKey;
  return {
    ok: true, baseUrl: AISTATE.baseUrl,
    keyMask: hasKey ? 'sk-te…7890' : '', hasKey,
    model: AISTATE.model, models: AISTATE.models, updatedAt: Date.now(),
    status: hasKey && AISTATE.model ? { level: 'on', text: '已接上 ' + AISTATE.model }
      : hasKey ? { level: 'half', text: '密钥有了，还差选一个模型' }
      : { level: 'off', text: '还没接算力：填密钥就能在画布里直接跑模型' },
    defaults: { baseUrl: 'https://ai.my10086.cn/v1', console: 'https://ai.my10086.cn/api/console', skill: 'https://ai.my10086.cn/api/console/skill', home: 'https://ai.my10086.cn/home?menu=zhinengti' }
  };
}

const SCAN = [
  { key: 'c1', source: 'workbuddy', kind: 'connector', group: '连接器市场', name: '135AI 排版', desc: '一句话，文章自动排好', path: '', installed: false, inline: { connector: { type: 'mcp', config: '{"url":"https://x/mcp"}', url: 'https://x/mcp', command: '' } } },
  { key: 'c2', source: 'workbuddy', kind: 'expert', group: '团队专家', name: 'A股投资顾问', desc: '所有 A 股分析的总入口', path: '', installed: false, inline: null },
  { key: 'c3', source: 'codex', kind: 'skill', group: 'Codex', name: '代码审查', desc: '按清单过一遍改动', path: '', installed: false, inline: null }
];

function test(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  [' + detail + ']' : ''));
}

app.whenReady().then(async () => {
  try {
    ipcMain.handle('data:get', () => ({ projects: [], flows: [], logs: [], inbox: {}, trash: [], activeId: null, originalCount: 0 }));
    ipcMain.handle('app:copy-text', () => { copyCalls++; return { ok: true }; });
    ipcMain.handle('apps:get', () => {
      const items = store.list(tmpRoot);
      return {
        ok: true, items: items.map(x => { const c = Object.assign({}, x); delete c.dir; return c; }),
        trash: store.listTrash(tmpRoot).map(t => ({ key: path.basename(t.dir), name: t.name, kind: t.kind, deletedAt: t.deletedAt })),
        kinds: store.KINDS, stats: store.stats(items), root: tmpRoot
      };
    });
    ipcMain.handle('apps:save', (e, patch) => store.save(tmpRoot, patch));
    ipcMain.handle('apps:remove', (e, id) => store.remove(tmpRoot, id));
    ipcMain.handle('apps:restore', (e, key) => store.restore(tmpRoot, key));
    ipcMain.handle('apps:purge', (e, key) => store.purge(tmpRoot, key));
    ipcMain.handle('apps:duplicate', (e, id) => store.duplicate(tmpRoot, id));
    ipcMain.handle('apps:prompt', (e, id) => {
      const it = store.get(tmpRoot, id);
      return it ? { ok: true, text: store.promptOf(it) } : { ok: false, error: '没有' };
    });
    ipcMain.handle('apps:open-folder', () => ({ ok: true }));
    ipcMain.handle('apps:open-target', () => ({ ok: true }));
    ipcMain.handle('apps:export', () => ({ ok: true }));
    ipcMain.handle('apps:import', () => ({ ok: true, results: [] }));
    ipcMain.handle('apps:scan', () => ({ ok: true, items: SCAN }));
    ipcMain.handle('apps:install', (e, cand) => {
      if (cand.inline && cand.inline.connector) {
        return store.save(tmpRoot, { kind: 'connector', name: cand.name, tagline: cand.desc, connector: cand.inline.connector, source: { type: 'workbuddy', path: '', label: 'WorkBuddy' } });
      }
      return store.save(tmpRoot, { kind: cand.kind, name: cand.name, tagline: cand.desc, body: '占位正文', source: { type: cand.source, path: '', label: cand.source } });
    });
    ipcMain.handle('apps:to-canvas', () => { canvasCalls++; return { ok: true, nodeId: 'n1' }; });
    ipcMain.handle('apps:close', () => ({ ok: true }));
    ipcMain.handle('app:paste-text', () => ({ ok: true, text: 'sk-testkey1234567890' }));
    ipcMain.handle('ai:get', () => aiPub());
    ipcMain.handle('ai:save', (e, patch) => {
      if (patch.apiKey) AISTATE.apiKey = patch.apiKey;
      if (patch.baseUrl) AISTATE.baseUrl = patch.baseUrl;
      if (patch.model) AISTATE.model = patch.model;
      if (Array.isArray(patch.models) && patch.models.length) AISTATE.models = patch.models;
      return aiPub();
    });
    ipcMain.handle('ai:detect', (e, patch) => {
      if (patch && patch.apiKey) AISTATE.apiKey = patch.apiKey;
      AISTATE.baseUrl = 'https://ai.my10086.cn/api/v1';
      AISTATE.models = [{ id: 'deepseek-chat', name: 'deepseek-chat' }, { id: 'gpt-4o-mini', name: 'gpt-4o-mini' }];
      return { ok: true, baseUrl: AISTATE.baseUrl, models: AISTATE.models, count: 2 };
    });
    ipcMain.handle('ai:models', () => ({ ok: true, baseUrl: AISTATE.baseUrl, models: AISTATE.models.length ? AISTATE.models : [{ id: 'deepseek-chat', name: 'deepseek-chat' }] }));
    ipcMain.handle('ai:test', (e, patch) => {
      if (patch && patch.model) AISTATE.model = patch.model;
      if (aiTestFail) return { ok: false, error: '无效的令牌', kind: 'auth' };
      return { ok: true, text: '连接正常', model: AISTATE.model || 'deepseek-chat', ms: 820, usage: { total_tokens: 9 } };
    });
    ipcMain.handle('ai:open', () => ({ ok: true }));
    ipcMain.handle('ai:open-settings', () => ({ ok: true }));

    const win = new BrowserWindow({
      width: 1200, height: 820, show: false,
      backgroundColor: '#0b0f17',
      webPreferences: {
        preload: path.join(ROOT, 'preload.js'),
        contextIsolation: true, nodeIntegration: false
      }
    });
    await win.loadFile(path.join(ROOT, 'apps.html'));
    await wait(800);

    const js = (code) => win.webContents.executeJavaScript(code);

    // 1) 结构：四类都在
    const rail = await js(`(() => ({
      rows: [...document.querySelectorAll('.rrow[data-t="kind"]')].map(x => x.textContent.replace(/\\s+/g,' ').trim()),
      stat: document.getElementById('stat').textContent,
      empty: document.getElementById('grid').textContent.replace(/\\s+/g,' ').trim().slice(0,60)
    }))()`);
    test('左侧列出专家/技能/连接器/资料库四类',
      ['专家', '技能', '连接器', '资料库'].every(k => rail.rows.some(r => r.indexOf(k) >= 0)), rail.rows.join(' | '));
    test('空库时有引导（下载或新建）', /下载/.test(rail.empty), rail.empty);

    // 2) 新建：打开抽屉并保存
    await js(`document.getElementById('newBtn').click(), 1`);
    await wait(260);
    const drawer1 = await js(`(() => ({
      on: document.getElementById('drawer').classList.contains('on'),
      kinds: document.querySelectorAll('#kinds button').length,
      title: document.getElementById('dTitle').textContent
    }))()`);
    test('点新建打开编辑器，能选四种类型', drawer1.on && drawer1.kinds === 4 && drawer1.title === '新建', JSON.stringify(drawer1));

    await js(`(() => {
      document.getElementById('fName').value = '跨境合规专家';
      document.getElementById('fTagline').value = '看出口合规、报关单据';
      document.getElementById('fBody').value = '# 角色\\n你是出口合规专家，先看 HS 编码再看单据。';
      document.getElementById('fTags').value = '跨境, 合规';
      return 1;
    })()`);
    await js(`document.getElementById('fSave').click(), 1`);
    await wait(500);
    const afterCreate = await js(`(() => ({
      cards: [...document.querySelectorAll('.card .nm')].map(x => x.textContent),
      stat: document.getElementById('stat').textContent
    }))()`);
    test('新建后卡片出现在列表里', afterCreate.cards.includes('跨境合规专家'), afterCreate.cards.join(','));
    test('统计跟着变', /1 项/.test(afterCreate.stat), afterCreate.stat);

    // 3) 修改
    await js(`document.querySelector('.card button[data-act="edit"]').click(), 1`);
    await wait(260);
    const editOpen = await js(`(() => ({
      title: document.getElementById('dTitle').textContent,
      name: document.getElementById('fName').value,
      body: document.getElementById('fBody').value.slice(0, 10),
      kindLocked: [...document.querySelectorAll('#kinds button')].every(b => b.disabled)
    }))()`);
    test('点编辑打开同一条，内容回填、类型锁定', editOpen.title === '修改' && editOpen.name === '跨境合规专家' && editOpen.kindLocked, JSON.stringify(editOpen));
    await js(`(() => { document.getElementById('fName').value = '出口合规专家'; document.getElementById('fSave').click(); return 1; })()`);
    await wait(450);
    const afterEdit = await js(`[...document.querySelectorAll('.card .nm')].map(x => x.textContent)`);
    test('改完名字立刻生效', afterEdit.includes('出口合规专家'), afterEdit.join(','));

    // 4) 用 → 放到画布
    await js(`(() => { document.getElementById('dX').click(); return 1; })()`);
    await wait(200);
    await js(`document.querySelector('.card button[data-act="use"]').click(), 1`);
    await wait(220);
    const pop = await js(`(() => ({ on: document.getElementById('pop').classList.contains('on'), items: [...document.querySelectorAll('#pop button')].map(b => b.textContent.trim()) }))()`);
    test('「用」菜单里有放到画布 / 复制给 AI', pop.on && pop.items.some(t => /画布/.test(t)) && pop.items.some(t => /复制/.test(t)), pop.items.join(' | '));
    await js(`[...document.querySelectorAll('#pop button')].find(b => /画布/.test(b.textContent)).click(), 1`);
    await wait(300);
    test('点放到画布会真的加节点', canvasCalls === 1, 'calls=' + canvasCalls);

    // 5) 下载
    await js(`document.getElementById('dlBtn').click(), 1`);
    await wait(700);
    const dl = await js(`(() => ({
      open: document.getElementById('dlMask').classList.contains('on'),
      stat: document.getElementById('dlStat').textContent,
      groups: [...document.querySelectorAll('#dlList .mgroup')].map(x => x.textContent),
      rows: document.querySelectorAll('#dlList .mrow').length
    }))()`);
    test('下载面板能列出本机可下载的能力', dl.open && dl.rows === 3 && /3 个可选/.test(dl.stat), JSON.stringify({ stat: dl.stat, groups: dl.groups }));
    test('按来源分组（连接器市场/团队专家/Codex）', dl.groups.join('|').indexOf('连接器市场') >= 0 && dl.groups.join('|').indexOf('Codex') >= 0, dl.groups.join(' | '));

    await js(`(() => {
      document.querySelectorAll('#dlList input[data-k]').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event('change')); });
      return 1;
    })()`);
    await wait(120);
    const hinted = await js(`document.getElementById('dlHint').textContent`);
    test('勾选后提示已选数量', /已选 3 项/.test(hinted), hinted);
    await js(`document.getElementById('dlGo').click(), 1`);
    await wait(900);
    const afterDl = await js(`(() => ({ cards: [...document.querySelectorAll('.card .nm')].map(x => x.textContent), stat: document.getElementById('stat').textContent }))()`);
    test('下载后三项都进了列表', afterDl.cards.length >= 4 && afterDl.cards.includes('135AI 排版'), afterDl.cards.join(','));
    test('下载完关闭面板', !(await js(`document.getElementById('dlMask').classList.contains('on')`)));

    // 6) 连接器卡片上显示来源是 WorkBuddy
    const srcChip = await js(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.indexOf('135AI 排版') >= 0);
      return card ? card.querySelector('.src').textContent : '';
    })()`);
    test('连接器显示来源 WorkBuddy', /WorkBuddy/.test(srcChip), srcChip);

    // 7) AI 算力：填密钥 → 自动找接口 → 保存 → 测试
    const pill0 = await js(`document.getElementById('aiPillText').textContent`);
    test('未接算力时头部有明确提示', pill0 === '未接算力', pill0);

    await js(`document.getElementById('aiRow').click(), 1`);
    await wait(320);
    const aiOpen = await js(`(() => ({
      open: document.getElementById('aiMask').classList.contains('on'),
      base: document.getElementById('aiBase').value,
      steps: document.querySelectorAll('#aiMask .step').length,
      links: [...document.querySelectorAll('#aiMask .linkrow button')].map(b => b.textContent)
    }))()`);
    test('AI 算力弹层打得开、有步骤和说明入口（含费用/线路直达）', aiOpen.open && aiOpen.steps === 3 && aiOpen.links.length === 5 && aiOpen.links.some(l => l.indexOf('费用') >= 0) && aiOpen.links.some(l => l.indexOf('线路') >= 0), JSON.stringify(aiOpen));
    test('默认地址指向 ai.my10086.cn', /ai\.my10086\.cn/.test(aiOpen.base), aiOpen.base);

    await js(`document.getElementById('aiPaste').click(), 1`);
    await wait(220);
    const keyVal = await js(`document.getElementById('aiKey').value`);
    test('能一键粘贴剪贴板里的密钥', keyVal === 'sk-testkey1234567890', keyVal);

    await js(`document.getElementById('aiDetect').click(), 1`);
    await wait(600);
    const det = await js(`(() => ({
      msg: document.getElementById('aiMsg').textContent.trim(),
      opts: [...document.querySelectorAll('#aiModel option')].map(o => o.value),
      base: document.getElementById('aiBase').value
    }))()`);
    test('自动找接口后填回地址并列出模型', /找到了/.test(det.msg) && det.opts.includes('deepseek-chat'), JSON.stringify(det));

    await js(`(() => { const s = document.getElementById('aiModel'); s.value = 'deepseek-chat'; s.dispatchEvent(new Event('change')); return 1; })()`);
    await js(`document.getElementById('aiSaveBtn').click(), 1`);
    await wait(500);
    const pill1 = await js(`document.getElementById('aiPillText').textContent`);
    test('保存后头部显示当前模型', /算力 · deepseek-chat/.test(pill1), pill1);

    await js(`document.getElementById('aiTest').click(), 1`);
    await wait(600);
    const testMsg = await js(`document.getElementById('aiMsg').textContent.trim()`);
    test('测试连接成功给出模型和耗时', /通了/.test(testMsg) && /deepseek-chat/.test(testMsg), testMsg);

    aiTestFail = true;
    await js(`document.getElementById('aiTest').click(), 1`);
    await wait(600);
    const failMsg = await js(`document.getElementById('aiMsg').textContent.trim()`);
    test('密钥不对时说清是密钥问题', /连不上/.test(failMsg) && /密钥/.test(failMsg), failMsg);
    aiTestFail = false;

    // 截图：AI 算力设置面板
    win.webContents.invalidate();
    await wait(150);
    const shotAi = path.join(os.tmpdir(), 'fde-apps-ai.png');
    fs.writeFileSync(shotAi, (await win.webContents.capturePage()).toPNG());
    console.log('  AI 截图: ' + shotAi);

    await js(`document.getElementById('aiX').click(), 1`);
    await wait(260);

    // 7) 删除 → 回收站 → 恢复
    await js(`(() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.textContent.indexOf('出口合规专家') >= 0);
      card.querySelector('button[data-act="del"]').click(); return 1;
    })()`);
    await wait(450);
    const afterDel = await js(`(() => ({
      cards: [...document.querySelectorAll('.card .nm')].map(x => x.textContent),
      trashN: [...document.querySelectorAll('.rrow')].find(r => /回收站/.test(r.textContent)).textContent.replace(/\\s+/g,' ')
    }))()`);
    test('删除后卡片消失，回收站计数 +1', !afterDel.cards.includes('出口合规专家') && /回收站\s*1/.test(afterDel.trashN), afterDel.trashN);

    await js(`document.getElementById('trashRow').click(), 1`);
    await wait(320);
    const trash = await js(`(() => ({
      open: document.getElementById('trMask').classList.contains('on'),
      text: document.getElementById('trList').textContent.replace(/\\s+/g,' ').trim().slice(0, 80),
      canRestore: !!document.querySelector('#trList button[data-r]')
    }))()`);
    test('回收站里能看到并可恢复', trash.open && /出口合规专家/.test(trash.text) && trash.canRestore, trash.text);
    await js(`document.querySelector('#trList button[data-r]').click(), 1`);
    await wait(500);
    const restored = await js(`[...document.querySelectorAll('.card .nm')].map(x => x.textContent)`);
    test('恢复后重新出现在列表', restored.includes('出口合规专家'), restored.join(','));

    // 8) 截图
    await js(`document.getElementById('trX').click(), 1`);
    await wait(400);
    const trClosed = await js(`!document.getElementById('trMask').classList.contains('on')`);
    test('回收站弹窗能关掉', trClosed);
    await wait(250);
    win.webContents.invalidate();
    await wait(120);
    const shot = path.join(os.tmpdir(), 'fde-apps.png');
    fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    console.log('  截图: ' + shot);

    // 9) 面板上的入口：找回窗口已换成应用功能
    const pw = new BrowserWindow({
      width: 380, height: 860, show: false,
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });
    ipcMain.handle('desktop:current', () => ({ ok: true }));
    await pw.loadFile(path.join(ROOT, 'panel.html'));
    await wait(600);
    const panel = await pw.webContents.executeJavaScript(`(() => ({
      apps: !!document.getElementById('appsBtn'),
      appsText: (document.getElementById('appsBtn') || {}).textContent || '',
      reshow: !!document.getElementById('reshowBtn'),
      hasOldWord: document.body.innerHTML.indexOf('找回窗口') >= 0
    }))()`);
    test('工作台里已是「应用功能」入口', panel.apps && /应用功能/.test(panel.appsText), panel.appsText.trim());
    test('「找回窗口」已彻底移除', !panel.reshow && !panel.hasOldWord);
    const panelAi = await pw.webContents.executeJavaScript(`(() => {
      const b = document.getElementById('aiBtn3');
      return { has: !!b, text: b ? b.textContent.trim() : '' };
    })()`);
    test('面板上有 AI 算力入口', panelAi.has && /AI 算力/.test(panelAi.text), panelAi.text);

    const pass = results.filter(r => r.ok).length;
    console.log('\n' + pass + '/' + results.length + ' 通过');
    try { fs.writeFileSync(path.join(os.tmpdir(), 'fde-apps-ui-result.json'), JSON.stringify(results, null, 2)); } catch (e) {}
    app.exit(pass === results.length ? 0 : 1);
  } catch (e) {
    console.log('异常: ' + (e && e.stack || e));
    app.exit(1);
  }
});
