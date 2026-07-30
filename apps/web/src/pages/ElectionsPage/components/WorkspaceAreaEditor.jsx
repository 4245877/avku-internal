/**
 * Control panel for the temporary boundary-editing mode (`?areaEdit=1`).
 *
 * The tracing itself happens on the map — this is the surrounding chrome: how
 * many vertices the outline has, how much ground it covers, and the two ways
 * out of it (a downloaded file or the JSON on the clipboard). The path the
 * export has to be saved to is spelled out here on purpose: the boundary is a
 * source file, and a traced outline that never lands in the repository is lost
 * on the next reload.
 */

import { useEffect, useState } from 'react';

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import { formatAreaSquareMeters } from '../../../features/elections/geo.js';
import { EXPORT_FILE_NAME } from '../../../features/elections/useWorkspaceEditor.js';
import styles from '../ElectionsPage.module.css';

/** How long the "copied" confirmation stays up. */
const COPY_NOTICE_TIMEOUT_MS = 2500;

const SAVE_PATH = `apps/web/src/features/elections/${EXPORT_FILE_NAME}`;

function WorkspaceAreaEditor({ editor, onExit }) {
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timeoutId = setTimeout(() => setNotice(''), COPY_NOTICE_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [notice]);

  async function handleCopy() {
    setNotice((await editor.copy()) ? 'JSON скопійовано' : 'Не вдалося скопіювати');
  }

  return (
    <section
      aria-label="Редагування межі робочої території"
      className={styles.areaEditor}
      data-map-overlay=""
    >
      <header className={styles.areaEditorHeader}>
        <span className={styles.areaEditorBadge}>
          <ElectionsIcon name="pin" size={14} />
          Режим межі
        </span>

        <button
          className={styles.areaEditorClose}
          onClick={onExit}
          title="Вийти з режиму редагування"
          type="button"
        >
          ✕
        </button>
      </header>

      <p className={styles.areaEditorHint}>
        Клацайте по карті, щоб обвести територію. Тягніть точку, щоб посунути її,
        порожню — щоб додати нову між сусідніми. Права кнопка на точці видаляє її.
      </p>

      <dl className={styles.areaEditorStats}>
        <div>
          <dt>Точок</dt>
          <dd>{editor.vertexCount}</dd>
        </div>
        <div>
          <dt>Площа</dt>
          <dd>{formatAreaSquareMeters(editor.areaSqm)}</dd>
        </div>
      </dl>

      <div className={styles.areaEditorActions}>
        <button
          className={styles.areaEditorButton}
          disabled={!editor.canUndo}
          onClick={editor.undo}
          type="button"
        >
          Скасувати
        </button>

        <button
          className={styles.areaEditorButton}
          disabled={editor.vertexCount === 0}
          onClick={editor.removeLastPoint}
          type="button"
        >
          Прибрати точку
        </button>

        <button
          className={styles.areaEditorButton}
          disabled={editor.vertexCount === 0}
          onClick={editor.clear}
          type="button"
        >
          Почати заново
        </button>

        <button className={styles.areaEditorButton} onClick={editor.resetToSaved} type="button">
          Збережена межа
        </button>
      </div>

      <div className={styles.areaEditorActions}>
        <button
          className={`${styles.areaEditorButton} ${styles.areaEditorButtonPrimary}`}
          disabled={!editor.isExportable}
          onClick={editor.download}
          type="button"
        >
          <ElectionsIcon name="download" size={14} />
          Завантажити GeoJSON
        </button>

        <button
          className={styles.areaEditorButton}
          disabled={!editor.isExportable}
          onClick={handleCopy}
          type="button"
        >
          Копіювати JSON
        </button>
      </div>

      <p className={styles.areaEditorPath}>
        Збережіть файл як <code>{SAVE_PATH}</code> — карта підхопить нову межу
        після перезавантаження.
      </p>

      <p aria-live="polite" className={styles.areaEditorNotice}>
        {notice ||
          (editor.isExportable ? '' : 'Потрібно щонайменше 3 точки для експорту.')}
      </p>
    </section>
  );
}

export default WorkspaceAreaEditor;
