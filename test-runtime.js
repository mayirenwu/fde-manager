const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rt = require('./runtime');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-test-'));

// 1) zip / unzip 往返（含中文文件名、二进制、大文件压缩）
const big = Buffer.alloc(9000, 'A');
const entries = [
  { name: 'manifest.json', data: JSON.stringify({ schema: 'fde.env/1', hello: '世界' }) },
  { name: 'packs/包一/README.md', data: '# 中文文件名\n' + 'x'.repeat(2000) },
  { name: 'bin/data.bin', data: big }
];
const buf = rt.zip(entries);
fs.writeFileSync(path.join(tmp, 't.fdeenv'), buf);
const back = rt.unzip(fs.readFileSync(path.join(tmp, 't.fdeenv')));
assert.strictEqual(back.size, 3, 'unzip 条目数');
assert.strictEqual(JSON.parse(back.get('manifest.json').toString()).hello, '世界');
assert.ok(back.get('packs/包一/README.md').toString().startsWith('# 中文文件名'));
assert.strictEqual(back.get('bin/data.bin').length, 9000);
assert.ok(buf.length < 3000, '大文件应该被压小，实际 ' + buf.length);
console.log('✓ zip 往返 / 中文名 / 压缩', buf.length, 'bytes');

// 2) 路径变量化
const home = 'C:\\Users\\张三';
const roots = rt.makeRoots({ home, desktop: home + '\\Desktop', docs: home + '\\Documents', appDir: 'D:\\FDE' });
const s1 = 'C:\\Users\\张三\\Desktop\\客户资料\\a.xlsx';
assert.strictEqual(rt.toVars(s1, roots), '${DESKTOP}\\客户资料\\a.xlsx');
assert.strictEqual(rt.fromVars('${DESKTOP}\\客户资料\\a.xlsx', roots), s1);
assert.strictEqual(rt.toVars('C:\\Windows\\system32\\cmd.exe', roots), 'C:\\Windows\\system32\\cmd.exe');
assert.strictEqual(rt.toVars('D:\\FDE\\main.js', roots), '${APPDIR}\\main.js');
console.log('✓ 路径变量化');

// 3) 快照往返
const packsDir = path.join(tmp, 'packs');
fs.mkdirSync(path.join(packsDir, 'com.demo.pack'), { recursive: true });
fs.writeFileSync(path.join(packsDir, 'com.demo.pack', 'manifest.json'), '{"id":"com.demo.pack"}');
const data = {
  projects: [{
    id: 'p1', name: '华东客户', desc: '测试',
    autorun: [{ type: 'exe', name: 'PS', path: home + '\\Desktop\\ps.exe', args: '' }],
    items: [{ id: 'i1', kind: 'script', name: '日报', path: home + '\\Documents\\日报.ps1' }],
    context: [{ id: 'c1', kind: 'folder', title: '资料', value: home + '\\Documents\\客户资料' }],
    windows: [{ hwnd: 123 }], status: 'running', statusMsg: '跑着'
  }],
  flows: [], logs: Array.from({ length: 300 }, (_, i) => ({ t: i, msg: 'log' + i })),
  canvas: { nodes: [{ id: 'n1', type: 'file', title: 'A', ref: { path: 'D:\\FDE\\main.js' } }], edges: [] },
  settings: { wallpaper: true }
};
const snapEntries = rt.snapshotEntries(data, {
  roots, packsDir, packScriptsDir: null, appVersion: '0.1.0'
});
const snap = rt.zip(snapEntries);
const parsed = rt.parseSnapshot(snap);
assert.strictEqual(parsed.manifest.schema, 'fde.env/1');
assert.strictEqual(parsed.manifest.counts.projects, 1);
assert.ok(parsed.data.projects[0].autorun[0].path.startsWith('${DESKTOP}'), '导出应为变量');
assert.strictEqual(parsed.data.projects[0].status, 'stopped', '运行态要清掉');
assert.strictEqual(parsed.data.logs.length, 150, '日志只留最近 150 条');
assert.strictEqual(parsed.data.projects[0].windows.length, 0);
assert.ok(parsed.files.has('packs/com.demo.pack/manifest.json'), '包要带上');
// 还原（模拟换了一台机器、换用户名）
const roots2 = rt.makeRoots({ home: 'C:\\Users\\李四', desktop: 'C:\\Users\\李四\\Desktop', docs: 'C:\\Users\\李四\\Documents', appDir: 'E:\\FDE' });
const restored = rt.restorePaths(parsed.data, roots2);
assert.strictEqual(restored.projects[0].autorun[0].path, 'C:\\Users\\李四\\Desktop\\ps.exe');
assert.strictEqual(restored.projects[0].items[0].path, 'C:\\Users\\李四\\Documents\\日报.ps1');
assert.strictEqual(restored.canvas.nodes[0].ref.path, 'E:\\FDE\\main.js');
console.log('✓ 快照往返 + 换用户还原');

// 4) token 估算 + 缓存
const cjk = rt.estTokens('这是一段中文提示词，大约二十个字。');
assert.ok(cjk >= 12 && cjk <= 30, '中文 token 估算: ' + cjk);
const cacheFile = path.join(tmp, 'cache.json');
const c = new rt.AiCache(cacheFile);
const k = 'p:abc';
assert.strictEqual(c.get(k), null);
c.set(k, { tokens: 500 });
assert.ok(c.get(k));
assert.strictEqual(c.stats().hits, 1);
console.log('✓ token 估算 / 缓存');

// 5) 环境体检
(async () => {
  const r = await rt.envCheck(restored, { dataRoot: path.join(tmp, 'data'), appDir: process.cwd() });
  assert.ok(Array.isArray(r.items) && r.items.length > 3);
  assert.ok(r.summary.error >= 1, '缺程序应报 error');
  assert.ok(r.items.some(i => i.title.includes('华东客户')), '应指出哪个项目的程序缺失');
  console.log('✓ 环境体检:', JSON.stringify(r.summary));

  // 6) 便携数据根解析
  const d1 = rt.resolveDataRoot({ argv: ['--data-dir=D:\\x\\y'], env: {}, appDir: tmp, defaultDir: 'C:\\def' });
  assert.strictEqual(d1.mode, 'custom');
  fs.writeFileSync(path.join(tmp, 'portable.json'), '{"dataDir":"fde-data"}');
  const d2 = rt.resolveDataRoot({ argv: [], env: {}, appDir: tmp, defaultDir: 'C:\\def' });
  assert.strictEqual(d2.mode, 'portable');
  assert.strictEqual(d2.dir, path.join(tmp, 'fde-data'));
  const d3 = rt.resolveDataRoot({ argv: [], env: {}, appDir: tmp + '\\none', defaultDir: 'C:\\def' });
  assert.strictEqual(d3.mode, 'appdata');
  console.log('✓ 数据根解析');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n全部通过');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
