/**
 * Overlay states for the map surface: initial load, load failure, and "the
 * current filters match nothing". Each is a self-contained overlay so the map
 * itself never has to branch on status.
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
        <span>Готуємо будинки в радіусі 3 км від штабу…</span>
      </div>
    </div>
  );
}

export function MapErrorState({ message, onRetry }) {
  return (
    <div className={styles.mapOverlay} data-map-overlay="" role="alert">
      <div className={`${styles.mapOverlayCard} ${styles.mapOverlayCardError}`}>
        <span aria-hidden="true" className={styles.mapOverlayIcon}>
          <ElectionsIcon name="warning" size={24} />
        </span>

        <strong>Не вдалося завантажити карту</strong>
        <span>{message}</span>

        <button className={styles.primaryButton} onClick={onRetry} type="button">
          <ElectionsIcon name="refresh" size={17} />
          Спробувати ще раз
        </button>
      </div>
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
