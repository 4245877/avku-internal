import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildCertificatePayload,
  buildDownloadFileName,
  createFormFromRecord,
  addOneYear,
  getCertificateStatus,
  getEmptyCertificateForm,
  hasValidationErrors,
  validateCertificateForm,
} from '../../features/certificates/certificateUtils.js';
import {
  createCertificate,
  downloadBlob,
  downloadCertificate,
  fetchCertificateTemplate,
  fetchCertificates,
  renewCertificate,
  updateCertificate,
} from '../../features/certificates/certificateApi.js';
import CertificateForm from './components/CertificateForm.jsx';
import CertificatePreview from './components/CertificatePreview.jsx';
import CertificateRegistry from './components/CertificateRegistry.jsx';
import PhotoCropper from './components/PhotoCropper.jsx';
import styles from './CertificatesPage.module.css';

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function upsertRecord(records, nextRecord) {
  const otherRecords = records.filter((record) => record.id !== nextRecord.id);

  return [nextRecord, ...otherRecords].sort((first, second) =>
    second.updatedAt.localeCompare(first.updatedAt),
  );
}

function CertificatesPage() {
  const photoInputRef = useRef(null);
  const [template, setTemplate] = useState(null);
  const [records, setRecords] = useState([]);
  const [form, setForm] = useState(getEmptyCertificateForm);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [exportingFormat, setExportingFormat] = useState('');
  const [registryAction, setRegistryAction] = useState(null);

  const activeCount = useMemo(
    () => records.filter((record) => getCertificateStatus(record.validUntil).tone === 'active').length,
    [records],
  );
  const expiredCount = useMemo(
    () => records.filter((record) => getCertificateStatus(record.validUntil).tone === 'expired').length,
    [records],
  );
  const currentSnapshot = useMemo(
    () => JSON.stringify(buildCertificatePayload(form)),
    [form],
  );
  const isDirty = currentSnapshot !== savedSnapshot;
  const selectedRecord = records.find((record) => record.id === form.id) ?? null;
  const previewImageUrl = form.photoDataUrl || form.photoUrl;

  const setCleanForm = useCallback((nextForm) => {
    setForm(nextForm);
    setSavedSnapshot(JSON.stringify(buildCertificatePayload(nextForm)));
    setErrors({});
  }, []);

  const confirmUnsavedChanges = useCallback(() => {
    if (!isDirty) {
      return true;
    }

    return window.confirm('Есть несохранённые изменения. Продолжить без сохранения?');
  }, [isDirty]);

  useEffect(() => {
    let isMounted = true;

    Promise.all([
      fetchCertificateTemplate(),
      fetchCertificates(),
    ])
      .then(([nextTemplate, nextRecords]) => {
        if (!isMounted) {
          return;
        }

        const nextForm = getEmptyCertificateForm();

        setTemplate(nextTemplate);
        setRecords(nextRecords);
        setCleanForm(nextForm);
        setNotice('');
      })
      .catch((error) => {
        if (isMounted) {
          setNotice(error instanceof Error ? error.message : 'Не удалось загрузить модуль удостоверений.');
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [setCleanForm]);

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
    if (!confirmUnsavedChanges()) {
      return;
    }

    setCleanForm(getEmptyCertificateForm());
    setNotice('');
  }, [confirmUnsavedChanges, setCleanForm]);

  const openRecord = useCallback((record) => {
    if (!confirmUnsavedChanges()) {
      return false;
    }

    setCleanForm(createFormFromRecord(record));
    setNotice('');
    return true;
  }, [confirmUnsavedChanges, setCleanForm]);

  const handlePhotoChange = useCallback(async (event) => {
    const [file] = event.target.files;

    if (!file) {
      return;
    }

    try {
      const photoDataUrl = await readFileAsDataUrl(file);

      setForm((currentForm) => ({
        ...currentForm,
        photoDataUrl,
      }));
      setErrors((currentErrors) => ({
        ...currentErrors,
        photo: '',
      }));
      setNotice('');
    } catch {
      setNotice('Не удалось прочитать фотографию.');
    } finally {
      event.target.value = '';
    }
  }, []);

  const saveForm = useCallback(async () => {
    const nextErrors = validateCertificateForm(form);

    setErrors(nextErrors);

    if (hasValidationErrors(nextErrors)) {
      setNotice('Заполните обязательные поля и загрузите фотографию.');
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
      setNotice('Удостоверение сохранено.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось сохранить удостоверение.');
    } finally {
      setIsSaving(false);
    }
  }, [form, setCleanForm]);

  const renewCurrentForm = useCallback(() => {
    setForm((currentForm) => ({
      ...currentForm,
      validUntil: addOneYear(currentForm.validUntil),
    }));
  }, []);

  const renewRecord = useCallback(async (record) => {
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

      setNotice('Срок действия продлён.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось продлить удостоверение.');
    } finally {
      setRegistryAction(null);
    }
  }, [form.id, setCleanForm]);

  const replacePhotoFromRegistry = useCallback((record) => {
    if (!openRecord(record)) {
      return;
    }

    window.setTimeout(() => {
      photoInputRef.current?.click();
    }, 0);
  }, [openRecord]);

  const exportRecord = useCallback(async (record, format) => {
    setRegistryAction({
      id: record.id,
      type: format,
    });

    try {
      const blob = await downloadCertificate(record, format);

      downloadBlob(blob, buildDownloadFileName(record, format));
      setNotice(`${format.toUpperCase()} сформирован.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Не удалось сформировать ${format.toUpperCase()}.`);
    } finally {
      setRegistryAction(null);
    }
  }, []);

  const exportCurrentRecord = useCallback(async (format) => {
    if (!selectedRecord) {
      setNotice('Сначала сохраните удостоверение.');
      return;
    }

    if (isDirty) {
      setNotice('Сохраните изменения перед экспортом.');
      return;
    }

    setExportingFormat(format);

    try {
      const blob = await downloadCertificate(selectedRecord, format);

      downloadBlob(blob, buildDownloadFileName(selectedRecord, format));
      setNotice(`${format.toUpperCase()} сформирован.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Не удалось сформировать ${format.toUpperCase()}.`);
    } finally {
      setExportingFormat('');
    }
  }, [isDirty, selectedRecord]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.eyebrow}>Документы</p>
          <h1 className={styles.title}>Удостоверения</h1>
          <p className={styles.description}>
            Реестр, редактор, предпросмотр и серверный экспорт удостоверений в PNG и PDF.
          </p>
        </div>

        <div className={styles.headerActions}>
          <button className={styles.secondaryButton} type="button" onClick={startNewRecord}>
            Новая запись
          </button>
          <button className={styles.primaryButton} type="button" onClick={saveForm} disabled={isSaving || loading}>
            {isSaving ? 'Сохранение...' : 'Сохранить'}
          </button>
        </div>
      </header>

      <section className={styles.statsGrid} aria-label="Сводка реестра">
        <div className={styles.statItem}>
          <span>Всего</span>
          <strong>{records.length}</strong>
        </div>
        <div className={styles.statItem}>
          <span>Действуют</span>
          <strong>{activeCount}</strong>
        </div>
        <div className={styles.statItem}>
          <span>Истекли</span>
          <strong>{expiredCount}</strong>
        </div>
      </section>

      {notice ? <p className={styles.notice} aria-live="polite">{notice}</p> : null}

      <section className={styles.workspace}>
        <CertificateRegistry
          records={records}
          selectedId={form.id}
          loading={loading}
          actionState={registryAction}
          onOpen={openRecord}
          onRenew={renewRecord}
          onReplacePhoto={replacePhotoFromRegistry}
          onExport={exportRecord}
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
            photoFrame={template?.layout.photo}
            error={errors.photo}
            onCropChange={updateCrop}
            onPhotoChange={handlePhotoChange}
          />
        </div>

        <CertificatePreview
          form={form}
          template={template}
          imageUrl={previewImageUrl}
          isExportDisabled={!selectedRecord || isDirty || Boolean(exportingFormat)}
          exportingFormat={exportingFormat}
          onExport={exportCurrentRecord}
        />
      </section>
    </main>
  );
}

export default CertificatesPage;
