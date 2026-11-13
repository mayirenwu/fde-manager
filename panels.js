/**
 * 项目设置面板的「跟随桌面」规则（纯函数，便于单测）。
 *
 * 背景：每个项目桌面各有一份设置面板（右侧那个小窗）。切换桌面时，
 * 屏幕上不该再留着上一个项目的设置，所以：
 *  - 切到项目 X：X 以外的面板都要关掉
 *  - 如果关掉的面板里包含"刚离开的那个项目"，且 X 的面板本来没开，
 *    就在原位置补开 X 的面板（看起来像跟着一起换过去）
 *  - 回到原电脑桌面（activeId 为 null）：全部关掉，不补开
 */
function planPanelSync(openIds, activeId) {
  const ids = (openIds || []).filter(x => !!x);
  if (!ids.length) return { close: [], open: null };
  const close = activeId ? ids.filter(id => id !== activeId) : ids.slice();
  const alreadyHasTarget = !!activeId && ids.indexOf(activeId) >= 0;
  const open = (activeId && !alreadyHasTarget && close.length) ? activeId : null;
  return { close, open };
}

module.exports = { planPanelSync };
