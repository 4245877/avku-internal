#!/usr/bin/env bash
# Read-only проверка внешнего и локального доступа к avku-internal
# и целостности магазина SKUFnya. Ничего не меняет.
#
# Использование:
#   bash scripts/verify-access.sh                # только локальные проверки + SKUFnya
#   bash scripts/verify-access.sh avku.domain.com  # + проверки внешнего адреса

set -u

EXTERNAL_HOST="${1:-}"
LOCAL_URL="http://192.168.0.151:18080"
PASS=0
FAIL=0

ok()   { echo "  [OK]   $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
info() { echo "  [info] $1"; }

echo "=== 1. Магазин SKUFnya не затронут ==="
SKUF=$(docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" | grep skufnya || true)
if [ -z "$SKUF" ]; then
  bad "контейнеры skufnya-* не найдены — магазин не работает!"
else
  echo "$SKUF" | sed 's/^/  /'
  UP_COUNT=$(echo "$SKUF" | grep -c "Up" || true)
  TOTAL=$(echo "$SKUF" | wc -l)
  if [ "$UP_COUNT" -eq "$TOTAL" ]; then
    ok "все контейнеры skufnya-* запущены ($UP_COUNT/$TOTAL)"
  else
    bad "не все контейнеры skufnya-* в состоянии Up ($UP_COUNT/$TOTAL)"
  fi
  if echo "$SKUF" | grep -q "0.0.0.0:80->" && echo "$SKUF" | grep -q "0.0.0.0:443->"; then
    ok "skufnya-nginx владеет портами 80 и 443"
  else
    bad "skufnya-nginx не слушает 80/443 — проверить магазин!"
  fi
fi

echo
echo "=== 2. Локальный доступ к avku-internal ==="
LOCAL_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$LOCAL_URL/" || echo "000")
if [ "$LOCAL_CODE" = "200" ]; then
  ok "локальный frontend отвечает 200 ($LOCAL_URL)"
else
  bad "локальный frontend вернул $LOCAL_CODE (ожидалось 200)"
fi
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$LOCAL_URL/api/health" || echo "000")
if [ "$API_CODE" = "200" ]; then
  ok "локальный /api/health отвечает 200"
else
  info "локальный /api/health вернул $API_CODE"
fi

echo
echo "=== 3. Привязка порта 18080 ==="
BIND=$(ss -tln | grep ":18080" || true)
if echo "$BIND" | grep -q "0.0.0.0:18080"; then
  bad "18080 слушается на 0.0.0.0 — порт открыт на всех интерфейсах!"
elif echo "$BIND" | grep -q "192.168.0.151:18080"; then
  ok "18080 привязан только к 192.168.0.151"
else
  bad "18080 не слушается вообще: '$BIND'"
fi

echo
echo "=== 4. cloudflared не публикует порты ==="
CF_PORTS=$(docker ps --filter "name=cloudflared" --format "{{.Names}}\t{{.Ports}}" || true)
if [ -z "$CF_PORTS" ]; then
  info "контейнер cloudflared не запущен (нормально до внедрения)"
elif echo "$CF_PORTS" | grep -qE "0\.0\.0\.0|->|:::"; then
  bad "cloudflared публикует порты на хосте: $CF_PORTS"
else
  ok "cloudflared запущен без опубликованных портов"
fi

if [ -n "$EXTERNAL_HOST" ]; then
  echo
  echo "=== 5. Внешний адрес закрыт без Google-входа ==="
  for PATH_CHECK in "/" "/api/health" "/api/warehouse"; do
    RESP=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 15 "https://${EXTERNAL_HOST}${PATH_CHECK}" || echo "000 ")
    CODE=${RESP%% *}
    REDIR=${RESP#* }
    case "$CODE" in
      302|303)
        if echo "$REDIR" | grep -q "cloudflareaccess.com"; then
          ok "${PATH_CHECK} -> $CODE redirect на Cloudflare Access login"
        else
          bad "${PATH_CHECK} -> $CODE, но redirect не на Access: $REDIR"
        fi
        ;;
      401|403)
        ok "${PATH_CHECK} -> $CODE (доступ запрещён без авторизации)"
        ;;
      200)
        bad "${PATH_CHECK} -> 200 БЕЗ авторизации — сайт открыт всему интернету!"
        ;;
      000)
        info "${PATH_CHECK} -> нет ответа (туннель ещё не запущен или DNS не создан)"
        ;;
      *)
        info "${PATH_CHECK} -> неожиданный код $CODE"
        ;;
    esac
  done

  echo
  echo "=== 6. /api не отдаёт данные без авторизации ==="
  BODY=$(curl -s --max-time 15 "https://${EXTERNAL_HOST}/api/warehouse" || true)
  if echo "$BODY" | head -c 200 | grep -qE '^\s*[\[{]'; then
    bad "/api/warehouse вернул JSON без авторизации!"
  else
    ok "/api/warehouse не отдаёт JSON без авторизации"
  fi
else
  echo
  info "Внешний hostname не задан — проверки 5-6 пропущены."
  info "Запуск с внешними проверками: bash scripts/verify-access.sh avku.<домен>"
fi

echo
echo "=== Итог: $PASS OK, $FAIL FAIL ==="
[ "$FAIL" -eq 0 ]
