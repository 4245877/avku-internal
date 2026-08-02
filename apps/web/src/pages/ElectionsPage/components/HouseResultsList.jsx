/**
 * Filtered list of houses — also the keyboard-accessible way to select a house,
 * since the map's shapes are not individually focusable.
 *
 * Long result sets are paged rather than virtualised: a chunk size of 40 keeps
 * the DOM small without pulling in a windowing dependency.
 */

import { useEffect, useState } from 'react';

import {
  campaignStateOf,
  formatApartments,
  formatAssignee,
  formatFloors,
  formatShortDate,
  getHouseFlags,
  getHouseTypeLabel,
  getStage,
  resolveApartments,
} from '../../../features/elections/houseUtils.js';
import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import styles from '../ElectionsPage.module.css';

const PAGE_SIZE = 40;

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
          const stage = getStage(house);
          const state = campaignStateOf(house);
          const flags = getHouseFlags(house);
          const isSelected = house.id === selectedHouseId;
          const apartments = resolveApartments(house);

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
                {/* The dot is the stage and only the stage — the same rule the
                    map follows, so a colour means one thing everywhere. */}
                <span aria-hidden="true" className={styles.swatch} data-stage={stage.id} />

                <span className={styles.houseRowBody}>
                  <span className={styles.houseRowTitle}>
                    <strong>{house.address}</strong>
                    {house.isHeadquarters && (
                      <span className={styles.houseRowBadge}>Штаб</span>
                    )}
                  </span>

                  {/* Only what OSM actually knows about this house — an empty
                      slot is left out rather than filled with "невідомо". */}
                  <small className={styles.houseRowMeta}>
                    {[
                      getHouseTypeLabel(house),
                      Number.isFinite(house.floors) ? formatFloors(house.floors) : null,
                      apartments.isKnown ? formatApartments(apartments.value) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>

                  {/* Separate signals, listed rather than merged: an overdue
                      task and an unowned house are different problems. */}
                  <span className={styles.houseRowFlags}>
                    {flags.hasOverdueTasks && (
                      <em className={styles.flagDanger}>
                        прострочено {state.overdueTasksCount}
                      </em>
                    )}
                    {flags.hasOpenIssues && (
                      <em className={styles.flagWarning}>
                        звернень {state.openIssuesCount}
                      </em>
                    )}
                    {flags.hasNoAssignee && (
                      <em className={styles.flagAccent}>без відповідального</em>
                    )}
                    {flags.isStale && <em className={styles.flagMuted}>дані застаріли</em>}
                  </span>
                </span>

                <span className={styles.houseRowSide}>
                  <small>
                    {state.assignees.length > 0
                      ? formatAssignee(state.assignees[0].email)
                      : '—'}
                  </small>
                  <em>{stage.short}</em>
                  <small>
                    {state.lastActionAt ? formatShortDate(state.lastActionAt) : 'без дій'}
                  </small>
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
