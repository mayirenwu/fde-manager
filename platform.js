/**
 * 跨平台能力层 —— 所有"这台机器能做什么"的判断都收在这里。
 *
 * 背景：FDE 最初是 Windows 专用（窗口隔离靠 Win32 + 常驻 PowerShell 助手、
 * 面板靠 AppBar 占位、开机自启用启动文件夹 .lnk）。要支持 macOS（Intel / Apple Silicon）
 * 和 Linux，就必须把"平台差异"从业务代码里挤出来，集中到这一个文件。
 *
 * 设计原则：
 *   1) 本文件不 require electron，纯 Node，方便单测（scripts 里有 test-platform.js）。
 *   2) 只做"判断 + 给出命令/路径"，不真正执行（执行留给调用方，便于测试与替换）。
 *   3) 能力用等级表示，不假设"非 Windows 就等于不能用"：
 *        full     —— 与 Windows 同等能力
 *        app      —— 只能按"整个应用"隐藏/显示（macOS，需辅助功能权限）
 *        window   —— 按窗口操作，但依赖外部工具（Linux + xdotool/wmctrl）
 *        none     —— 不支持，业务侧降级但功能仍可用
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const PLATFORM = process.platform;   // 'win32' | 'darwin' | 'linux'
const ARCH = process.arch;           // 'x64' | 'arm64' | ...

const LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** 各平台能力矩阵。新增平台只改这里。 */
const MATRIX = {
  win32: {
    id: 'win32',
    label: 'Windows',
    windowMgmt: 'full',        // 完整：按窗口隐藏/显示/移动
    appBar: true,              // 能把面板注册成系统侧边栏（工作区让位）
    wallpaper: true,           // 能换桌面壁纸（按项目配色）
    elevation: true,           // 有 UAC 提权概念
    autostart: 'startup-lnk',  // 启动文件夹快捷方式
    scriptExt: '.ps1',
    shell: 'powershell.exe',
    shortcutPrefix: 'Control+Alt',
    modifier: 'Ctrl',
    trayIcon: 'tray.ico'
  },
  darwin: {
    id: 'darwin',
    label: 'macOS',
    windowMgmt: 'app',         // 进程级：隐藏整个 App（需"辅助功能"授权）
    appBar: false,
    wallpaper: false,
    elevation: false,
    autostart: 'launch-agent',
    scriptExt: '.sh',
    shell: '/bin/sh',
    shortcutPrefix: 'Command+Alt',
    modifier: 'Cmd',
    trayIcon: 'trayTemplate.png'
  },
  linux: {
    id: 'linux',
    label: 'Linux',
    windowMgmt: 'window',      // 依赖 xdotool（X11）；Wayland 下自动关闭
    appBar: false,
    wallpaper: false,
    elevation: false,
    autostart: 'xdg-autostart',
    scriptExt: '.sh',
    shell: '/bin/sh',
    shortcutPrefix: 'Control+Alt',
    modifier: 'Ctrl',
    trayIcon: 'tray.png'
  }
};

function caps(plat) {
  const id = plat || PLATFORM;
  return MATRIX[id] || Object.assign({}, MATRIX.linux, { id, label: LABELS[id] || id });
}

const isWin = () => PLATFORM === 'win32';
const isMac = () => PLATFORM === 'darwin';
const isLinux = () => PLATFORM === 'linux';

/** 是否有"窗口级"隔离能力（Windows 全量，Linux 靠 xdotool，macOS 为应用级） */
function isolationLevel(plat) {
  return caps(plat).windowMgmt;
}

/**
 * 脚本执行计划：按扩展名选解释器，跨平台。
 * @returns {{cmd:string,args:string[],ext:string}|null}
 */
function scriptPlan(file, plat) {
  const p = caps(plat);
  const ext = String((String(file).toLowerCase().match(/\.[^.\\/]+$/) || [''])[0]);
  if (ext === '.ps1') {
    // .ps1 只有在 Windows 上才有意义；其它系统若装了 pwsh 也能跑
    return p.id === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], ext }
      : { cmd: 'pwsh', args: ['-NoProfile', '-File', file], ext };
  }
  if (ext === '.sh' || ext === '.command') {
    // Windows 没有默认 sh：装了 Git Bash 也不该悄悄用（保持行为可预期）
    return p.id === 'win32' ? null : { cmd: '/bin/sh', args: [file], ext };
  }
  if (ext === '.py') return { cmd: p.id === 'win32' ? 'python' : 'python3', args: [file], ext };
  if (ext === '.bat' || ext === '.cmd') {
    return p.id === 'win32' ? { cmd: 'cmd.exe', args: ['/c', file], ext } : null;
  }
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') {
    // 打包后机器上不一定有独立 node，用 Electron 自带的那份（RUN_AS_NODE 模式）
    return { cmd: process.execPath, args: [file], ext, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return null;
}

/**
 * 打开一个"东西"（程序 / 文件夹 / 文件）的命令。
 * Windows 用 explorer 代启（保持普通权限），macOS 用 open，Linux 用 xdg-open。
 * @returns {{cmd:string,args:string[]}}
 */
function openPlan(target, plat) {
  const p = caps(plat);
  if (p.id === 'win32') return { cmd: 'explorer.exe', args: [target] };
  if (p.id === 'darwin') {
    return /\.app$/i.test(target) ? { cmd: 'open', args: ['-a', target] } : { cmd: 'open', args: [target] };
  }
  return { cmd: 'xdg-open', args: [target] };
}

