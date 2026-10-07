# Ручное резервное копирование удостоверений AVKU

Production: `192.168.0.151`. Приёмник: `chieftec`, `192.168.0.137:22`.
Единственное хранилище: ZFS `backup/avku-internal`, `/srv/backup/avku-internal`.
Этот документ описывает реализованный код и установку. Он не подтверждает состоявшийся production rollout: см. итоговый отчёт и его verdict.

## Состав и согласованность

Кнопка сохраняет весь реестр, включая active и draft. Сохранённый SQLite snapshot содержит все столбцы, индексы и ограничения; отдельно включаются только фотографии, на которые он ссылается. UK/EN layout/background/stamp, все установленные TTF resources, фактические font resolutions, восстановительный fontconfig, source API и Web, dependency lockfiles и несекретные Docker/nginx build resources входят в архив. Это сохраняет и production UI с черновиками из dirty worktree. Generated PNG — воспроизводимый cache; архив не включает его, старые backup, `.env`, ключи и токены.

Все create/update/activate/renew/remove проходят через один gate repository, включая SQL transaction, rename нового фото и удаление старого. Capture входит в тот же gate, делает `node:sqlite.backup()` и копирует фото из snapshot и templates. После capture gate освобождается. Fonts/source — immutable image resources, их можно копировать без блокирования реестра. Развёртывание поддерживает один экземпляр API; масштабирование API требует общего межпроцессного gate перед вводом второго writer.

