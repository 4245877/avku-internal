# Модуль «Вибори»

The "Вибори" map is backed by real OpenStreetMap data, not by generated
geometry. Every building inside the working area is overlaid as its own
interactive polygon carrying its OSM address, on top of one of two base layers:

| Mode | Base | What it shows |
| --- | --- | --- |
| «Карта» | OpenStreetMap raster | Roads, street names, building outlines, house numbers from z18. |
| «Супутник» | Esri World Imagery + CARTO Voyager labels | Orthophoto (real pixels to z19 over Kyiv, stretched beyond) with roads, street names and house numbers printed over it — a hybrid, not a bare photo. |

Switching modes replaces the tile layers and nothing else: the zoom, the
position, the selected house, the traced boundary and any open editor survive
untouched, and the chosen mode is restored on the next visit.

Тайлы загружаются из сторонних сервисов. Сохраняйте attribution и проверяйте
условия выбранного поставщика перед изменением конфигурации. Разрешённые CSP
источники в `infra/nginx/app.conf` должны соответствовать `basemaps.js`.

Campaign address: **вулиця Зодчих, 58А, Київ, 03170** (`50.4307636,
30.3640481` — the OSM position of the building itself).

### Working area boundary

The territory is an arbitrary GeoJSON polygon in one file:

```
apps/web/src/features/elections/workspaceArea.geo.json
```

That file supplies the fallback boundary; the saved API boundary takes precedence. The map fits its initial zoom
to the polygon, dims and disables everything outside it, and a building is shown
and clickable only when its footprint is inside the polygon or crosses its
border. Replacing the file moves the whole district — no other change needed.

**The file currently shipped is a placeholder**: an exact 3 km circle around the
campaign address, i.e. the territory the module covered before it moved to
polygons. Replace it with a boundary traced over the real map:

1. Press **Редагувати межу** in the page header (the mode is also reachable
   directly at `/elections?areaEdit=1`, which is what the button puts in the
   address bar).
2. Click along the border to drop vertices. Drag a filled handle to move a
   vertex, drag a hollow midpoint handle to insert one between two neighbours,
   right-click a vertex to delete it. `Ctrl+Z` undoes, `Backspace` drops the
   last point. Panning and zooming are unrestricted in this mode, and the
   satellite base layer is available for tracing over imagery.
3. Press **Зберегти межу**. The boundary takes effect immediately — the map
   re-fits to it, the dimming mask follows it and the dataset is re-cut to it —
   and is written to the API at `PUT /api/elections/area`, which stores it under
   `<DATA_ROOT>/elections/workspace-area.geo.json`. That is the permanent copy:
   every browser reads it on load, and `scripts/fetch-osm-buildings.mjs` reads
   it to decide what to download. `localStorage` (`avku-elections-area-v1`) is
   only a cache, so the first paint opens on the right territory and the page
   keeps working when the API is down. The confirmation banner says which of the
   two actually happened.
4. **Експортувати GeoJSON** is a separate action and saves nothing. It hands
   back the same document as a file, for committing over
   `apps/web/src/features/elections/workspaceArea.geo.json` so a fresh checkout
   ships with it.

An unfinished outline survives a reload on its own — it is kept in
`localStorage` under `avku-elections-area-draft-v1` until it is saved. A saved
boundary can always be taken back: reopen the editor and press **Початкова
межа**, then **Зберегти межу**, which deletes the stored boundary
(`DELETE /api/elections/area`) and returns the district to the file in the
repository.

The polygon is validated on both sides before it is stored: closed rings, at
least three points, coordinates in `[longitude, latitude]` order and in range, a
non-zero enclosed area, and no self-intersection (a figure-of-eight has no
unambiguous inside, so the dimming mask and the house filter would disagree
about which half is the district).

Re-run the dataset script after moving or enlarging the boundary — see below.
The map itself will say when that is needed: if the local snapshot does not
reach the new territory, a banner reports it and offers a one-click live
download from OpenStreetMap for the session.

### Buildings dataset

The dataset is a versioned snapshot at
`apps/web/public/data/elections/houses.json`, built by querying the Overpass
API. Regenerate it whenever the district should pick up newer OSM edits:

```bash
node scripts/fetch-osm-buildings.mjs
# or, from apps/web:  pnpm run data:houses
```

