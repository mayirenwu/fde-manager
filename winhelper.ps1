# FDE Win32 helper - long lived process, one command per line on stdin.
# Protocol: command fields separated by '|'. Reply: single line starting with '@@'.
#   ENUM|<excludePidsCsv>        -> JSON array of windows
#   HIDE|h1,h2,h3                -> ok
#   CLOSE|h1,h2,h3               -> ok  (WM_CLOSE 优雅关闭)
#   SHOW|h1,h2,h3                -> ok  (restores iconic windows)
#   WALL|<abs path>              -> ok  (SPI_SETDESKWALLPAPER)
#   GENWALL|<path>|<c1>|<c2>|<w>|<h> -> ok
#   FOCUS|h                      -> ok
#   QUIT
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Drawing

$cs = @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WU {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, uint w, uint l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int SystemParametersInfoW(int act, int p, string v, int ini);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfoW(int act, int p, ref RECT r, int ini);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder sb, ref int size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static string[] SkipClass = new string[] {
    "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow", "ForegroundStaging", "MultitaskingViewFrame",
    "ApplicationManager_DesktopShellWindow", "XamlExplorerHostIslandWindow",
    "Windows.Internal.Shell.TabProxyWindow", "TaskListThumbnailWnd", "EdgeUiInputTopWndClass"
  };

  // 进程可执行文件完整路径——用它把「同一软件的所有进程」归到同一个桌面
  public static string ExePath(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return "";
    try {
      int size = 1024;
      StringBuilder sb = new StringBuilder(size);
      if (QueryFullProcessImageNameW(h, 0, sb, ref size)) return sb.ToString();
      return "";
    } finally { CloseHandle(h); }
  }

  // 系统可用工作区（已扣掉任务栏和 AppBar 占用的空间）
  public static int[] WorkArea() {
    RECT r = new RECT();
    if (SystemParametersInfoW(0x0030, 0, ref r, 0)) return new int[] { r.left, r.top, r.right, r.bottom };
    return new int[] { 0, 0, 0, 0 };
  }

  // 精确设置窗口矩形（不激活、不改 Z 序）
  public static void SetRect(IntPtr h, int x, int y, int w, int hh) {
    SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0004 | 0x0010);
  }

  static bool IsCloaked(IntPtr h) {
    int v = 0;
    int hr = DwmGetWindowAttribute(h, 14, out v, 4);
    return hr == 0 && v != 0;
  }

  public static List<string> List() {
    List<string> res = new List<string>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == 0) return true;
      StringBuilder sb = new StringBuilder(256);
      GetClassNameW(h, sb, 256);
      string cls = sb.ToString();
      for (int i = 0; i < SkipClass.Length; i++) if (SkipClass[i] == cls) return true;
      int ex = GetWindowLongW(h, -20);
      // 注意：不再跳过 WS_EX_TOOLWINDOW 窗口（交易软件的"下单窗/预警条/提示弹窗"
      // 常带此样式，跳过会导致它们永远不受管理、出现在每个桌面上）。
      // 是否为工具窗口随行返回，由主进程决定是否接管。
      //
      // cloaked（UWP 挂起、窗口在别的虚拟桌面上）也不整条丢掉了：整条丢掉会让主进程
      // 以为"窗口关了"，把它的桌面归属一起清掉 —— 之后它再出现就被当成新窗口，
      // 落到当时所在的桌面，于是"切回来发现少了几个窗口"。这里改为按不可见上报，
      // 归属保住，是否接管由主进程按 known（已接管句柄）决定。
      bool cloaked = IsCloaked(h);
      StringBuilder tb = new StringBuilder(512);
      GetWindowTextW(h, tb, 512);
      string title = tb.ToString();
      if (title.Length == 0) return true;
      int left = 0, top = 0;
      RECT rr;
      if (GetWindowRect(h, out rr)) { left = rr.left; top = rr.top; }
      string exe = ExePath(pid);
      bool vis = IsWindowVisible(h) && !cloaked;
      res.Add(h.ToInt64().ToString() + "\t" + pid.ToString() + "\t" + cls + "\t" +
              (vis ? "1" : "0") + "\t" + (IsIconic(h) ? "1" : "0") +
              "\t" + title.Replace("\t", " ").Replace("|", "/") + "\t" + left.ToString() + "\t" + top.ToString() +
              "\t" + exe.Replace("\t", " ").Replace("|", "/") +
              "\t" + (((ex & 0x80) != 0) ? "1" : "0") +
              "\t" + (cloaked ? "1" : "0") +
              "\t" + ((h == fg) ? "1" : "0"));
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static void SetWall(string path) { SystemParametersInfoW(0x0014, 0, path, 3); }
  public static void Show(IntPtr h, int cmd) { ShowWindow(h, cmd); }
  public static void Focus(IntPtr h) { SetForegroundWindow(h); }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static int[] GetRect(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return null;
    return new int[] { r.left, r.top, r.right, r.bottom };
  }
  public static void MoveTo(IntPtr h, int x, int y) {
    SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010);
  }
}
"@

