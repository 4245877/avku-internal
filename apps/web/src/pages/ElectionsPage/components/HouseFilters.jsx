/**
 * Filter row: completeness chips plus street / building-type / sort selects.
 * The component is stateless — the page owns the filter object.
 */

import {
  FILL_STATUSES,
  HOUSE_TYPES,
} from '../../../features/elections/electionsTypes.js';
import { HOUSE_SORT_OPTIONS, formatNumber } from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const chipToneClassNames = {
  success: styles.chipSuccess,
  warning: styles.chipWarning,
  neutral: styles.chipNeutral,
};

function HouseFilters({ filters, summary, streets, onChange, onReset, hasActive, disabled }) {
  return (
    <div className={styles.filters}>
      <div aria-label="Фільтр за заповненістю" className={styles.chipGroup} role="group">
        <button
          aria-pressed={filters.fillStatus === 'all'}
          className={[
            styles.chip,
            filters.fillStatus === 'all' ? styles.chipActive : '',
          ]
            .filter(Boolean)
            .join(' ')}
          disabled={disabled}
          onClick={() => onChange({ fillStatus: 'all' })}
          type="button"
        >
          Усі
          <span className={styles.chipCount}>{formatNumber(summary.total)}</span>
        </button>

        {FILL_STATUSES.map((status) => {
          const isActive = filters.fillStatus === status.id;

          return (
            <button
              aria-pressed={isActive}
              className={[
                styles.chip,
                chipToneClassNames[status.tone],
                isActive ? styles.chipActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={disabled}
              key={status.id}
              onClick={() => onChange({ fillStatus: isActive ? 'all' : status.id })}
              type="button"
            >
              {status.shortLabel}
              <span className={styles.chipCount}>{formatNumber(summary[status.id])}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.selectGroup}>
        <label className={styles.selectField}>
          <span className="sr-only">Вулиця</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ street: event.target.value })}
            value={filters.street}
          >
            <option value="all">Усі вулиці</option>
            {streets.map((street) => (
              <option key={street} value={street}>
                {street}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Тип будинку</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ houseType: event.target.value })}
            value={filters.houseType}
          >
            <option value="all">Будь-який тип</option>
            {HOUSE_TYPES.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.selectField}>
          <span className="sr-only">Сортування</span>
          <select
            disabled={disabled}
            onChange={(event) => onChange({ sortBy: event.target.value })}
            value={filters.sortBy}
          >
            {HOUSE_SORT_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {hasActive && (
          <button className={styles.resetFiltersButton} onClick={onReset} type="button">
            <ElectionsIcon name="close" size={15} />
            Скинути
          </button>
        )}
      </div>
    </div>
  );
}

export default HouseFilters;
