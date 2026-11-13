/**
 * 项目设置面板「跟桌面走」的规则单测。
 * 跑法：node test-panels.js
 */
const { planPanelSync } = require('./panels');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + '\n   得到 ' + a + '\n   期望 ' + b); }
}

// 没开面板：什么都不做
eq('没开面板时不动作', planPanelSync([], 'p2'), { close: [], open: null });

// 开着 A，切到 B：关 A，补开 B
eq('A → B：关 A 补开 B', planPanelSync(['p1'], 'p2'), { close: ['p1'], open: 'p2' });

// 开着 B（目标本身），切到 B：不动
eq('已在 B 桌面：不动', planPanelSync(['p2'], 'p2'), { close: [], open: null });

// 同时开着 A 和 B，切到 B：只关 A，B 保持原位置
eq('A+B → B：只关 A', planPanelSync(['p1', 'p2'], 'p2'), { close: ['p1'], open: null });

// 开着 A，回原电脑桌面：全关，不补开
eq('A → 原电脑桌面：全关', planPanelSync(['p1'], null), { close: ['p1'], open: null });

// 开着 A、B，回原电脑桌面：两个都关
eq('A+B → 原电脑桌面：全关', planPanelSync(['p1', 'p2'], null), { close: ['p1', 'p2'], open: null });

// 开着 A、C，切到 B：两个都关，补开 B
eq('A+C → B：全关并补开 B', planPanelSync(['p1', 'p3'], 'p2'), { close: ['p1', 'p3'], open: 'p2' });

// 开着 A、C，切到 C：关 A，C 不动
eq('A+C → C：只关 A', planPanelSync(['p1', 'p3'], 'p3'), { close: ['p1'], open: null });

// 脏数据（null/空串）不应被当成项目
eq('忽略空 id', planPanelSync([null, '', 'p1'], 'p2'), { close: ['p1'], open: 'p2' });

console.log('\n' + (fail ? '✗' : '✓') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
