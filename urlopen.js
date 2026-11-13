/**
 * 打开网页 / 认领浏览器窗口（纯函数，便于单测）
 *
 * 为什么需要这一层：
 *   用「系统默认浏览器」打开网址时，Windows 常常是让**已经在运行的那个浏览器进程**
 *   再开一个窗口 / 一个标签页。那个进程早就属于"原电脑桌面"或别的项目了，
 *   于是我们按"同一进程跟随"规则把新窗口判给了别的桌面 → 立刻被隐藏。
 *   用户看到的就是"闪一下就不见了，任务栏也没有"，但浏览器其实开着。
 *
 * 做法：
 *   1) 打开前记一条"打开意图"（谁开的、什么网址、几秒内、用哪个 exe）；
 *   2) 优先用 `--new-window` 让浏览器**新开一个窗口**（新 hwnd 才认领得到）；
 *   3) 新窗口出现时先看意图，比"同进程/同软件"规则优先，直接归到发起打开的桌面；
 *   4) 万一浏览器只在已有窗口里加了个标签页（没有新窗口），
 *      由 pickRescueWindow 在几秒后把那个窗口搬到发起打开的桌面。
 */

/** 可执行文件名（小写，不含目录） */
function baseName(exe) {
  const s = String(exe || '').trim().replace(/^"|"$/g, '');
  if (!s) return '';
  const parts = s.split(/[\\/]/);
  return (parts[parts.length - 1] || '').toLowerCase();
}

// 常见浏览器可执行文件名（含国产壳浏览器）
const BROWSER_KEYS = [
  'msedge', 'chrome', 'firefox', 'brave', 'vivaldi', 'opera', 'opera_gx', 'yandex',
  '360se', '360chrome', '360se6', 'qqbrowser', 'sogouexplorer', 'maxthon',
  'liebao', '2345explorer', 'ucbrowser', 'quark', 'doubao', 'chromium', 'thorium',
  'arc', 'safari', 'waterfox', 'palemoon', 'theworld', 'avant', 'slimjet', 'centbrowser'
];

/** 这个 exe 是不是浏览器 */
function isBrowserExe(exe) {
  const b = baseName(exe).replace(/\.exe$/, '');
  if (!b) return false;
  if (BROWSER_KEYS.includes(b)) return true;
  // 兜底：名字里带明显特征的（例如 "Chrome-portable"、"360se(1)"）
  return /(chrome|msedge|firefox|browser|explorer\.?360|360se|qqbrowser)/.test(b);
}

/** Chromium 内核（新开窗口用 --new-window） */
function isChromium(exe) {
  const b = baseName(exe);
  return /(chrome|msedge|brave|vivaldi|opera|yandex|360|qqbrowser|sogou|maxthon|liebao|2345|uc|quark|doubao|chromium|thorium|centbrowser|slimjet|avant)/.test(b);
}

/** 从网址取出主机名（小写、去端口、保留 www 以便精确匹配） */
function hostOf(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  let rest = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  rest = rest.replace(/^[^@]*@/, '');
  const host = rest.split(/[/?#]/)[0].split(':')[0].toLowerCase();
  if (!host || /^\d+$/.test(host)) return host;
  return host;
}

/** 主机名的几档匹配串：www.amazon.com → ['www.amazon.com','amazon.com','amazon'] */
function hostLabels(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return [];
  const out = [h];
  const noWww = h.replace(/^www\d*\./, '');
  if (noWww && noWww !== h) out.push(noWww);
  const first = noWww.split('.')[0];
  // 太短的首段（如 "x"、单字母）容易误匹配，不用
  if (first && first.length >= 3) out.push(first);
  return out;
}

/** 网页标题里是否像这个站点（浏览器标题通常是"页面标题 - 站点名"） */
function titleLooksLike(title, host) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  return hostLabels(host).some(l => l && t.includes(l));
}

/**
 * 打开网页的启动参数。尽量不要用 shell.openExternal：
 * 它会让已在运行的浏览器"就地开标签页"，拿不到新窗口句柄。
 */
function launchPlan(exe, url) {
  const b = baseName(exe);
  if (!b) return null;
  if (isChromium(exe)) return { exe, args: ['--new-window', url] };
  if (/firefox|waterfox|palemoon|librewolf/.test(b)) return { exe, args: ['-new-window', url] };
  return { exe, args: [url] };
}

/**
 * 从一条"打开命令"里取出可执行文件路径。
 * 兼容三种真实写法：
 *   "C:\Program Files (x86)\...\msedge.exe" --single-argument %1
 *   "C:\Users\x\AppData\Roaming\360se6\Application\360se.exe" -- "%1"
 *   C:\Chrome\chrome.exe -- "%1"
 */
function parseExe(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const q = s.match(/^"([^"]+\.exe)"/i);
  if (q) return q[1];
  const q2 = s.match(/"([^"]+\.exe)"/i);
  if (q2) return q2[1];
  const e = s.match(/^(.+?\.exe)(?=\s|$)/i);
  if (e) return e[1].trim();
  return '';
}

