# План Фазы 2: привязка Google-аккаунта к сотруднику в avku-internal

Статус: ПЛАН, код не написан, ничего не применено. Реализуется после запуска
туннеля (Фаза 1) и по отдельному подтверждению, т.к. требует правки
`infra/nginx/app.conf` и пересборки контейнера api.

## Зачем нужна Фаза 2

Фаза 1 (Cloudflare Access) уже полностью закрывает frontend и /api от
неавторизованных. Фаза 2 добавляет:

1. Backend знает, КТО работает (проверенный email из JWT, а не аноним).
2. Защита от подделки заголовков (defense-in-depth).
3. Таблица employees — основа для будущих ролей и аудита.
4. /api/me и кнопка Logout в UI.

## Принцип проверки: только JWT, не email-заголовок

Cloudflare Access добавляет к каждому запросу через туннель:

- `Cf-Access-Jwt-Assertion` — подписанный JWT (RS256);
- `Cf-Access-Authenticated-User-Email` — простой текстовый заголовок.

Доверять можно ТОЛЬКО JWT: подпись проверяется по публичным ключам
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, значит подделать
его нельзя даже при прямом доступе к origin. Email-заголовок сам по себе —
просто строка, его подделает любой `curl -H`. Email берём из claim `email`
проверенного JWT.

Проверки токена:
- подпись по JWKS (кэшировать ключи, обновлять раз в ~1 час);
- `aud` == AUD-тег Access-приложения (Zero Trust → Access → Applications →
  avku-internal → Overview → Application Audience (AUD) Tag);
- `iss` == `https://<team>.cloudflareaccess.com`;
- `exp` / `nbf`.

Библиотека: `jose` (без нативных зависимостей, TypeScript, ~0 конфигурации).
Единственная новая прод-зависимость api.

## Два режима запроса: туннель и LAN

| Источник | Признак | Поведение |
|---|---|---|
| Cloudflare Tunnel | есть валидный `Cf-Access-Jwt-Assertion` | пропустить, извлечь email, upsert employee |
| LAN (192.168.0.151:18080) | JWT нет | пропустить как доверенный локальный доступ (текущее поведение) |
| JWT есть, но невалиден | подпись/aud/exp не сошлись | 401 |

Против подделки «пустого» случая (злоумышленник в LAN шлёт свой
`Cf-Access-*`) — nginx затирает эти заголовки на LAN-входе (см. ниже),
а из интернета до origin вообще нет пути (порт привязан к LAN-IP).
Дополнительно middleware отвергает запрос, где email-заголовок есть,
а валидного JWT нет.

Конфигурация через env (в `.env`):

```
AVKU_ACCESS_TEAM_DOMAIN=avku.cloudflareaccess.com
AVKU_ACCESS_AUD=<aud-тег приложения>
```

