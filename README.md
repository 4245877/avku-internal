# AVKU Internal

Внутреннее приложение: удостоверения, склад помощи, логистика, работа по домам
«Вибори», панель мониторинга. API — Node.js 22/TypeScript с `node:sqlite`,
интерфейс — React/Vite. SMM пока хранит данные в localStorage браузера.

## Структура

- `apps/api/src/`: HTTP API, репозитории и встроенные транзакционные миграции SQLite.
- `apps/web/src/`: интерфейс, API-клиенты и тесты; `public/data/elections` — OSM snapshot.
- `storage/certificates/templates/`: версионируемые UK/EN PNG/JSON-шаблоны.
- `design/`: исходники печатного дизайна; в Docker не копируются.
- `infra/nginx/`: внешний proxy и статический web server.
- `infra/systemd/`: подготовленное определение запуска/остановки с Docker.
- `infra/scripts/`: полное резервирование/восстановление данных, опциональное шифрование.
- `infra/certificate-backup/`: ручные копии удостоверений, SFTP receiver и проверки восстановления.
- `scripts/`: обновление OSM snapshot и безопасный импорт телефонов из DOCX.
- `docs/`: [эксплуатация](docs/operations.md), [конфигурация](docs/configuration.md),
  [доступ](docs/cloudflare-access-setup.md), [«Вибори»](docs/elections.md),
  [диагностика фотографий](docs/certificates-photo-switching-investigation.md).

## Локальная разработка

Нужны Node.js **22.23.1** и pnpm **11.9.0**. На сервере системный Node 20;
для проверок используйте Node 22 в Docker. Два приложения имеют независимые
lockfiles; корневого pnpm workspace нет.

```bash
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm --dir apps/api install --frozen-lockfile
pnpm --dir apps/web install --frozen-lockfile
pnpm --dir apps/api start
# В другом терминале:
pnpm --dir apps/web dev
```

API: `http://localhost:3001/api/health`; web: `http://localhost:5173`.
Для локального Docker: `docker compose up --build`.
Development использует отдельный named volume `app-data`, не production bind mount.
Локальный proxy учитывает dev-порт web 5173.

## Production

Единственная стандартная композиция для production включает API, статический
web, nginx и изолированный backup worker:

```bash
docker compose -p avku-internal \
  -f docker-compose.prod.yml -f docker-compose.backup.yml \
  -f docker-compose.release.yml config --quiet
```

`docker-compose.release.yml` закрепляет проверенные версии всех трёх образов.
Подробный порядок сборки, проверки, обновления и отката —
[docs/operations.md](docs/operations.md). Перед обновлением создайте проверенную
копию данных. Cloudflare Tunnel работает отдельным Compose-проектом.

Production данные находятся в **`/var/lib/avku-internal/data`**, в API это `/data`:
`certificates`, `warehouse`, `logistics`, `elections`, `employees`.
Они сохраняются при пересоздании контейнеров. Репозиторный `storage/` не является
рабочим production-хранилищем. Старые локальные базы/фото и backups сохранены;
их нельзя удалять как build cache.

API после подготовки прав запускается через `gosu node`. Web — статический nginx
без репозитория, секретов и Node.js. Worker не имеет production `/data` или Docker
socket; jobs/staging и SSH credentials находятся вне репозитория.

## Удостоверения и телефоны

Статус записи — `draft` или `active`, отдельно от срока действия. Черновику
достаточно ФИО и уникального номера; даты и фото могут быть SQL `NULL`.
Сохранение не активирует черновик: полную запись оформляют отдельной операцией
`PATCH /api/certificates/:id/activate`. Черновики нельзя печатать, экспортировать
или продлевать. Старые записи остаются `active`.

Миграции находятся в репозиториях TypeScript и выполняются при открытии БД;
удостоверения используют `PRAGMA user_version=4`. Совместимое необязательное
`phone_number TEXT NULL` добавляется идемпотентно по наличию столбца без изменения
базовой версии протокола резервирования. API-свойство — `phoneNumber`.
JSON и multipart поддерживают добавление, изменение и очистку; пустая строка
и `null` сохраняются как SQL `NULL`, пропущенное поле сохраняет прежний телефон.
Телефоны доступны только во внутреннем редакторе; PNG/PDF/duplex A4 их не содержат.

