import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addOneYear,
  buildCertificateSnapshot,
  buildCertificatePayload,
  buildDownloadFileName,
  createFormFromRecord,
  getCertificateStatus,
  getEmptyCertificateForm,
  hasValidationErrors,
  validateCertificateForm,
} from '../../features/certificates/certificateUtils.js';
import {
  createCertificate,
  deleteCertificate,
  downloadBlob,
  downloadCertificate,
  fetchCertificates,
  fetchCertificateTemplate,
  renewCertificate,
  updateCertificate,
} from '../../features/certificates/certificateApi.js';
import CertificateForm from './components/CertificateForm.jsx';
import CertificatePreview from './components/CertificatePreview.jsx';
import CertificateRegistry from './components/CertificateRegistry.jsx';
import DeleteCertificateDialog from './components/DeleteCertificateDialog.jsx';
import PhotoCropper from './components/PhotoCropper.jsx';
import styles from './CertificatesPage.module.css';

const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const PHOTO_TYPE_BY_EXTENSION = new Map([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

const NOTICE_STYLE_BY_TYPE = {
  error: 'noticeError',
  info: 'noticeInfo',
  success: 'noticeSuccess',
  warning: 'noticeWarning',
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Не вдалося прочитати файл.'));
    reader.readAsDataURL(file);
  });
}

function getErrorMessage(error, fallbackMessage) {
  return error instanceof Error && error.message
    ? error.message
    : fallbackMessage;
}