/**
 * 解析 `reg query ... /ve` 的输出，取出可执行文件路径。
 * 真实输出长得像：
 *   HKEY_CLASSES_ROOT\MSEdgeHTM\shell\open\command
 *       (Default)    REG_SZ    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1
 * 注意路径里可能有空格，必须按引号取，不能按空格切。
 */
function parseRegExe(out) {
  const lines = String(out || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (!m) continue;
    const v = parseExe(m[1]);
    if (v) return v;
  }
  // 没有 REG_SZ 列（例如 PowerShell 直接输出了命令本体）：整段里找 .exe
  return parseExe(out);
}

/**
 * 新窗口是不是"我刚打开的那个网页"。
 * @param {Array} intents 打开意图列表 { owner, url, host, exe, at, used }
 * @param {object} w      新窗口 { exe, title }
 * @param {number} now
 * @param {object} opt    { ttl=20000, freshMs=9000 }
 * @returns {object|null} 命中的意图（调用方负责标记 used）
 *
 * 规则：
 *  - 过期（> ttl）或已用过的不要；
 *  - 意图里记了 exe（指定了浏览器）→ 必须同一个 exe；没记 → 必须是浏览器；
 *  - 标题像这个站点 → 认；
 *  - 标题暂时为空 / 还在加载 → 只在打开后 freshMs 内认（避免误领别的浏览器窗口）。
 */
function matchIntent(intents, w, now, opt) {
  const ttl = (opt && opt.ttl) || 20000;
  const freshMs = (opt && opt.freshMs) || 9000;
  const exe = baseName(w && w.exe);
  for (const it of (intents || [])) {
    if (!it || it.used) continue;
    if (now - it.at > ttl) continue;
    const wantExe = baseName(it.exe);
    if (wantExe) {
      if (wantExe !== exe) continue;
    } else if (!isBrowserExe(w && w.exe)) {
      continue;
    }
    if (titleLooksLike(w && w.title, it.host)) return it;
    // 纯数字标题 = 浏览器自己的助手/广告小窗（360、QQ 浏览器常见），不是我们要的页面。
    // 让它吃掉意图的话，真正的页面窗口就没人认领，会被当成"别的桌面的窗口"藏起来。
    if (/^[\d\s\-_.]+$/.test(String((w && w.title) || '').trim())) continue;
    if (now - it.at <= freshMs) return it;
  }
  return null;
}

/**
 * 兜底：浏览器没开新窗口，只在已有窗口里加了标签页。
 * 从当前窗口列表里挑出"最可能是刚打开的那个网页"的窗口。
 * 优先：前台窗口 > 刚刚还是前台的窗口（可能已被我们藏起来）> 标题像这个站点。
 * @param {Array} list  [{ hwnd, pid, exe, title, vis, iconic, fg }]
 * @param {object} intent
 * @param {object} opt  { recentFgHwnd }
 * @returns {object|null}
 */
