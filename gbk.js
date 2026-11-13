/**
 * 中文关键词 → 1688 搜索能认的 GBK 百分号编码。
 *
 * 背景：s.1688.com 的搜索页是 GBK 页面，keywords 参数按 GBK 解读。
 * 直接发 UTF-8（encodeURIComponent 的默认行为）会在搜索框里变成
 * "椹《璧疯韩鎵舵墜" 这类乱码。
 *
 * 优先级：
 *   1) 装了 iconv-lite 就用它（纯 JS，跨平台最快）
 *   2) macOS / Linux：调系统自带的 iconv 命令（posix 都有，不依赖 npm 包）
 *   3) Windows：系统代码页 936（PowerShell + GetEncoding(936)）
 *   4) 都失败就退回 UTF-8（至少能打开页面，用户可手动粘关键词）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const cache = new Map();

function pct(bytes) {
  return Array.from(bytes).map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
}

function viaIconv(str) {
  // 可选依赖：有就用，没有就抛
  // eslint-disable-next-line global-require
  const iconv = require('iconv-lite');
  return pct(iconv.encode(str, 'gbk'));
}

/** macOS / Linux：系统自带的 iconv 命令行（/usr/bin/iconv），不依赖 npm 包 */
function viaIconvCli(str) {
  const buf = execFileSync('iconv', ['-f', 'UTF-8', '-t', 'GBK'], {
    input: Buffer.from(str, 'utf8'), timeout: 5000, maxBuffer: 1024 * 1024
  });
  if (!buf || !buf.length) throw new Error('iconv 没输出');
  return pct(buf);
}

function viaCodepage(str, tmpDir) {
  const dir = tmpDir || process.env.TEMP || process.env.TMP || '.';
  const tmp = path.join(dir, 'fde-gbk-' + process.pid + '-' + Date.now().toString(36) + '.txt');
  fs.writeFileSync(tmp, str, 'utf8');
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    "$p='" + tmp.replace(/'/g, "''") + "';" +
    '$s=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8);' +
    '$b=[Text.Encoding]::GetEncoding(936).GetBytes($s);' +
    "($b | ForEach-Object { '{0:X2}' -f $_ }) -join ''"
  ];
  try {
    const hex = String(execFileSync('powershell.exe', ps, {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    }) || '').trim();
    if (!/^[0-9A-F]+$/i.test(hex)) throw new Error('代码页转换没返回十六进制');
    return pct(Buffer.from(hex, 'hex'));
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

/**
 * @param {string} str 中文关键词
 * @param {{tmpDir?: string}} [opts]
 * @returns {string} 形如 %C2%ED%C2%B1 的 GBK 百分号编码
 */
function gbkPercent(str, opts) {
  const s = String(str == null ? '' : str).trim();
  if (!s) return '';
  if (cache.has(s)) return cache.get(s);
  let out = '';
  try { out = viaIconv(s); } catch (e) { out = ''; }
  if (!out && process.platform !== 'win32') {
    // macOS / Linux 的常规路径（Windows 上 iconv 命令通常不存在）
    try { out = viaIconvCli(s); } catch (e) { out = ''; }
  }
  if (!out && process.platform === 'win32') {
    try { out = viaCodepage(s, opts && opts.tmpDir); } catch (e) { out = ''; }
  }
  if (!out) out = encodeURIComponent(s);   // 兜底：至少不会打不开
  cache.set(s, out);
  return out;
}

/** 拼 1688 搜索地址（关键词已按 GBK 编码） */
function search1688Url(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return 'https://www.1688.com/';
  return 'https://s.1688.com/selloffer/offer_search.htm?keywords=' + gbkPercent(kw);
}

/** 拼淘宝搜索地址（UTF-8，用来比零售价） */
function searchTaobaoUrl(keyword) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return 'https://www.taobao.com/';
  return 'https://s.taobao.com/search?q=' + encodeURIComponent(kw);
}

/** 按平台拼搜索地址 */
function searchUrl(platform, keyword) {
  return String(platform || '1688') === 'taobao' ? searchTaobaoUrl(keyword) : search1688Url(keyword);
}

module.exports = { gbkPercent, search1688Url, searchTaobaoUrl, searchUrl };