The script downloads the **bounding box of whichever boundary is in force**,
plus a 250 m margin — not a fixed circle around the campaign address. It resolves
that boundary in order: `--area <file>`, then the API (the boundary saved from
**Редагувати межу**, which is what users are actually looking at), then the
shipped `workspaceArea.geo.json`. That order is what makes a re-traced district
download its own ground rather than the old one's.

Useful flags:

```bash
node scripts/fetch-osm-buildings.mjs --area ~/Downloads/workspaceArea.geo.json
node scripts/fetch-osm-buildings.mjs --margin 400            # default 250 m of slack
node scripts/fetch-osm-buildings.mjs --api http://localhost:3001/api
node scripts/fetch-osm-buildings.mjs --no-server             # ignore the saved boundary
node scripts/fetch-osm-buildings.mjs --out apps/web/public/data/elections/houses.json
node scripts/fetch-osm-buildings.mjs --include-unaddressed   # also keep buildings with no addr:housenumber
```

The snapshot keeps the whole download and records the box it covers under
`coverage.box`; the polygon is applied when the app loads it, so re-tracing the
border inside the covered box does not require re-downloading OSM — and moving
it outside that box is detected and reported instead of showing an empty map.

The script walks several public Overpass mirrors and retries, because any single
instance is regularly busy. It refuses to overwrite the snapshot with an empty
result. Current snapshot: ~5 900 addressed buildings, ~4.7 MB (~0.65 MB gzipped —
`infra/nginx/web.conf` compresses `/data/`), of which ~3 590 fall inside the
shipped placeholder boundary. It is larger than the old circular download on
purpose: covering the polygon's whole bounding box is what lets the boundary be
re-traced anywhere inside it without another download.

Attributes come straight from OSM tags: `addr:street`, `addr:housenumber`,
`building`, `building:levels`, `start_date`. Anything OSM does not carry stays
`null` and the UI renders it as "невідомо" rather than inventing a value.
Entrance / apartment / resident counts shown before a survey are labelled
"оціночно, за геометрією" and are derived from the real footprint area, its
street frontage and the mapped storey count — they disappear as soon as a
canvasser enters measured data.

