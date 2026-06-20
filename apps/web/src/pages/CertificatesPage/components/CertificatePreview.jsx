import { useEffect, useMemo, useRef, useState } from 'react';

import {
  formatDate,
  getImageSize,
  getPhotoPlacement,
  splitFullName,
} from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

const DEFAULT_PHOTO_BLEED = 2;
const DEFAULT_TEXT_WIDTH_FACTOR = 0.58;
let textMeasureContext;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getTextOrigin(align) {
  if (align === 'right') {
    return 'right center';
  }

  if (align === 'center' || align === 'centre') {
    return 'center';
  }

  return 'left center';
}

function getFontFamily(font) {
  if (!font || font === 'sans') {
    return undefined;
  }

  if (font === 'Roboto Medium') {
    return "'Roboto Medium', Roboto, Arial, sans-serif";
  }

  if (font === 'Arial Narrow') {
    return "'Arial Narrow', Arial, sans-serif";
  }

  return font;
}

function getFontWeight(font) {
  if (font === 'Roboto Medium') {
    return 500;
  }

  if (font === 'Arial Narrow') {
    return 400;
  }

  return undefined;
}

function getTextMeasureContext() {
  if (typeof document === 'undefined') {
    return null;
  }

  if (!textMeasureContext) {
    textMeasureContext = document.createElement('canvas').getContext('2d');
  }

  return textMeasureContext;
}

function getCanvasFont(fontSize, field) {
  const fontWeight = getFontWeight(field.font) ?? 400;
  const fontFamily = getFontFamily(field.font) ?? 'sans-serif';

  return `${fontWeight} ${fontSize}px ${fontFamily}`;
}

function estimateTextWidth(value, fontSize, field) {
  const compactValue = String(value ?? '').trim();

  if (!compactValue) {
    return 0;
  }

  return compactValue.length * fontSize * (field.widthFactor ?? DEFAULT_TEXT_WIDTH_FACTOR);
}

function measureTextWidth(value, fontSize, field) {
  const compactValue = String(value ?? '').trim();
  const context = getTextMeasureContext();

  if (!compactValue || !context) {
    return estimateTextWidth(compactValue, fontSize, field);
  }

  context.font = getCanvasFont(fontSize, field);

  return context.measureText(compactValue).width;
}