«Волонтерська команда» и «Посада» — независимые необязательные текстовые поля
редактора и реестра. API: `volunteerTeam` и `position`; SQLite:
`volunteer_team TEXT NULL`, `position TEXT NULL`. Колонки добавляются тем же
идемпотентным расширением v4: существующие записи получают NULL без изменения
остальных данных. JSON/multipart поддерживают заполнение, изменение и очистку;
пропущенное поле сохраняет прежнее значение, пустая строка/пробелы/`null` очищают
его. Реестр отображает заполненные значения и учитывает их при поиске.
Поля не меняют печатные шаблоны и экспорт удостоверений.


Импортёр не требует дополнительных Python-пакетов:

```bash
python3 scripts/import-certificate-phones.py \
  --document 'список виданих посвідчень (2).docx' \
  --database /var/lib/avku-internal/data/certificates/certificates.sqlite
```

Это read-only dry run. Для применения после проверки приватного отчёта нужен
`--apply`; остановите записи на время импорта. Скрипт сначала создаёт и проверяет
online backup, затем в одной транзакции добавляет столбец/телефоны и сравнивает
все старые поля, включая timestamps. Он отказывается от неоднозначных ФИО/номеров,
неполных телефонов и перезаписи существующих значений. Несколько контактов
сохраняются через `; `. DOCX и отчёты приватны, в Git/Docker не включаются.

Контроль 27 октября 2026: **169 удостоверений, 88 телефонов, 81 NULL**.
30 строк исходного документа требуют ручной сверки; автоматические исправления
не выполнялись. Приватный отчёт:
`storage/certificates/import-reports/REPORT-2026-10-27.md`.

## Резервирование и восстановление

Полный backup пяти БД, фото, generated cache и территории:

```bash
DATA_ROOT=/var/lib/avku-internal/data \
BACKUP_ROOT=/var/backups/avku-internal ./infra/scripts/backup-db.sh
```

Нужен `sqlite3` либо Node 22 с `node:sqlite`; простой copy live SQLite недопустим.
Каждая копия самодостаточна, WAL включён, `integrity_check` обязателен.
Шифрование AES-256-GCM включается через `BACKUP_ENCRYPTION_KEY_FILE`;
ключ хранится отдельно от данных и копий с режимом 0600.

```bash
# Сначала проверить восстановление в НОВЫЙ отдельный каталог:
BACKUP_DIR=/var/backups/avku-internal/<UTC-stamp> \
RESTORE_ROOT=/tmp/avku-restore-trial ./infra/scripts/restore-db.sh
```

Для зашифрованной копии передайте тот же `BACKUP_ENCRYPTION_KEY_FILE`.
Production restore требует остановки writers и сохранения текущего состояния;
старые WAL/SHM не переносятся. См. [эксплуатацию](docs/operations.md).

Кнопка на главной странице создаёт отдельный проверяемый архив **удостоверений**
со снимком БД, referenced photos, templates/fonts и исходниками для восстановления.
SFTP-приёмник сохраняет два slot; расписания нет. Это другой формат: используйте
[специализированную инструкцию](infra/certificate-backup/README.md), а не `restore-db.sh`.

## Проверки

```bash
./infra/scripts/check-api.sh
pnpm --dir apps/web test
pnpm --dir apps/web build
python3 -B -m unittest discover -s scripts -p 'test_import_certificate_phones.py'
python3 -B -m unittest discover -s infra/certificate-backup -p 'test_extract.py'
python3 -B -m unittest discover -s infra/certificate-backup/server -p 'test_publisher.py'
```

Полный API-набор использует шрифты и immutable recovery resources: скрипт
создаёт изолированный test image и монтирует только read-only fixtures.
CI использует тот же запуск. Отдельный быстрый typecheck при Node 22:
`pnpm --dir apps/api typecheck`.

Браузерные сценарии записи запускайте только на изолированном localhost API и
тестовом DATA_ROOT: `playwright.drafts.config.js`. Проверки backup UI с mocks:
`playwright.backups.config.js`. Диагностика фото и Cloudflare — отдельные read-only
сценарии; [инструкция](docs/certificates-photo-switching-investigation.md).
`.github/workflows/ci.yml` проверяет API, UI, сборку и Python-инструменты.

## Приватность исходников

Docker context использует allowlist исходников/шаблонов. Базы, документы, фото,
backups, `.env`, ключи, Git history и локальные инструменты исключены.
Gitignore не удаляет секреты из прежних коммитов. Токен туннеля, ранее попавший
в `.env.cloudflare.example`, требуется ротировать в Cloudflare; история Git
сохраняется и не переписывается этим аудитом. Закрытые audit/rollback материалы
лежат в `storage/backups/project-audit-20261027/` (0700).

Итог выполненного аудита и redeploy: [27 октября 2026](docs/AUDIT-2026-10-27.md).
