/**
 * ai.js 单元测试：地址整理、模型/对话解析、本地假接口跑通、自动探测、报错分型。
 * 跑法：node test-ai.js
 */
const http = require('http');
const ai = require('./ai');

let pass = 0, fail = 0;
function t(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// ---- 地址整理 ----
t('默认地址是平台的 /v1', ai.normalizeBase('') === ai.DEFAULT_BASE);
t('去掉结尾斜杠', ai.normalizeBase('https://ai.my10086.cn/v1/') === 'https://ai.my10086.cn/v1');
t('粘整条 chat 地址也能纠正', ai.normalizeBase('https://ai.my10086.cn/v1/chat/completions') === 'https://ai.my10086.cn/v1');
t('粘 models 地址也能纠正', ai.normalizeBase('https://ai.my10086.cn/v1/models') === 'https://ai.my10086.cn/v1');
t('没写协议自动补 https', ai.normalizeBase('ai.my10086.cn/v1') === 'https://ai.my10086.cn/v1');
const ep = ai.endpoints('https://ai.my10086.cn/v1');
t('拼出 models / chat 两个端点', ep.models === 'https://ai.my10086.cn/v1/models' && ep.chat === 'https://ai.my10086.cn/v1/chat/completions');

// ---- 密钥 ----
t('识别 sk- 密钥', ai.looksLikeKey('sk-abcdefgh12345678'));
t('识别长串密钥', ai.looksLikeKey('a'.repeat(32)));
t('普通文字不算密钥', !ai.looksLikeKey('我的密钥'));
t('打码保留头尾', ai.maskKey('sk-1234567890abcdef').indexOf('sk-12') === 0 && ai.maskKey('sk-1234567890abcdef').slice(-4) === 'cdef');

// ---- 解析 ----
const m1 = ai.parseModels({ data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-chat', owned_by: 'ds' }] });
t('OpenAI data[] 模型列表', m1.length === 2 && m1[1].id === 'deepseek-chat');
const m2 = ai.parseModels({ models: ['a', 'b'] });
t('字符串数组也能解析', m2.length === 2 && m2[0].id === 'a');
const m3 = ai.parseModels({ data: { list: [{ model: 'x' }] } });
t('data.list 也能解析', m3.length === 1 && m3[0].id === 'x');
t('空对象不炸', ai.parseModels({}).length === 0);

const c1 = ai.parseChat({ choices: [{ message: { content: '你好' } }], usage: { total_tokens: 12 } });
t('choices[0].message.content', c1.text === '你好' && c1.usage.total_tokens === 12);
const c2 = ai.parseChat({ choices: [{ text: '旧格式' }] });
t('choices[0].text 兼容', c2.text === '旧格式');
const c3 = ai.parseChat({ output_text: '新版格式' });
t('output_text 兼容', c3.text === '新版格式');
const c4 = ai.parseChat({ choices: [{ message: { content: [{ type: 'text', text: '分段' }] } }] });
t('分段 content 拼起来', c4.text === '分段');

t('状态：没密钥是 off', ai.status({}).level === 'off');
t('状态：有密钥没模型是 half', ai.status({ apiKey: 'sk-x' }).level === 'half');
t('状态：都齐是 on 且带模型名', ai.status({ apiKey: 'sk-x', model: 'm1' }).text.indexOf('m1') >= 0);

// ---- 本地假接口 ----
let server = null;
let base = '';
let authSeen = '';
let siteTokenSeen = '';
let siteBodySeen = null;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      authSeen = req.headers.authorization || '';
      if (req.url === '/v1/models') {
        if (!/^Bearer sk-/.test(authSeen)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: '无效的令牌' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'fde-test-1' }, { id: 'fde-test-2' }] }));
      }
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          let j = {};
          try { j = JSON.parse(body); } catch (e) {}
          if (j.model === 'bad') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: '模型不存在' } }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: j.model,
            choices: [{ message: { content: '收到：' + ((j.messages || [])[0] || {}).content } }],
            usage: { total_tokens: 9 }
          }));
        });
        return;
      }
      // ---- 站点原生协议（统一入口）----
      // 站外探测时同源路径是 SPA 页，真实接口在 /api 前缀下，正好测「自动回退」
      if (req.url.startsWith('/moxing/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><html><body>SPA</body></html>');
      }
      if (req.url === '/api/moxing/moxingliebiao' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          const raw = ai.decryptToken(req.headers.token || '');
          if (raw !== 'sk-site-key-1234567890') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ msg: 'token 无效' }));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: { list: [
            { 模型id: 'site-1', 模型名称: '站点模型一', 厂商: '厂A' },
            { 模型id: 'site-2', 模型名称: '站点模型二' }
          ] } }));
        });
        return;
      }
      if (req.url === '/api/moxing/tongyirukouchat' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          let j = {};
          try { j = JSON.parse(body); } catch (e) {}
          siteTokenSeen = ai.decryptToken(req.headers.token || '');
          siteBodySeen = j;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if ((j.用户消息 || '').includes('拦截测试')) {
            res.write('data: ' + JSON.stringify({ 是否拦截: true, 提示标题: '安全提示', 提示内容: '内容不合规' }) + '\n\n');
            return res.end('data: [DONE]\n\n');
          }
          res.write('data: ' + JSON.stringify({ 内容: '你好' }) + '\n\n');
          res.write('data: raw-not-json\n\n');
          res.write('data: ' + JSON.stringify({ content: '，世界' }) + '\n\n');
          res.write('data: ' + JSON.stringify({ 会话id: 's1', 任务id: 't1' }) + '\n\n');
          res.end('data: [DONE]\n\n');
        });
        return;
      }
      if (req.url === '/api/moxing/liaotian/xuliu' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          let j = {};
          try { j = JSON.parse(body); } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { content: '续传内容：' + (j.任务id || '') } }));
        });
        return;
      }
      // 其它路径故意返回网页，模拟"地址填错"
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body>SPA</body></html>');
    });
    server.listen(0, '127.0.0.1', () => {
      base = 'http://127.0.0.1:' + server.address().port + '/v1';
      resolve();
    });
  });
}