try {
  Add-Type -TypeDefinition $cs -ErrorAction Stop
} catch {
  [Console]::Error.WriteLine('CSC:' + $_.Exception.Message)
  [Console]::Out.WriteLine('@@err:compile-failed')
  exit 1
}

function Reply([string]$s) { [Console]::Out.WriteLine('@@' + $s); [Console]::Out.Flush() }

# Hidden helper windows created by IME / GDI / tray apps - not real app windows
$JunkTitles = @(
  'Default IME', 'MSCTFIME UI', 'Sogou_TSF_UI', 'HintWnd', 'DDE Server Window',
  'Task Host Window', 'RECORDER_NOTIFY_WND', 'NVOGLDC invisible',
  '__wglDummyWindowFodder', 'Spaces External GPU Surface', 'Menu', 'tool_tips',
  'Program Manager', 'MiracastConnectionWindow', 'MS_WebcheckMonitor'
)

Reply '{"ok":true,"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  $p = $line.Split('|')
  $cmd = $p[0].ToUpper()
  if ($cmd -eq 'QUIT') { break }
  try {
    if ($cmd -eq 'ENUM') {
      # ENUM|<excludePidsCsv>|<knownHwndsCsv>
      $ex = @()
      if ($p.Length -gt 1 -and $p[1].Length -gt 0) { $ex = $p[1].Split(',') }
      $known = @{}
      if ($p.Length -gt 2 -and $p[2].Length -gt 0) {
        foreach ($k in $p[2].Split(',')) { if ($k.Length -gt 0) { $known[$k] = 1 } }
      }
      $rows = [WU]::List()
      $list = New-Object System.Collections.ArrayList
      $nameCache = @{}
      foreach ($r in $rows) {
        $f = $r.Split("`t")
        if ($f.Length -lt 6) { continue }
        if ($ex -contains $f[1]) { continue }
        $title = [string]$f[5]
        if ($JunkTitles -contains $title) { continue }
        if ($title.StartsWith('GDI+ Window')) { continue }
        # 不可见且不属于已接管窗口的，一律忽略（输入法、托盘等辅助窗口）
        if ($f[3] -eq '0' -and -not $known.ContainsKey($f[0])) { continue }
        $procId = [int]$f[1]
        if (-not $nameCache.ContainsKey($procId)) {
          $n = ''
          try { $n = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { $n = '' }
          $nameCache[$procId] = $n
        }
        $pn = $nameCache[$procId]
        if (-not $pn) { continue }
        [void]$list.Add([pscustomobject]@{
          hwnd   = [double]$f[0];
          pid    = $procId;
          proc   = [string]$pn;
          title  = [string]$f[5];
          vis    = ($f[3] -eq '1');
          iconic = ($f[4] -eq '1');
          x      = $(if ($f.Length -gt 6) { [int]$f[6] } else { 0 });
          y      = $(if ($f.Length -gt 7) { [int]$f[7] } else { 0 });
          exe    = $(if ($f.Length -gt 8) { [string]$f[8] } else { '' });
          tool   = $(if ($f.Length -gt 9) { $f[9] -eq '1' } else { $false });
          cloaked = $(if ($f.Length -gt 10) { $f[10] -eq '1' } else { $false });
          fg     = $(if ($f.Length -gt 11) { $f[11] -eq '1' } else { $false })
        })
      }
      if ($list.Count -eq 0) { Reply '[]' }
      else { Reply (ConvertTo-Json -InputObject $list.ToArray() -Compress -Depth 3) }
    }
    elseif ($cmd -eq 'FG') {
      # 当前前台窗口句柄（打开网页后靠它认出"浏览器把哪个窗口翻上来了"）
      $h = [WU]::Foreground()
      if ($h -eq [IntPtr]::Zero) { Reply '0' } else { Reply $h.ToInt64().ToString() }
    }
    elseif ($cmd -eq 'HIDE' -or $cmd -eq 'SHOW' -or $cmd -eq 'SHOWMIN' -or $cmd -eq 'MIN') {
      if ($p.Length -gt 1 -and $p[1].Length -gt 0) {
        foreach ($h in $p[1].Split(',')) {
          if ($h.Length -eq 0) { continue }
          $ptr = [IntPtr]([int64]$h)
          if ($cmd -eq 'SHOW') {
            if ([WU]::IsIconic($ptr)) { [WU]::Show($ptr, 9) } else { [WU]::Show($ptr, 5) }
          } elseif ($cmd -eq 'SHOWMIN') {
            [WU]::Show($ptr, 7)
          } elseif ($cmd -eq 'MIN') {
            # 异步最小化：目标程序卡死/繁忙时也不会拖住助手
            [void][WU]::ShowWindowAsync($ptr, 6)
          } else {
            # 异步隐藏：同上；对"正在忙"的窗口也能送达消息
            [void][WU]::ShowWindowAsync($ptr, 0)
          }
        }
      }
      Reply 'ok'
    }
    elseif ($cmd -eq 'CLOSE') {
      # CLOSE|h1,h2,...  向窗口投递 WM_CLOSE（优雅关闭，程序有机会保存数据）
      if ($p.Length -gt 1 -and $p[1].Length -gt 0) {
        foreach ($h in $p[1].Split(',')) {
          if ($h.Length -eq 0) { continue }
          [void][WU]::PostMessage([IntPtr]([int64]$h), 0x0010, 0, 0)
        }
      }
      Reply 'ok'
    }
    elseif ($cmd -eq 'WORK') {
      $r = [WU]::WorkArea()
      Reply ('{"l":' + $r[0] + ',"t":' + $r[1] + ',"r":' + $r[2] + ',"b":' + $r[3] + '}')
    }
    elseif ($cmd -eq 'SETRECT') {
      # SETRECT|hwnd|x|y|w|h
      if ($p.Length -gt 5) {
        [WU]::SetRect([IntPtr]([int64]$p[1]), [int]$p[2], [int]$p[3], [int]$p[4], [int]$p[5])
      }
      Reply 'ok'
    }
    elseif ($cmd -eq 'WALL') {
      if ($p.Length -gt 1) { [WU]::SetWall($p[1]) }
      Reply 'ok'
    }
    elseif ($cmd -eq 'MOVE') {
      if ($p.Length -gt 3) { [WU]::MoveTo([IntPtr]([int64]$p[1]), [int]$p[2], [int]$p[3]) }
      Reply 'ok'
    }
    elseif ($cmd -eq 'RECT') {
      $arr = New-Object System.Collections.ArrayList
      if ($p.Length -gt 1 -and $p[1].Length -gt 0) {
        foreach ($h in $p[1].Split(',')) {
          if ($h.Length -eq 0) { continue }
          $r = [WU]::GetRect([IntPtr]([int64]$h))
          if ($null -ne $r) {
            [void]$arr.Add([pscustomobject]@{ hwnd = [double]$h; l = $r[0]; t = $r[1]; r = $r[2]; b = $r[3] })
          }
        }
      }
      if ($arr.Count -eq 0) { Reply '[]' }
      else { Reply (ConvertTo-Json -InputObject $arr.ToArray() -Compress -Depth 3) }
    }
    elseif ($cmd -eq 'PPID') {
      # PPID|p1,p2,...  -> JSON [{ProcessId, ParentProcessId}]
      if ($p.Length -gt 1 -and $p[1].Length -gt 0) {
        $filter = ($p[1].Split(',') | Where-Object { $_ } | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR '
        $rows = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue |
                  Select-Object ProcessId, ParentProcessId)
        if ($rows.Count -eq 0) { Reply '[]' }
        else { Reply (ConvertTo-Json -InputObject $rows -Compress -Depth 3) }
      } else { Reply '[]' }
    }
    elseif ($cmd -eq 'FOCUS') {
      if ($p.Length -gt 1) { [WU]::Focus([IntPtr]([int64]$p[1])) }
      Reply 'ok'
    }
    elseif ($cmd -eq 'GENWALL') {
      $file = $p[1]; $c1 = $p[2]; $c2 = $p[3]
      $gw = [int]$p[4]; $gh = [int]$p[5]
      $textFile = ''
      if ($p.Length -gt 6) { $textFile = [string]$p[6] }
      $bmp = New-Object System.Drawing.Bitmap -ArgumentList $gw, $gh
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $rect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $gw, $gh
      $col1 = [System.Drawing.ColorTranslator]::FromHtml($c1)
      $col2 = [System.Drawing.ColorTranslator]::FromHtml($c2)
      $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList $rect, $col1, $col2, ([single]55)
      $g.FillRectangle($br, $rect)
      $br.Dispose()

      # 项目名：第 1 行是名字，其余行是每块屏的 x,y,w,h（图片内坐标），每块屏各自居中画一遍
      $text = ''
      $areas = @()
      if ($textFile -ne '' -and (Test-Path -LiteralPath $textFile)) {
        try {
          $lines = @(Get-Content -LiteralPath $textFile -Encoding UTF8)
          if ($lines.Count -ge 1) { $text = ([string]$lines[0]).Trim() }
          for ($i = 1; $i -lt $lines.Count; $i++) {
            $parts = ([string]$lines[$i]).Split(',')
            if ($parts.Count -eq 4) {
              $areas += ,@([single]$parts[0], [single]$parts[1], [single]$parts[2], [single]$parts[3])
            }
          }
        } catch {}
      }
      if ($areas.Count -eq 0) { $areas += ,@([single]0, [single]0, [single]$gw, [single]$gh) }

      if ($text -ne '') {
        try { $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit } catch {}
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = [System.Drawing.StringAlignment]::Center
        $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
        foreach ($a in $areas) {
          $ax = [single]$a[0]; $ay = [single]$a[1]; $aw = [single]$a[2]; $ah = [single]$a[3]
          if ($aw -le 0 -or $ah -le 0) { continue }
          # 字号按屏的短边 5% 起，字不倒特别大；名字太长自动缩到两侧留白 14%
          $size = [Math]::Round([Math]::Min($aw, $ah) * 0.05)
          if ($size -lt 16) { $size = 16 }
          $font = New-Object System.Drawing.Font -ArgumentList 'Microsoft YaHei', ([single]$size), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
          for ($k = 0; $k -lt 8; $k++) {
            $sz = $g.MeasureString($text, $font)
            if ($sz.Width -le ($aw * 0.72)) { break }
            $font.Dispose()
            $size = [Math]::Round($size * 0.86)
            if ($size -lt 12) { $size = 12 }
            $font = New-Object System.Drawing.Font -ArgumentList 'Microsoft YaHei', ([single]$size), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
          }
          $box = New-Object System.Drawing.RectangleF -ArgumentList $ax, $ay, $aw, $ah
          $off = [single]([Math]::Max(1, [Math]::Round($size * 0.05)))
          $boxSh = New-Object System.Drawing.RectangleF -ArgumentList ($ax + $off), ($ay + $off), $aw, $ah
          $shadow = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(78, 0, 0, 0))
          $brush = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(226, 255, 255, 255))
          $g.DrawString($text, $font, $shadow, $boxSh, $fmt)
          $g.DrawString($text, $font, $brush, $box, $fmt)
          $shadow.Dispose(); $brush.Dispose(); $font.Dispose()
        }
        $fmt.Dispose()
      }

      $g.Dispose()
      $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      Reply 'ok'
    }
    else {
      Reply 'err:unknown-command'
    }
  } catch {
    Reply ('err:' + $_.Exception.Message)
  }
}
