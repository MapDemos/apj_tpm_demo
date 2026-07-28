#!/bin/bash
# geonator ローカルプロキシ経由 Claude 401 診断
# 使い方: geonator 直下で  bash diagnosis.sh

echo "=== 1. api-key.txt の健全性 ==="
if [ -f local-proxy/api-key.txt ]; then
  KEY=$(tr -d '\n' < local-proxy/api-key.txt)
  echo "存在 OK / 先頭 $(head -c 12 local-proxy/api-key.txt) / 長さ ${#KEY} 文字"
else
  KEY=""
  echo "存在: なし(!)  ← プロキシがキーを読めず500になるはず"
fi

echo "=== 2. Anthropicへ直接（キー単体の有効性・CORS無関係）==="
if [ -n "$KEY" ]; then
  curl -s -o /dev/null -w "HTTP %{http_code}\n" https://api.anthropic.com/v1/messages -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" -d '{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
else
  echo "キー未取得のためスキップ"
fi

echo "=== 3. configが指すプロキシ経由（ポート自動検出）==="
PROXY=$(grep -o 'http://localhost:[0-9]*' config.local.js 2>/dev/null | head -1)
if [ -z "$PROXY" ]; then
  PROXY=$(grep -o 'http://localhost:[0-9]*' config.js 2>/dev/null | head -1)
fi
echo "検出プロキシURL: ${PROXY:-見つからず}"
if [ -n "$PROXY" ]; then
  curl -s -o /dev/null -w "HTTP %{http_code}\n" "$PROXY/" -H "Content-Type: application/json" -d '{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
fi

echo "=== 4. ポート稼働状況 ==="
SERVER_PORT=$(grep -o 'const PORT = [0-9]*' local-proxy/server.js | grep -o '[0-9]*')
CONFIG_PORT=$(echo "$PROXY" | grep -o '[0-9]*$')
echo "server.js の PORT: ${SERVER_PORT:-取得できず}"
echo "config が指すポート: ${CONFIG_PORT:-取得できず}"
if [ -n "$SERVER_PORT" ] && [ -n "$CONFIG_PORT" ] && [ "$SERVER_PORT" != "$CONFIG_PORT" ]; then
  echo "⚠ 不一致: server.jsとconfigが別ポートを指しています"
fi
if [ -n "$CONFIG_PORT" ]; then
  echo "port $CONFIG_PORT で稼働中のPID: $(lsof -ti :$CONFIG_PORT 2>/dev/null | head -1 || echo なし)"
fi

echo "=== 5. config の値 ==="
grep -n 'CLAUDE_API_PROXY\|ANTHROPIC_DIRECT_API_KEY' config.local.js 2>/dev/null || echo "config.local.js なし"
