# Конфигурация

API variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port. |
| `API_PORT` | unset | Legacy fallback for `PORT`. |
| `DATA_ROOT` | `<repo>/storage` locally, required in production | Root for runtime data. Production must set this explicitly; Docker uses `/data`. |
| `CERTIFICATES_STORAGE_ROOT` | `$DATA_ROOT/certificates` | Certificate SQLite DB, photos and generated files. |
| `CERTIFICATES_TEMPLATES_DIRECTORY` | `<repo>/storage/certificates/templates` | Multi-template certificate catalog. |
| `CERTIFICATES_DEFAULT_TEMPLATE_ID` | `volunteer-card-v1-uk` | Default certificate template. |
| `CERTIFICATES_LEGACY_REGISTRY_PATH` | `$CERTIFICATES_STORAGE_ROOT/registry.json` | Optional legacy JSON registry for one-time migration into SQLite. |
| `CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR` | unset | Legacy single-template override. When set, only the default template is served. |
| `CERTIFICATES_TEMPLATE_DIRECTORY` | unset | Deprecated alias for `CERTIFICATES_LEGACY_SINGLE_TEMPLATE_DIR`. |
| `WAREHOUSE_STORAGE_ROOT` | `$DATA_ROOT/warehouse` | Warehouse SQLite DB location. |
| `LOGISTICS_STORAGE_ROOT` | `$DATA_ROOT/logistics` | Logistics SQLite DB location. |
| `NODE_OPTIONS` | unset | Docker sets `--no-warnings=ExperimentalWarning` because the API uses `node:sqlite`. |

Frontend variables:

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_API_URL` | `/api` | Shared API base URL used by frontend API clients. |
| `VITE_CERTIFICATES_API_URL` | `VITE_API_URL` or `/api` | Certificates API base URL override. |
| `VITE_WAREHOUSE_API_URL` | `VITE_API_URL` or `/api` | Warehouse API base URL override. |
| `VITE_LOGISTICS_API_URL` | `VITE_API_URL` or `/api` | Logistics API base URL override. |
| `VITE_API_PROXY_TARGET` | `http://localhost:3001` | Vite dev-server proxy target for `/api`; Docker sets it to `http://api:3001`. |

Elections map variables (all optional — the map works with no configuration):

| Variable | Default | Description |
| --- | --- | --- |
| `VITE_ELECTIONS_SOURCE` | `backend` | Where houses come from: `backend` (the API — the source of truth), `snapshot` (the shipped OSM dataset, for working on the map with no API running), or `overpass` (a live OpenStreetMap query). |
| `VITE_ELECTIONS_API_URL` | `/api/elections` | Base URL of the elections API. The default is correct for the normal same-origin deployment (Vite proxy in dev, nginx in prod); it is also where the working-area boundary is read from and saved to. |
| `ELECTIONS_STORAGE_ROOT` | `<DATA_ROOT>/elections` | API-side directory holding the campaign database (`elections.sqlite`), the saved working-area boundary and uploaded attachments. |
| `ELECTIONS_ADMIN_EMAILS` | unset | Comma-separated bootstrap admins for the elections module. Needed at least once: on a fresh database nobody has a role, so nobody could grant one. |
| `ELECTIONS_DEV_AUTH` / `ELECTIONS_DEV_ROLE` | unset | Local development only. Both must be set to grant a role without an Access identity; ignored when `NODE_ENV=production`, logged at startup, and shown as a red badge in the UI. |
| `VITE_MAP_MODE` | `streets` | Base layer selected on load: `streets` («Карта») or `satellite` («Супутник»). A mode picked in the UI is remembered per browser and wins over this. |
| `VITE_MAP_PROVIDER` | auto | Forces the tile provider for **both** modes: `osm`, `maptiler` or `mapbox`. Unset means: a configured commercial token if there is one, otherwise the key-free set. |
| `VITE_MAPTILER_KEY` | unset | MapTiler key. Moves both modes to MapTiler (Streets v2 + Satellite Hybrid). |
| `VITE_MAPBOX_TOKEN` | unset | Mapbox token. Moves both modes to Mapbox (Streets v12 + Satellite Streets v12). |

Tiles are third-party images loaded by the browser, so a host that is not in the
`img-src` list of the Content-Security-Policy in `infra/nginx/app.conf` renders
nothing at all — no error, just a blank base layer. Keep that list in step with
`apps/web/src/features/elections/basemaps.js` when changing providers.


## Авторизация и резервирование

`AVKU_ACCESS_TEAM_DOMAIN` и `AVKU_ACCESS_AUD` включают проверку подписанного
Cloudflare Access JWT. Email-заголовку без валидного JWT доверять нельзя.
Доверенный LAN-вход без JWT сохранён; для записи в «Вибори» нужна роль сотрудника.
Подробности: [доступ](cloudflare-access-setup.md).

`CERTIFICATE_BACKUP_ENABLED=true`, `CERTIFICATE_BACKUP_STATE=/jobs`,
`CERTIFICATE_BACKUP_STAGING=/staging`, `CERTIFICATE_BACKUP_ORIGINS` включают ручные
резервные копии. Полная конфигурация находится вне репозитория в
`~/.config/avku-certificate-backup/runtime.env`; SSH key монтируется только worker.
Протокол, transport settings и восстановление: [backup guide](../infra/certificate-backup/README.md).
`AVKU_RELEASE_ID` задаётся при сборке; рабочие image tags закреплены в
`docker-compose.release.yml`.

`.env` задаёт параметры Compose и API, `.env.cloudflare` — секрет туннеля.
`VITE_*` — публичные параметры сборки: секретов в них быть не должно.
