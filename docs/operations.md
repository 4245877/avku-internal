# Эксплуатация AVKU Internal

## Production и данные

Рабочий каталог: `/home/hpelitdesk/apps/avku-internal`.
Стек: `docker-compose.prod.yml` + `docker-compose.backup.yml` +
`docker-compose.release.yml`, проект `avku-internal`.
Последний файл закрепляет все три image tags и release ID сборки API/worker.
`backup.release`/`shutdown` оставлены как совместимые обёртки для установленного
systemd lifecycle unit; они используют ту же release.yml без повторения tags.
Не запускайте один prod.yml поверх рабочего стека: он не подключает worker/config.

API монтирует `/var/lib/avku-internal/data:/data`; web не имеет data mount.
Worker монтирует только `~/.local/share/avku-certificate-backups/{jobs,staging}` и
RO SSH secrets из `~/.config/avku-certificate-backup/`, без `/data`/Docker socket.
Cloudflare connector — отдельный проект `avku-cloudflared`. Другие приложения
этого сервера не входят в операции обновления AVKU.

`storage/` в checkout содержит старые локальные данные и приватные копии.
Не удалять его как cache. Templates в `storage/certificates/templates` версионируются
и входят в API image; редакторские template assets Web нужны отдельно браузеру.
Это разные runtime-потребители, а не лишние дубликаты.

## Порядок обновления

1. Проверить Git diff и содержимое текущих images. Сохранить image IDs/tags,
   `docker inspect` и разрешённую Compose-конфигурацию в каталог 0700.
   Вывод `compose config` и inspect содержит env/secrets: не публиковать.
2. Сделать online backup всех пяти БД и архивов штатным `backup-db.sh`.
   На хосте нужен sqlite3 либо Node 22. При Node 20 использовать runtime image:

```bash
# Подготовить принадлежащий текущему пользователю закрытый BACKUP_ROOT заранее.
docker run --rm --network none --user 1000:1000 --entrypoint sh \
  -v /var/lib/avku-internal/data:/data:ro \
  -v "$PWD/infra/scripts:/scripts:ro" \
  -v "$PWD/storage/backups:/backups" \
  -e DATA_ROOT=/data -e BACKUP_ROOT=/backups \
  avku-internal-api:audit-20261027 /scripts/backup-db.sh
```

3. Восстановить копию через `restore-db.sh` в новый изолированный каталог.
   Проверить `integrity_check`, `foreign_key_check`, число записей/телефонов,
   ссылки и hashes фото. Запустить API storage check на копии. Production путь
   в тестовый контейнер не монтировать.
4. Выбрать новый уникальный release tag, обновить tags/build args release.yml
   вместе. Выполнить build и тесты до остановки production:

```bash
docker compose -p avku-internal \
  -f docker-compose.prod.yml -f docker-compose.backup.yml \
  -f docker-compose.release.yml build api web backup-worker
```

Полная сборка включает исходники API, актуальные recovery Web sources,
шаблоны и lockfiles. Замены файлов в готовых образах не требуются.
Base Node/nginx закреплены digest; lockfiles устанавливаются frozen.
Debian apt packages берутся из настроенного Debian mirror: побитовая
идентичность будущих apt layers не гарантируется. Проверяем функциональную
воспроизводимость из исходников, а не обещаем детерминированный tar образа.

5. Запустить новую версию на копии данных и localhost, проверить API/UI,
   редактирование/NULL телефона, draft activation, UK/EN PNG/PDF и duplex A4.
   Проверить ручной backup/capture/restore на synthetic данных.
6. Перед cutover проверить отсутствие активной backup job. Сохранить последнюю
   online копию и прежние image tags. Обновить только три сервиса:

```bash
docker compose -p avku-internal \
  -f docker-compose.prod.yml -f docker-compose.backup.yml \
  -f docker-compose.release.yml up -d --no-build --pull never --no-deps \
  --wait --wait-timeout 120 api web backup-worker
# Nginx повторно разрешает адреса пересозданных upstream:
docker exec avku-internal-nginx-1 nginx -t
docker exec avku-internal-nginx-1 nginx -s reload
```

