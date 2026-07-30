/**
 * A single building footprint on the map.
 *
 * Click and hover are delegated from the parent group (see `HouseMap`), so each
 * shape stays a bare `<path>` carrying only its id — with several hundred
 * buildings on screen that is the difference between a smooth and a janky map.
 */

import { memo } from 'react';

import styles from '../ElectionsPage.module.css';

const statusClassNames = {
  complete: styles.houseComplete,
  partial: styles.housePartial,
  empty: styles.houseEmpty,
};

function MapHouseShape({ houseId, path, status, isMuted, isHeadquarters }) {
  const className = [
    styles.house,
    statusClassNames[status],
    isMuted ? styles.houseMuted : '',
    isHeadquarters ? styles.houseHeadquarters : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <path
      className={className}
      d={path}
      data-house-id={houseId}
      vectorEffect="non-scaling-stroke"
    />
  );
}

export default memo(MapHouseShape);
