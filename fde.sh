#!/bin/bash
# ============================================================
# FDE 工作台 · Linux 启动器
#
# 用法：./fde.sh        （第一次先 chmod +x fde.sh）
#
# 说明：
#  - 窗口隔离需要 xdotool（X11 会话）：sudo apt install xdotool
#    Wayland 会话下无法跨应用隐藏窗口，程序会自动降级，其余功能正常。
#  - 若提示缺少依赖，先执行：npm install
# ============================================================
set -u
cd "$(dirname "$0")" || exit 1

APP_DIR="$(pwd)"

if [ -x "$APP_DIR/node_modules/electron/dist/electron" ]; then
  exec "$APP_DIR/node_modules/electron/dist/electron" "$APP_DIR" "$@"
fi

if [ -x "$APP_DIR/node_modules/.bin/electron" ]; then
  exec "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" "$@"
fi

if command -v electron >/dev/null 2>&1; then
  exec "$(command -v electron)" "$APP_DIR" "$@"
fi

echo "找不到 FDE 的运行库（node_modules/electron）。"
echo "请在软件目录执行：cd \"$APP_DIR\" && npm install"
echo "或者使用打包好的 .AppImage / .deb 版本。"
exit 1
