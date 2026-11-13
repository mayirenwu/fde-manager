/** router.js 单测：自动挑模型 + 备胎链 */
const r = require('./router');
const list = [
  'gem-3.8-flash', 'gem-3.1-pro', 'gem-3.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp', 'qwen3.8-max', 'glm-5.3-flash', 'kimi-k3',
  'kling-v3-video', 'suno-v6', 'tt-image-2.5'
];

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('FAIL ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); } };

// 1) isAuto
ok('auto 判定', r.isAuto('auto') && r.isAuto('AUTO') && r.isAuto('') && r.isAuto(null) && !r.isAuto('gem-3.8-flash'));

// 2) 排除媒体模型
const chats = r.chatOnly(list);
ok('只留聊天模型', !chats.some(x => /kling|suno|tt-image/.test(x)) && chats.length === 9, chats);
ok('去重+字符串/对象混用', r.chatOnly([{ name: 'a-x' }, 'a-x', null]).join() === 'a-x');

// 3) 普通对话 → 中间档，不应挑最贵
const p1 = r.plan({ preferred: 'auto', task: { purpose: 'chat' }, chatModels: list });
ok('普通对话给了模型', !!p1.picked);
ok('普通对话不选最贵', r.analyze(p1.picked).tier <= 2, p1);

// 4) 搭台出方案 → 高档
const p2 = r.plan({ preferred: 'auto', task: { purpose: 'build' }, chatModels: list });
ok('搭台选强模型', r.analyze(p2.picked).tier === 3, p2);

// 5) 写脚本 → 高档
const p3 = r.plan({ preferred: 'auto', task: { purpose: 'script' }, chatModels: list });
ok('写脚本选强模型', r.analyze(p3.picked).tier === 3, p3);

// 6) 带图 → 必须视觉模型
const p4 = r.plan({ preferred: 'auto', task: { hasImages: true, purpose: 'chat' }, chatModels: list });
ok('带图选视觉模型', p4.picked === 'deepseek-v4-flash-vision-exp', p4);
ok('带图原因说清楚', /图/.test(p4.reason), p4.reason);

// 7) 长文 → 高档
const p5 = r.plan({ preferred: 'auto', task: { chars: 20000 }, chatModels: list });
ok('长文选高档', r.analyze(p5.picked).tier === 3, p5);

// 8) 快问快答 → 轻档
const p6 = r.plan({ preferred: 'auto', task: { purpose: 'quick' }, chatModels: list });
ok('快问快答选轻档', r.analyze(p6.picked).tier <= 2 && p6.picked, p6);

// 9) 固定模型：尊重用户选择
const p7 = r.plan({ preferred: 'kimi-k3', task: { purpose: 'chat' }, chatModels: list });
ok('固定模型就用它', p7.picked === 'kimi-k3' && p7.auto === false, p7);

// 10) 备胎链：不含重复，长度 ≤ 4，第一位是 picked
const p8 = r.plan({ preferred: 'auto', task: { purpose: 'chat' }, chatModels: list });
ok('备胎链结构', p8.chain[0] === p8.picked && new Set(p8.chain).size === p8.chain.length && p8.chain.length <= 4 && p8.chain.length >= 2, p8.chain);

// 11) 目录为空
const p9 = r.plan({ preferred: 'auto', task: {}, chatModels: [] });
ok('空目录不炸', p9.picked === '' && p9.chain.length === 0, p9);

// 12) 手打错模型名 → 先试它，再兜底
const p10 = r.plan({ preferred: 'gpt-nonexist', task: {}, chatModels: list });
ok('错模型名先试再兜底', p10.picked === 'gpt-nonexist' && p10.chain.length > 1, p10);

// 13) 失败换不换
ok('密钥错不换模型', r.worthRetry('auth', 0, 3) === false);
ok('超时可以换', r.worthRetry('timeout', 0, 3) === true);
ok('空内容可以换', r.worthRetry('empty', 0, 3) === true);
ok('换够次数就停', r.worthRetry('empty', 3, 3) === false);

// 14) 打分单调性：同族 pro 应高于 flash
ok('pro 高于 flash', r.score('gem-3.1-pro', { purpose: 'build' }) > r.score('gem-3.8-flash', { purpose: 'build' }));

/* ---- runWithFallback：失败自动换下一个 ---- */
(async () => {
  // A) 第一个模型返回空内容 → 换第二个成功
  const seenA = [];
  const ra = await r.runWithFallback({
    chain: ['a-model', 'b-model', 'c-model'],
    canSwitch: true,
    chat: async (m) => { seenA.push(m); return m === 'a-model' ? { ok: false, kind: 'empty', error: '空内容' } : { ok: true, text: 'hi', model: m }; }
  });
  ok('空内容换到下一个', ra.ok && ra.result.model === 'b-model' && seenA.join() === 'a-model,b-model', { seenA, ra });

  // B) 密钥错 → 不换
  const seenB = [];
  const rb = await r.runWithFallback({
    chain: ['a', 'b'], canSwitch: true,
    chat: async (m) => { seenB.push(m); return { ok: false, kind: 'auth', error: '密钥不对' }; }
  });
  ok('密钥错不浪费尝试', !rb.ok && seenB.length === 1, seenB);

  // C) 关闭自动换 → 只试第一个
  const seenC = [];
  const rc = await r.runWithFallback({
    chain: ['a', 'b'], canSwitch: false,
    chat: async (m) => { seenC.push(m); return { ok: false, kind: 'empty' }; }
  });
  ok('关掉开关只试一个', !rc.ok && seenC.length === 1, seenC);

  // D) 全挂 → 返回试过的列表
  const rd = await r.runWithFallback({
    chain: ['a', 'b', 'c', 'd', 'e'], canSwitch: true, maxTries: 4,
    chat: async () => ({ ok: false, kind: 'timeout', error: '超时' })
  });
  ok('最多试 4 个', !rd.ok && rd.tried.length === 4, rd.tried);

  // E) chat 抛异常也不炸
  const re = await r.runWithFallback({ chain: ['a'], canSwitch: true, chat: async () => { throw new Error('boom'); } });
  ok('异常兜住', !re.ok && /boom/.test(re.last.error), re.last);

  // F) 切换回调被调用
  const sw = [];
  await r.runWithFallback({
    chain: ['a', 'b'], canSwitch: true,
    chat: async (m) => m === 'a' ? { ok: false, kind: 'http' } : { ok: true },
    onSwitch: (p, n) => sw.push(p + '>' + n)
  });
  ok('切换有通知', sw.join() === 'a>b', sw);

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
