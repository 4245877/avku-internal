# Диагностика переключения фотографий

Исправление находится в `apps/web/src/features/certificates/usePhotoImage.js`.
При смене удостоверения прежняя загрузка отменяется через AbortController,
проверка актуальности результата не позволяет старому кадру заменить новый,
object URLs освобождаются. Отмена освобождает соединения браузера и предотвращает
очередь из брошенных фото при быстром переключении.

Оба набора тестов актуальны и сохранены: unit проверки и браузерная диагностика
покрывают разные уровни. `PhotoCropper` проверяет редактор кадрирования отдельно.
Старые JSON network traces с реальными ФИО/UUID и development screenshot/logs
удалены из исходников; приватные оригиналы есть в audit source archive.

## Локальная проверка

Используйте Node 22, зависимости из lockfiles и Chromium/Playwright 1.56.0.
Сценарии переключения фото читают данные и ничего не создают/не удаляют:

```bash
cd apps/web
AVKU_E2E_BASE_URL=http://192.168.0.151:18080 \
  pnpm exec playwright test --config playwright.config.js --project chromium
```

`certificates-photo-switching.spec.js` проверяет повторное переключение,
разные задержки и соответствие последней выбранной записи. Recorder сохраняет
network evidence в ignored `e2e-results/`; эти файлы могут содержать ФИО/UUID.
Не публикуйте traces, screenshots и отчёты с реальными удостоверениями.

## Cloudflare

Для отдельного tunnel-сценария нужна действующая Access-сессия. Получить её
интерактивно на доверенной workstation и сохранить **вне репозитория**:

```bash
pnpm exec playwright open --save-storage="$HOME/.avku-access.storageState.json" \
  https://internal.avku.org/certificates
AVKU_E2E_BASE_URL=https://internal.avku.org \
AVKU_E2E_STORAGE_STATE="$HOME/.avku-access.storageState.json" \
  pnpm exec playwright test --config playwright.config.js --project chromium
```

Без `AVKU_E2E_STORAGE_STATE` Cloudflare test пропускается: это отсутствие
интерактивной identity, а не доказательство исправности внешнего входа.
Deploy/rollback выполняется по [operations.md](operations.md), с полной
production-композицией и закреплёнными image tags.