Map data © OpenStreetMap contributors, [ODbL 1.0](https://www.openstreetmap.org/copyright).

### Elections: campaign data

The OSM snapshot describes *buildings*. Everything a campaign records **about**
those buildings lives in the API database at
`<DATA_ROOT>/elections/elections.sqlite`, with uploaded photos under
`<DATA_ROOT>/elections/attachments/`. Neither is in the repository: the database
holds contact details and campaign history. The importer below refreshes only
OSM-derived buildings; it cannot recreate user-entered campaign data.

A house has its own permanent id, and `osm_type`/`osm_id` are only matching
attributes. That is what lets the snapshot be regenerated without orphaning
anything anybody recorded — re-running the importer updates the OSM-derived
columns and leaves the internal id, and therefore every action, issue, task and
contact, exactly where it was.

Load (or refresh) the houses table:

```bash
# First run: also creates the campaign everything hangs off.
pnpm --dir apps/api exec tsx src/scripts/import-osm-snapshot.ts \
  --campaign "Кампанія 2026"

# Later runs, after `pnpm --dir apps/web data:houses`:
pnpm --dir apps/api exec tsx src/scripts/import-osm-snapshot.ts
```

It is idempotent and reports what it did (`створено / оновлено / без змін /
зникло з OSM`). An OSM object that has disappeared is flagged
`osm_status = 'missing'`, never deleted — the building is usually still there,
and the work on it certainly is.

#### Data entered before the backend existed

Earlier versions kept survey data in one browser, in `localStorage` under
`avku-elections-details-v1`. For some houses that entry is the only copy. The
module detects it and shows a banner offering, in this order: **download the
file**, then **send it to the server**, where it becomes a reviewable import
batch. The original key is never removed automatically.

The same file can be imported from the command line:

```bash
# Preview only — writes nothing.
pnpm --dir apps/api exec tsx src/scripts/import-local-overrides.ts export.json

# Apply the rows that matched a house outright.
pnpm --dir apps/api exec tsx src/scripts/import-local-overrides.ts export.json --apply
```

Rows that cannot be matched are reported and left in the batch for a person to
decide; nothing is dropped silently. Every created record is tagged
`source = import:<batch_id>`, and the whole batch is reversible:

```
POST /api/elections/import/<batch_id>/rollback
```

Residents' political positions and age bands from the old data are **not**
imported. They are dropped while the rows are being built, so they never reach
storage; the report says how many values were removed and never what they were.

#### Editing a house

Clicking a building opens its card beside the map; **Редагувати** opens the
full-screen editor over the page. The map underneath is never unmounted, so
closing the editor returns to the same house, the same zoom and the same
filters — nothing is restored, because nothing was thrown away.

Ten sections, each loading its own records the first time it is opened:
Основне, Характеристики будинку, Контактні особи, Відповідальні, Дії,
Звернення, Завдання, Події, Файли, Історія. Switching house cancels whatever is
still in flight, so clicking down a street cannot leave one building's actions
under another building's address.

The two form sections accumulate a draft and are written by **Зберегти**; the
rest are independent records that save themselves. Every exit — the close
button, `Esc`, the browser's back gesture, the next/previous house arrows —
goes through the same guard and asks before discarding unsaved work.

Concurrency is explicit. Both `PATCH /houses/:id` and `PATCH /houses/:id/state`
accept `expectedUpdatedAt`, the `updatedAt` the editor loaded, and answer **409**
when somebody else has written since; the editor then offers *Оновити дані* or
*Зберегти мою версію* rather than silently rolling the other person's edit back.
The field is optional, so scripts and the importer are unaffected.

Fields and routes added for it (schema version 3, migrated in place):

| Addition | Why |
| --- | --- |
| `houses.block` | Corpus or letter. Folding it into `number` breaks `address_normalized`, which is the duplicate-detection key; `building` already holds the OSM `building=*` tag. |
| `house_campaign_state.next_step` | What is planned here next, in words. `next_action_at` only says *when*. |
| `person_contacts.verified_at` / `verified_by` | When a phone was last confirmed to work, stamped by the server. Carried across a person edit by contact id, or a rename would reset every number to "never verified". |
| `houses.source` on write | It was in the input type and the change-log field list, but no statement ever wrote it. |
| `GET /houses/:id/events` | The campaign's events narrowed to one building. |
| `PATCH /actions/:id` | Correct a logged action instead of deleting and re-entering it, which lost the original author and timestamp. |
| `PATCH /person-links/:id` | Fix an entrance or flat number without re-making the link, which would claim the person moved in today. |
| `DELETE /people/:id` | Remove a contact person and their phone numbers (manager only). Distinct from `DELETE /person-links/:id`, which only detaches them from this building. |
| `GET /houses/:id/history` | Now returns the building's own edits **and** its campaign-state changes, which are journalled under `<campaignId>:<houseId>`. |

Coordinates and the building outline are deliberately not editable through the
form: they decide where the building is on everybody's map, and the outline is
OpenStreetMap's. The section explains what to do instead and links to the OSM
object.

#### Roles

Writing requires a role, held in the `employees` table
(`agitator` → `coordinator` → `manager` → `admin`). Being on the LAN grants
nothing: a request with no identity is refused.

| Variable | Effect |
|---|---|
| `ELECTIONS_ADMIN_EMAILS` | Comma-separated bootstrap admins. Needed at least once — on a fresh database nobody has a role, so nobody could grant one. |
| `ELECTIONS_DEV_AUTH=1` + `ELECTIONS_DEV_ROLE=<role>` | Local development only. Both are required, it is ignored when `NODE_ENV=production`, it logs a warning at startup, and the UI shows a red badge while it is active. |

Roles are granted through `PUT /api/elections/roles/<email>` (admin only), or in
the UI once an admin exists.


## Инварианты модели и импорта

Постоянный дом отделён от состояния конкретной кампании; контакты, назначения,
действия, обращения, задачи, события и файлы имеют отдельные сущности. Импорт
сначала создаёт проверяемый batch, сохраняет provenance и поддерживает rollback.
Старый localStorage не удаляется автоматически. Дубликаты, неоднозначные адреса
и отсутствующие сведения требуют проверки, а не выдуманных значений.
Политические предпочтения и возрастные группы жителей не входят в модель.
Платежи и кадровые/юридические анкеты не следует добавлять в карточку дома.
Не удаляйте legacy helpers: они сохраняют путь переноса единственной старой копии.
