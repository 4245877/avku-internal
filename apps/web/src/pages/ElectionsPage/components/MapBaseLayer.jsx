/**
 * Static map background: covered-radius ring, parks and water, the street
 * network and the campaign anchor. Everything is drawn in the local metre grid,
 * so road widths are real widths and the layer scales like a real map.
 *
 * Text and marker sizes are divided by `zoom` (pixels per metre) to stay
 * visually constant while the geometry around them scales.
 */

import { memo } from 'react';

import { AREA_RADIUS_METERS, polygonToPath, polylineToPath } from '../../../features/elections/geo.js';
import styles from '../ElectionsPage.module.css';

/** Above this zoom ratio the map is close enough for street names to help. */
const STREET_LABEL_ZOOM = 1.9;
const LANDMARK_LABEL_ZOOM = 1.4;

const landmarkClassNames = {
  forest: styles.landmarkForest,
  park: styles.landmarkPark,
  water: styles.landmarkWater,
  civic: styles.landmarkCivic,
};

/**
 * Label halo thickness in screen pixels. Text lives inside the scaled group, so
 * both font size and stroke width are divided by `zoom` to stay constant.
 */
const LABEL_HALO_PIXELS = 3;

const haloWidth = (zoom) => LABEL_HALO_PIXELS / zoom;

/** Keeps rotated labels readable instead of upside down. */
function labelAngle(from, to) {
  const degrees = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

  if (degrees > 90) {
    return degrees - 180;
  }

  if (degrees < -90) {
    return degrees + 180;
  }

  return degrees;
}

function StreetLabel({ street, zoom }) {
  const middleIndex = Math.floor(street.points.length / 2);
  const anchor = street.points[middleIndex];
  const previous = street.points[Math.max(0, middleIndex - 1)];
  const angle = labelAngle(previous, anchor);
  const fontSize = (street.kind === 'avenue' ? 13 : 11) / zoom;

  return (
    <text
      className={styles.streetLabel}
      fontSize={fontSize}
      strokeWidth={haloWidth(zoom)}
      transform={`translate(${anchor.x} ${anchor.y}) rotate(${angle})`}
      x="0"
      y={-street.width / 2 - fontSize * 0.55}
    >
      {street.short}
    </text>
  );
}

function MapBaseLayer({ streets, landmarks, zoom, zoomRatio }) {
  const showStreetLabels = zoomRatio >= STREET_LABEL_ZOOM;
  const showLandmarkLabels = zoomRatio >= LANDMARK_LABEL_ZOOM;

  return (
    <g>
      <circle className={styles.areaFill} cx="0" cy="0" r={AREA_RADIUS_METERS} />

      <g>
        {landmarks
          .filter((landmark) => landmark.ring)
          .map((landmark) => (
            <path
              className={`${styles.landmark} ${landmarkClassNames[landmark.kind] ?? ''}`}
              d={polygonToPath(landmark.ring)}
              key={landmark.id}
            />
          ))}
      </g>

      {/* Roads are drawn twice: a dark casing, then the lighter carriageway. */}
      <g className={styles.roadCasings}>
        {streets.map((street) => (
          <path
            d={polylineToPath(street.points)}
            key={street.id}
            strokeWidth={street.width + 3.5}
          />
        ))}
      </g>

      <g className={styles.roadSurfaces}>
        {streets.map((street) => (
          <path
            className={street.kind === 'avenue' ? styles.roadAvenue : undefined}
            d={polylineToPath(street.points)}
            key={street.id}
            strokeWidth={street.width}
          />
        ))}
      </g>

      <circle className={styles.areaRing} cx="0" cy="0" r={AREA_RADIUS_METERS} />

      {showLandmarkLabels && (
        <g>
          {landmarks
            .filter((landmark) => landmark.ring)
            .map((landmark) => (
              <text
                className={styles.landmarkLabel}
                fontSize={12 / zoom}
                key={landmark.id}
                strokeWidth={haloWidth(zoom)}
                x={landmark.labelAt.x}
                y={landmark.labelAt.y}
              >
                {landmark.name}
              </text>
            ))}
        </g>
      )}

      {showStreetLabels && (
        <g>
          {streets
            .filter((street) => street.showLabel)
            .map((street) => (
              <StreetLabel key={street.id} street={street} zoom={zoom} />
            ))}
        </g>
      )}

      <g>
        {landmarks
          .filter((landmark) => landmark.kind === 'metro')
          .map((landmark) => (
            <g key={landmark.id} transform={`translate(${landmark.point.x} ${landmark.point.y})`}>
              <circle className={styles.metroMark} cx="0" cy="0" r={9 / zoom} />
              <text className={styles.metroGlyph} fontSize={11 / zoom} x="0" y={4 / zoom}>
                М
              </text>
              {showLandmarkLabels && (
                <text
                  className={styles.metroLabel}
                  fontSize={11 / zoom}
                  strokeWidth={haloWidth(zoom)}
                  x="0"
                  y={22 / zoom}
                >
                  {landmark.name}
                </text>
              )}
            </g>
          ))}
      </g>

      {/* Campaign anchor — вулиця Якуба Коласа, 6. */}
      <g className={styles.anchorMark}>
        <circle className={styles.anchorPulse} cx="0" cy="0" r={20 / zoom} />
        <circle className={styles.anchorRing} cx="0" cy="0" r={11 / zoom} />
        <circle className={styles.anchorDot} cx="0" cy="0" r={4.5 / zoom} />
      </g>
    </g>
  );
}

export default memo(MapBaseLayer);