/** 结束进程的命令 */
function killPlan(pid, plat) {
  const p = caps(plat);
  if (p.id === 'win32') return { cmd: 'taskkill', args: ['/F', '/PID', String(pid)] };
  return { cmd: 'kill', args: ['-9', String(pid)] };
}

/** 开机自启文件路径（用户级，不需要管理员） */
function autostartPath(opts) {
  const o = opts || {};
  const p = caps(o.plat);
  const home = o.home || os.homedir();
  const appName = o.appName || 'FDE Manager';
  if (p.autostart === 'startup-lnk') {
    const appData = o.appData || process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', appName + '.lnk');
  }
  if (p.autostart === 'launch-agent') {
    return path.join(home, 'Library', 'LaunchAgents', 'com.fde.manager.plist');
  }
  return path.join(o.configHome || process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'autostart', 'fde-manager.desktop');
}

/**
 * 开机自启文件内容（macOS LaunchAgent plist / Linux .desktop）。
 * Windows 的 .lnk 不是文本，走 PowerShell 创建，见 main.js。
 */
function autostartContent(opts) {
  const o = opts || {};
  const p = caps(o.plat);
  const exe = String(o.exe || process.execPath);
  const args = Array.isArray(o.args) ? o.args : [];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (p.autostart === 'launch-agent') {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>com.fde.manager</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>' + esc(exe) + '</string>',
      ...args.map(a => '    <string>' + esc(a) + '</string>'),
      '  </array>',
      '  <key>RunAtLoad</key><true/>',
      '  <key>ProcessType</key><string>Interactive</string>',
      '</dict>',
      '</plist>',
      ''
    ].join('\n');
  }
  if (p.autostart === 'xdg-autostart') {
    return [
      '[Desktop Entry]',
      'Type=Application',
      'Name=FDE Manager',
      'Comment=FDE 桌面项目管理器',
      'Exec="' + exe + '"' + (args.length ? ' ' + args.join(' ') : ''),
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n');
  }
  return '';
}

/** 全局热键前缀（macOS 用 Command，其它用 Ctrl） */
function shortcutAccel(key, plat) {
  return caps(plat).shortcutPrefix + '+' + key;
}

/** 常被用到的浏览器：按平台给候选路径（存在性由调用方判断） */
function knownBrowsers(opts) {
  const o = opts || {};
  const p = caps(o.plat);
  const home = o.home || os.homedir();
  if (p.id === 'win32') {
    return [
      ['Microsoft Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
      ['Microsoft Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
      ['Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
      ['Google Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
      ['Mozilla Firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'],
      ['Mozilla Firefox', 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe']
    ];
  }
  if (p.id === 'darwin') {
    const A = '/Applications';
    return [
      ['Safari', '/Applications/Safari.app'],
      ['Google Chrome', path.join(A, 'Google Chrome.app')],
      ['Microsoft Edge', path.join(A, 'Microsoft Edge.app')],
      ['Mozilla Firefox', path.join(A, 'Firefox.app')],
      ['Arc', path.join(A, 'Arc.app')],
      ['Chrome（用户目录）', path.join(home, 'Applications', 'Google Chrome.app')]
    ];
  }
  return [
    ['Google Chrome', '/usr/bin/google-chrome'],
    ['Chromium', '/usr/bin/chromium'],
    ['Chromium', '/usr/bin/chromium-browser'],
    ['Mozilla Firefox', '/usr/bin/firefox'],
    ['Microsoft Edge', '/usr/bin/microsoft-edge']
  ];
}

/** 托盘图标候选文件（打包后优先 resources，其次程序目录） */
function trayIconCandidates(opts) {
  const o = opts || {};
  const appDir = o.appDir || __dirname;
  const name = caps(o.plat).trayIcon;
  const dirs = [o.resourcesPath, path.join(appDir, 'assets'), path.join(appDir, 'build'), appDir].filter(Boolean);
  const out = [];
  for (const d of dirs) out.push(path.join(d, name));
  // 兜底：任意一张 PNG
  for (const d of dirs) out.push(path.join(d, 'icon.png'));
  return out;
}

/** 程序目录里必须存在的文件（跨平台） */
function requiredFiles(plat) {
  const base = ['main.js', 'preload.js', 'platform.js', 'wmp.js'];
  return caps(plat).id === 'win32' ? base.concat(['winhelper.ps1']) : base;
}

/** 这个平台要不要检查/申请管理员权限 */
function needsElevation(plat) {
  return !!caps(plat).elevation;
}

/** 给 UI 用的一句话说明 */
function describe(plat) {
  const p = caps(plat);
  const lvl = { full: '窗口级隔离', app: '应用级隔离（需辅助功能权限）', window: '窗口级隔离（需 xdotool，X11）', none: '不支持窗口隔离' }[p.windowMgmt] || '';
  return p.label + ' · ' + lvl;
}

module.exports = {
  PLATFORM, ARCH, LABELS, MATRIX,
  caps, isWin, isMac, isLinux, isolationLevel, describe,
  scriptPlan, openPlan, killPlan,
  autostartPath, autostartContent,
  shortcutAccel, knownBrowsers, trayIconCandidates, requiredFiles, needsElevation
};
