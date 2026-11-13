/**
 * 跨平台静态审计：防止"Windows 专属调用"悄悄回流到不该出现的地方。
 * 跑法：node scripts/check-platform.js（node 就能跑，不需要 electron）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let bad = 0;
const ok = (cond, text) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + text);
  if (!cond) bad++;
};

/** 在文件里数某个标记出现次数 */
const count = (file, re) => {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return (s.match(re) || []).length;
};

/* ---- 1. 新增的平台层必须在 ---- */
ok(fs.existsSync(path.join(ROOT, 'platform.js')), 'platform.js 存在（能力矩阵的唯一出处）');
ok(fs.existsSync(path.join(ROOT, 'wmp.js')), 'wmp.js 存在（窗口命令的跨平台实现）');

/* ---- 2. main.js 里 Windows 专属调用必须都有 IS_WIN 守卫 ----
 * 规则：每个 `powershell.exe` / `taskkill` / `explorer.exe` 出现位置，
 *       往上追溯到最近的函数声明行（function xxx），这段里必须出现 IS_WIN / platform 判断；
 *       没有就算违规。守卫一般都写在函数开头（提前 return 的模式）。
 */
function guarded(file, re, guardRe) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/);
  const badLines = [];
  s.forEach((line, i) => {
    if (!re.test(line)) return;
    // 往上找最近的函数声明（含 async function / const xxx = ... => 的简写不做，
    // 业务代码里平台调用都在具名函数里）
    let start = i;
    for (let k = i; k >= 0 && i - k < 400; k--) {
      if (/^(async\s+)?function\s+\w+|^const\s+\w+\s*=\s*(async\s*)?\(/.test(s[k])) { start = k; break; }
    }
    const ctx = s.slice(start, i + 1).join('\n');
    if (!guardRe.test(ctx)) badLines.push((i + 1) + ': ' + line.trim().slice(0, 80));
  });
  return badLines;
}
const WIN_CALL = /powershell\.exe|taskkill|explorer\.exe|C:\\\\Windows|notepad\.exe/;
const GUARD = /IS_WIN|isWin\(|PLAT\.|platform\./;
for (const f of ['main.js']) {
  const badLines = guarded(f, WIN_CALL, GUARD);
  ok(badLines.length === 0,
    f + ' 里所有 Windows 专属调用都在 IS_WIN 守卫内' + (badLines.length ? '：\n      ' + badLines.join('\n      ') : ''));
}

/* ---- 3. 曾经"顺手写在业务里"的平台调用必须清干净 ---- */
ok(count('apps.js', /powershell\.exe/) === 0, 'apps.js 不再直接调 PowerShell（zip 解析已换纯 JS）');
ok(/Expand-Archive -LiteralPath/.test(fs.readFileSync(path.join(ROOT, 'apps.js'), 'utf8')) === false,
  'apps.js 不再调用 Expand-Archive（仅注释提及不算违规）');
ok(!/execFileSync\('powershell/.test(fs.readFileSync(path.join(ROOT, 'apps.js'), 'utf8')), 'apps.js 没有 execFileSync(powershell)');
ok(count('gbk.js', /process\.platform/) > 0, 'gbk.js 按平台选编码路径（iconv / iconv-cli / 代码页）');

/* ---- 4. 打包要素齐全 ---- */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(pkg.build && pkg.build.win && pkg.build.mac && pkg.build.linux, 'package.json 里有 win / mac / linux 三份打包配置');
ok(!!(pkg.build.mac.target || []).find(x => (x.arch || []).includes('arm64')), 'mac 目标含 arm64（Apple M 系列）');
ok(!!(pkg.build.mac.target || []).find(x => (x.arch || []).includes('x64')), 'mac 目标含 x64（Intel）');
ok((pkg.build.linux.target || []).length >= 1, 'linux 目标存在（AppImage / deb）');
ok(pkg.dependencies && pkg.dependencies['iconv-lite'], 'iconv-lite 是正式依赖（跨平台 GBK）');
for (const f of ['build/icon.ico', 'build/icon.icns', 'build/icon.png', 'build/icons/256x256.png',
  'assets/tray.png', 'assets/tray.ico', 'assets/trayTemplate.png']) {
  ok(fs.existsSync(path.join(ROOT, f)), '图标就位: ' + f);
}
for (const f of ['启动 FDE.vbs', '启动 FDE.command', 'fde.sh']) {
  ok(fs.existsSync(path.join(ROOT, f)), '启动器就位: ' + f);
}

/* ---- 5. 面板/文档提示（防止文档还写着"仅 Windows"） ---- */
ok(fs.existsSync(path.join(ROOT, 'docs', '跨平台说明.md')) || fs.existsSync(path.join(ROOT, '跨平台说明.md')),
  '有跨平台使用说明文档');

console.log('\n' + (bad ? 'FAIL ' + bad + ' 项' : 'ALL PASS 跨平台审计通过'));
process.exit(bad ? 1 : 0);
