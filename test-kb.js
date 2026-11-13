/**
 * 知识库引擎测试（纯 Node，不启动 Electron）
 * 覆盖：分词 / 切块 / 摘要 / 指纹 / 检索排序 / 提示词 / 目录扫描 / docx·xlsx 抽取 / GBK
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const kb = require('./kb');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (extra ? ' | ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' | ' + extra : '')); }
}

/* 造一个最小 zip（stored / deflate 都支持），用来验证 docx/xlsx 抽取 */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = require('zlib').crc32 ? zlib.crc32(raw) : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const lhBuf = Buffer.concat([lh, nameBuf, comp]);
    locals.push(lhBuf);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    offset += lhBuf.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));

/* ---------- 分词 ---------- */
const toks = kb.tokenize('适老改造 方案 报价 XHS-2024');
t('中文按二元切', toks.includes('适老') && toks.includes('改造'), JSON.stringify(toks.slice(0, 8)));
t('英文数字按词切', toks.includes('xhs') && toks.includes('2024'));
t('停用词被过滤', kb.tokenize('的 了 是 我们 the and').length === 0, JSON.stringify(kb.tokenize('的 了 是')));

/* ---------- 切块 ---------- */
const long = Array.from({ length: 40 }, (_, i) => '第' + (i + 1) + '段：适老化改造要注意防滑、扶手高度、夜间照明这些问题，细节决定体验。').join('\n\n');
const chunks = kb.chunk(long, { size: 300, overlap: 60 });
t('长文切出多块', chunks.length >= 4, String(chunks.length));
t('每块不超过 size 的 2 倍', chunks.every((c) => c.text.length <= 620), String(Math.max(...chunks.map((c) => c.text.length))));
t('块序号连续', chunks.every((c, i) => c.i === i));
t('空文本切出 0 块', kb.chunk('   ').length === 0);

/* ---------- 摘要 ---------- */
const md = '# 居家适老改造报价模板\n\n本模板适用于 60 岁以上老人家庭，含浴室防滑、扶手安装、夜间照明三项。\n\n## 报价\n- 浴室防滑垫 45 元\n- 马桶扶手 129 元\n- 床边扶手 169 元\n\n适老化改造的核心是防滑和扶手，适老化改造报价要拆开写。';
const s = kb.summarize('报价模板.md', md);
t('标题取 Markdown 一级标题', s.title === '居家适老改造报价模板', s.title);
t('摘要非空且截断', s.summary.length > 10 && s.summary.length <= 141, String(s.summary.length));
t('提炼出标签', s.tags.length >= 2, JSON.stringify(s.tags));

/* ---------- 指纹去重 ---------- */
t('同内容不同空白指纹相同', kb.fingerprint('a b\n c') === kb.fingerprint('a  b c'));
t('不同内容指纹不同', kb.fingerprint('方案A') !== kb.fingerprint('方案B'));

/* ---------- 检索 ---------- */
const docs = [
  { name: 'a.md', title: '浴室防滑改造方案', text: '浴室地砖湿滑，老人洗澡容易摔倒。方案：防滑垫 + 洗澡椅 + 马桶扶手。报价 300 元。' },
  { name: 'b.md', title: '客户访谈纪要', text: '客户张阿姨，72 岁，独居，最担心夜里起夜摸黑摔倒。预算 500 元以内。' },
  { name: 'c.txt', title: '发票开具说明', text: '发票抬头请提供公司名称与税号，普票三个工作日寄出。' }
];
const r1 = kb.search(docs, '防滑');
t('检索命中相关文档', r1.length >= 1 && /防滑/.test(r1[0].doc.title), r1[0] && r1[0].doc.title);
t('摘要片段含关键词', r1[0].snippet.text.indexOf('防滑') >= 0, r1[0].snippet.text.slice(0, 40));
t('不相关文档排后面或不出现在首位', !/发票/.test(r1[0].doc.title));
const r2 = kb.search(docs, '夜里起夜');
t('长查询能命中', r2.length >= 1 && /访谈/.test(r2[0].doc.title), r2[0] && r2[0].doc.title);
t('空查询返回空', kb.search(docs, '   ').length === 0);
const r3 = kb.search(docs, '防滑 报价');
t('多词查询综合打分', r3.length >= 1 && r3[0].doc.name === 'a.md');
t('检索结果带命中词', r3[0].hits.length >= 1, JSON.stringify(r3[0].hits));

/* ---------- 提示词与引用 ---------- */
const prompt = kb.askPrompt('洗澡防滑怎么做？', r1);
t('提示词带资料与问题', /【资料 1】/.test(prompt) && /【问题】洗澡防滑怎么做/.test(prompt));
t('提示词要求标注来源', /\[资料 n\]/.test(prompt));
t('解析引用编号', JSON.stringify(kb.citations('结论 A [资料 2]，另有依据【资料1】')) === '[1,2]', JSON.stringify(kb.citations('结论 A [资料 2]，另有依据【资料1】')));

