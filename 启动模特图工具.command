#!/bin/zsh
cd "$(dirname "$0")"

if ! node --input-type=module -e 'await import("sharp")' >/dev/null 2>&1; then
  echo "首次运行正在安装图片处理组件，请稍候……"
  if ! npm install --omit=dev; then
    echo ""
    echo "图片处理组件安装失败，请检查网络后重新双击启动。"
    echo "按任意键关闭窗口。"
    read -k 1
    exit 1
  fi
fi

(sleep 1 && open "http://127.0.0.1:5178") &
node server.js
