docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d --build



# avku-internal

Internal AVKU monorepo for operational modules: certificates, warehouse aid and logistics transfers. The API is a Node.js/TypeScript HTTP server without Express; the frontend is a React/Vite application.

## Project Structure

```text
apps/
  api/                    Node.js 22 + TypeScript API
    src/
      db/                 shared SQLite helpers
      http/               request/response helpers
      modules/            certificates, warehouse, logistics domain code
      routes/             API route handlers
      __tests__/          node:test checks
  web/                    React + Vite frontend
    src/
      features/           API clients and feature helpers
      layouts/            shared application layout
      pages/              dashboard and module pages
infra/
  nginx/                  reverse proxy config for Docker
  node/                   shared Node image with fonts for rendering
  scripts/backup-db.sh    runtime data backup script
storage/
  certificates/
    templates/            versioned certificate templates
design/                   design sources for certificate templates
docker-compose.yml        local Docker composition
docker-compose.prod.yml   production-oriented Docker composition
```

## Requirements

- Node.js 22.
- Corepack/pnpm (`corepack enable`).
- Docker and Docker Compose, if running containers.
- `sqlite3` is optional for backups. If it is unavailable, the backup script copies SQLite files together with WAL/SHM files.

## Local Setup

Install dependencies separately because the repository currently has independent lockfiles under `apps/api` and `apps/web`.

```bash
cd apps/api
corepack enable
pnpm install --frozen-lockfile

cd ../web
corepack enable
pnpm install --frozen-lockfile
```

## Environment Variables

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
| `VITE_ELECTIONS_SOURCE` | `snapshot` | Where houses come from: `snapshot` (the shipped OSM dataset), `backend` (`VITE_ELECTIONS_API_URL`), or `overpass` (a live OpenStreetMap query). |
| `VITE_ELECTIONS_API_URL` | unset | Base URL of the houses API. Required when `VITE_ELECTIONS_SOURCE=backend`. |
| `VITE_MAP_BASEMAP` | `osm` | Base layer selected on load: `osm`, `carto-voyager`, `carto-light`, `esri-imagery`, or a configured commercial provider. |
| `VITE_MAPTILER_KEY` | unset | Adds MapTiler Streets to the base-layer switcher. |
| `VITE_MAPBOX_TOKEN` | unset | Adds Mapbox Streets to the base-layer switcher. |

## Run API Locally

```bash
cd apps/api
pnpm start
```

The API listens on `http://localhost:3001` by default. Health check:

```bash
curl http://localhost:3001/api/health
```

Storage and template validation without starting the server:

```bash
cd apps/api
pnpm check
```

## Run Web Locally

Start the API first, then:

```bash
cd apps/web
pnpm run dev
```

The Vite app is available at `http://localhost:5173`. In local mode `/api` is proxied to `VITE_API_PROXY_TARGET` or `http://localhost:3001`.

Production build:

```bash
cd apps/web
pnpm run build
```

There are no frontend `typecheck` or `lint` scripts at the moment, so CI only installs dependencies and runs the Vite build for the web app.

## Run With Docker

Local Docker composition:

```bash
docker compose up --build
```

Ports:

- API: `http://localhost:3001`
- Web dev server: `http://localhost:5173`
- Nginx reverse proxy: `http://localhost:8080`

Production-oriented composition:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

The production compose exposes Nginx on `AVKU_HTTP_PORT` (`18080` by default in `.env`). API runtime data is mounted from the host path `/var/lib/avku-internal/data` to `/data`; the API environment sets `DATA_ROOT=/data`.

## Runtime Data

Default local runtime data lives under `storage/`:

```text
storage/certificates/certificates.sqlite
storage/certificates/photos/
storage/certificates/generated/
storage/warehouse/warehouse.sqlite
storage/logistics/logistics.sqlite
```

SQLite WAL/SHM sidecar files may appear next to each database. Runtime databases, uploaded photos, generated certificate files and backups are ignored by git. Certificate templates under `storage/certificates/templates/` are versioned and are required by the API.

Production runtime data must not live inside the repository. The host layout is:

```text
/var/lib/avku-internal/data/
/var/lib/avku-internal/data/certificates/
/var/lib/avku-internal/data/warehouse/
/var/lib/avku-internal/data/logistics/
/var/backups/avku-internal/
```