function pickRescueWindow(list, intent, opt) {
  const pool = (list || []).filter(w => w && isBrowserExe(w.exe) && !w.iconic);
  if (!pool.length) return null;
  const byFg = pool.find(w => w.fg && w.vis);
  if (byFg) return byFg;
  // 打开网页后浏览器把哪个窗口翻到前台了：倒着找最近的那个
  const hits = (opt && opt.fgHits) || [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const w = pool.find(x => x.hwnd === hits[i]);
    if (w) return w;
  }
  const fgHwnd = opt && opt.recentFgHwnd;
  if (fgHwnd) {
    const byRecent = pool.find(w => w.hwnd === fgHwnd);
    if (byRecent) return byRecent;
  }
  const byTitle = pool.find(w => titleLooksLike(w.title, intent && intent.host));
  if (byTitle) return byTitle;
  return null;
}

/** 读注册表拿"默认浏览器"：ProgId + 打开命令。用 PowerShell，避免 reg.exe 被安全软件拦。 */
function queryDefaultBrowser(execFileImpl) {
  const execFile = execFileImpl || require('child_process').execFile;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$p=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -Name ProgId).ProgId",
    "if($p){ Write-Output ('PROGID=' + $p) }",
    "$c=(Get-ItemProperty (\"Registry::HKEY_CLASSES_ROOT\\$p\\shell\\open\\command\")).'(default)'",
    "if($c){ Write-Output ('CMD=' + $c) }"
  ].join('\n');
  return new Promise((resolve) => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 10000 }, (err, stdout) => {
          const out = err ? '' : String(stdout || '');
          const pm = out.match(/PROGID=(\S+)/);
          const cm = out.match(/CMD=([^\r\n]+)/);
          resolve({ progId: pm ? pm[1].trim() : '', cmdLine: cm ? cm[1].trim() : '' });
        });
    } catch (e) { resolve({ progId: '', cmdLine: '' }); }
  });
}

let browserCache = { at: 0, exe: '' };
function resetBrowserCache() { browserCache = { at: 0, exe: '' }; }

/**
 * 默认浏览器 exe（查不到返回空 → 调用方退化为交给系统打开）。
 * @param {object} opt
 *   query()   返回 { progId, cmdLine }，默认读注册表
 *   browsers() 返回已安装浏览器列表（用于 ProgId 兜底匹配）
 *   exists(p)  判断文件是否存在，默认 fs.existsSync
 *   ttl        缓存毫秒，默认 5 分钟
 */
async function resolveDefaultBrowser(opt) {
  const o = opt || {};
  const ttl = o.ttl || 5 * 60 * 1000;
  const now = Date.now();
  if (browserCache.exe && now - browserCache.at < ttl) return browserCache.exe;
  const exists = o.exists || ((p) => { try { return require('fs').existsSync(p); } catch (e) { return false; } });
  const info = await (o.query ? o.query() : queryDefaultBrowser());
  const candidate = info && info.cmdLine ? parseExe(info.cmdLine) : '';
  let exe = '';
  if (candidate && exists(candidate)) exe = candidate;
  // 默认浏览器的路径可能属于"另一个系统用户"（这份配置跟着账户走），
  // 不可用就按 ProgId 挑一个同类浏览器顶上
  if (!exe && info && info.progId && o.browsers) {
    try {
      const list = await o.browsers();
      const want = String(info.progId).toLowerCase();
      const hit = (list || []).find(b => {
        const k = baseName(b.path).replace(/\.exe$/, '');
        return k && want.includes(k);
      });
      if (hit && exists(hit.path)) exe = hit.path;
    } catch (e) {}
  }
  // 都不行也别扔掉注册表给的路径：存在性判断可能因为权限读不到（EPERM），
  // 真正的失败留给 openUrlOn 起进程时报错，再退化为交给系统打开。
  if (!exe) exe = candidate;
  browserCache = { at: Date.now(), exe };
  return exe;
}

module.exports = {
  baseName, isBrowserExe, isChromium, hostOf, hostLabels, titleLooksLike,
  launchPlan, parseExe, parseRegExe, matchIntent, pickRescueWindow,
  queryDefaultBrowser, resolveDefaultBrowser, resetBrowserCache
};
