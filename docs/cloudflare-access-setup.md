# Инструкция: Cloudflare Tunnel + Access + Google-вход для avku-internal

Цель: внешний адрес `https://internal.avku.org` с обязательным входом через
Google и allowlist по email. Локальный доступ `http://192.168.0.151:18080`
не меняется. Корень `avku.org` и `www.avku.org` (GitHub Pages) остаются
публичным статическим сайтом. Магазин SKUFnya не затрагивается ни на одном шаге.

Все шаги выполняются в браузере (Cloudflare / Google Cloud Console),
кроме шага 6 — единственного шага на сервере.

---

## Шаг 0. Предварительно

- Аккаунт Cloudflare (бесплатный): https://dash.cloudflare.com/sign-up
- Аккаунт Google (уже есть).
- Стоимость: 0. Домен avku.org уже есть, Zero Trust Free — до 50 пользователей.

## Шаг 1. Перенести DNS-зону avku.org в Cloudflare

Cloudflare Free работает только с целой зоной, поэтому DNS avku.org
переносится под управление Cloudflare (регистратор остаётся imena.com.ua,
меняются только nameservers).

Полный пошаговый план с baseline-записями, проверками и откатом:
**docs/dns-migration-avku-org.md**. Кратко:

1. Add a domain → avku.org → Free.
2. Проверить импорт всех 6 записей (4×A @, CNAME www, MX) —
   все с серым облачком (DNS only).
3. Сменить NS у imena.com.ua на выданные Cloudflare.
4. Дождаться статуса Active, проверить, что avku.org/www живы.

## Шаг 2. Zero Trust и team domain

1. В дашборде: Zero Trust (one.dash.cloudflare.com).
2. При первом входе выбрать team name, например `avku`.
   Получится team domain: `avku.cloudflareaccess.com` — страница логина.
3. План: Free (потребуется привязать карту или PayPal, списаний нет).

## Шаг 3. Создать Tunnel

1. Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.
2. Имя: `avku-internal`.
3. На экране установки коннектора выбрать Docker и СКОПИРОВАТЬ ТОКЕН
   (длинная строка после `--token`). Команду из дашборда НЕ запускать —
   у нас свой compose-файл. Токен пойдёт в `.env.cloudflare` на шаге 6.
4. Next → Public hostname:
   - Subdomain: `internal`
   - Domain: `avku.org`
   - Path: пусто
   - Service: Type `HTTP`, URL `nginx:80`
     (это DNS-имя avku-internal-nginx-1 внутри docker-сети
     avku-internal_avku_internal, к которой подключится cloudflared).
5. Save. Cloudflare сам создаст CNAME `internal` → `<tunnel-id>.cfargotunnel.com`.
   Записи корня @ и www при этом не меняются — вручную DNS не трогаем.

## Шаг 4. Google как identity provider

1. Google Cloud Console (console.cloud.google.com) → создать проект,
   например `avku-access`.
2. APIs & Services → OAuth consent screen:
   - User type: External, статус Testing достаточно
     (в Testing добавляются test users — это и есть сотрудники;
     либо Publish app, allowlist всё равно контролирует Access).
3. APIs & Services → Credentials → Create credentials → OAuth client ID:
   - Type: Web application
   - Authorized redirect URI:
     `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
     (подставить team domain из шага 2, например
     `https://avku.cloudflareaccess.com/cdn-cgi/access/callback`)
4. Скопировать Client ID и Client Secret.
5. Zero Trust → Settings → Authentication → Login methods →
   Add new → Google → вставить Client ID/Secret → Save → Test.

## Шаг 5. Access Application (защита сайта и /api)

1. Zero Trust → Access → Applications → Add an application → Self-hosted.
2. Name: `avku-internal`.
3. Application domain: subdomain `internal`, domain `avku.org`, path пусто —
   политика накрывает ВЕСЬ hostname, включая `/api/*`.
   Корень avku.org и www сюда НЕ добавлять — они остаются публичными.
4. Session Duration: 24 hours (можно меньше).
5. Login methods: только Google (отключить One-time PIN, чтобы вход был
   строго через Google).
6. Policy:
   - Name: `employees-allowlist`
   - Action: Allow
   - Include → Selector: Emails → значение: `alner4245877@gmail.com`
7. Save.

Добавление следующего сотрудника = добавить его email в этот список
(Access → Applications → avku-internal → Policies → Edit). Без деплоя.
Удаление сотрудника = убрать email + Access → отозвать его сессии
(Revoke existing sessions).

## Шаг 6. Сервер (единственный шаг на сервере — по отдельному подтверждению)

```bash
cd /home/hpelitdesk/apps/avku-internal
cp .env.cloudflare.example .env.cloudflare
chmod 600 .env.cloudflare
# вставить токен из шага 3 в CLOUDFLARE_TUNNEL_TOKEN=

# контрольный снимок магазина ДО:
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep skufnya

docker compose -p avku-cloudflared -f docker-compose.cloudflared.yml \
  --env-file .env.cloudflare up -d

docker logs avku-cloudflared-cloudflared-1 --tail 20
# ожидаем: "Registered tunnel connection" (обычно 4 соединения)

bash scripts/verify-access.sh internal.avku.org

# контрольный снимок магазина ПОСЛЕ:
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep skufnya
```

## Шаг 7. Проверка глазами

1. С телефона через мобильный интернет (не Wi-Fi!) открыть
   `https://internal.avku.org` — должна появиться страница Cloudflare Access
   с кнопкой входа через Google.
2. Войти своим Google — сайт должен открыться.
3. Попросить кого-то с email НЕ из allowlist войти — должен получить отказ.
4. `https://internal.avku.org/api/warehouse` без входа — не должен отдать JSON.
5. Отдельно убедиться, что `https://avku.org` и `https://www.avku.org`
   открываются как раньше, БЕЗ страницы логина.

## Logout

- Выход: открыть `https://internal.avku.org/cdn-cgi/access/logout` —
  Cloudflare завершает сессию Access. Ссылку можно добавить в UI (Фаза 2).
- Принудительный выход сотрудника: Zero Trust → Access →
  Revoke existing sessions у приложения, либо убрать email из политики.

## Откат

```bash
docker compose -p avku-cloudflared -f docker-compose.cloudflared.yml down
```

Затем в дашборде: удалить Tunnel и Access Application — CNAME internal
удалится вместе с туннелем, корень avku.org не затрагивается.
Полный откат DNS (возврат NS на imena) описан в docs/dns-migration-avku-org.md.
Основной стек avku-internal и магазин SKUFnya ничем из этого не затрагиваются.

## Что НЕ делаем

- Не используем trycloudflare.com / quick tunnel — там нет Access-политик.
- Не публикуем порты у cloudflared, не используем 80/443/8080/18080 наружу.
- Не открываем порты на роутере, не меняем UFW.
- Не включаем Access для корня avku.org и www — статический сайт публичный.
- Не касаемся контейнеров, сетей, nginx и DNS магазина SKUFnya.
