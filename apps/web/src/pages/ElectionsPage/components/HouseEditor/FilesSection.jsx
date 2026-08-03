/**
 * «Файли» — photographs of the entrance, the notice board, a document.
 *
 * `capture="environment"` on the camera input is what makes "add a photo of the
 * entrance" a five-second action in the field rather than a trip through the
 * gallery. The plain file input beside it is for a desk, where the photo is
 * already on the machine.
 *
 * The upload is a real `FormData` request and the confirmation waits for the
 * server: an optimistic thumbnail that vanishes on the next reload is worse
 * than a two-second spinner.
 */

import { useRef, useState } from 'react';

import {
  deleteAttachment,
  uploadAttachment,
} from '../../../../features/elections/electionsApi.js';
import { formatAssignee, formatDate } from '../../../../features/elections/houseUtils.js';
import { useEditorMutation } from '../../../../features/elections/useEditorMutation.js';
import ElectionsIcon from '../../../../features/elections/ElectionsIcon.jsx';
import {
  Button,
  Card,
  CollectionState,
  ConfirmButton,
  FormStatus,
  TextField,
} from './editorFields.jsx';
import styles from './HouseEditor.module.css';

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return '';
  }

  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function FilesSection({ house, campaignId, state, canWrite, isReadOnly, onChanged }) {
  const [note, setNote] = useState('');
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const mutation = useEditorMutation();

  async function upload(file, kind) {
    if (!file) {
      return;
    }

    const saved = await mutation.run(
      () =>
        uploadAttachment(
          {
            file,
            ownerType: 'house',
            ownerId: house.id,
            houseId: house.id,
            kind,
            note: note.trim(),
          },
          { campaignId },
        ),
      'Файл завантажено.',
    );

    if (saved) {
      setNote('');
      onChanged();
    }
  }

  const canEdit = canWrite && !isReadOnly;

  const uploadControls = canEdit && (
    <div className={styles.uploadRow}>
      <Button
        icon="building"
        isBusy={mutation.isBusy}
        onClick={() => cameraRef.current?.click()}
        variant="primary"
      >
        Зробити фото
      </Button>

      <Button
        icon="note"
        isBusy={mutation.isBusy}
        onClick={() => fileRef.current?.click()}
        variant="ghost"
      >
        Вибрати файл
      </Button>

      <input
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          upload(event.target.files?.[0], 'photo');
          event.target.value = '';
        }}
        ref={cameraRef}
        type="file"
      />

      <input
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];

          upload(file, file?.type?.startsWith('image/') ? 'photo' : 'document');
          event.target.value = '';
        }}
        ref={fileRef}
        type="file"
      />
    </div>
  );

  return (
    <Card icon="layers" title="Файли">
      {canEdit && (
        <>
          <TextField
            hint="Необовʼязково — додається до наступного завантаженого файлу"
            label="Підпис до файлу"
            onChange={setNote}
            placeholder="Дошка оголошень, 2 підʼїзд"
            value={note}
            wide
          />

          {uploadControls}
        </>
      )}

      <FormStatus error={mutation.error} notice={mutation.notice} />

      <CollectionState
        action={uploadControls}
        emptyIcon="layers"
        emptyText="Фото підʼїзду чи дошки оголошень допомагає наступному агітатору знайти вхід."
        emptyTitle="Файлів ще немає"
        state={state}
      />

      {state.items.length > 0 && (
        <ul className={styles.fileList}>
          {state.items.map((file) => (
            <li className={styles.fileRow} key={file.id}>
              <a
                className={styles.fileLink}
                href={file.url}
                rel="noreferrer noopener"
                target="_blank"
              >
                <ElectionsIcon
                  name={file.kind === 'photo' ? 'building' : 'note'}
                  size={16}
                />
                {file.fileName}
              </a>

              <small>
                {formatDate(file.createdAt)} · {formatAssignee(file.uploadedBy)} ·{' '}
                {formatSize(file.byteSize)}
                {file.note ? ` · ${file.note}` : ''}
              </small>

              {canEdit && (
                <ConfirmButton
                  confirmLabel="Видалити"
                  isBusy={mutation.isBusy}
                  onConfirm={async () => {
                    const done = await mutation.run(
                      () => deleteAttachment(file.id, { campaignId }),
                      'Файл видалено.',
                    );

                    if (done) {
                      onChanged();
                    }

                    return Boolean(done);
                  }}
                  question="Видалити файл?"
                  variant="quiet"
                >
                  <ElectionsIcon name="trash" size={14} />
                  <span className="sr-only">Видалити {file.fileName}</span>
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default FilesSection;