function getRecordTimestamp(record) {
  const timestamp = Date.parse(record?.updatedAt ?? '');

  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortRecordsByUpdatedAt(records) {
  return [...records].sort((first, second) => {
    const timestampDifference = getRecordTimestamp(second) - getRecordTimestamp(first);

    if (timestampDifference !== 0) {
      return timestampDifference;
    }

    return String(second?.id ?? '').localeCompare(String(first?.id ?? ''));
  });
}

function upsertRecord(records, nextRecord) {
  const otherRecords = records.filter((record) => record.id !== nextRecord.id);

  return sortRecordsByUpdatedAt([nextRecord, ...otherRecords]);
}

function normalizePhotoMimeType(value) {
  const mimeType = String(value ?? '').toLowerCase();

  if (mimeType === 'image/jpg' || mimeType === 'image/pjpeg') {
    return 'image/jpeg';
  }

  return ALLOWED_PHOTO_TYPES.has(mimeType) ? mimeType : '';
}

function getPhotoMimeType(file) {
  const fileMimeType = normalizePhotoMimeType(file.type);

  if (fileMimeType) {
    return fileMimeType;
  }

  const extension = file.name
    .split('.')
    .pop()
    ?.toLowerCase();

  return PHOTO_TYPE_BY_EXTENSION.get(extension) ?? '';
}

function normalizePhotoDataUrl(dataUrl, mimeType) {
  if (!mimeType) {
    return dataUrl;
  }

  return dataUrl.replace(
    /^data:[^;]*;base64,/i,
    `data:${mimeType};base64,`,
  );
}

function validatePhotoFile(file) {
  if (!getPhotoMimeType(file)) {
    return 'Підтримуються фотографії у форматах JPG, PNG та WebP.';
  }

  if (file.size === 0) {
    return 'Файл фотографії порожній.';
  }

  if (file.size > MAX_PHOTO_SIZE_BYTES) {
    return 'Розмір фотографії не повинен перевищувати 10 МБ.';
  }

  return '';
}

function CertificatesPage() {
  const photoInputRef = useRef(null);

  const [template, setTemplate] = useState(null);
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(getEmptyCertificateForm);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [registryLoadError, setRegistryLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [exportingFormat, setExportingFormat] = useState('');
  const [registryAction, setRegistryAction] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [shouldOpenPhotoPicker, setShouldOpenPhotoPicker] = useState(false);

  const statusSummary = useMemo(() => {
    return records.reduce(
      (summary, record) => {
        const { tone } = getCertificateStatus(record.validUntil);

        if (tone === 'active') {
          summary.active += 1;
        } else if (tone === 'soon') {
          summary.soon += 1;
        } else if (tone === 'expired') {
          summary.expired += 1;
        } else {
          summary.muted += 1;
        }

        return summary;
      },
      { active: 0, soon: 0, expired: 0, muted: 0 },
    );
  }, [records]);

  const currentSnapshot = useMemo(
    () => buildCertificateSnapshot(form),
    [form],
  );

  const isDirty = currentSnapshot !== savedSnapshot;
  const selectedRecord = useMemo(
    () => records.find((record) => record.id === form.id) ?? null,
    [form.id, records],
  );
  const previewImageUrl = form.photoDataUrl || form.photoUrl;
  const isAnyActionRunning = Boolean(
    loading || isSaving || exportingFormat || registryAction,
  );

  const showNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const setCleanForm = useCallback((nextForm) => {
    setForm(nextForm);
    setSavedSnapshot(buildCertificateSnapshot(nextForm));
    setErrors({});
  }, []);

  const confirmUnsavedChanges = useCallback(() => {
    if (!isDirty) {
      return true;
    }

    return window.confirm(
      'Є незбережені зміни. Продовжити без збереження?',
    );
  }, [isDirty]);

  useEffect(() => {
    let isMounted = true;

    async function loadCertificatesModule() {
      const [templateResult, recordsResult] = await Promise.allSettled([
        fetchCertificateTemplate(),
        fetchCertificates(),
      ]);

      if (!isMounted) {
        return;
      }

      const loadingErrors = [];

      if (templateResult.status === 'fulfilled') {
        setTemplate(templateResult.value);

        if (templateResult.value.warning) {
          loadingErrors.push(templateResult.value.warning);
        }
      } else {
        loadingErrors.push(
          getErrorMessage(
            templateResult.reason,
            'Не вдалося завантажити шаблон посвідчення.',
          ),
        );
      }

      if (recordsResult.status === 'fulfilled') {
        setRecords(sortRecordsByUpdatedAt(recordsResult.value));
        setRegistryLoadError('');
      } else {
        const recordsMessage = getErrorMessage(
          recordsResult.reason,
          'Не вдалося завантажити реєстр посвідчень.',
        );

        setRegistryLoadError(recordsMessage);
        loadingErrors.push(
          recordsMessage,
        );
      }

      setCleanForm(getEmptyCertificateForm());

      if (loadingErrors.length === 0) {
        clearNotice();
      } else {
        showNotice(
          loadingErrors.length === 2 ? 'error' : 'warning',
          loadingErrors.join(' '),
        );
      }

      setLoading(false);
    }

    loadCertificatesModule().catch((error) => {
      if (!isMounted) {
        return;
      }

      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося завантажити модуль посвідчень.'),
      );
      setRegistryLoadError(
        getErrorMessage(error, 'Не вдалося завантажити реєстр посвідчень.'),
      );
      setCleanForm(getEmptyCertificateForm());
      setLoading(false);
    });

    return () => {
      isMounted = false;
    };
  }, [clearNotice, setCleanForm, showNotice]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (!isDirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isDirty]);

  useEffect(() => {
    if (!shouldOpenPhotoPicker) {
      return;
    }

    const photoInput = photoInputRef.current;

    if (photoInput) {
      photoInput.click();
    }

    setShouldOpenPhotoPicker(false);
  }, [form.id, shouldOpenPhotoPicker]);

  const updateField = useCallback((field, value) => {
    setForm((currentForm) => ({
      ...currentForm,
      [field]: value,
    }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      [field]: '',
    }));
  }, []);

  const updateCrop = useCallback((photoCrop) => {
    setForm((currentForm) => ({
      ...currentForm,
      photoCrop,
    }));
  }, []);

  const startNewRecord = useCallback(() => {
    if (isAnyActionRunning || !confirmUnsavedChanges()) {
      return;
    }

    setCleanForm(getEmptyCertificateForm());
    clearNotice();
  }, [clearNotice, confirmUnsavedChanges, isAnyActionRunning, setCleanForm]);

  const openRecord = useCallback((record) => {
    if (isAnyActionRunning || !confirmUnsavedChanges()) {
      return false;
    }

    setCleanForm(createFormFromRecord(record));
    clearNotice();
    return true;
  }, [clearNotice, confirmUnsavedChanges, isAnyActionRunning, setCleanForm]);

  const handlePhotoChange = useCallback(async (event) => {
    const input = event.currentTarget;
    const [file] = input.files ?? [];

    if (!file) {
      return;
    }

    const validationMessage = validatePhotoFile(file);

    if (validationMessage) {
      setErrors((currentErrors) => ({
        ...currentErrors,
        photo: validationMessage,
      }));
      showNotice('error', validationMessage);
      input.value = '';
      return;
    }

    try {
      const photoDataUrl = normalizePhotoDataUrl(
        await readFileAsDataUrl(file),
        getPhotoMimeType(file),
      );
      const defaultPhotoCrop = getEmptyCertificateForm().photoCrop;

      setForm((currentForm) => ({
        ...currentForm,
        photoDataUrl,
        photoFile: file,
        photoUrl: '',
        photoCrop: defaultPhotoCrop,
      }));
      setErrors((currentErrors) => ({
        ...currentErrors,
        photo: '',
      }));
      clearNotice();
    } catch (error) {
      const message = getErrorMessage(error, 'Не вдалося прочитати фотографію.');

      setErrors((currentErrors) => ({
        ...currentErrors,
        photo: message,
      }));
      showNotice('error', message);
    } finally {
      input.value = '';
    }
  }, [clearNotice, showNotice]);

  const saveForm = useCallback(async () => {
    if (loading || isSaving || registryAction || exportingFormat) {
      return;
    }

    if (!isDirty) {
      showNotice('info', 'Усі зміни вже збережено.');
      return;
    }

    const nextErrors = validateCertificateForm(form);

    setErrors(nextErrors);

    if (hasValidationErrors(nextErrors)) {
      showNotice(
        'error',
        "Заповніть обов'язкові поля та завантажте фотографію.",
      );
      return;
    }

    setIsSaving(true);

    try {
      const payload = buildCertificatePayload(form);
      const savedRecord = form.id
        ? await updateCertificate(form.id, payload)
        : await createCertificate(payload);
      const nextForm = createFormFromRecord(savedRecord);

      setRecords((currentRecords) => upsertRecord(currentRecords, savedRecord));
      setCleanForm(nextForm);
      showNotice('success', 'Посвідчення збережено.');
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося зберегти посвідчення.'),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    exportingFormat,
    form,
    isDirty,
    isSaving,
    loading,
    registryAction,
    setCleanForm,
    showNotice,
  ]);

  const renewCurrentForm = useCallback(() => {
    if (isAnyActionRunning) {
      return;
    }

    setForm((currentForm) => ({
      ...currentForm,
      validUntil: addOneYear(currentForm.validUntil),
    }));
    showNotice('info', 'Дату подовжено на один рік. Збережіть зміни.');
  }, [isAnyActionRunning, showNotice]);

  const renewRecord = useCallback(async (record) => {
    if (isAnyActionRunning) {
      return;
    }

    if (form.id === record.id && !confirmUnsavedChanges()) {
      return;
    }

    setRegistryAction({
      id: record.id,
      type: 'renew',
    });

    try {
      const renewedRecord = await renewCertificate(record.id);

      setRecords((currentRecords) => upsertRecord(currentRecords, renewedRecord));

      if (form.id === renewedRecord.id) {
        setCleanForm(createFormFromRecord(renewedRecord));
      }

      showNotice('success', 'Термін дії подовжено.');
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося подовжити посвідчення.'),
      );
    } finally {
      setRegistryAction(null);
    }
  }, [
    confirmUnsavedChanges,
    form.id,
    isAnyActionRunning,
    setCleanForm,
    showNotice,
  ]);

  const replacePhotoFromRegistry = useCallback((record) => {
    if (!openRecord(record)) {
      return;
    }

    setShouldOpenPhotoPicker(true);
  }, [openRecord]);

  const exportRecord = useCallback(async (record, format) => {
    if (isAnyActionRunning) {
      return;
    }

    if (form.id === record.id && isDirty) {
      showNotice('warning', 'Збережіть зміни перед експортом.');
      return;
    }

    setRegistryAction({
      id: record.id,
      type: format,
    });

    try {
      const blob = await downloadCertificate(record, format);

      downloadBlob(blob, buildDownloadFileName(record, format));
      showNotice('success', `${format.toUpperCase()} сформовано.`);
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(
          error,
          `Не вдалося сформувати ${format.toUpperCase()}.`,
        ),
      );
    } finally {
      setRegistryAction(null);
    }
  }, [form.id, isAnyActionRunning, isDirty, showNotice]);

  const requestDeleteRecord = useCallback((record) => {
    if (isAnyActionRunning) {
      return;
    }

    if (form.id === record.id && !confirmUnsavedChanges()) {
      return;
    }

    setDeleteCandidate(record);
    clearNotice();
  }, [
    clearNotice,
    confirmUnsavedChanges,
    form.id,
    isAnyActionRunning,
  ]);

  const closeDeleteDialog = useCallback(() => {
    if (registryAction?.type === 'delete') {
      return;
    }

    setDeleteCandidate(null);
  }, [registryAction]);

  const confirmDeleteRecord = useCallback(async () => {
    if (!deleteCandidate || isAnyActionRunning) {
      return;
    }

    setRegistryAction({
      id: deleteCandidate.id,
      type: 'delete',
    });

    try {
      await deleteCertificate(deleteCandidate.id);

      setRecords((currentRecords) =>
        currentRecords.filter((record) => record.id !== deleteCandidate.id),
      );

      if (form.id === deleteCandidate.id) {
        setCleanForm(getEmptyCertificateForm());
      }

      setDeleteCandidate(null);
      showNotice('success', 'Посвідчення видалено.');
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(error, 'Не вдалося видалити посвідчення.'),
      );
    } finally {
      setRegistryAction(null);
    }
  }, [
    deleteCandidate,
    form.id,
    isAnyActionRunning,
    setCleanForm,
    showNotice,
  ]);

  const exportCurrentRecord = useCallback(async (format) => {
    if (loading || isSaving || registryAction || exportingFormat) {
      return;
    }

    if (!selectedRecord) {
      showNotice('warning', 'Спочатку збережіть посвідчення.');
      return;
    }

    if (isDirty) {
      showNotice('warning', 'Збережіть зміни перед експортом.');
      return;
    }

    setExportingFormat(format);

    try {
      const blob = await downloadCertificate(selectedRecord, format);

      downloadBlob(blob, buildDownloadFileName(selectedRecord, format));
      showNotice('success', `${format.toUpperCase()} сформовано.`);
    } catch (error) {
      showNotice(
        'error',
        getErrorMessage(
          error,
          `Не вдалося сформувати ${format.toUpperCase()}.`,
        ),
      );
    } finally {
      setExportingFormat('');
    }
  }, [
    exportingFormat,
    isDirty,
    isSaving,
    loading,
    registryAction,
    selectedRecord,
    showNotice,
  ]);

  const noticeClassName = notice
    ? [styles.notice, styles[NOTICE_STYLE_BY_TYPE[notice.type]]]
      .filter(Boolean)
      .join(' ')
    : '';

  return (
    <main
      className={styles.page}
      aria-busy={loading || isSaving}
    >
      <header className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.eyebrow}>Документи</p>
          <h1 className={styles.title}>Посвідчення</h1>
          <p className={styles.description}>
            Реєстр, редактор, попередній перегляд та серверний експорт посвідчень у PNG та PDF.
          </p>
        </div>

        <div className={styles.headerActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={startNewRecord}
            disabled={isAnyActionRunning}
          >
            Новий запис
          </button>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={saveForm}
            disabled={isAnyActionRunning || !isDirty}
          >
            {isSaving ? 'Збереження…' : 'Зберегти'}
          </button>
        </div>
      </header>

      <section className={styles.statsGrid} aria-label="Статистика реєстру">
        <div className={styles.statItem}>
          <span>Всього</span>
          <strong>{records.length}</strong>
        </div>
        <div className={styles.statItem}>
          <span>Активні</span>
          <strong>{statusSummary.active}</strong>
        </div>
        <div className={styles.statItem}>
          <span>Незабаром спливають</span>
          <strong>{statusSummary.soon}</strong>
        </div>
        <div className={styles.statItem}>
          <span>Прострочені</span>
          <strong>{statusSummary.expired}</strong>
        </div>
        <div className={styles.statItem}>
          <span>Без статусу</span>
          <strong>{statusSummary.muted}</strong>
        </div>
      </section>

      <div
        className={styles.noticeRegion}
        aria-live="polite"
        aria-atomic="true"
      >
        {notice ? (
          <div
            className={noticeClassName}
            role={notice.type === 'error' ? 'alert' : 'status'}
          >
            <span>{notice.text}</span>
            <button
              className={styles.noticeCloseButton}
              type="button"
              onClick={clearNotice}
              aria-label="Закрити сповіщення"
            >
              Закрити
            </button>
          </div>
        ) : null}
      </div>

      <section className={styles.workspace}>
        <CertificateRegistry
          records={records}
          selectedId={form.id}
          loading={loading}
          loadError={registryLoadError}
          actionState={registryAction}
          onOpen={openRecord}
          onRenew={renewRecord}
          onReplacePhoto={replacePhotoFromRegistry}
          onExport={exportRecord}
          onDelete={requestDeleteRecord}
        />

        <div className={styles.editorStack}>
          <CertificateForm
            form={form}
            errors={errors}
            isSaving={isSaving}
            isDirty={isDirty}
            onChange={updateField}
            onRenew={renewCurrentForm}
            onSave={saveForm}
            onReset={startNewRecord}
          />

          <PhotoCropper
            ref={photoInputRef}
            imageUrl={previewImageUrl}
            crop={form.photoCrop}
            photoFrame={template?.layout?.photo}
            error={errors.photo}
            onCropChange={updateCrop}
            onPhotoChange={handlePhotoChange}
          />
        </div>

        <CertificatePreview
          form={form}
          template={template}
          imageUrl={previewImageUrl}
          isExportDisabled={
            !selectedRecord
            || isDirty
            || isAnyActionRunning
          }
          exportingFormat={exportingFormat}
          onExport={exportCurrentRecord}
        />
      </section>

      <DeleteCertificateDialog
        record={deleteCandidate}
        isDeleting={registryAction?.type === 'delete'}
        onCancel={closeDeleteDialog}
        onConfirm={confirmDeleteRecord}
      />
    </main>
  );
}

export default CertificatesPage;