Нельзя заменять этот механизм копированием live SQLite файла в WAL. Поведение Backup API описано в [Node SQLite documentation](https://nodejs.org/download/release/v22.23.1/docs/api/sqlite.html#sqlitebackupsource-db-destination-options).

## Поток

1. Используется общая авторизация приложения: проверенный Access JWT либо существующий доверенный LAN-вход. Отдельных backup-ролей и email allowlist нет. Внешний Host без identity запрещён, LAN Host должен соответствовать настроенному локальному origin. POST требует точный Origin, JSON, `X-Avku-Backup: manual` и UUID `Idempotency-Key`.
2. SQLite job store с FULL synchronous и partial unique index принимает один active job. Ответ `202` означает только принятие, а не успех.
3. API асинхронно формирует capture в `/staging/<uuid>/payload`. Worker не имеет mount production `/data` или Docker socket.
4. Worker проверяет manifest/checksums/SQLite/photos/templates, создаёт tar.gz, безопасно распаковывает уже упакованный архив и проверяет его содержимое повторно.
5. Artifact — обычный `tar.gz`, manifest format 3, без прикладного шифрования и без recovery key. SHA-256 всего проверенного архива фиксируется до передачи. SSH шифрует транспорт.
6. SFTP: `<uuid>.partial`, transport metadata во временном marker, atomic rename marker в `<uuid>.ready` последним.
7. `systemd.path` запускает root publisher. Он проверяет mount/realpath/ownership, держит flock, открывает только regular/no-follow/single-link файлы, проверяет size/SHA-256, копирует candidate в root-only `.candidates`, проверяет gzip CRC, безопасные tar members, manifest и SHA-256 каждого файла без root extract.
8. Publisher fsync записывает reservation с server generation и ожидаемым checksum; затем `os.replace()` атомарно заменяет один slot. Другой slot сохраняется. Файл и директории fsync; durable receipt/catalog подтверждают commit.
9. Worker ждёт durable receipt с совпадающими job ID, size, SHA-256, slot, committedAt и явным `cleanupPending=false`. Затем сверяет тот же job/hash/size/slot/generation с каталогом slots, также с `cleanupPending=false`. Между atomic writes receipt и catalog он продолжает ожидание только текущего manual job. После подтверждения обновляет inventory и безопасно очищает свой job namespace. Только после этого — `succeeded`; ACK loss или неподтверждённый catalog сохраняют job для reconciliation без повторной ротации.

Manifest внутри архива: format/schema/runtime/release, actor, UTC snapshot, job ID, counts active/draft/total/photos, templates, font resolutions, каждый файл с size/SHA-256, recovery paths. Root-owned receipts/catalog содержат только job ID, UTC snapshot, format, size/hash, slot, generation и timestamps. Они нужны для проверки и reconciliation; personal data и actor остаются внутри защищённого архива.

## Retention 2

Завершённые файлы исключительно `slots/slot-1` и `slots/slot-2`. В начале заполняются свободные slots; затем заменяется slot с меньшим **server generation**. Порядок не зависит от часов production. Reservation fsync до replace позволяет восстановить receipt после crash/ACK loss. Перед ротацией оба существующих artifact сверяются с исходными durable receipts; повреждение старой копии блокирует ротацию.

Во время операции физически существуют два old slot, пользовательская incoming загрузка и root-only проверяемая копия candidate. Это необходимые временные данные, не дополнительные опубликованные версии. Старый slot не удаляется заранее. ZFS snapshots AVKU и Sanoid запрещены.

Root cleanup failure отмечается `cleanupPending`; worker оставляет `needs_attention`, блокируя следующий job. Cleanup никогда не обходит UUID namespace и не следует за symlink/hardlink. Остаток без ready не публикуется. При неизвестном результате SSH предыдущий job продолжается/reconciles; новый job не создаётся.

## Секреты и права

На `.151`, вне Git:

```
/home/hpelitdesk/.config/avku-certificate-backup/       0700
  id_ed25519                                       0600
  id_ed25519.pub
  known_hosts                                      0600
  runtime.env                                      0600
/home/hpelitdesk/.local/share/avku-certificate-backups/
  jobs/                                            0700
  staging/                                         0700
```

Worker получает secrets RO, jobs/staging RW, read-only root filesystem, без capabilities и отдельный Docker bridge для SSH transport. Он не подключается к сети API или других приложений. API получает только jobs/staging и несекретную конфигурацию. SSH private key ему не монтируется. Encryption key не нужен и не монтируется ни одному backup-компоненту.

Pinned host: `SHA256:yOkFAxawvrMrmUDuqQoxK8LYGzSdcmZua5fyfbicqBQ`. Только ED25519 host key, StrictHostKeyChecking=yes, agent/password/interactive auth выключены. Нельзя заменять pin автоматическим trust или `StrictHostKeyChecking=no`.

Dedicated receiver `avku-backup`: system/nologin/locked password, только primary group, без sudo/lxd/docker/ZFS delegation. Источник только `.151`; publickey только bare ED25519; no PTY/forwarding/tunnel/user rc. Internal SFTP chroot root-owned и не writable пользователю. Incoming 0700 принадлежит dedicated user. Status root-owned 0750/0640, group avku-backup может только читать. Slots расположены **вне chroot**, root-owned 0750/0640 с group miha: владелец может скачать архив с доверенной рабочей станции, production account не может читать/менять slots. Root-only `.candidates` 0700.

Publisher явно задаёт status files режим 0640 через `fchmod`, независимо от umask установщика. После первой установки требуется проверить чтение `/status/slots.json` именно dedicated SFTP user; проверки root stat недостаточно.

Ограничения используются только для AVKU; Lite-Forest не меняется. Технические средства OpenSSH описаны в [sshd_config](https://man.openbsd.org/sshd_config).

## Установка `.137` из административной сессии владельца

Пакет готовится в `/home/miha/avku-backup-install`, public key отдельно от репозитория. Сверить public fingerprint и SHA-256 установочных файлов с `.151` перед запуском. Нужна действующая интерактивная sudo авторизация; пароль не передавать через чат или args.

```bash
cd /home/miha/avku-backup-install
ssh-keygen -lf id_ed25519.pub
sudo bash ./install.sh /home/miha/avku-backup-install/id_ed25519.pub
```

Установщик проверяет mount до создания структуры, выделенный UID/groups/shell, задаёт exec/setuid/devices=off, atime=off, compression=zstd, устанавливает profile и publisher, выполняет `sshd -t`/effective config и unit verify. Reload ssh, enable только `.path`; timer не создаётся. После установки проверить effective source restriction для `.151` и другого IP, groups/password lock, `zfs allow`, LF baseline, SFTP upload/status и запреты slots/shell. Нельзя продолжать rollout при любом failed check.

После первого **реального ручного** backup измерить полный архив и применить ограничение pool usage:

```bash
sudo bash ./set-quota.sh <измеренный-размер-artifact-в-байтах>
```

Предложена quota 128 GiB: запас сверх четырёх временных artifact при protocol limit 16 GiB каждый, около 15% доступного пула на момент baseline. Это защищает pool от incoming abuse. Пересматривать quota и protocol/local-space limits при росте; не использовать размер синтетического теста для измерения production backup. Quota до реального измерения не применяется.

## Настройка и rollout `.151`

`runtime.env` содержит только nonsecret config. После проверки dedicated SSH включить ручной backup:

```dotenv
CERTIFICATE_BACKUP_ENABLED=true
CERTIFICATE_BACKUP_STATE=/jobs
CERTIFICATE_BACKUP_STAGING=/staging
CERTIFICATE_BACKUP_ORIGINS=https://internal.avku.org,http://192.168.0.151:18080
```

Origin — точный URL browser origin, без trailing slash. Существующие AVKU_ACCESS_TEAM_DOMAIN/AUD в `.env` сохраняются. Для доверенного LAN без индивидуальной identity аудит использует `trusted-local`. Не доверять unsigned email header.

Собрать все candidate images с одним release ID, прогнать tests, сверить source digest. До rollout сохранить текущие image IDs и Git baseline. Использовать только проверенные images; API build target `runtime`, worker `backup-worker`. `docker-compose.backup.yml` — обязательный override при последующих production deployments:

```bash
export AVKU_BACKUP_RELEASE=<проверенный-versioned-release>
docker compose -p avku-internal -f docker-compose.prod.yml -f docker-compose.backup.yml -f docker-compose.backup.release.yml up -d --no-build --pull never --wait api backup-worker web
docker compose -p avku-internal -f docker-compose.prod.yml -f docker-compose.backup.yml -f docker-compose.backup.release.yml exec nginx nginx -s reload
```

Проверить health, LAN registry/templates/photos, Cloudflare identity, доступный LAN backup, запрет анонимного внешнего backup, snapshot counts, PNG/PDF/duplex без production CRUD. Затем три ручных UI backup, реальные 2 slots, fault до commit и restore обеих versions. Rollout считается завершённым только после этих проверок.

После работающего dedicated SFTP и publication убрать **только** public key `.151` из administrative miha authorized_keys. Перед удалением открыть и проверить независимую сессию владельца с доверенной workstation. Сохранять Windows key и другие строки/options буквально. Не удалять administrative key раньше dedicated checks. Production операции больше не используют miha или Windows посредника.

## Восстановление без ключа

Новый manual certificate backup не зависит от `encryption_key`, vault или офлайн-копии секрета. Администратор `.137` может взять любой retained `slot-N`, сверить SHA-256 с root-owned catalog и восстановить архив в отдельном namespace. Потеря `.151` не лишает архивы возможности восстановления. SSH private key нужен только для передачи; для локального чтения/restore администратором он не нужен. Backup содержит персональные данные в открытом виде на диске, доступ ограничен filesystem permissions и административным доступом chieftec. Файлы нельзя публиковать в web, чат или публичные хранилища.

Для восстановления после полной потери `.151` архив содержит API/Web source, lockfiles, templates/fonts и build resources. До закрытия задачи следует сохранить matching worker runtime на `.137`: `.runtime/<release>.worker.tar` и `.sha256`, root-owned 0640, вне chroot. Runtime не содержит production данные/секреты и не считается третьей backup-версией. Его SHA-256 надо проверить, затем `docker load -i` на isolated recovery-host. Recovery-артефакты этого manual workflow версии 3 не совместимы с ранее созданными synthetic AES envelopes версии 2.

## Restore/verify

1. С доверенной workstation подключиться к miha@chieftec с pinned host. Скачать **один выбранный** `slots/slot-N` напрямую через SFTP и соответствующий root-owned status/catalog; дополнительный export artifact на `.137` не создавать.
2. Взять transport SHA-256 из проверенного catalog/receipt. Проверить его до распаковки.
3. Подготовить matching worker image/release , только isolated directories и localhost; никаких production mounts, Docker socket или API с production environment.
4. Запустить `restore.ts` с artifact, ожидаемым SHA-256 и новым staging directory. Например внутри isolated worker container:

```bash
node --import tsx src/modules/certificate-backups/restore.ts \
  /recovery-input/slot-1 <ожидаемый-sha256> /recovery-output/new-unique-directory
```

Tool отказывается от существующего destination, symlink parent и production DATA_ROOT. Он проверяет transport SHA-256, gzip/tar и manifest format 3, запрещает absolute/.. paths, symlink/hardlink и special files, ограничивает entries/expanded size. Проверяет внутренние hashes, DB integrity/foreign keys/schema, counts/photo references, декодирование всех фото, UK/EN assets, font file SHA. Создаёт `recovery-context/` с исходными Docker COPY paths, entrypoint, extractor, web public resources и lockfiles. Проверка реестра, draft, UK/EN PNG/PDF и duplex использует **сохранённый в архиве API source** и зависимости matching worker image, а не текущий Git worktree. Payload не изменяется. Не менять live certificates.

5. Повторить для второго slot. Сохранять отчёт и job ID, не содержимое БД/фото/ключ.
6. Production restore — отдельная административная операция после проверки staging: остановить API writers, подготовить новый certificates namespace с verified DB/photos, matching templates/fonts/release, UID/GID; сохранить текущие данные вне операции cutover по отдельному плану; установить validated dataset единым переключением; WAL/shm от старой БД не переносить. Проверить health/registry/export и открыть API. Не выполнять production restore в ordinary test.

Legacy `restore-db.sh` не читает certificate archive format 3; его нельзя использовать для этого artifact.

## Interrupted/needs_attention

Capture restart не продолжается из полусформированного snapshot: безопасное cleanup и interrupted. Уже captured manual job может быть продолжен worker. Upload ACK loss: receipt с тем же UUID/SHA/size даёт reconciliation без второй ротации. Не выставлять succeeded вручную и не удалять active row из SQLite.

Для ручного reconcile существующего job остановить обычный worker, запустить одноразовый worker (тот же flock), затем вернуть обычный:

```bash
export AVKU_BACKUP_RELEASE=<развёрнутый-проверенный-release>
docker compose -p avku-internal -f docker-compose.prod.yml -f docker-compose.backup.yml -f docker-compose.backup.release.yml stop backup-worker
docker compose -p avku-internal -f docker-compose.prod.yml -f docker-compose.backup.yml -f docker-compose.backup.release.yml run --rm --no-deps backup-worker \
  node --import tsx src/modules/certificate-backups/manage.ts reconcile <uuid>
docker compose -p avku-internal -f docker-compose.prod.yml -f docker-compose.backup.yml -f docker-compose.backup.release.yml up -d --no-build --pull never backup-worker
```

Для remote cleanup error после устранения filesystem проблемы администратор вручную запускает `sudo systemctl start avku-backup-publish.service`; это не создаёт backup. Mount mismatch исправлять монтажом нужного dataset, а не созданием fallback directories. Только затем reconcile job.

## Проверки и отсутствие расписания

`test_publisher.py` — retention, corruption, partials, symlink, space, mount mismatch, ACK crash, generation/clock drift. `test_extract.py` — dangerous members. API backup tests — WAL/file gate, idempotency, auth/CSRF, keyless archive, missing photos, restart, SSH uncertainty, cleanup escape, restore. Web tests — manual/confirmation/disabled/reload/results.

`certificate-backup-isolated-e2e.ts`, `isolated_receiver.py`, `browser-e2e.mjs` и `ssh-lab.Dockerfile` — **только synthetic tests**. Test receiver симулирует mount check и никогда не устанавливается как production publisher. Production install берёт исключительно `publisher.py` с fixed BASE и реальной mount/ownership проверкой.

Нет новых cron, timers, Sanoid policies, периодического retry или startup job insertion. `.path` завершает только manually uploaded ready. Worker `fs.watch` реагирует на готовый capture; startup/restart однократно продолжает ранее принятый manual job. `needs_attention` после неопределённого результата требует явного reconcile или рестарта worker, без периодических попыток. SQL INSERT jobs доступен только POST handler. Перед закрытием проверять и существующие root/user cron и timers обоих серверов, Sanoid includes/recursive policy и snapshots dataset; не трогать LF.

## Остаточные риски

Две копии на одном pool не защищают от потери всего backup-сервера, позднего логического повреждения или двух последовательных плохих подтверждённых snapshot. Source administrator/worker compromise может сформировать новые формально корректные плохие копии. Backup-server root может удалить архив. Manual RPO зависит от действий оператора. Ввод второго API writer без общего gate, изменение схемы без версии/tool update, отсутствие matching runtime и недостаток staging/quota требуют отдельной проверки до изменения эксплуатации.