Inside the API container this same data root is `/data`. Certificate templates are not runtime data; they stay versioned under `storage/certificates/templates/` and are baked into the API image.

Create production directories before starting the stack. The API image currently has no explicit `USER`, so standard Docker runs it as UID/GID `0:0`; if a future image sets `USER`, replace `0:0` with the value returned by the inspect command below.

```bash
docker image inspect avku-internal-api:latest --format '{{.Config.User}}'

sudo install -d -o 0 -g 0 -m 0750 /var/lib/avku-internal/data
sudo install -d -o 0 -g 0 -m 0750 /var/lib/avku-internal/data/certificates
sudo install -d -o 0 -g 0 -m 0750 /var/lib/avku-internal/data/warehouse
sudo install -d -o 0 -g 0 -m 0750 /var/lib/avku-internal/data/logistics
sudo install -d -o 0 -g 0 -m 0700 /var/backups/avku-internal
```

Before migrating existing SQLite files, stop the API or use `sqlite3 .backup`. If copying files directly, copy the main database and any `-wal` and `-shm` files together. Do not delete the old `runtime/data` or `storage` directories until the new stack has started, health checks pass, records/photos/PNG/PDF export work, and data survives a container recreate.

## Elections Map Data

The "Вибори" map is backed by real OpenStreetMap data, not by generated
geometry. The base layer is served by a map provider (OpenStreetMap raster tiles
by default), and every building inside the working area is overlaid as its own
interactive polygon carrying its OSM address.

Campaign address: **вулиця Якуба Коласа, 6, Київ, 03146** (`50.4345086,
30.3774787` — the OSM position of the building itself).

### Working area boundary

The territory is an arbitrary GeoJSON polygon in one file:

```
apps/web/src/features/elections/workspaceArea.geo.json
```

That file is the only definition of the district. The map fits its initial zoom
to the polygon, dims and disables everything outside it, and a building is shown
and clickable only when its footprint is inside the polygon or crosses its
border. Replacing the file moves the whole district — no other change needed.

**The file currently shipped is a placeholder**: an exact 3 km circle around the
campaign address, i.e. the territory the module covered before it moved to
polygons. Replace it with a boundary traced over the real map:

1. Open the map with `?areaEdit=1` — e.g. `/elections?areaEdit=1`. This is a
   temporary mode; nothing in the normal UI leads to it.
2. Click along the border to drop vertices. Drag a filled handle to move a
   vertex, drag a hollow midpoint handle to insert one between two neighbours,
   right-click a vertex to delete it. `Ctrl+Z` undoes, `Backspace` drops the
   last point. Panning and zooming are unrestricted in this mode, and the
   satellite base layer is available for tracing over imagery.
3. Press **Завантажити GeoJSON** (or copy the JSON) and save the result over
   `apps/web/src/features/elections/workspaceArea.geo.json`.
4. Reload. The unfinished outline also survives a reload on its own — it is kept
   in `localStorage` under `avku-elections-area-draft-v1` until exported.

Re-run the dataset script after enlarging the boundary: Overpass is queried by
radius, and the default radius is derived from the polygon.

### Buildings dataset

The dataset is a versioned snapshot at
`apps/web/public/data/elections/houses.json`, built by querying the Overpass
API. Regenerate it whenever the district should pick up newer OSM edits:

```bash
node scripts/fetch-osm-buildings.mjs
# or, from apps/web:  pnpm run data:houses
```

Useful flags:

```bash
node scripts/fetch-osm-buildings.mjs --radius 4000   # default covers the polygon + 250 m
node scripts/fetch-osm-buildings.mjs --out apps/web/public/data/elections/houses.json
node scripts/fetch-osm-buildings.mjs --include-unaddressed   # also keep buildings with no addr:housenumber
```

The snapshot keeps the whole circular download; the polygon is applied when the
app loads it, so re-tracing the border does not require re-downloading OSM.

The script walks several public Overpass mirrors and retries, because any single
instance is regularly busy. It refuses to overwrite the snapshot with an empty
result. Current snapshot: ~3 550 addressed buildings, ~2.8 MB (~0.4 MB gzipped —
`infra/nginx/web.conf` compresses `/data/`).

