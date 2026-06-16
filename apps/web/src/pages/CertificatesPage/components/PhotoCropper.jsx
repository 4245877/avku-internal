import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  clampCrop,
  getCropLimits,
  getImageSize,
  getPhotoPlacement,
} from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

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
  const cropLimits = useMemo(
    () => getCropLimits(imageSize, photoFrame, safeCrop.zoom),
    [imageSize, photoFrame, safeCrop.zoom],
  );
  const photoPlacement = useMemo(
    () => getPhotoPlacement(imageSize, photoFrame, safeCrop),
    [imageSize, photoFrame, safeCrop],
  );

  const updateCrop = useCallback((nextCrop) => {
    onCropChange(clampCrop({
      ...safeCrop,
      ...nextCrop,
    }, imageSize, photoFrame));
  }, [imageSize, onCropChange, photoFrame, safeCrop]);

  const getFramePoint = useCallback((event) => {
    const rectangle = frameRef.current.getBoundingClientRect();

    return {
      x: ((event.clientX - rectangle.left) / rectangle.width) * photoFrame.width,
      y: ((event.clientY - rectangle.top) / rectangle.height) * photoFrame.height,
    };
  }, [photoFrame]);

  const startDragging = useCallback((event) => {
    if (!imageSize || !photoFrame) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = getFramePoint(event);
  }, [getFramePoint, imageSize, photoFrame]);

  const movePhoto = useCallback((event) => {
    if (!dragStateRef.current || !imageSize || !photoFrame) {
      return;
    }

    const point = getFramePoint(event);
    const previousPoint = dragStateRef.current;

    dragStateRef.current = point;
    updateCrop({
      offsetX: safeCrop.offsetX + point.x - previousPoint.x,
      offsetY: safeCrop.offsetY + point.y - previousPoint.y,
    });
  }, [getFramePoint, imageSize, photoFrame, safeCrop.offsetX, safeCrop.offsetY, updateCrop]);

  const stopDragging = useCallback((event) => {
    dragStateRef.current = null;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <section className={styles.photoPane} aria-label="Фотография">
      <div className={styles.paneHeader}>
        <div>
          <p className={styles.paneEyebrow}>Фото</p>
          <h2 className={styles.paneTitle}>Кадрирование</h2>
        </div>

        <label className={styles.fileButton}>
          Заменить
          <input ref={inputRef} className={styles.fileInputHidden} type="file" accept="image/*" onChange={onPhotoChange} />
        </label>
      </div>

      <div className={styles.cropSection}>
        <div
          ref={frameRef}
          className={`${styles.cropCanvasFrame} ${error ? styles.cropCanvasFrameError : ''}`}
          onPointerDown={startDragging}
          onPointerMove={movePhoto}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onPointerLeave={stopDragging}
        >
          {imageUrl && photoPlacement ? (
            <img className={styles.cropImage} src={imageUrl} alt="" style={photoPlacement} draggable="false" />
          ) : (
            <span className={styles.cropPlaceholder}>Фото не выбрано</span>
          )}
        </div>

        <div className={styles.cropControls}>
          <label className={styles.rangeField}>
            <span>Масштаб</span>
            <input
              type="range"
              min="1"
              max="3"
              step="0.01"
              value={safeCrop.zoom}
              onChange={(event) => updateCrop({ zoom: Number(event.target.value) })}
              disabled={!imageSize}
            />
          </label>

          <label className={styles.rangeField}>
            <span>Горизонталь</span>
            <input
              type="range"
              min={-cropLimits.x}
              max={cropLimits.x}
              step="1"
              value={safeCrop.offsetX}
              onChange={(event) => updateCrop({ offsetX: Number(event.target.value) })}
              disabled={!imageSize || cropLimits.x === 0}
            />
          </label>

          <label className={styles.rangeField}>
            <span>Вертикаль</span>
            <input
              type="range"
              min={-cropLimits.y}
              max={cropLimits.y}
              step="1"
              value={safeCrop.offsetY}
              onChange={(event) => updateCrop({ offsetY: Number(event.target.value) })}
              disabled={!imageSize || cropLimits.y === 0}
            />
          </label>

          {error ? <small className={styles.fieldError}>{error}</small> : null}
        </div>
      </div>
    </section>
  );
});

export default PhotoCropper;
