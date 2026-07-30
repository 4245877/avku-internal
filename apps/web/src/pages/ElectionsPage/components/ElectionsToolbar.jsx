/**
 * Search + filters bar above the workspace. Purely compositional: it wires the
 * search field and the filter row to the page's single filter object.
 */

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import { formatHouses } from '../../../features/elections/houseUtils.js';
import HouseFilters from './HouseFilters.jsx';
import HouseSearchField from './HouseSearchField.jsx';
import styles from '../ElectionsPage.module.css';

function ElectionsToolbar({
  houses,
  filters,
  summary,
  streets,
  resultCount,
  hasActiveFilters,
  isDisabled,
  onFiltersChange,
  onResetFilters,
  onSelectHouse,
}) {
  return (
    <section aria-label="Пошук і фільтри" className={styles.toolbar}>
      <div className={styles.toolbarTop}>
        <HouseSearchField
          disabled={isDisabled}
          houses={houses}
          onQueryChange={(query) => onFiltersChange({ query })}
          onSelectHouse={onSelectHouse}
          query={filters.query}
        />

        <p className={styles.resultCount}>
          <ElectionsIcon name="building" size={16} />
          <span>
            Знайдено <strong>{formatHouses(resultCount)}</strong>
          </span>
        </p>
      </div>

      <HouseFilters
        disabled={isDisabled}
        filters={filters}
        hasActive={hasActiveFilters}
        onChange={onFiltersChange}
        onReset={onResetFilters}
        streets={streets}
        summary={summary}
      />
    </section>
  );
}

export default ElectionsToolbar;