Attributes come straight from OSM tags: `addr:street`, `addr:housenumber`,
`building`, `building:levels`, `start_date`. Anything OSM does not carry stays
`null` and the UI renders it as "невідомо" rather than inventing a value.
Entrance / apartment / resident counts shown before a survey are labelled
"оціночно, за геометрією" and are derived from the real footprint area, its
street frontage and the mapped storey count — they disappear as soon as a
canvasser enters measured data.

Map data © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright).

## Backup And Restore

Create a backup:

```bash
./infra/scripts/backup-db.sh
```

By default, backups are read from `DATA_ROOT=/var/lib/avku-internal/data` and written to `BACKUP_ROOT=/var/backups/avku-internal/<UTC timestamp>/`. The script backs up:

- `certificates/certificates.sqlite`
- `warehouse/warehouse.sqlite`
- `logistics/logistics.sqlite`
- `certificates/registry.json`, if present
- certificate `photos/` and `generated/` archives, if present

You can override paths:

```bash
DATA_ROOT=/path/to/data BACKUP_ROOT=/path/to/backups ./infra/scripts/backup-db.sh
```

Each SQLite database is captured as a single, self-contained snapshot (the WAL
is folded in) using `sqlite3 .backup`, or `node:sqlite` VACUUM INTO when
`sqlite3` is not installed, and is then verified with `PRAGMA integrity_check`
before the backup is considered successful. This means a restored
`*.sqlite` file never depends on `-wal`/`-shm` sidecars. If neither `sqlite3`
nor `node` is available the script fails loudly instead of writing a fragile
raw copy.

There is no dedicated restore script yet. To restore manually:

1. Stop the API process or container.
2. Copy each backed-up `*.sqlite` file back to its matching storage root under `/var/lib/avku-internal/data` (a single file per database — no sidecars).
3. If the backup contains `certificates/photos.tar.gz` or `certificates/generated.tar.gz`, extract them into `/var/lib/avku-internal/data/certificates`.
4. Start the API again and run `pnpm check` from `apps/api`, or check `/api/health`.

For Docker production, the host paths above are the source of truth because `/data` is a bind mount, not a Docker named volume.

## Access Control

The API and web services perform **no application-level authentication** by
design: access is controlled entirely at the network edge.

- In production the stack is bound to the LAN address only
  (`AVKU_BIND_IP`, e.g. `192.168.0.151:18080`); the `api` and `web` containers
  are `expose`-only and never published to the host directly — all traffic goes
  through nginx.
- External access is expected to be fronted by **Cloudflare Access**
  (see `docs/cloudflare-access-setup.md`).

This is an accepted decision for an internal tool. If the service is ever
exposed beyond the LAN/Cloudflare Access perimeter, add an authentication layer
(e.g. nginx Basic Auth or an API token) before doing so.

## Implemented Modules

- Certificates: template catalog, record CRUD, photo upload, renewal, PNG/PDF export, SQLite persistence and legacy registry migration.
- Warehouse: item CRUD, stock movements, CSV export, SQLite persistence and initial seed data.
- Logistics: transfer CRUD, timeline events, CSV export, SQLite persistence and initial seed data.

## Partially Ready Modules

- Elections: the map itself is real. Buildings, addresses, house numbers, streets and yards come from OpenStreetMap (see below), and every building is a separate clickable object with its own survey card. The working area is a GeoJSON polygon (`workspaceArea.geo.json`) — the shipped one is still the placeholder circle until a boundary is traced in `?areaEdit=1`. Survey data entered into those cards is still kept in browser `localStorage` under `avku-elections-details-v1`; there is no API persistence yet.
- SMM: frontend prototype only. Data is kept in browser `localStorage` under `avku-smm-data-v1`; there is no API persistence yet.
- Dashboard: uses static in-client data and export helpers; it is not connected to live aggregate API data yet.
- Deploy automation: `infra/scripts/deploy.sh` exists but is empty. Current GitHub workflow is CI only.

## Checks

API:

```bash
cd apps/api
pnpm typecheck
pnpm test
```

Frontend:

```bash
cd apps/web
pnpm run build
```

GitHub Actions workflow `.github/workflows/deploy.yml` runs API install/typecheck/tests and frontend install/build on pushes to `main` and pull requests.
