#!/bin/bash
# 启动 cloudflared 隧道，获取 URL 后自动注册到 Railway bot
# 内置心跳：每 60 秒健康检查 + 注册，隧道卡死自动重启

cd "$(dirname "$0")"

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"

PROXY_SECRET="${PROXY_SECRET:-lark-proxy-secret-2026}"
RAILWAY_BOT_URL="${RAILWAY_BOT_URL:-https://lark-claude-bot-93eq-production.up.railway.app}"
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-60}"  # 秒

# ── 注册函数 ──────────────────────────────────────────────────────────────────
register() {
  local url="$1"
  local res http_code body
  res=$(curl --noproxy '*' -s -w '\n%{http_code}' -X POST \
    "${RAILWAY_BOT_URL}/register-proxy" \
    -H "Content-Type: application/json" \
    -H "x-proxy-secret: ${PROXY_SECRET}" \
    -d "{\"url\":\"${url}\"}" 2>&1)
  http_code=$(echo "$res" | tail -1)
  body=$(echo "$res" | head -1)
  if [ "$http_code" = "200" ]; then
    echo "[$(date)] ✅ 注册成功 LARK_PROXY_URL=$url" | tee -a "$LOG_DIR/proxy.log"
    return 0
  else
    echo "[$(date)] ⚠️  注册失败 (HTTP $http_code): $body" | tee -a "$LOG_DIR/proxy.log"
    return 1
  fi
}

# ── 启动 cloudflared ──────────────────────────────────────────────────────────
echo "[$(date)] 启动 cloudflared..." | tee -a "$LOG_DIR/proxy.log"
CF_LOG="$LOG_DIR/cloudflared.log"
> "$CF_LOG"
cloudflared tunnel --url http://localhost:7788 > "$CF_LOG" 2>&1 &
CF_PID=$!

echo "[$(date)] cloudflared PID: $CF_PID，等待隧道建立..." | tee -a "$LOG_DIR/proxy.log"

# 等待 URL 出现（最多 60 秒）
TUNNEL_URL=""
for i in $(seq 1 60); do
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | head -1)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[$(date)] ❌ 获取隧道 URL 失败" | tee -a "$LOG_DIR/proxy.log"
  kill $CF_PID 2>/dev/null
  exit 1
fi

echo "[$(date)] ✅ 隧道 URL: $TUNNEL_URL" | tee -a "$LOG_DIR/proxy.log"

# 首次注册
register "$TUNNEL_URL"

# ── 心跳循环：每 60 秒重新注册 + 健康检查（隧道卡死则强制重启） ──────────────
FAIL_COUNT=0
(
  while kill -0 $CF_PID 2>/dev/null; do
    sleep "$HEARTBEAT_INTERVAL"
    # 读取最新 URL
    CURRENT_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | tail -1)
    if [ -z "$CURRENT_URL" ]; then continue; fi

    # 健康检查：通过公网 URL 打 /health
    HTTP_CODE=$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' \
      --max-time 10 "${CURRENT_URL}/health" 2>/dev/null || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
      FAIL_COUNT=0
      register "$CURRENT_URL"
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
      echo "[$(date)] ⚠️  隧道健康检查失败 (HTTP $HTTP_CODE)，连续失败 $FAIL_COUNT 次" | tee -a "$LOG_DIR/proxy.log"
      if [ "$FAIL_COUNT" -ge 3 ]; then
        echo "[$(date)] 🔄 隧道卡死，强制重启 cloudflared..." | tee -a "$LOG_DIR/proxy.log"
        kill $CF_PID 2>/dev/null
        break
      fi
    fi
  done
) &
HEARTBEAT_PID=$!

# 等待 cloudflared 退出（pm2 通过此进程判断存活）
wait $CF_PID
kill $HEARTBEAT_PID 2>/dev/null
