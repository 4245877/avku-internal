# Отчет по серверу и развёртыванию нового проекта

Дата проверки: 2026-07-09.

## 1. Текущее состояние сервера

- ОС: Ubuntu 26.04 LTS, x86_64.
- Kernel: `7.0.0-27-generic`.
- Uptime на момент проверки: около 2 дней 18 часов.
- Диск `/`: 115G всего, 56G занято, 54G свободно, использование около 52%.
- RAM: 6.2 GiB всего, 2.7 GiB занято, 3.5 GiB доступно.
- Swap: 4.0 GiB всего, 1.7 GiB используется. Использование swap уже заметное, поэтому новые сервисы лучше запускать с лимитами ресурсов и мониторингом.
- Docker: Engine 29.5.2, Compose v5.1.4.
- Host-level Nginx не установлен и не запущен. Публичный HTTP/HTTPS сейчас обслуживает контейнер `skufnya-nginx`.
- При проверке `df` есть ошибка по `/tmp/RustDesk/cliprdr-client`: `Transport endpoint is not connected`. Это похоже на зависший mount/endpoint RustDesk, стоит отдельно проверить и очистить.

Проекты в `/home/hpelitdesk/apps/`:

- `SKUFnya` - около 1.8G, текущий магазин/backend/admin, запущен через Docker Compose.
- `SKUFstore` - около 136M, Next.js storefront, Dockerfile есть, но среди запущенных compose-проектов не обнаружен.
- `avku-internal` - около 572M, новый внутренний проект, Docker Compose файлы есть, контейнеры не запущены.

Права на каталоги и секреты:

- `/home/hpelitdesk/apps` - `775`.
- `/home/hpelitdesk/apps/SKUFnya` - `775`.
- `/home/hpelitdesk/apps/SKUFnya/ops/.env` - `600`.
- `/home/hpelitdesk/apps/SKUFnya/apps/api/.env` - `600`.
- `/home/hpelitdesk/apps/SKUFstore/apps/storefront/.env.local` - `600`.
- `/home/hpelitdesk/apps/avku-internal` - `707`. Это риск: у `others` есть права чтения, записи и входа в каталог. Рекомендуется исправить минимум на `750` или `700`.

## 2. Запущенные сервисы

Запущенные системные сервисы, важные для размещения проектов:

- `docker.service`, `containerd.service` - контейнерная платформа.
- `ssh.service` - SSH.
- `tailscaled.service` - Tailscale.
- `rustdesk.service` - удалённый доступ.
- `certbot.timer` - автоматическое обновление сертификатов Let's Encrypt.
- `skufnya-backup.timer` - ежедневный backup магазина.
- `unattended-upgrades.service` - автоматические обновления пакетов.
- Также активны GUI/desktop и локальные сервисы: `lightdm`, `cups`, `avahi-daemon`, `colord`, `ModemManager`. Для серверного режима их нужно пересмотреть и отключить, если они не нужны.

Запущенный Docker Compose проект:

- Compose project: `ops`.
- Config file: `/home/hpelitdesk/apps/SKUFnya/ops/docker-compose.yml`.

Контейнеры магазина:

- `skufnya-nginx` - `nginx:1.27-alpine`, healthy, публикует `80`, `443`, `127.0.0.1:8080`, `100.91.30.10:8080`.
- `skufnya-api` - `ops-api`, healthy, порт `3001` только внутри Docker-сети.
- `skufnya-admin-panel` - `ops-admin-panel`, healthy, порт `80` только внутри Docker-сети.
- `skufnya-postgres` - `postgres:16`, healthy, порт `5432` только внутри Docker-сети.
- `skufnya-redis` - `redis:7-alpine`, healthy, порт `6379` только внутри Docker-сети.
- `skufnya-minio` - `minio/minio:latest`, порт `9000` внутри Docker-сети, console `127.0.0.1:9001`.

Открытые порты:

- `0.0.0.0:22` и `[::]:22` - SSH.
- `0.0.0.0:80` и `[::]:80` - `skufnya-nginx`.
- `0.0.0.0:443` и `[::]:443` - `skufnya-nginx`.
- `127.0.0.1:8080` и `100.91.30.10:8080` - админка магазина через `skufnya-nginx`.
- `127.0.0.1:9001` - MinIO console.
- `192.168.0.151:35557`, UDP `0.0.0.0:21119`, UDP `0.0.0.0:44847` - RustDesk.
- UDP `41641` - Tailscale.
- UDP `5353` - mDNS/Avahi.
- `127.0.0.1:631` - CUPS.

