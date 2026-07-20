import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  EMPTY_CROP,
  FACE_PRESET_ZOOM,
  MAX_ROTATION,
  MAX_ZOOM,
  MIN_ROTATION,
  MIN_ZOOM,
} from '../../../features/certificates/certificateTypes.js';
import {
  clampCrop,
  getCropBounds,
  getEffectiveResolution,
  getImageSize,
  getPhotoPlacement,
  normalizeRotation,
} from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

const COARSE_NUDGE = 10;
const WHEEL_ZOOM_STEP = 0.0015;

/**
 * Face guide proportions, as fractions of the frame. Follows the usual ID-photo
 * rule of thumb: head fills ~70% of the height and the eyes sit slightly above
 * the middle. Purely a visual aid — nothing snaps to it.
 */
const FACE_GUIDE = {
  centerX: 50,
  centerY: 46,
  radiusX: 27,
  radiusY: 35,
  eyeLine: 40,
};

const PhotoCropper = forwardRef(function PhotoCropper({
  imageUrl,
  crop,
  photoFrame,
  error,
  onCropChange,
  onPhotoChange,
}, inputRef) {
  const frameRef = useRef(null);
  const dragStateRef = useRef(null);
  const [imageSize, setImageSize] = useState(null);
  const [showGuides, setShowGuides] = useState(true);

  useEffect(() => {
    let isMounted = true;

    getImageSize(imageUrl)
      .then((size) => {
        if (isMounted) {
          setImageSize(size);
        }
      })
      .catch(() => {
        if (isMounted) {
          setImageSize(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [imageUrl]);

  const safeCrop = useMemo(
    () => clampCrop(crop, imageSize, photoFrame),
    [crop, imageSize, photoFrame],
  );
  const cropBounds = useMemo(
    () => getCropBounds(imageSize, photoFrame, safeCrop.zoom, safeCrop.rotation),
    [imageSize, photoFrame, safeCrop.rotation, safeCrop.zoom],
  );
  const photoPlacement = useMemo(
    () => getPhotoPlacement(imageSize, photoFrame, safeCrop),
    [imageSize, photoFrame, safeCrop],
  );
  const resolution = useMemo(
    () => getEffectiveResolution(imageSize, photoFrame, safeCrop),
    [imageSize, photoFrame, safeCrop],
  );

  const isReady = Boolean(imageSize && photoFrame);
  const isModified = useMemo(
    () => (
      safeCrop.zoom !== EMPTY_CROP.zoom ||
      safeCrop.rotation !== EMPTY_CROP.rotation ||
      Math.round(safeCrop.offsetX) !== EMPTY_CROP.offsetX ||
      Math.round(safeCrop.offsetY) !== EMPTY_CROP.offsetY
    ),
    [safeCrop],
  );

  const updateCrop = useCallback((nextCrop) => {
    onCropChange(clampCrop({
      ...safeCrop,
      ...nextCrop,
    }, imageSize, photoFrame));
  }, [imageSize, onCropChange, photoFrame, safeCrop]);

  const nudge = useCallback((deltaX, deltaY) => {
    updateCrop({
      offsetX: safeCrop.offsetX + deltaX,
      offsetY: safeCrop.offsetY + deltaY,
    });
  }, [safeCrop.offsetX, safeCrop.offsetY, updateCrop]);

  const centerPhoto = useCallback(() => {
    updateCrop({
      offsetX: 0,
      offsetY: 0,
    });
  }, [updateCrop]);

  const fitToGuide = useCallback(() => {
    onCropChange(clampCrop({
      ...EMPTY_CROP,
      zoom: FACE_PRESET_ZOOM,
    }, imageSize, photoFrame));
  }, [imageSize, onCropChange, photoFrame]);

  const resetCrop = useCallback(() => {
    onCropChange({ ...EMPTY_CROP });
  }, [onCropChange]);

  const rotateBy = useCallback((delta) => {
    updateCrop({ rotation: normalizeRotation(safeCrop.rotation + delta) });
  }, [safeCrop.rotation, updateCrop]);

  const getFramePoint = useCallback((event) => {
    const rectangle = frameRef.current.getBoundingClientRect();

    return {
      x: ((event.clientX - rectangle.left) / rectangle.width) * photoFrame.width,
      y: ((event.clientY - rectangle.top) / rectangle.height) * photoFrame.height,
    };
  }, [photoFrame]);

  const startDragging = useCallback((event) => {
    if (!isReady) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = getFramePoint(event);
  }, [getFramePoint, isReady]);

  const movePhoto = useCallback((event) => {
    if (!dragStateRef.current || !isReady) {
      return;
    }

    const point = getFramePoint(event);
    const previousPoint = dragStateRef.current;

    dragStateRef.current = point;
    nudge(point.x - previousPoint.x, point.y - previousPoint.y);
  }, [getFramePoint, isReady, nudge]);

  const stopDragging = useCallback((event) => {
    dragStateRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // Wheel-to-zoom needs a non-passive listener, which React's onWheel cannot give us.
  useEffect(() => {
    const frame = frameRef.current;

    if (!frame || !isReady) {
      return undefined;
    }

    const handleWheel = (event) => {
      event.preventDefault();
      updateCrop({ zoom: safeCrop.zoom - event.deltaY * WHEEL_ZOOM_STEP });
    };

    frame.addEventListener('wheel', handleWheel, { passive: false });

    return () => frame.removeEventListener('wheel', handleWheel);
  }, [isReady, safeCrop.zoom, updateCrop]);

  const handleKeyDown = useCallback((event) => {
    if (!isReady) {
      return;
    }

    const step = event.shiftKey ? COARSE_NUDGE : 1;
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];

    if (!move) {
      return;
    }

    event.preventDefault();
    nudge(move[0], move[1]);
  }, [isReady, nudge]);

  return (
    <section className={styles.photoPane} aria-label="Фотографія">
      <div className={styles.paneHeader}>
        <div>
          <p className={styles.paneEyebrow}>Фото</p>
          <h2 className={styles.paneTitle}>Кадрування</h2>
        </div>

        <label className={styles.fileButton}>
          Замінити
          <input
            ref={inputRef}
            className={styles.fileInputHidden}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            onChange={onPhotoChange}
          />
        </label>
      </div>

      <div className={styles.cropSection}>
        <div className={styles.cropStage}>
          <div
            ref={frameRef}
            className={`${styles.cropCanvasFrame} ${error ? styles.cropCanvasFrameError : ''}`}
            role="application"
            aria-label="Перетягніть фото, стрілки — точне зміщення, колесо — масштаб"
            tabIndex={isReady ? 0 : -1}
            onPointerDown={startDragging}
            onPointerMove={movePhoto}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onPointerLeave={stopDragging}
            onKeyDown={handleKeyDown}
          >
            {imageUrl && photoPlacement ? (
              <img className={styles.cropImage} src={imageUrl} alt="" style={photoPlacement} draggable="false" />
            ) : (
              <span className={styles.cropPlaceholder}>Фото не вибрано</span>
            )}

            {isReady && showGuides ? (
              <svg
                className={styles.cropGuides}
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <ellipse
                  cx={FACE_GUIDE.centerX}
                  cy={FACE_GUIDE.centerY}
                  rx={FACE_GUIDE.radiusX}
                  ry={FACE_GUIDE.radiusY}
                />
                <line x1="0" y1={FACE_GUIDE.eyeLine} x2="100" y2={FACE_GUIDE.eyeLine} />
                <line x1={FACE_GUIDE.centerX} y1="0" x2={FACE_GUIDE.centerX} y2="100" />
              </svg>
            ) : null}
          </div>

          <label className={styles.guideToggle}>
            <input
              type="checkbox"
              checked={showGuides}
              onChange={(event) => setShowGuides(event.target.checked)}
            />
            <span>Напрямні</span>
          </label>
        </div>

        <div className={styles.cropControls}>
          <label className={styles.rangeField}>
            <span>
              Масштаб
              <output className={styles.rangeValue}>{safeCrop.zoom.toFixed(2)}×</output>
            </span>
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step="0.01"
              value={safeCrop.zoom}
              onChange={(event) => updateCrop({ zoom: Number(event.target.value) })}
              disabled={!isReady}
            />
          </label>

          <div className={styles.rangeField}>
            <label className={styles.rangeField}>
              <span>
                Поворот
                <output className={styles.rangeValue}>{safeCrop.rotation.toFixed(1)}°</output>
              </span>
              <input
                type="range"
                min={MIN_ROTATION}
                max={MAX_ROTATION}
                step="0.1"
                value={safeCrop.rotation}
                onChange={(event) => updateCrop({ rotation: Number(event.target.value) })}
                disabled={!isReady}
              />
            </label>

            <div className={styles.cropButtonRow}>
              <button type="button" className={styles.cropChip} onClick={() => rotateBy(-90)} disabled={!isReady}>
                ⟲ 90°
              </button>
              <button type="button" className={styles.cropChip} onClick={() => rotateBy(-1)} disabled={!isReady}>
                −1°
              </button>
              <button type="button" className={styles.cropChip} onClick={() => rotateBy(1)} disabled={!isReady}>
                +1°
              </button>
              <button type="button" className={styles.cropChip} onClick={() => rotateBy(90)} disabled={!isReady}>
                ⟳ 90°
              </button>
            </div>
          </div>

          <div className={styles.offsetField}>
            <span className={styles.offsetLabel}>Зміщення, px</span>

            <div className={styles.offsetInputs}>
              <label>
                <span>X</span>
                <input
                  className={styles.input}
                  type="number"
                  step="1"
                  min={-cropBounds.x}
                  max={cropBounds.x}
                  value={Math.round(safeCrop.offsetX)}
                  onChange={(event) => updateCrop({ offsetX: Number(event.target.value) })}
                  disabled={!isReady}
                />
              </label>
              <label>
                <span>Y</span>
                <input
                  className={styles.input}
                  type="number"
                  step="1"
                  min={-cropBounds.y}
                  max={cropBounds.y}
                  value={Math.round(safeCrop.offsetY)}
                  onChange={(event) => updateCrop({ offsetY: Number(event.target.value) })}
                  disabled={!isReady}
                />
              </label>
            </div>

            <div className={styles.nudgePad} role="group" aria-label="Точне зміщення">
              <button type="button" className={styles.nudgeButton} style={{ gridArea: 'up' }} onClick={() => nudge(0, -1)} disabled={!isReady} aria-label="Вгору на 1 px">↑</button>
              <button type="button" className={styles.nudgeButton} style={{ gridArea: 'left' }} onClick={() => nudge(-1, 0)} disabled={!isReady} aria-label="Ліворуч на 1 px">←</button>
              <button type="button" className={styles.nudgeButton} style={{ gridArea: 'center' }} onClick={centerPhoto} disabled={!isReady} aria-label="Центрувати">•</button>
              <button type="button" className={styles.nudgeButton} style={{ gridArea: 'right' }} onClick={() => nudge(1, 0)} disabled={!isReady} aria-label="Праворуч на 1 px">→</button>
              <button type="button" className={styles.nudgeButton} style={{ gridArea: 'down' }} onClick={() => nudge(0, 1)} disabled={!isReady} aria-label="Вниз на 1 px">↓</button>
            </div>
          </div>

          <div className={styles.cropButtonRow}>
            <button type="button" className={styles.cropChip} onClick={centerPhoto} disabled={!isReady}>
              Центрувати
            </button>
            <button type="button" className={styles.cropChip} onClick={fitToGuide} disabled={!isReady}>
              Під овал
            </button>
            <button type="button" className={styles.cropChip} onClick={resetCrop} disabled={!isReady || !isModified}>
              Скинути
            </button>
          </div>

          <div className={styles.cropResult}>
            <span className={styles.offsetLabel}>Результат</span>
            <div className={styles.cropResultFrame}>
              {imageUrl && photoPlacement ? (
                <img className={styles.cropImage} src={imageUrl} alt="Попередній перегляд кадрування" style={photoPlacement} draggable="false" />
              ) : null}
            </div>
          </div>

          {resolution !== null && resolution < 1 ? (
            <small className={styles.cropHint}>
              Роздільна здатність фото нижча за рамку ({Math.round(resolution * 100)}%) — результат може бути розмитим.
            </small>
          ) : null}

          {error ? <small className={styles.fieldError}>{error}</small> : null}
        </div>
      </div>
    </section>
  );
});

export default PhotoCropper;
