#!/bin/zsh
set -e

cd "$(dirname "$0")"

if [[ ! -f config.yml ]]; then
  cp config.example.yml config.yml
fi

api_key=$(grep -E '^[[:space:]]*api_key:' config.yml | head -1 | cut -d: -f2- | tr -d '[:space:]"')
if [[ -z "$api_key" || "$api_key" == "YOUR_AGNES_API_KEY" ]]; then
  echo "请先在 config.yml 中配置 agnes.api_key，然后重新运行。"
  exit 1
fi

echo "正在启动猫 Meme 剧场：http://localhost:4173/cat-meme-theater/"
exec node server.mjs