Статус firewall UFW не удалось подтвердить без root-доступа: `ufw status` требует root. Это нужно проверить отдельно.

## 3. Текущее устройство Nginx и SSL

Публичного Nginx на хосте нет. Текущий reverse proxy - контейнер `skufnya-nginx`.

Конфигурация магазина:

- default server на `80` возвращает `444`.
- `api.skufnya.com` на `80` редиректит на HTTPS.
- `api.skufnya.com` на `443` использует сертификат из `/etc/letsencrypt/live/api.skufnya.com/`.
- `/api/admin/` и `/docs` публично закрыты через `404`.
- `/uploads/` отдаётся из readonly volume.
- Админка доступна отдельно на `:8080` только через `localhost` и Tailscale IP.

Сертификаты:

- `certbot.timer` активен.
- Полный список сертификатов прочитать не удалось без root-доступа.
- Не подтвержден deploy hook для reload контейнера Nginx после обновления сертификата. Это важно: после renewal Nginx должен перечитать новые файлы сертификата.

## 4. Backup и надежность

Для магазина настроен systemd timer:

- `skufnya-backup.timer` - ежедневно около `03:30 UTC`, с задержкой до 10 минут.
- `skufnya-backup.service` запускает `/home/hpelitdesk/apps/SKUFnya/ops/backup/backup.sh` от root.

Проблема:

- Последний запуск `skufnya-backup.service` завершился ошибкой.
- Причина: Google Drive вернул `403 storageQuotaExceeded`.
- Пик памяти backup-процесса: около 2.9G.

Это высокий риск для магазина. Перед размещением нового проекта нужно восстановить успешное резервное копирование: освободить квоту, сменить remote, добавить локальную ротацию и проверку восстановления.

Для `avku-internal` есть `infra/scripts/backup-db.sh`, но production compose хранит данные в Docker volume `avku-internal_app-data`. Нужно заранее решить, где будут жить SQLite-данные и как будет запускаться backup:

- либо bind mount отдельного каталога с правами `700`, например `/home/hpelitdesk/apps/avku-internal/runtime:/data`;
- либо named volume `avku-internal_app-data` плюс backup-контейнер или systemd service, который монтирует этот volume и запускает `backup-db.sh` с `DATA_ROOT=/data`.

## 5. Риски при размещении нового проекта рядом с магазином

1. Конфликт портов.
   - `avku-internal/docker-compose.prod.yml` публикует `80:80`, но `80` уже занят `skufnya-nginx`.
   - dev compose нового проекта публикует `8080:80`, но `8080` уже используется админкой магазина на `127.0.0.1` и Tailscale IP.
   - dev compose публикует `3001:3001`, а `3001` используется API внутри обоих проектов. На хосте этот порт сейчас не опубликован магазином, но публичная публикация API нового проекта не нужна.

2. Риск остановки магазина при перезапуске общего proxy.
   - Сейчас `skufnya-nginx` владеет `80/443`.
   - Любая ошибка в конфигурации этого контейнера может уронить доступ к магазину.
   - Нельзя запускать второй Nginx с `80/443` параллельно.

3. Недостаточная изоляция файлов.
   - `avku-internal` имеет права `707`, что позволяет доступ `others`.
   - В проекте есть runtime SQLite-файлы и WAL/SHM рядом с кодом.
   - Внутри проекта есть Windows Node bundle `.tools/node-v22.23.1-win-x64`, который не нужен для Ubuntu deployment и увеличивает размер/шум.

4. Backup магазина уже в ошибке.
   - Добавление нового проекта увеличит нагрузку и объем данных.
   - Перед новым deployment нужно привести backups в рабочее состояние.

5. Ресурсы.
   - RAM свободна, но swap уже используется.
   - Новый проект на Node/Vite/SQLite не должен быть тяжелым, но сборки Node могут потреблять память.
   - У текущего `ops-api` image размер около 3.7G, Docker storage уже стоит держать под контролем.

