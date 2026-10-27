# Доступ: Cloudflare Tunnel, Access и LAN

Production: `https://internal.avku.org` через Cloudflare Access;
доверенный LAN: `http://192.168.0.151:18080`. API/web не публикуют отдельных
host ports; доступ идёт через nginx. Tunnel — отдельный исходящий connector
в существующей Docker-сети AVKU, без входящих портов на маршрутизаторе.

## Конфигурация

`.env.cloudflare.example` содержит только placeholders. Скопируйте его в
`.env.cloudflare` (0600), получите новый tunnel token в Cloudflare Zero Trust
и задайте Access team domain/application AUD в API `.env` (0600).
Секреты не передавать через чат, args или Git. Access Application должна
закрывать весь hostname, включая `/api`, использовать Google IdP и явный
allowlist сотрудников. Нельзя создавать bypass policy для `/api`.

Tunnel public hostname `internal.avku.org` направляется на `http://nginx:80`
в сети `avku-internal_avku_internal`. Запуск существующего connector:

```bash
docker compose -p avku-cloudflared --env-file .env.cloudflare \
  -f docker-compose.cloudflared.yml up -d
```

API проверяет подпись JWT через `jose`, issuer, audience и срок действия.
Email берётся из подписанного JWT, `Cf-Access-Authenticated-User-Email` сам
по себе не считается identity. Невалидный JWT отвергается; без JWT сохраняется
доверенный LAN-доступ. Nginx очищает Access-заголовки на LAN Host и передаёт
их для `internal.avku.org`. Валидная identity создаёт/обновляет employee;
`GET /api/me` возвращает identity либо локальный режим.

«Вибори» дополнительно проверяет роли `agitator/coordinator/manager/admin`.
`ELECTIONS_ADMIN_EMAILS` задаёт bootstrap admins; dev-auth выключен в production.
Остальные внутренние операции сохраняют существующую LAN/Access границу.
Для backup POST дополнительно нужны exact Origin, JSON, manual header и
idempotency UUID: [протокол](../infra/certificate-backup/README.md).

## Проверка и восстановление

```bash
curl -fsS http://192.168.0.151:18080/api/health
curl -fsS http://192.168.0.151:18080/api/me
bash scripts/verify-access.sh internal.avku.org
```

Без Access-сессии внешний сайт должен требовать вход. После Google-входа
проверить `/api/me` в браузере и logout. Изменение API env требует пересоздания
API с полной production-композицией из [operations.md](operations.md).
Не отключать Access для диагностики и не публиковать 3001/8080 в интернет.

Исторический DNS baseline 9 июля 2026 (не текущий DNS inventory): apex имел
четыре GitHub Pages A `185.199.108.153`–`185.199.111.153`, `www` CNAME на
`4245877.github.io`, MX 10 `mail.imena.com.ua`; старые NS — `pid1.srv53.net`,
`pid2.srv53.org`. Смена DNS-провайдера сейчас не нужна. Перед любой будущей
операцией выгрузить актуальную зону, сверить A/AAAA/CNAME/MX/TXT/DNSSEC,
сохранить обе зоны на время TTL. Не восстанавливать старый baseline вслепую.
Доступ/туннель `internal` не требует изменения публичного сайта или почты.

В истории Git обнаружен действующий tunnel token из прежнего example.
После получения нового токена обновить только `.env.cloudflare`, пересоздать
connector и проверить Access/LAN. Старый токен отозвать в Cloudflare.
Удаление строки из текущего файла не отзывает секрет из прошлых коммитов.
