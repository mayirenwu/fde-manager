#!/bin/bash
# ============================================================
# FDE 工作台 · macOS 启动器（双击运行）
#
# 说明：
#  - macOS 没有 UAC 提权这一套，不需要"管理员权限"启动；
#    但要在「系统设置 → 隐私与安全性 → 辅助功能」里把本程序加进去，
#    否则切换项目桌面时无法隐藏/显示其它应用（其余功能不受影响）。
#  - 第一次双击如果被系统拦下，右键 → 打开，或执行：
#      chmod +x "启动 FDE.command"
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

APP_DIR="$(pwd)"
ELECTRON="$APP_DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ -x "$ELECTRON" ]; then
  exec "$ELECTRON" "$APP_DIR"
fi

if [ -d "$APP_DIR/node_modules/electron" ]; then
  # 依赖在但 dist 不完整：让 electron 包自己去找/下载运行库
  exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR"
fi

if command -v electron >/dev/null 2>&1; then
  exec "$(command -v electron)" "$APP_DIR"
fi

echo "找不到 FDE 的运行库（node_modules/electron）。"
echo
echo "请在软件目录里执行一次："
echo "  cd \"$APP_DIR\" && npm install"
echo
echo "如果只是想在 Mac 上直接用，建议使用打包好的 .dmg 版本。"
read -r -p "按回车键关闭…" _
exit 1