6. Firewall и лишние сервисы.
   - UFW не подтвержден.
   - RustDesk, Avahi, CUPS и GUI-сервисы увеличивают поверхность атаки. Если они не нужны для эксплуатации, лучше отключить или ограничить доступ.

## 6. Оптимальный способ развёртывания `avku-internal`

Новый проект нужно разворачивать отдельным Docker Compose стеком, отдельно от магазина:

- Compose project name: `avku-internal`.
- Отдельная Docker network: `avku-internal_default` или явно `avku_internal_net`.
- Отдельные volumes/data directories.
- API не публиковать на хост.
- Nginx нового проекта не должен занимать `80/443`.
- Наружу должен смотреть только один контролируемый reverse proxy.

Так как проект называется `avku-internal` и содержит операционные модули, рекомендуемый режим по умолчанию - не публиковать его в открытый интернет. Лучше открыть его только через Tailscale или VPN.

### Вариант A - рекомендованный для внутреннего проекта

Оставить магазин как есть, а новый проект опубликовать только на Tailscale IP или localhost:

- заменить в `avku-internal/docker-compose.prod.yml` публикацию `80:80` на один из вариантов:
  - `100.91.30.10:18080:80` - доступ только через Tailscale IP;
  - `127.0.0.1:18080:80` - доступ только локально, дальше можно проксировать отдельным edge proxy.
- не публиковать API `3001` наружу.
- домен настроить во внутреннем DNS/Tailscale MagicDNS, например `avku-internal.<tailnet>` или отдельный приватный поддомен.
- SSL для внутреннего доступа лучше сделать через Tailscale HTTPS/Tailscale Serve либо через внутренний reverse proxy с сертификатом для приватного домена.

Плюсы:

- минимальный риск для магазина;
- не нужно трогать текущие `80/443`;
- новый проект изолирован от публичного трафика.

Минусы:

- публичный домен с Let's Encrypt так не появится без дополнительного proxy/ACME-настройки.

### Вариант B - если нужен публичный домен

Сделать отдельный edge reverse proxy, который будет единственным владельцем `80/443`, например `/home/hpelitdesk/apps/edge-proxy`.

Целевая схема:

- `edge-proxy` публикует `80:80` и `443:443`.
- `SKUFnya` и `avku-internal` остаются в отдельных Docker Compose проектах.
- `edge-proxy` подключается к отдельной external network, например `edge_net`.
- В каждый проект добавляется только внутренний upstream, доступный edge proxy.
- Сертификаты и ACME challenge централизованы в edge proxy.

Для перехода нужно аккуратно мигрировать текущий `skufnya-nginx`, потому что он сейчас занимает `80/443`. До миграции нельзя просто поднять второй proxy на тех же портах.

Компромиссный вариант без полной миграции:

- использовать текущий `skufnya-nginx` как временный edge proxy;
- подключить `skufnya-nginx` и `avku-internal-nginx` к общей external network;
- добавить отдельный `server_name` для нового домена;
- проксировать новый домен на `avku-internal-nginx:80`;
- не добавлять сервисы `avku-internal` в compose магазина.

Это быстрее, но смешивает конфигурацию магазина и несвязанного проекта. Для долгосрочной схемы лучше отдельный edge proxy.

## 7. Рекомендации по Nginx, доменам и SSL

1. Не запускать текущий `avku-internal/docker-compose.prod.yml` без изменений.
   - Он конфликтует с портом `80`.
   - Он не настраивает HTTPS.

2. Для публичного размещения использовать отдельный домен или поддомен.
   - Пример: `internal.example.com`.
   - Не размещать внутренний проект path-based под доменом магазина, если проекты не связаны.

3. В Nginx делать отдельный `server_name`.
   - Не использовать `server_name _` для production-домена.
   - Default server должен продолжать закрывать неизвестные hostnames.

4. SSL выпускать отдельно для домена нового проекта.
   - Если используется текущий certbot на хосте, после renewal нужен reload Nginx-контейнера:
     `docker exec skufnya-nginx nginx -s reload`
   - Для отдельного edge proxy лучше добавить deploy hook, который reload делает автоматически.

5. Для внутреннего проекта добавить базовые ограничения.
   - `client_max_body_size` по реальной потребности.
   - `proxy_read_timeout` и `proxy_send_timeout`.
   - security headers.
   - access logs с ротацией.

