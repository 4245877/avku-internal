import { useEffect, useMemo, useRef, useState } from 'react';

import {
  formatDate,
  getImageSize,
  getPhotoPlacement,
  splitFullName,
} from '../../../features/certificates/certificateUtils.js';
import styles from '../CertificatesPage.module.css';

function getFieldStyle(field, canvas, previewWidth) {
  return {
    left: `${(field.x / canvas.width) * 100}%`,
    top: `${(field.y / canvas.height) * 100}%`,
    width: `${(field.width / canvas.width) * 100}%`,
    height: `${(field.height / canvas.height) * 100}%`,
    fontSize: `${Math.max(12, (previewWidth * field.fontSize) / canvas.width)}px`,
    textAlign: field.align === 'centre' ? 'center' : field.align || 'left',
  };
}

function PreviewText({ value, field, canvas, previewWidth, strong = true }) {
  if (!field || !value) {
    return null;
  }

  return (
    <span
      className={`${styles.previewText} ${strong ? styles.previewTextStrong : ''}`}
      style={getFieldStyle(field, canvas, previewWidth)}
    >
      {value}
    </span>
  );
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
    () => (layout ? getPhotoPlacement(imageSize, layout.photo, form.photoCrop) : null),
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
            <img className={styles.previewLayer} src={assets.backgroundUrl} alt="" />

            {imageUrl && photoPlacement ? (
              <div
                className={styles.previewPhotoFrame}
                style={{
                  left: `${(layout.photo.x / layout.canvas.width) * 100}%`,
                  top: `${(layout.photo.y / layout.canvas.height) * 100}%`,
                  width: `${(layout.photo.width / layout.canvas.width) * 100}%`,
                  height: `${(layout.photo.height / layout.canvas.height) * 100}%`,
                  borderRadius: `${(previewWidth * layout.photo.radius) / layout.canvas.width}px`,
                }}
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

            {assets.stampOverlayUrl ? (
              <img
                className={`${styles.previewLayer} ${styles.previewStamp}`}
                src={assets.stampOverlayUrl}
                alt=""
                style={getStampStyle(layout, previewWidth)}
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
