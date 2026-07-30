/**
 * Address search with ranked suggestions.
 *
 * The field drives two things at once: the free-text filter applied to the map
 * and the list, and a combobox of concrete addresses that jumps straight to a
 * house. Implemented as an ARIA combobox so it is fully keyboard-operable.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import { fillStatusesById } from '../../../features/elections/electionsTypes.js';
import { formatDistance } from '../../../features/elections/geo.js';
import { getFillStatus, searchHouses } from '../../../features/elections/houseUtils.js';
import styles from '../ElectionsPage.module.css';

const SUGGESTION_LIMIT = 7;

const statusDotClassNames = {
  complete: styles.swatchComplete,
  partial: styles.swatchPartial,
  empty: styles.swatchEmpty,
};

function HouseSearchField({ houses, query, onQueryChange, onSelectHouse, disabled }) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const wrapperRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const suggestions = useMemo(
    () => (query.trim() ? searchHouses(houses, query, SUGGESTION_LIMIT) : []),
    [houses, query],
  );

  useEffect(() => {
    setActiveIndex(-1);
  }, [query]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    function handleDocumentPointerDown(event) {
      if (!wrapperRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('pointerdown', handleDocumentPointerDown);

    return () => document.removeEventListener('pointerdown', handleDocumentPointerDown);
  }, [isOpen]);

  const showSuggestions = isOpen && suggestions.length > 0;

  function commitSuggestion(house) {
    onSelectHouse(house);
    onQueryChange(house.address);
    setIsOpen(false);
    setActiveIndex(-1);
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) {
        return;
      }

      event.preventDefault();
      setIsOpen(true);

      const direction = event.key === 'ArrowDown' ? 1 : -1;

      setActiveIndex((current) => {
        const next = current + direction;

        if (next < 0) {
          return suggestions.length - 1;
        }

        return next >= suggestions.length ? 0 : next;
      });

      return;
    }

    if (event.key === 'Enter') {
      const house = suggestions[activeIndex] ?? suggestions[0];

      if (house) {
        event.preventDefault();
        commitSuggestion(house);
      }
    }
  }

  return (
    <div className={styles.searchWrapper} ref={wrapperRef}>
      <div className={styles.searchField}>
        <span aria-hidden="true" className={styles.searchIcon}>
          <ElectionsIcon name="search" size={18} />
        </span>

        <input
          aria-activedescendant={
            showSuggestions && activeIndex >= 0
              ? `${optionIdPrefix}-${activeIndex}`
              : undefined
          }
          aria-autocomplete="list"
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-expanded={showSuggestions}
          aria-label="Пошук будинку за адресою"
          autoComplete="off"
          className={styles.searchInput}
          disabled={disabled}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Пошук за адресою — наприклад, Коласа 6"
          role="combobox"
          type="text"
          value={query}
        />

        {query && (
          <button
            aria-label="Очистити пошук"
            className={styles.searchClear}
            onClick={() => {
              onQueryChange('');
              setIsOpen(false);
            }}
            type="button"
          >
            <ElectionsIcon name="close" size={16} />
          </button>
        )}
      </div>

      {showSuggestions && (
        <ul className={styles.suggestionList} id={listboxId} role="listbox">
          {suggestions.map((house, index) => {
            const status = getFillStatus(house);

            return (
              <li
                aria-selected={index === activeIndex}
                className={[
                  styles.suggestionItem,
                  index === activeIndex ? styles.suggestionItemActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                id={`${optionIdPrefix}-${index}`}
                key={house.id}
                onClick={() => commitSuggestion(house)}
                onPointerEnter={() => setActiveIndex(index)}
                role="option"
              >
                <span
                  aria-hidden="true"
                  className={`${styles.swatch} ${statusDotClassNames[status]}`}
                />

                <span className={styles.suggestionText}>
                  <strong>{house.address}</strong>
                  <small>
                    {fillStatusesById[status].shortLabel} ·{' '}
                    {formatDistance(house.distanceMeters)} від штабу
                  </small>
                </span>

                <ElectionsIcon name="chevronRight" size={16} />
              </li>
            );
          })}
        </ul>
      )}

      {isOpen && query.trim() && suggestions.length === 0 && (
        <p className={styles.suggestionEmpty} role="status">
          Адресу не знайдено. Спробуйте лише назву вулиці — наприклад, <em>Зодчих</em>.
        </p>
      )}
    </div>
  );
}

export default HouseSearchField;
