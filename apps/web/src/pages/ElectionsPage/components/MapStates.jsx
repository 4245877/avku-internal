/**
 * Overlay states for the map surface.
 *
 * The load of the *house dataset* and the load of the *map* are two different
 * things, and only one of them is allowed to hide the other. Tiles, streets and
 * the traced border come from Leaflet and are drawn as soon as the map has a
 * size; the dataset is a separate request that can be slow, empty, out of area
 * or broken. So every state below a full-map skeleton is a banner that leaves
 * the cartography visible — a canvasser with no house data can still see which
 * streets the territory covers, and an error no longer looks like a dead map.
 *
 * Only the very first load, when there is nothing on the map at all yet, earns
 * the full-surface treatment.
 */

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

/** Skeleton streets — purely decorative, drawn while the dataset loads. */
const SKELETON_LINES = [
  { top: '18%', left: '-10%', width: '120%', rotate: '-3deg' },
  { top: '46%', left: '-10%', width: '120%', rotate: '2deg' },
  { top: '74%', left: '-10%', width: '120%', rotate: '-1deg' },
];

const SKELETON_COLUMNS = ['24%', '52%', '78%'];

/**
 * The first paint, before Leaflet has tiles to show. Opaque on purpose: there
 * is nothing underneath worth seeing yet.
 */
export function MapLoadingState() {
  return (
    <div className={styles.mapOverlay} data-map-overlay="" role="status">
      <div aria-hidden="true" className={styles.mapSkeleton}>
        {SKELETON_LINES.map((line) => (
          <span
            className={styles.mapSkeletonLine}
            key={line.top}
            style={{
              top: line.top,
              left: line.left,
              width: line.width,
              transform: `rotate(${line.rotate})`,
            }}
          />
        ))}

        {SKELETON_COLUMNS.map((left) => (
          <span
            className={styles.mapSkeletonColumn}
            key={left}
            style={{ left }}
          />
        ))}
      </div>

      <div className={styles.mapOverlayCard}>
        <span aria-hidden="true" className={styles.mapSpinner} />
        <strong>Завантаження карти</strong>
        <span>Готуємо будинки в межах робочої території…</span>
      </div>
    </div>
  );
}

/** House data is reloading over a map that is already drawn. */
export function MapBusyState({ label = 'Оновлюємо будинки за новою межею…' }) {
  return (
    <p className={styles.mapStatusBanner} data-map-overlay="" role="status">
      <span aria-hidden="true" className={styles.mapSpinner} />
      {label}
    </p>
  );
}

/**
 * The dataset request failed. The map stays visible behind the banner, so the
 * territory and its streets are still readable while the retry runs.
 */
export function MapErrorState({ message, onRetry }) {
  return (
    <div className={styles.mapBanner} data-map-overlay="" role="alert">
      <span aria-hidden="true" className={styles.mapBannerIcon}>
        <ElectionsIcon name="warning" size={20} />
      </span>

      <span className={styles.mapBannerText}>
        <strong>Не вдалося завантажити будинки</strong>
        <small>{message}</small>
      </span>

      <button className={styles.primaryButton} onClick={onRetry} type="button">
        <ElectionsIcon name="refresh" size={17} />
        Спробувати ще раз
      </button>
    </div>
  );
}

/**
 * The tile service itself failed — a blocked host, an exhausted quota, a wrong
 * key, or no route out of the network.
 *
 * This is a different failure from a missing dataset and has to say so: the
 * houses, the boundary and the survey data are all still there, and what is
 * gone is the cartography under them. Naming the provider is the difference
 * between "the map is broken" and one line in an nginx policy.
 */
export function MapTilesErrorState({ mode, onRetry }) {
  return (
    <div className={styles.mapBanner} data-map-overlay="" role="alert">
      <span aria-hidden="true" className={styles.mapBannerIcon}>
        <ElectionsIcon name="warning" size={20} />
      </span>

      <span className={styles.mapBannerText}>
        <strong>Не вдалося завантажити тайли карти</strong>
        <small>
          Підкладку не віддає {mode.provider}. Будинки, межа й дані залишаються
          на місці — перевірте зʼєднання, доступ до сервера тайлів або ліміти
          провайдера.
        </small>
      </span>

      <button className={styles.primaryButton} onClick={onRetry} type="button">
        <ElectionsIcon name="refresh" size={17} />
        Повторити
      </button>
    </div>
  );
}

/**
 * The boundary was re-traced onto ground the local OSM snapshot never covered.
 *
 * This is the state that used to present itself as an empty map: the polygon is
 * right, the filter is right, and the dataset simply does not reach there. It
 * offers both ways out — a live download for this session, and the command that
 * makes the refreshed snapshot permanent.
 */
export function MapCoverageState({ coverage, isRefreshing, onRefresh }) {
  return (
    <div className={styles.mapBanner} data-map-overlay="" role="status">
      <span aria-hidden="true" className={styles.mapBannerIcon}>
        <ElectionsIcon name="warning" size={20} />
      </span>

      <span className={styles.mapBannerText}>
        <strong>
          {coverage.houseCount > 0
            ? 'Локальний набір OSM покриває межу лише частково'
            : 'Локальний набір OSM не покриває нову межу'}
        </strong>
        <small>
          {coverage.houseCount > 0
            ? `Показано ${coverage.houseCount} буд. із завантаженої раніше ділянки. `
            : 'Будинки для цієї території ще не завантажено. '}
          Оновіть набір із OpenStreetMap або виконайте{' '}
          <code>{coverage.command}</code>.
        </small>
      </span>

      <button
        className={styles.primaryButton}
        disabled={isRefreshing}
        onClick={onRefresh}
        type="button"
      >
        <ElectionsIcon name="refresh" size={17} />
        {isRefreshing ? 'Завантажуємо…' : 'Завантажити з OSM'}
      </button>
    </div>
  );
}

/** The territory is covered by the dataset and genuinely holds no buildings. */
export function MapEmptyAreaState({ onEditArea }) {
  return (
    <div className={styles.mapBanner} data-map-overlay="" role="status">
      <span aria-hidden="true" className={styles.mapBannerIcon}>
        <ElectionsIcon name="pin" size={20} />
      </span>

      <span className={styles.mapBannerText}>
        <strong>У межах території немає жодного будинку</strong>
        <small>
          Дані OSM для цієї ділянки завантажено, але адресних будівель тут немає.
          Розширте межу або обведіть територію заново.
        </small>
      </span>

      <button className={styles.ghostButton} onClick={onEditArea} type="button">
        Редагувати межу
      </button>
    </div>
  );
}

export function MapEmptyResultState({ onResetFilters }) {
  return (
    <div className={styles.mapEmptyBanner} data-map-overlay="" role="status">
      <span aria-hidden="true">
        <ElectionsIcon name="search" size={18} />
      </span>

      <span>
        <strong>Жоден будинок не підходить під фільтри</strong>
        <small>Карта показує територію без виділених обʼєктів.</small>
      </span>

      <button className={styles.ghostButton} onClick={onResetFilters} type="button">
        Скинути фільтри
      </button>
    </div>
  );
}