6. Если доступ публичный, добавить дополнительную защиту.
   - HTTP basic auth, SSO, VPN allowlist или хотя бы IP allowlist.
   - Rate limiting для auth/API routes.
   - Закрыть прямой доступ к API-порту.

## 8. Рекомендации по Docker Compose и автозапуску

Для `avku-internal/docker-compose.prod.yml`:

- убрать публикацию `80:80`;
- не публиковать API наружу;
- добавить `restart: unless-stopped` для всех сервисов уже есть, это хорошо;
- добавить healthcheck для `api`, `web`, `nginx`;
- добавить `init: true`, `stop_grace_period`, `security_opt: ["no-new-privileges:true"]`;
- добавить ограничение логов:
  - `driver: json-file`;
  - `max-size: "10m"`;
  - `max-file: "5"`;
- зафиксировать имя compose-проекта через `.env` или запуск:
  - `docker compose -p avku-internal -f docker-compose.prod.yml up -d --build`;
- не использовать dev compose в production, потому что он запускает `pnpm install` и Vite dev server на старте.

Автозапуск:

- Docker service уже запущен.
- `restart: unless-stopped` обеспечит автозапуск контейнеров после reboot.
- Дополнительный systemd unit для compose нужен только если требуется строгий порядок запуска или отдельные pre/post hooks. Если добавлять unit, он должен зависеть от `docker.service` и `network-online.target`.

## 9. Рекомендации по backup для нового проекта

1. До запуска production определить постоянное место данных.
   - Лучше отдельный runtime каталог с правами `700`, не смешанный с кодом.
   - Альтернатива - named Docker volume плюс отдельный backup service.

2. Настроить ежедневный backup SQLite.
   - Использовать `infra/scripts/backup-db.sh`.
   - Для SQLite лучше использовать `.backup`, а не простое копирование во время работы.

3. Проверить restore.
   - Backup без проверки восстановления нельзя считать рабочим.

4. Не начинать deployment нового проекта до исправления backup магазина.
   - Сейчас последний backup магазина упал из-за квоты Google Drive.

## 10. Рекомендуемый порядок работ

1. Исправить backup магазина.
   - Освободить или заменить Google Drive remote.
   - Проверить успешный запуск `skufnya-backup.service`.
   - Сделать тест восстановления хотя бы в отдельный каталог или временный volume.

2. Исправить права:
   - `/home/hpelitdesk/apps/avku-internal` с `707` на `750` или `700`;
   - runtime/data каталоги держать `700`;
   - `.env` и backup credentials держать `600`.

3. Выбрать режим доступа к `avku-internal`.
   - Для внутреннего проекта: Tailscale-only.
   - Для публичного проекта: отдельный домен через edge proxy.

4. Исправить `docker-compose.prod.yml`.
   - Убрать конфликтный `80:80`.
   - Не публиковать `3001`.
   - Добавить healthchecks, logging limits и security options.

5. Настроить reverse proxy.
   - В краткосрочной схеме: отдельный server block в текущем proxy или Tailscale-only публикация.
   - В долгосрочной схеме: отдельный `edge-proxy`, который владеет `80/443`.

6. Настроить SSL.
   - Выпустить сертификат для нового домена.
   - Добавить автоматический reload proxy после renewal.

7. Запустить staging-проверку.
   - `docker compose -p avku-internal -f docker-compose.prod.yml config`
   - `docker compose -p avku-internal -f docker-compose.prod.yml up -d --build`
   - проверить health endpoints;
   - проверить, что магазин по `api.skufnya.com` не изменился;
   - проверить доступность нового домена только из нужной сети.

8. Добавить monitoring/alerts.
   - disk usage;
   - Docker container health;
   - backup success/failure;
   - certbot renewal;
   - memory/swap.

## 11. Итог

Текущий магазин развернут достаточно изолированно внутри Docker Compose: базы и Redis не опубликованы наружу, публичные порты держит один Nginx-контейнер. Новый проект нельзя запускать текущим production compose без изменений, потому что он попытается занять порт `80` и не имеет отдельной HTTPS-схемы.

Оптимальный путь: отдельный compose-стек `avku-internal`, без публикации API и без захвата `80/443`; доступ через Tailscale-only для внутреннего использования или через отдельный edge reverse proxy для публичного домена. Перед deployment обязательно исправить backup магазина и права на каталог `avku-internal`.
