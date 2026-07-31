/**
 * Map legend that doubles as a filter: each row shows how many houses are in
 * that completeness state and toggles the corresponding filter when pressed.
 */

import { FILL_STATUSES } from '../../../features/elections/electionsTypes.js';
import { formatNumber } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const statusSwatchClassNames = {
  complete: styles.swatchComplete,
  partial: styles.swatchPartial,
  empty: styles.swatchEmpty,
};

function MapLegend({ summary, activeStatus, onStatusChange }) {
  return (
    <div className={styles.mapLegend} data-map-overlay="">
      <p className={styles.mapLegendTitle}>
        <ElectionsIcon name="layers" size={15} />
        Заповненість даних
      </p>

      <ul className={styles.mapLegendList}>
        {FILL_STATUSES.map((status) => {
          const isActive = activeStatus === status.id;

          return (
            <li key={status.id}>
              <button
                aria-pressed={isActive}
                className={[styles.mapLegendRow, isActive ? styles.mapLegendRowActive : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onStatusChange(isActive ? 'all' : status.id)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={`${styles.swatch} ${statusSwatchClassNames[status.id]}`}
                />
                <span className={styles.mapLegendLabel}>{status.shortLabel}</span>
                <span className={styles.mapLegendCount}>
                  {formatNumber(summary[status.id])}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className={styles.mapLegendHint}>
        <span aria-hidden="true" className={styles.swatchAnchor} />
        Штаб — вул. Зодчих, 58А
      </p>
    </div>
  );
}

export default MapLegend;
