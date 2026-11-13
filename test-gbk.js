/**
 * GBK 关键词编码：1688 搜索页是 GBK，UTF-8 会乱码成"椹《璧疯韩鎵舵墜"。
 * 这里验证「拼出来的 URL 能原样还原成中文」。
 * 跑法：node test-gbk.js
 */
const g = require('./gbk');

let pass = 0, fail = 0;
const t = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' — ' + extra : '')); } };

const dec = (pctEnc) => {
  const buf = Buffer.from(pctEnc.split('%').filter(Boolean).map(h => parseInt(h, 16)));
  return new TextDecoder('gbk').decode(buf);
};

for (const kw of ['马桶起身扶手', '浴室折叠洗澡椅', '门槛斜坡垫 可裁剪', 'A4 夜灯']) {
  const url = g.search1688Url(kw);
  const enc = url.split('keywords=')[1] || '';
  t(/^https:\/\/s\.1688\.com\/selloffer\/offer_search\.htm\?keywords=/.test(url), '1688 地址格式正确：' + kw);
  t(dec(enc) === kw, 'GBK 编码可还原：' + kw, dec(enc));
  t(/%[0-9A-F]{2}/.test(enc) && !/[\u4e00-\u9fa5]/.test(enc), '编码结果里不含明文中文：' + kw);
}

t(g.search1688Url('') === 'https://www.1688.com/', '空关键词回到 1688 首页');
t(g.search1688Url('  马桶  ') === g.search1688Url('马桶'), '前后空格被裁掉');
t(g.search1688Url('马桶') === g.search1688Url('马桶'), '同一关键词有缓存、结果稳定');

const tb = g.searchTaobaoUrl('马桶扶手');
t(/^https:\/\/s\.taobao\.com\/search\?q=/.test(tb), '淘宝地址格式正确（UTF-8）');
t(decodeURIComponent(tb.split('q=')[1]) === '马桶扶手', '淘宝关键词可还原');

console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
