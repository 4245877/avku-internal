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
 * The command that regenerates the shipped snapshot — a real answer, but only
 * for somebody with the repository checked out. A canvasser on a tablet has no
 * terminal to run it in, so for them it is noise beside the button that does
 * the same thing, and it is shown in development only.
 */
const IS_DEVELOPMENT = Boolean(import.meta.env?.DEV);

/** How much of the territory has no data, in words a canvasser can act on. */
function describeGap(coverage) {
  const missingShare = 1 - (coverage.coveredShare ?? 0);

  if (!(missingShare > 0)) {
    return 'Частина території залишилася без даних';
  }

  // Rounding must never turn a real gap into "0% missing": under half a per
  // cent the honest word is "small", not a number that reads as nothing.
  const percent = missingShare < 0.005 ? null : Math.round(missingShare * 100);
  const extent =
    percent === null
      ? 'Без даних лишилася невелика ділянка скраю'
      : `Без даних лишилося приблизно ${percent}% території`;

  return coverage.gapMeters > 0
    ? `${extent}: межа виходить за завантажену ділянку на ${coverage.gapMeters} м`
    : extent;
}

/**
 * The boundary was re-traced onto ground the local OSM snapshot never covered.
 *
 * This is the state that used to present itself as an empty map: the polygon is
 * right, the filter is right, and the dataset simply does not reach there.
 *
 * The banner is also where the way out lives, so it carries the whole life of
 * that download — running, failed, done — instead of handing a failure to the
 * page-wide error state, which would blame the map for a busy Overpass mirror
 * and offer a retry of the wrong request.
 *
 * Downloading is not the only way out, though: the gap can be real and still be
 * ground nobody canvasses, and "I have read this" deserves an answer that is
 * not a minute of Overpass. Hence the close button, which is available in every
 * stage of that download — a banner that locks itself open while a mirror
 * grinds, or that has just told the user it failed, is exactly when being able
 * to put it away matters most.
 */
export function MapCoverageState({ coverage, refresh, onRefresh, onCancel, onDismiss }) {
  const isRefreshing = refresh.status === 'loading';
  const hasFailed = refresh.status === 'error';
  const progress = refresh.progress;

  return (
    <div
      className={styles.mapBanner}
      data-map-overlay=""
      role={hasFailed ? 'alert' : 'status'}
    >
      <span aria-hidden="true" className={styles.mapBannerIcon}>
        <ElectionsIcon name="warning" size={20} />
      </span>

      <span className={styles.mapBannerText}>
        <strong>
          {coverage.houseCount > 0
            ? 'Дані OSM покривають територію не повністю'
            : 'Для цієї території ще немає даних OSM'}
        </strong>

        <small>
          {/* "Завантажено", not "показано": the filters decide what is on the
              map right now, and this number is about the dataset. */}
          {coverage.houseCount > 0
            ? `Завантажено ${coverage.houseCount} буд. із раніше збереженої ділянки. `
            : 'Жодного будинку для цієї межі ще не завантажено. '}
          {describeGap(coverage)}. Завантажте будівлі з OpenStreetMap — карта
          доповниться по всій поточній межі.
        </small>

        {isRefreshing && (
          <small className={styles.mapBannerProgress}>
            <span aria-hidden="true" className={styles.mapSpinner} />
            Запитуємо OpenStreetMap
            {progress ? ` (спроба ${progress.round} з ${progress.attempts})` : ''}… Це
            може тривати до хвилини.
          </small>
        )}

        {hasFailed && (
          <small className={styles.mapBannerError}>
            Не вдалося звʼязатися з OpenStreetMap. Сервіс безкоштовний і часто
            буває перевантажений — спробуйте ще раз за хвилину.
          </small>
        )}

        {/* Which mirror said what is a developer's question; a canvasser gets
            the sentence above and the button. */}
        {hasFailed && IS_DEVELOPMENT && <small>{refresh.error}</small>}

        {IS_DEVELOPMENT && (
          <small>
            Щоб оновити набір у репозиторії: <code>{coverage.command}</code>
          </small>
        )}
      </span>

      {isRefreshing ? (
        <button className={styles.ghostButton} onClick={onCancel} type="button">
          Скасувати
        </button>
      ) : (
        <button className={styles.primaryButton} onClick={onRefresh} type="button">
          <ElectionsIcon name="refresh" size={17} />
          {hasFailed ? 'Спробувати ще раз' : 'Завантажити з OSM'}
        </button>
      )}

      {/* Last in the DOM as well as on screen: a screen-reader user should hear
          what the banner says and what it offers before the way to silence it. */}
      <button
        aria-label="Закрити попередження про неповне покриття OSM"
        className={styles.mapBannerDismiss}
        onClick={onDismiss}
        type="button"
      >
        <ElectionsIcon name="close" size={16} />
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