function getFittedTextMetrics(value, field, baseFontSize, minFontSize, width) {
  const baseWidth = measureTextWidth(value, baseFontSize, field);

  if (baseWidth <= width) {
    return {
      fontSize: baseFontSize,
      width: baseWidth,
    };
  }

  let low = minFontSize;
  let high = baseFontSize;
  let bestFontSize = minFontSize;

  for (let index = 0; index < 8; index += 1) {
    const mid = (low + high) / 2;
    const measuredWidth = measureTextWidth(value, mid, field);

    if (measuredWidth <= width) {
      bestFontSize = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  return {
    fontSize: bestFontSize,
    width: measureTextWidth(value, bestFontSize, field),
  };
}

function getTextMetrics(value, field, canvas, previewWidth) {
  const baseFontSize = Math.max(8, (previewWidth * field.fontSize) / canvas.width);
  const minFontSize = Math.max(
    8,
    (previewWidth * (field.minFontSize ?? field.fontSize * 0.48)) / canvas.width,
  );
  const width = (previewWidth * field.width) / canvas.width;
  const fitted = getFittedTextMetrics(value, field, baseFontSize, minFontSize, width);
  const fontSize = fitted.fontSize;
  const fittedWidth = fitted.width;
  const scaleX = fittedWidth > width ? clamp(width / fittedWidth, 0.78, 1) : 1;

  return {
    fontSize,
    scaleX,
  };
}

function getFieldStyle(value, field, canvas, previewWidth) {
  const metrics = getTextMetrics(value, field, canvas, previewWidth);
  const height = (previewWidth * field.height) / canvas.width;

  return {
    left: `${(field.x / canvas.width) * 100}%`,
    top: `${(field.y / canvas.height) * 100}%`,
    width: `${(field.width / canvas.width) * 100}%`,
    height: `${(field.height / canvas.height) * 100}%`,
    fontFamily: getFontFamily(field.font),
    fontWeight: getFontWeight(field.font),
    fontSize: `${metrics.fontSize}px`,
    lineHeight: `${height}px`,
    textAlign: field.align === 'centre' ? 'center' : field.align || 'left',
    transform: metrics.scaleX < 1 ? `scaleX(${metrics.scaleX})` : undefined,
    transformOrigin: getTextOrigin(field.align),
  };
}

function PreviewText({ value, field, canvas, previewWidth, strong = true }) {
  if (!field || !value) {
    return null;
  }

  return (
    <span
      className={`${styles.previewText} ${strong ? styles.previewTextStrong : ''}`}
      style={getFieldStyle(value, field, canvas, previewWidth)}
    >
      {value}
    </span>
  );
}

function getPhotoBleed(photo) {
  return clamp(Number(photo.bleed ?? DEFAULT_PHOTO_BLEED) || 0, 0, 8);
}

function getPhotoFrameStyle(layout, previewWidth) {
  const bleed = getPhotoBleed(layout.photo);

  return {
    left: `${((layout.photo.x - bleed) / layout.canvas.width) * 100}%`,
    top: `${((layout.photo.y - bleed) / layout.canvas.height) * 100}%`,
    width: `${((layout.photo.width + bleed * 2) / layout.canvas.width) * 100}%`,
    height: `${((layout.photo.height + bleed * 2) / layout.canvas.height) * 100}%`,
    borderRadius: `${(previewWidth * (layout.photo.radius + bleed)) / layout.canvas.width}px`,
  };
}

function getPhotoFrameForPlacement(photo) {
  const bleed = getPhotoBleed(photo);

  return {
    ...photo,
    width: photo.width + bleed * 2,
    height: photo.height + bleed * 2,
  };
}

function getStampStyle(layout, previewWidth) {
  if (!layout.stampOverlay) {
    return {
      inset: 0,
      width: '100%',
      height: '100%',
    };
  }

  return {
    left: `${(layout.stampOverlay.x / layout.canvas.width) * 100}%`,
    top: `${(layout.stampOverlay.y / layout.canvas.height) * 100}%`,
    right: 'auto',
    bottom: 'auto',
    width: `${(layout.stampOverlay.width / layout.canvas.width) * 100}%`,
    height: `${(layout.stampOverlay.height / layout.canvas.height) * 100}%`,
    maxWidth: 'none',
    borderRadius: `${(previewWidth * 4) / layout.canvas.width}px`,
  };
}

function applyImageFallback(event, fallbackUrl) {
  if (!fallbackUrl || event.currentTarget.dataset.fallbackApplied === 'true') {
    return;
  }

  event.currentTarget.dataset.fallbackApplied = 'true';
  event.currentTarget.src = fallbackUrl;
}

function CertificatePreview({
  form,
  template,
  imageUrl,
  isExportDisabled,
  exportingFormat,
  onExport,
}) {
  const previewRef = useRef(null);
  const [previewWidth, setPreviewWidth] = useState(380);
  const [imageSize, setImageSize] = useState(null);
  const layout = template?.layout;
  const assets = template?.assets;

  useEffect(() => {
    if (!previewRef.current) {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;

      if (entry?.contentRect.width) {
        setPreviewWidth(entry.contentRect.width);
      }
    });

    observer.observe(previewRef.current);

    return () => observer.disconnect();
  }, []);

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

  const photoPlacement = useMemo(
    () => (layout ? getPhotoPlacement(imageSize, getPhotoFrameForPlacement(layout.photo), form.photoCrop) : null),
    [form.photoCrop, imageSize, layout],
  );
  const nameParts = useMemo(
    () => splitFullName(form.fullName),
    [form.fullName],
  );

  return (
    <aside className={styles.previewPane} aria-label="Попередній результат">
      <div className={styles.paneHeader}>
        <div>
          <p className={styles.paneEyebrow}>Попередній перегляд</p>
          <h2 className={styles.paneTitle}>Готовий макет</h2>
        </div>
      </div>

      <div className={styles.previewFrame}>
        {layout && assets ? (
          <div
            ref={previewRef}
            className={styles.previewSurface}
            style={{
              aspectRatio: `${layout.canvas.width} / ${layout.canvas.height}`,
            }}
          >
            <img
              className={styles.previewLayer}
              src={assets.backgroundUrl || assets.backgroundFallbackUrl}
              alt=""
              onError={(event) => applyImageFallback(event, assets.backgroundFallbackUrl)}
            />

            {imageUrl && photoPlacement ? (
              <div
                className={styles.previewPhotoFrame}
                style={getPhotoFrameStyle(layout, previewWidth)}
              >
                <img className={styles.previewPhoto} src={imageUrl} alt="" style={photoPlacement} draggable="false" />
              </div>
            ) : null}

            <PreviewText
              value={nameParts.lastName}
              field={layout.fields.lastName}
              canvas={layout.canvas}
              previewWidth={previewWidth}
            />
            <PreviewText
              value={nameParts.firstAndMiddleName}
              field={layout.fields.fullName}
              canvas={layout.canvas}
              previewWidth={previewWidth}
              strong={false}
            />
            <PreviewText
              value={form.certificateNumber}
              field={layout.fields.certificateNumber}
              canvas={layout.canvas}
              previewWidth={previewWidth}
            />
            <PreviewText
              value={layout.fields.issuedAt ? formatDate(form.issuedAt) : ''}
              field={layout.fields.issuedAt}
              canvas={layout.canvas}
              previewWidth={previewWidth}
            />
            <PreviewText
              value={formatDate(form.validUntil)}
              field={layout.fields.validUntil}
              canvas={layout.canvas}
              previewWidth={previewWidth}
            />

            {assets.stampOverlayUrl || assets.stampOverlayFallbackUrl ? (
              <img
                className={`${styles.previewLayer} ${styles.previewStamp}`}
                src={assets.stampOverlayUrl || assets.stampOverlayFallbackUrl}
                alt=""
                style={getStampStyle(layout, previewWidth)}
                onError={(event) => applyImageFallback(event, assets.stampOverlayFallbackUrl)}
              />
            ) : null}
          </div>
        ) : (
          <div className={styles.previewLoading}>Завантаження шаблону…</div>
        )}
      </div>

      <div className={styles.exportActions}>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => onExport('png')}
          disabled={isExportDisabled || exportingFormat === 'png'}
        >
          {exportingFormat === 'png' ? 'PNG...' : 'PNG'}
        </button>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={() => onExport('pdf')}
          disabled={isExportDisabled || exportingFormat === 'pdf'}
        >
          {exportingFormat === 'pdf' ? 'PDF...' : 'PDF'}
        </button>
      </div>
    </aside>
  );
}

export default CertificatePreview;