Grace period API — 60 секунд, worker — 600; API дожидается принятого capture,
worker — активной операции. `flock -F` передаёт SIGTERM worker непосредственно.
`down -v`, volume prune и удаление data directories для обновления не нужны.

7. Проверить health всех сервисов и LAN nginx, все записи/телефоны, логи,
   существующий backup inventory и повторный запуск. В production не создавать
   тестовые удостоверения: операции записи проверяются на копии.

## Откат и восстановление

Для аудита 27 октября сохранены:

- `avku-internal-api:rollback-audit-20261027` → прежний phones image;
- `avku-internal-web:rollback-audit-20261027` → прежний phones image;
- `avku-internal-backup-worker:rollback-audit-20261027` → прежний worker;
- `storage/backups/project-audit-20261027/compose-before.private.yml` — полная
  рабочая композиция до изменений;
- `containers-before.private.json`, `source-before.tar.gz`, SQLite snapshots,
  полный backup с фото и проверенное восстановление.

При ошибке release использовать сохранённую композицию:

```bash
docker compose -p avku-internal \
  -f storage/backups/project-audit-20261027/compose-before.private.yml \
  up -d --no-build --pull never --no-deps --wait api web backup-worker
docker exec avku-internal-nginx-1 nginx -s reload
```

Откат образов не требует восстановления БД: схема этого release совместима.
Не заменять актуальную базу старым snapshot: это потеряло бы поздние записи.
Если повреждены именно данные, остановить writers, сохранить текущее состояние
и отдельно восстановить заранее проверенный dataset. `restore-db.sh` удаляет
старые WAL/SHM и требует полной копии соответствующего формата.
Ручные certificate archives format 3 восстанавливаются через
[restore.ts](../infra/certificate-backup/README.md), а не общий shell restore.

## Границы проверки

Cloudflare Access проверяется отдельно с интерактивной сессией оператора;
LAN smoke test не доказывает успешный Google-вход. Receiver configuration и
ZFS quota не изменяются обычным redeploy. Реальные remote slots нельзя
ротировать повторными synthetic тестами; используйте изолированный receiver.
Сохранённый worker image archive нужен для isolated disaster recovery;
если меняется release, обеспечьте отдельную защищённую копию runtime вне
production-хоста по инструкции backup guide.

## Запуск и остановка вместе с Docker

Установленный `/etc/systemd/system/avku-internal-lifecycle.service` сначала
останавливает ingress/tunnel, затем API (с drain принятого capture) и worker.
Он использует старые имена overrides, поэтому `backup.release.yml` теперь
ссылается через `extends` на единую release.yml, а `shutdown.yml` — пустая
совместимая обёртка. Их нельзя удалять, пока установленный unit использует эти
пути. Разрешённые Compose-модели старого и нового входа проверены на равенство.

Готовый unit с прямой стандартной командой находится в
`infra/systemd/avku-internal-lifecycle.service`. Для установки нужен root/sudo;
в ходе аудита `sudo -n` потребовал интерактивную авторизацию, поэтому системный
файл оставлен прежним. Безопасная последующая установка из admin session:

```bash
sudo install -o root -g root -m 0644 infra/systemd/avku-internal-lifecycle.service \
  /etc/systemd/system/avku-internal-lifecycle.service
sudo systemd-analyze verify /etc/systemd/system/avku-internal-lifecycle.service
sudo systemctl daemon-reload
systemctl show avku-internal-lifecycle.service -p ExecStart -p ExecStop
```

Перезапускать lifecycle unit для применения определения не нужно: его stop
останавливает рабочее приложение. Исходный unit сохранён в audit backup.
Прежние stop timeouts сохранены; полного reboot/Docker-daemon restart этот
аудит не выполняет. После root-миграции и проверки отсутствия внешних ссылок
две compatibility wrappers можно удалить отдельно.