Если переменные не заданы — middleware выключен, поведение как сейчас
(безопасно: внешний трафик всё равно закрыт Access'ом на Cloudflare).

## Изменения по файлам

### Новые файлы (api)

- `apps/api/src/http/access-auth.ts`
  Middleware: разбор и проверка `Cf-Access-Jwt-Assertion` через `jose`
  (createRemoteJWKSet + jwtVerify), результат — `{ email } | null (LAN)`,
  либо HttpError 401.

- `apps/api/src/modules/employees/employee-records.ts`
  Репозиторий по образцу существующих модулей. SQLite-таблица:

  ```sql
  CREATE TABLE IF NOT EXISTS employees (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    name       TEXT,
    first_seen TEXT NOT NULL,   -- ISO-8601
    last_seen  TEXT NOT NULL
  );
  ```

  Файл БД: `/data/employees/employees.sqlite` (на хосте —
  `runtime/data/employees/`, рядом с certificates/warehouse/logistics;
  бэкапится тем же механизмом, что и остальные).

  JIT-provisioning: при первом валидном JWT с новым email — INSERT,
  при повторных — UPDATE last_seen. Отдельного «создания пользователя»
  не нужно: allowlist уже проверил Cloudflare. Первый сотрудник появится
  автоматически при первом входе alner4245877@gmail.com.

- `apps/api/src/routes/employees.ts`
  - `GET /api/me` → `{ email, name, firstSeen }` для запроса с JWT;
    для LAN-запроса → `{ email: null, local: true }`.
  - (опционально позже) `GET /api/employees` — список для админа.

### Изменяемые файлы

- `apps/api/src/server.ts` — вызов access-auth перед dispatchRequest,
  маршрут `/api/me`, прокидка employeeRepository.
- `apps/api/src/config.ts` — createEmployeeRepository, чтение
  AVKU_ACCESS_TEAM_DOMAIN / AVKU_ACCESS_AUD.
- `apps/api/package.json` — зависимость `jose`.
- `infra/nginx/app.conf` — гигиена заголовков: nginx на LAN-входе затирает
  клиентские Cf-заголовки, чтобы их нельзя было подделать из локальной сети:

  ```nginx
  # внутри location /api/ и location /
  proxy_set_header Cf-Access-Jwt-Assertion "";
  proxy_set_header Cf-Access-Authenticated-User-Email "";
  ```

  Примечание: cloudflared ходит в `nginx:80`, т.е. через тот же server-блок.
  Чтобы не затереть заголовки туннельного трафика, добавляется ВТОРОЙ
  server-блок `server_name avku.<домен>;` без затирания (запросы из туннеля
  приходят с Host = avku.<домен>, запросы из LAN — с Host = 192.168.0.151).
  Итоговая схема:

  ```nginx
  # server-блок 1: server_name avku.<домен>  — трафик из туннеля,
  #   Cf-заголовки пропускаются как есть (их выставил Cloudflare).
  # server-блок 2: default_server (_)        — LAN,
  #   Cf-заголовки затираются.
  ```

- `.env` — две новые переменные (см. выше).

### Frontend (опционально, отдельным шагом)

- `apps/web`: запрос `GET /api/me` при загрузке; если `email != null` —
  показать email и кнопку «Выйти» → переход на
  `https://avku.<домен>/cdn-cgi/access/logout`.
  В LAN-режиме (`local: true`) ничего не показывать.

## Logout

- Основной механизм: `https://avku.<домен>/cdn-cgi/access/logout`
  (завершает сессию Cloudflare Access; своих сессий у приложения нет,
  поэтому этого достаточно).
- Session Duration в Access-приложении ограничивает время жизни сессии
  (рекомендация: 24 часа).
- Принудительный logout сотрудника: Revoke sessions в Zero Trust.

## Порядок внедрения (после подтверждения)

1. Код: access-auth.ts, employees, /api/me, правки server.ts/config.ts,
   тесты в `apps/api/src/__tests__`.
2. Правка `infra/nginx/app.conf` (двухблочная схема).
3. `.env`: добавить AVKU_ACCESS_TEAM_DOMAIN и AVKU_ACCESS_AUD.
4. Пересборка ТОЛЬКО своего проекта:
   `docker compose -p avku-internal -f docker-compose.prod.yml up -d --build api nginx`
   (SKUFnya не затрагивается; проверка `grep skufnya` до и после).
5. Проверки:
   - LAN: `curl http://192.168.0.151:18080/api/me` → `{"email":null,"local":true}`;
   - LAN c поддельным заголовком:
     `curl -H "Cf-Access-Authenticated-User-Email: fake@x.com" http://192.168.0.151:18080/api/me`
     → email по-прежнему null (заголовок затёрт nginx);
   - Внешне после Google-входа: `/api/me` → ваш email;
   - `bash scripts/verify-access.sh avku.<домен>`.

## Откат Фазы 2

- `git checkout` правок + пересборка api/nginx тем же compose-проектом.
- Данные employees в `runtime/data/employees/` при откате не удаляются
  и ничему не мешают.

## Риски, остающиеся после Фазы 2

- Ролей нет: любой сотрудник из allowlist может всё, что умеет приложение.
  Таблица employees — задел под роли (можно добавить колонку role).
- LAN остаётся доверенным по решению владельца: любой в домашней сети
  имеет полный доступ без логина.
- Компрометация Google-аккаунта сотрудника = доступ (митигируется 2FA).
