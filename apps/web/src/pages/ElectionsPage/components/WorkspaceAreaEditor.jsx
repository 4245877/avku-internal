/**
 * Control panel for boundary editing.
 *
 * The tracing itself happens on the map — this is the surrounding chrome: how
 * many vertices the outline has, how much ground it covers, the ways to take a
 * step back, and the one button that matters, «Зберегти межу», which puts the
 * outline in force for the whole module straight away.
 *
 * Saving is local to this browser. The export below it is how a boundary
 * becomes everybody's: the file it produces is exactly `workspaceArea.geo.json`,
 * so the path to save it to is spelled out rather than left to be guessed.
 */

import { useEffect, useState } from 'react';

import ElectionsIcon from '../../../features/elections/ElectionsIcon.jsx';
import { formatAreaSquareMeters } from '../../../features/elections/geo.js';
import { EXPORT_FILE_NAME } from '../../../features/elections/useWorkspaceEditor.js';
import styles from '../ElectionsPage.module.css';

/** How long a one-off confirmation stays up. */
const NOTICE_TIMEOUT_MS = 3500;

const SAVE_PATH = `apps/web/src/features/elections/${EXPORT_FILE_NAME}`;

/** The standing line under the buttons — what the outline needs, or is. */
function statusMessage(editor) {
  if (!editor.isSaveable) {
    return 'Клацніть по карті щонайменше 3 рази, щоб окреслити територію.';
  }

  if (editor.isSelfIntersecting) {
    return 'Контур перетинає сам себе — межа вийде непередбачуваною.';
  }

  if (editor.hasRestoredDraft) {
    return 'Відновлено незбережений контур із попереднього сеансу.';
  }

  if (editor.hasUnsavedChanges) {
    return 'Є незбережені зміни — натисніть «Зберегти межу». Контур не зникне: ' +
      'він лишається чернеткою, доки його не збережено.';
  }

  return 'Контур збігається з чинною межею території.';
}

function WorkspaceAreaEditor({ editor, onExit, onSave }) {
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) {
      return undefined;
    }

    const timeoutId = setTimeout(() => setNotice(''), NOTICE_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [notice]);

  async function handleCopy() {
    setNotice((await editor.copy()) ? 'JSON скопійовано' : 'Не вдалося скопіювати');
  }

  function handleSave() {
    const result = onSave();

    if (!result?.isSaved) {
      setNotice(result?.error ?? 'Не вдалося зберегти межу.');
    }
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
          Редагування межі
        </span>

        <button
          className={styles.areaEditorClose}
          onClick={onExit}
          title="Завершити редагування"
          type="button"
        >
          <ElectionsIcon name="close" size={13} />
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
          title="Скасувати останню дію (Ctrl+Z)"
          type="button"
        >
          Скасувати
        </button>

        <button
          className={styles.areaEditorButton}
          disabled={editor.vertexCount === 0}
          onClick={editor.removeLastPoint}
          title="Прибрати останню точку (Backspace)"
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
          Очистити
        </button>

        <button
          className={styles.areaEditorButton}
          disabled={!editor.hasUnsavedChanges}
          onClick={editor.resetToSaved}
          title="Повернути контур до збереженої межі"
          type="button"
        >
          Збережена межа
        </button>

        {/* Only worth offering once the shipped boundary is not the one in
            force — it is the way back from a saved outline that went wrong. */}
        {editor.isAreaCustom && (
          <button
            className={styles.areaEditorButton}
            onClick={editor.resetToShipped}
            title="Повернути контур до початкової межі з репозиторію"
            type="button"
          >
            Початкова межа
          </button>
        )}
      </div>

      <button
        className={styles.areaEditorSave}
        disabled={!editor.isSaveable}
        onClick={handleSave}
        type="button"
      >
        <ElectionsIcon name="check" size={16} />
        Зберегти межу
      </button>

      <p aria-live="polite" className={styles.areaEditorNotice}>
        {notice || statusMessage(editor)}
      </p>

      <details className={styles.areaEditorExport}>
        <summary>Експорт GeoJSON</summary>

        <div className={styles.areaEditorActions}>
          <button
            className={styles.areaEditorButton}
            disabled={!editor.isSaveable}
            onClick={editor.download}
            type="button"
          >
            <ElectionsIcon name="download" size={14} />
            Завантажити файл
          </button>

          <button
            className={styles.areaEditorButton}
            disabled={!editor.isSaveable}
            onClick={handleCopy}
            type="button"
          >
            Копіювати JSON
          </button>
        </div>

        <p className={styles.areaEditorPath}>
          Збережена тут межа діє лише в цьому браузері. Щоб вона стала спільною,
          покладіть файл у <code>{SAVE_PATH}</code>.
        </p>
      </details>
    </section>
  );
}

export default WorkspaceAreaEditor;