async function run() {
  await startServer();

  // 交付配置种入：默认只种接口和模型清单，不种密钥（密钥各人自己填）
  const sd = ai.seedDelivery({}, { baseUrl: 'https://api.chan.com', apiKey: 'sk-channel-key-123456', model: 'm1', models: ['m1', 'm2'], label: '测试渠道' });
  t('交付配置能种入空白配置（接口地址 + 模型）', sd.ok && sd.config.baseUrl === 'https://api.chan.com/v1' && sd.config.models.length === 2, JSON.stringify(sd));
  t('默认不种密钥、不标渠道预置', sd.config.apiKey === '' && sd.config.delivered === false && sd.config.deliveredLabel === '');
  t('交付配置的模型存成 {id,name} 对象（界面才显示得出来）', sd.ok && sd.config.models[0] && sd.config.models[0].id === 'm1' && sd.config.models[0].name === 'm1', JSON.stringify(sd.config.models));
  const sdKeep = ai.seedDelivery({ apiKey: 'sk-user-own-key-123456', updatedAt: 1 }, { shareKey: true, apiKey: 'sk-channel-key-123456' });
  t('用户已有密钥时不覆盖', !sdKeep.ok && /不覆盖/.test(sdKeep.reason), sdKeep.reason);
  const sdBad = ai.seedDelivery({}, { shareKey: true, apiKey: '太短' });
  t('shareKey 但交付文件密钥非法时拒绝', !sdBad.ok && /格式不对/.test(sdBad.reason), sdBad.reason);

  t('normalizeBase 裸域名自动补 /v1', ai.normalizeBase('https://api.example.com') === 'https://api.example.com/v1', ai.normalizeBase('https://api.example.com'));
  t('normalizeBase 带路径不乱补', ai.normalizeBase('https://api.example.com/openai/v1') === 'https://api.example.com/openai/v1', ai.normalizeBase('https://api.example.com/openai/v1'));

// 自定义/本地供应商校验
const pvs = ai.sanitizeProviders([
  { id: 'a', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', models: ['qwen3', 'llama'], local: true },
  { baseUrl: '不是地址' },
  null,
  { name: '远程', baseUrl: 'https://api.x.dev/v1/', apiKey: 'sk-x-1234567890', models: ['m1'] }
]);
t('供应商：合法的留下且地址收敛', pvs.length === 2 && pvs[0].baseUrl === 'http://127.0.0.1:11434/v1' && pvs[1].baseUrl === 'https://api.x.dev/v1', JSON.stringify(pvs).slice(0, 150));
t('供应商：最多 10 个', ai.sanitizeProviders(Array.from({ length: 15 }, (_, i) => ({ name: 'n' + i, baseUrl: 'https://a' + i + '.com/v1' }))).length === 10, '');
t('供应商：模型列表钳到 100', ai.sanitizeProviders([{ name: 'x', baseUrl: 'https://a.com/v1', models: Array.from({ length: 150 }, (_, i) => 'm' + i) }])[0].models.length === 100, '');
  t('normalizeBase 直接粘补全路径也能收敛', ai.normalizeBase('https://api.example.com/v1/chat/completions') === 'https://api.example.com/v1', ai.normalizeBase('https://api.example.com/v1/chat/completions'));

  const lm = await ai.listModels({ baseUrl: base, apiKey: 'sk-localtest1234' });
  t('本地接口能拉到模型', lm.ok && lm.models.length === 2, lm.error || '');
  t('请求带上了 Bearer 密钥', /^Bearer sk-/.test(authSeen), authSeen);

  const bad = await ai.listModels({ baseUrl: base, apiKey: 'wrong-key-no-prefix' });
  t('密钥不对时明确报错', !bad.ok && /令牌|401|无效/.test(bad.error), bad.error);

  const noKey = await ai.listModels({ baseUrl: base, apiKey: '' });
  t('没密钥不发请求', !noKey.ok && noKey.kind === 'nokey');

  const ch = await ai.chat({ baseUrl: base, apiKey: 'sk-localtest1234', model: 'fde-test-1' },
    { messages: [{ role: 'user', content: '在吗' }] });
  t('对话能拿到内容', ch.ok && ch.text === '收到：在吗', ch.error || '');

  const chBad = await ai.chat({ baseUrl: base, apiKey: 'sk-localtest1234', model: 'bad' },
    { messages: [{ role: 'user', content: 'x' }] });
  t('模型报错时把服务端原话带出来', !chBad.ok && /模型不存在/.test(chBad.error), chBad.error);

  const noModel = await ai.chat({ baseUrl: base, apiKey: 'sk-localtest1234' }, { messages: [] });
  t('没选模型时拦住', !noModel.ok && noModel.kind === 'nomodel');

  // 地址填到网页路径：应提示"返回的是网页"
  const html = await ai.listModels({ baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1/oops', apiKey: 'sk-localtest1234' });
  t('地址指向网页时给出可懂的提示', !html.ok && /网页/.test(html.error), html.error);

  // 自动探测：baseUrl 指向本地就能命中
  const det = await ai.detect({ baseUrl: base, apiKey: 'sk-localtest1234' });
  t('自动找接口能命中可用地址', det.ok && det.base === base && det.models.length === 2, det.error || '');

  const detBad = await ai.detect({ baseUrl: base, apiKey: '' });
  t('没密钥时探测直接拦住', !detBad.ok && detBad.kind === 'nokey');

  // 连接被拒（端口没人听）
  const dead = await ai.listModels({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-localtest1234' });
  t('连不上时报网络错误而不是崩', !dead.ok && !!dead.error, dead.error);

  // ---- 站点原生协议（统一入口 / SSE / 续流）----
  t('加密Token 能往返解出原密钥', ai.decryptToken(ai.encryptToken('sk-roundtrip-xyz')) === 'sk-roundtrip-xyz');
  t('加密Token 每次带随机干扰串', ai.encryptToken('abc') !== ai.encryptToken('abc'));
  t('SSE 字段中英文都能抠出正文', JSON.stringify([
    ai.sseDelta({ content: 'a' }), ai.sseDelta({ 内容: 'b' }), ai.sseDelta({ delta: { content: 'c' } })
  ]) === '["a","b","c"]');

  const siteOrigin = base.replace(/\/v1$/, '');
  const sm = await ai.siteModels({ baseUrl: siteOrigin, apiKey: 'sk-site-key-1234567890' });
  t('站点模型列表（/api 前缀自动回退）', sm.ok && sm.protocol === 'site' && sm.models.length === 2, sm.error || '');
  t('站点模型解析出中文名与厂商', sm.ok && sm.models[0].id === 'site-1' && sm.models[0].name.indexOf('厂A') === 0, sm.ok ? sm.models[0].name : '');

  const sc = await ai.chat(
    { baseUrl: siteOrigin, apiKey: 'sk-site-key-1234567890', protocol: 'site', model: 'site-1' },
    { messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] }
  );
  t('站点统一入口 SSE 拼出完整正文', sc.ok && sc.text === '你好raw-not-json，世界', sc.ok ? sc.text : (sc.error || ''));
  t('站点对话带回任务id与回话id', sc.ok && sc.taskId === 't1' && sc.sessionId === 's1', sc.ok ? sc.taskId : '');
  t('站点请求头里的密钥是加密后的原文', siteTokenSeen === 'sk-site-key-1234567890', siteTokenSeen);
  t('站点请求体用中文键（模型id/用户消息）', !!siteBodySeen && siteBodySeen['模型id'] === 'site-1' && siteBodySeen['用户消息'].indexOf('SYS') === 0, siteBodySeen && siteBodySeen['用户消息']);

  const blocked = await ai.chat(
    { baseUrl: siteOrigin, apiKey: 'sk-site-key-1234567890', protocol: 'site', model: 'site-1' },
    { messages: [{ role: 'user', content: '拦截测试' }] }
  );
  t('站点拦截事件报成人话而不是空内容', !blocked.ok && blocked.kind === 'blocked' && blocked.error.indexOf('安全提示') === 0, blocked.error || '');

  const rs = await ai.siteResume({ baseUrl: siteOrigin, apiKey: 'sk-site-key-1234567890' }, 'task-xyz');
  t('断流续传按任务id拿到内容', rs.ok && rs.text === '续传内容：task-xyz', rs.error || rs.text || '');

  // 自动探测：裸域名自动补 /v1 后优先命中 OpenAI 兼容接口（normalizeBase 新行为）
  const detSite = await ai.detect({ baseUrl: siteOrigin, apiKey: 'sk-site-key-1234567890' });
  t('探测裸域名自动补 /v1 命中 OpenAI 兼容接口', detSite.ok && detSite.base === base && detSite.models.length === 2, detSite.ok ? detSite.base + ' / ' + detSite.protocol : (detSite.error || ''));

  /* ---- 交付配置：默认不种密钥（分发给别的 FDE 时不能带我的 key） ---- */
  const dNoKey = { label: '渠道', baseUrl: 'https://api.lk888.ai/v1', apiKey: 'sk-abcdef1234567890', model: 'gem-3.8-flash', models: ['gem-3.8-flash'] };
  const sd1 = ai.seedDelivery({}, dNoKey);
  t('交付文件没写 shareKey 时，密钥不种进用户配置', sd1.ok && sd1.config.apiKey === '' && sd1.keySeeded === false, JSON.stringify(sd1.config || sd1));
  t('但仍预置接口地址和模型清单（只需自己填 key）', sd1.ok && /lk888/.test(sd1.config.baseUrl) && sd1.config.models.length === 1, JSON.stringify(sd1.config && sd1.config.models));
  t('没种密钥就不该标“渠道预置”', sd1.config.delivered === false && sd1.config.deliveredLabel === '');

  const dShare = Object.assign({ shareKey: true }, dNoKey);
  const sd2 = ai.seedDelivery({}, dShare);
  t('显式 shareKey:true 才种密钥（渠道统一买单的场景）', sd2.ok && sd2.keySeeded === true && sd2.config.apiKey === dNoKey.apiKey);
  t('种了密钥才标“渠道预置”', sd2.config.delivered === true && /渠道/.test(sd2.config.deliveredLabel));

  const sd3 = ai.seedDelivery({ apiKey: 'sk-my-own-key-123456', updatedAt: 1 }, dNoKey);
  t('用户已经配过，绝不覆盖', !sd3.ok && /不覆盖/.test(sd3.reason), sd3.reason);

  const sd4 = ai.seedDelivery({ apiKey: 'sk-my-own-key-123456', updatedAt: 1 }, dShare);
  t('就算交付文件带 shareKey，也不覆盖用户自己的 key', !sd4.ok, sd4.reason);

  t('分发前清洗：默认剥掉密钥', !('apiKey' in ai.sanitizeDelivery(dNoKey)));
  t('分发前清洗：shareKey:true 时保留', ai.sanitizeDelivery(dShare).apiKey === dNoKey.apiKey);
  t('分发前清洗不动其它字段', ai.sanitizeDelivery(dNoKey).model === 'gem-3.8-flash');

  // 仓库里这份交付文件本身也不能带 key
  const deliv = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fde-delivery.json'), 'utf8'));
  t('仓库里的 fde-delivery.json 不含 apiKey', !('apiKey' in deliv), Object.keys(deliv).join(','));
  t('仓库里的 fde-delivery.json 没打开 shareKey', deliv.shareKey !== true);

  server.close();
  console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
}
run();
