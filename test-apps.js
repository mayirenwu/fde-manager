/**
 * apps.js 单元测试：四类能力的存、改、删、回收站、导入、下载、导出。
 * 跑法：node test-apps.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const apps = require('./apps');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-apps-unit-'));

// ---- 新建 / 列表 ----
const r1 = apps.save(root, { kind: 'expert', name: '跨境合规专家', tagline: '看出口合规', body: '# 角色\n你是合规专家', tags: '跨境, 合规, 合规' });
t('新建专家成功', r1.ok && r1.item.id.startsWith('expert.'));
t('标签去重', (r1.item.tags || []).join(',') === '跨境,合规', (r1.item.tags || []).join(','));

const r2 = apps.save(root, { kind: 'skill', name: '日报整理', body: '1. 汇总 2. 结论' });
const r3 = apps.save(root, { kind: 'connector', name: '企查查', connector: { type: 'mcp', config: '{"url":"https://x"}', url: 'https://x' } });
const r4 = apps.save(root, { kind: 'library', name: '客户模板', library: { path: 'D:\\资料', items: ['报价.xlsx'] } });
t('四类都能建', r1.ok && r2.ok && r3.ok && r4.ok);

const list = apps.list(root);
t('列表返回 4 项并按时间倒序', list.length === 4 && list[0].name === '客户模板', list.map(x => x.name).join(','));

// ---- 非法输入 ----
t('空名字被拒', !apps.save(root, { kind: 'skill', name: '   ' }).ok);
t('非法类型被拒', !apps.save(root, { kind: 'nope', name: 'x' }).ok);
t('路径穿越被拒', apps.get(root, '../etc') === null && apps.get(root, 'skill..\\x') === null);
const rootBig = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-apps-big-'));
t('超长正文被截断', apps.save(rootBig, { kind: 'skill', name: '大文件', body: 'x'.repeat(300 * 1024) }).item.body.length <= 200 * 1024);

// ---- 修改 / 置顶 / 复制 ----
const up = apps.save(root, { id: r2.item.id, name: '日报整理 v2', pinned: true });
t('按 id 修改不改类型', up.ok && up.item.kind === 'skill' && up.item.pinned === true);
const dup = apps.duplicate(root, r1.item.id);
t('复制生成新 id', dup.ok && dup.item.id !== r1.item.id && /副本/.test(dup.item.name), dup.error || (dup.item && dup.item.name));
t('复制后列表 +1', apps.list(root).length === 5, 'len=' + apps.list(root).length);

// ---- 正文落盘 ----
t('body.md 单独存在', fs.existsSync(path.join(root, 'skill', r2.item.id, 'body.md')));

// ---- 删除 / 回收站 / 恢复 ----
t('删除进回收站', apps.remove(root, r1.item.id).ok && apps.list(root).length === 4);
const trash = apps.listTrash(root);
t('回收站有记录', trash.length === 1 && trash[0].name === '跨境合规专家');
const key = path.basename(trash[0].dir);
t('恢复回来', apps.restore(root, key).ok && apps.list(root).some(x => x.id === r1.item.id));
t('恢复后回收站清空', apps.listTrash(root).length === 0);
apps.remove(root, r1.item.id);
const t2 = apps.listTrash(root)[0];
t('彻底删除不可恢复', apps.purge(root, path.basename(t2.dir)).ok && apps.listTrash(root).length === 0);

// ---- 导入：md / json / 文件夹 / zip ----
const md = path.join(root, 'sample.md');
fs.writeFileSync(md, '---\nname: 报价规则\ndescription: 先看汇率再看账期\n---\n# 报价规则\n第一步…');
const imp1 = apps.importFrom(root, md);
t('md 按前 matter 导入为技能', imp1.ok && imp1.item.kind === 'skill' && imp1.item.name === '报价规则', JSON.stringify(imp1.item || {}).slice(0, 80));

const mcpJson = path.join(root, 'mcp.json');
fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { demo: { url: 'https://demo/mcp' } } }));
const imp2 = apps.importFrom(root, mcpJson);
t('mcp.json 导入为连接器并带上配置', imp2.ok && imp2.item.kind === 'connector' && /demo/.test(imp2.item.connector.config));

const dir = path.join(root, 'skilldir');
fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: 目录技能\ndescription: 从文件夹来\n---\n做法…');
fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2');
const imp3 = apps.importFrom(root, dir);
t('文件夹导入，附件进 files/', imp3.ok && fs.existsSync(path.join(root, imp3.item.kind, imp3.item.id, 'files', 'data.csv')));

// zip（依赖 Windows 自带 Expand-Archive）
const zip = path.join(root, 'pack.zip');
try {
  fs.writeFileSync(path.join(root, 'ziptest', 'SKILL.md').replace(/\\ziptest\\/, '\\ziptest\\'), '');
} catch (e) {}
fs.mkdirSync(path.join(root, 'ziptest'), { recursive: true });
fs.writeFileSync(path.join(root, 'ziptest', 'SKILL.md'), '---\nname: 压缩技能\n---\n来自 zip');
try {
  require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Compress-Archive -Path ' + JSON.stringify(path.join(root, 'ziptest')).replace(/"/g, "'") + ' -DestinationPath ' + JSON.stringify(zip).replace(/"/g, "'") + ' -Force'], { timeout: 30000 });
  const imp4 = apps.importFrom(root, zip);
  t('zip 解压后导入', imp4.ok && imp4.item.name === '压缩技能', imp4.error || imp4.item.name);
} catch (e) {
  t('zip 解压后导入', false, e.message.slice(0, 80));
}

// ---- 前端 matter 折行（团队专家的写法） ----
const fm = apps.stripFrontmatter('---\nname: advisor\ndescription: >-\n  A股投资顾问：所有分析\n  的统一入口。\ntools: Bash\n---\n正文');
t('YAML 折行能拼回一句', /A股投资顾问：所有分析 的统一入口。|A股投资顾问：所有分析\s*的统一入口。/.test(fm.meta.description), fm.meta.description);

// ---- 下载 ----
const cand = { key: 'k1', source: 'workbuddy', kind: 'expert', name: 'A股投资顾问', desc: '总入口', path: dir };
const inst = apps.installCandidate(root, cand);
t('从候选安装成功', inst.ok && inst.item.source.type === 'workbuddy');
const scan = apps.scanSources(os.homedir(), root);
t('扫描不抛错且是数组', Array.isArray(scan));
t('同一来源不重复装（按名字去重交给上层）', apps.installCandidate(root, cand).ok);

// ---- 导出 / 提示词 ----
const expDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-apps-exp-'));
const exp = apps.exportTo(root, r2.item.id, expDir);
t('导出到指定目录', exp.ok && fs.existsSync(path.join(exp.dir, 'manifest.json')), exp.error || exp.dir);
const pr = apps.promptOf(apps.get(root, r3.item.id));
t('连接器的提示词带配置', /https:\/\/x/.test(pr), pr.slice(0, 60));
const pr2 = apps.promptOf(apps.get(root, r2.item.id));
t('技能的提示词带正文', /汇总/.test(pr2));

// ---- 统计 ----
const st = apps.stats(apps.list(root));
t('统计各类型数量', st.total === apps.list(root).length && typeof st.expert === 'number');

console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
