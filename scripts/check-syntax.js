/**
 * 页面内联脚本语法检查（比在浏览器里发现 SyntaxError 快得多）
 * 用法：node scripts/check-syntax.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const files = fs.readdirSync(ROOT).filter((f) => /\.html$/i.test(f));

let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let i = 0;
  while ((m = re.exec(html))) {
    i++;
    const code = m[1];
    if (!code.trim()) continue;
    const before = html.slice(0, m.index).split('\n').length;
    try {
      new vm.Script(code, { filename: f });
    } catch (e) {
      bad++;
      const localLine = (e.stack || '').match(/:(\d+)/);
      const line = localLine ? before + Number(localLine[1]) - 1 : before;
      console.log('✗ ' + f + ' 第 ' + line + ' 行（第 ' + i + ' 段脚本）: ' + e.message);
    }
  }
  const js = html.match(/<script[^>]*\bsrc="([^"]+)"/g) || [];
  if (i) console.log('· ' + f + '：' + i + ' 段内联脚本' + (js.length ? ' + ' + js.length + ' 个外链' : ''));
}
console.log(bad ? '\nFAIL ' + bad + ' 处语法错误' : '\nALL PASS 内联脚本语法无误');
process.exit(bad ? 1 : 0);
