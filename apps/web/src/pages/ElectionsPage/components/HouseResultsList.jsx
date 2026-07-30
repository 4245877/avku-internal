/**
 * Filtered list of houses — also the keyboard-accessible way to select a house,
 * since the map's shapes are not individually focusable.
 *
 * Long result sets are paged rather than virtualised: a chunk size of 40 keeps
 * the DOM small without pulling in a windowing dependency.
 */

import { useEffect, useState } from 'react';

import { fillStatusesById } from '../../../features/elections/electionsTypes.js';
import { formatDistance } from '../../../features/elections/geo.js';
import {
  formatApartments,
  formatFloors,
  getCompletionRatio,
  getFillStatus,
  getHouseTypeLabel,
  resolveApartments,
} from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const PAGE_SIZE = 40;

const statusDotClassNames = {
  complete: styles.swatchComplete,
  partial: styles.swatchPartial,
  empty: styles.swatchEmpty,
};

function HouseResultsList({
  houses,
  selectedHouseId,
  onSelectHouse,
  isLoading,
  hasActiveFilters,
  onResetFilters,
}) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // A new result set always starts from the top of the list.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [houses]);

  if (isLoading) {
    return (
      <div className={styles.listSkeleton} role="status">
        <span className="sr-only">Завантаження списку будинків</span>

        {Array.from({ length: 6 }, (_, index) => (
          <span className={styles.listSkeletonRow} key={index} />
        ))}
      </div>
    );
  }

  if (houses.length === 0) {
    return (
      <div className={styles.listEmpty}>
        <span aria-hidden="true" className={styles.listEmptyIcon}>
          <ElectionsIcon name="search" size={26} />
        </span>

        <strong>Будинків не знайдено</strong>
        <p>
          {hasActiveFilters
            ? 'Під поточні фільтри не підпадає жоден будинок території.'
            : 'У цій зоні поки немає даних про будинки.'}
        </p>

        {hasActiveFilters && (
          <button className={styles.ghostButton} onClick={onResetFilters} type="button">
            Скинути фільтри
          </button>
        )}
      </div>
    );
  }

  const visibleHouses = houses.slice(0, visibleCount);

  return (
    <div className={styles.listScroll}>
      <ul className={styles.houseList}>
        {visibleHouses.map((house) => {
          const status = getFillStatus(house);
          const isSelected = house.id === selectedHouseId;
          const completion = Math.round(getCompletionRatio(house) * 100);

          return (
            <li key={house.id}>
              <button
                aria-current={isSelected}
                className={[styles.houseRow, isSelected ? styles.houseRowActive : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSelectHouse(house.id)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={`${styles.swatch} ${statusDotClassNames[status]}`}
                />

                <span className={styles.houseRowBody}>
                  <span className={styles.houseRowTitle}>
                    <strong>{house.address}</strong>
                    {house.isHeadquarters && (
                      <span className={styles.houseRowBadge}>Штаб</span>
                    )}
                  </span>

                  <small className={styles.houseRowMeta}>
                    {getHouseTypeLabel(house)} · {formatFloors(house.floors)} ·{' '}
                    {formatApartments(resolveApartments(house).value)}
                  </small>

                  <span className={styles.houseRowProgress}>
                    <span
                      className={styles.houseRowProgressFill}
                      data-status={status}
                      style={{ width: `${completion}%` }}
                    />
                  </span>
                </span>

                <span className={styles.houseRowSide}>
                  <small>{formatDistance(house.distanceMeters)}</small>
                  <em>{fillStatusesById[status].shortLabel}</em>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {visibleCount < houses.length && (
        <button
          className={styles.loadMoreButton}
          onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
          type="button"
        >
          Показати ще {Math.min(PAGE_SIZE, houses.length - visibleCount)} з{' '}
          {houses.length - visibleCount}
        </button>
      )}
    </div>
  );
}

export default HouseResultsList;