/* ---------- 文本抽取 ---------- */
fs.writeFileSync(path.join(tmp, 'a.md'), md, 'utf8');
fs.writeFileSync(path.join(tmp, 'b.csv'), '品名,售价,拿货价\n洗澡椅,139,33\n', 'utf8');
fs.writeFileSync(path.join(tmp, 'c.html'), '<h1>标题</h1><script>var x=1</script><p>正文内容&nbsp;测试</p>', 'utf8');
const e1 = kb.extractText(path.join(tmp, 'a.md'));
t('md 直接读', e1.ok && /适老改造/.test(e1.text));
const e2 = kb.extractText(path.join(tmp, 'b.csv'));
t('csv 直接读', e2.ok && /洗澡椅/.test(e2.text));
const e3 = kb.extractText(path.join(tmp, 'c.html'));
t('html 去标签去脚本', e3.ok && /正文内容\s*测试/.test(e3.text) && !/var x/.test(e3.text), e3.text);

/* GBK 编码文件 */
const gbkBuf = Buffer.from([0xC2, 0xED, 0xCD, 0xB0]); // “马桶”的 GBK 字节
fs.writeFileSync(path.join(tmp, 'gbk.txt'), gbkBuf);
const e4 = kb.extractText(path.join(tmp, 'gbk.txt'));
t('GBK 文件能正确解码', e4.ok && e4.text.indexOf('马桶') >= 0, JSON.stringify(e4.text));

/* docx */
const docxXml = '<?xml version="1.0"?><w:document><w:body>'
  + '<w:p><w:r><w:t>适老改造方案</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>浴室防滑垫 45 元</w:t></w:r></w:p>'
  + '</w:body></w:document>';
fs.writeFileSync(path.join(tmp, 'd.docx'), makeZip([{ name: 'word/document.xml', data: docxXml }]));
const e5 = kb.extractText(path.join(tmp, 'd.docx'));
t('docx 抽出正文', e5.ok && /适老改造方案/.test(e5.text) && /45 元/.test(e5.text), e5.ok ? e5.text.replace(/\n/g, '|') : e5.error);

/* xlsx */
const shared = '<?xml version="1.0"?><sst><si><t>品名</t></si><si><t>拿货价</t></si><si><t>折叠洗澡椅</t></si></sst>';
fs.writeFileSync(path.join(tmp, 'e.xlsx'), makeZip([{ name: 'xl/sharedStrings.xml', data: shared }]));
const e6 = kb.extractText(path.join(tmp, 'e.xlsx'));
t('xlsx 抽出共享字符串', e6.ok && /折叠洗澡椅/.test(e6.text), e6.ok ? e6.text.replace(/\n/g, '|') : e6.error);

/* 不支持的类型给人话 */
const e7 = kb.extractText(path.join(tmp, 'x.pdf'), Buffer.from('%PDF-1.4'));
t('PDF 给出明确指引', !e7.ok && /另存为/.test(e7.error), e7.error);

/* ---------- 目录扫描 ---------- */
const sub = path.join(tmp, 'sub');
fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
fs.mkdirSync(sub, { recursive: true });
fs.writeFileSync(path.join(tmp, 'node_modules', 'skip.md'), '不应导入');
fs.writeFileSync(path.join(tmp, 'logo.png'), Buffer.from([0x89, 0x50]));
fs.writeFileSync(path.join(sub, 'nested.md'), '# 嵌套文档\n\n内容内容内容');
fs.writeFileSync(path.join(tmp, '.hidden.md'), '隐藏文件不应导入');
const scan = kb.scanDir(tmp);
const rels = scan.files.map((f) => f.rel);
t('扫描找到嵌套文件', rels.includes('sub/nested.md'), JSON.stringify(rels));
t('跳过 node_modules', !rels.some((x) => /node_modules/.test(x)));
t('跳过图片等不支持类型', !rels.some((x) => /\.png$/.test(x)));
t('跳过隐藏文件', !rels.some((x) => /\.hidden/.test(x)));
t('扫描给出跳过统计', scan.skipped.dir >= 1 && scan.skipped.ext >= 1, JSON.stringify(scan.skipped));

/* ---------- 库模板 ---------- */
t('内置 7 类库模板', kb.KINDS.length === 7, String(kb.KINDS.length));
t('每类库都有骨架字段与说明', kb.KINDS.every((k) => k.fields.length && k.hint));

console.log('\n' + (fails.length ? 'FAIL  ' + fails.length + ' 项失败 / ' : 'PASS  ') + pass + ' 通过');
if (fails.length) { fails.forEach((f) => console.log('   - ' + f)); process.exit(1); }
