import { useMemo, useState } from 'react';
import SmmIcon from '../../features/smm/SmmIcon.jsx';
import { useSmmData } from '../../features/smm/SmmDataContext.jsx';
import {
  formatDate,
  getMaterialIssues,
  getMaterialTitle,
  permissionLabels,
} from '../../features/smm/smmUtils.js';
import styles from './SmmPage.module.css';

const emptyForm = {
  description: '',
  event: '',
  shootingDate: new Date().toISOString().slice(0, 10),
  author: '',
  permission: 'unknown',
  driveUrl: '',
  mediaType: 'Фото',
  fileNames: [],
};

function MaterialsPage() {
  const { materials, addMaterial } = useSmmData();
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState('');
  const [permissionFilter, setPermissionFilter] = useState('all');
  const [fileInputKey, setFileInputKey] = useState(0);
  const [message, setMessage] = useState('');

  const filteredMaterials = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return materials.filter((material) => {
      const matchesPermission =
        permissionFilter === 'all' ||
        material.permission === permissionFilter;
      const matchesSearch =
        !normalizedSearch ||
        [
          material.description,
          material.event,
          material.author,
          material.mediaType,
        ]
          .join(' ')
          .toLowerCase()
          .includes(normalizedSearch);

      return matchesPermission && matchesSearch;
    });
  }, [materials, permissionFilter, search]);

  function updateField(event) {
    const { name, value } = event.target;

    setForm((currentForm) => ({
      ...currentForm,
      [name]: value,
    }));
  }

  function updateFiles(event) {
    setForm((currentForm) => ({
      ...currentForm,
      fileNames: Array.from(event.target.files, (file) => file.name),
    }));
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (!form.event.trim() && !form.description.trim()) {
      setMessage('Додайте подію, проєкт або короткий опис.');
      return;
    }

    if (!form.author.trim()) {
      setMessage('Вкажіть автора матеріалу.');
      return;
    }

    addMaterial({
      ...form,
      description: form.description.trim(),
      event: form.event.trim(),
      author: form.author.trim(),
      driveUrl: form.driveUrl.trim(),
    });

    setForm({
      ...emptyForm,
      shootingDate: new Date().toISOString().slice(0, 10),
    });
    setFileInputKey((currentKey) => currentKey + 1);
    setMessage('Матеріал додано. Він уже доступний SMM-спеціалісту.');
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Банк контенту</p>
          <h1 className={styles.pageTitle}>Матеріали</h1>
          <p className={styles.pageDescription}>
            Швидко додайте фото, відео або посилання на Google Drive. Для
            нового матеріалу достатньо однієї хвилини.
          </p>
        </div>

        <div className={styles.headerStat}>
          <strong>{materials.length}</strong>
          <span>матеріалів у банку</span>
        </div>
      </header>

      <div className={styles.materialsLayout}>
        <section className={styles.contentPanel}>
          <div className={styles.toolbar}>
            <label className={styles.searchField}>
              <SmmIcon name="search" size={18} />
              <span className="sr-only">Пошук матеріалів</span>
              <input
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Пошук за подією, автором або описом"
                type="search"
                value={search}
              />
            </label>

            <select
              aria-label="Фільтр за дозволом на публікацію"
              className={styles.filterSelect}
              onChange={(event) => setPermissionFilter(event.target.value)}
              value={permissionFilter}
            >
              <option value="all">Усі дозволи</option>
              <option value="yes">Публікацію дозволено</option>
              <option value="unknown">Дозвіл невідомий</option>
              <option value="no">Публікацію заборонено</option>
            </select>
          </div>

          <div className={styles.resultsHeader}>
            <span>
              Знайдено: <strong>{filteredMaterials.length}</strong>
            </span>
            <span>Спочатку нові</span>
          </div>

          <div className={styles.materialCards}>
            {filteredMaterials.map((material) => {
              const issues = getMaterialIssues(material);

              return (
                <article className={styles.materialCard} key={material.id}>
                  <div
                    className={`${styles.materialVisual} ${
                      material.mediaType === 'Відео'
                        ? styles.materialVisualVideo
                        : ''
                    }`}
                  >
                    <SmmIcon
                      name={
                        material.mediaType === 'Відео' ? 'camera' : 'material'
                      }
                      size={26}
                    />
                    <span>{material.mediaType}</span>
                  </div>

                  <div className={styles.materialCardBody}>
                    <div className={styles.cardTopline}>
                      <span
                        className={`${styles.permissionBadge} ${
                          styles[`permissionBadge-${material.permission}`]
                        }`}
                      >
                        <span />
                        {permissionLabels[material.permission]}
                      </span>
                      <span>{formatDate(material.shootingDate)}</span>
                    </div>

                    <h2>{getMaterialTitle(material)}</h2>
                    <p>
                      {material.description ||
                        'Опис ще не додано. Матеріал потребує уточнення.'}
                    </p>

                    <div className={styles.materialMeta}>
                      <span>
                        <SmmIcon name="user" size={15} />
                        {material.author}
                      </span>

                      {material.driveUrl ? (
                        <a
                          href={material.driveUrl}
                          rel="noreferrer"
                          target="_blank"
                        >
                          <SmmIcon name="link" size={15} />
                          Google Drive
                        </a>
                      ) : material.fileNames.length > 0 ? (
                        <span>
                          <SmmIcon name="file" size={15} />
                          {material.fileNames.length} файли
                        </span>
                      ) : (
                        <span className={styles.missingMeta}>
                          <SmmIcon name="warning" size={15} />
                          Немає файлу
                        </span>
                      )}
                    </div>

                    {issues.length > 0 && (
                      <div className={styles.issueList}>
                        {issues.map((issue) => (
                          <span key={issue}>{issue}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}

            {filteredMaterials.length === 0 && (
              <div className={styles.emptyResults}>
                <SmmIcon name="search" size={24} />
                <strong>Матеріалів не знайдено</strong>
                <span>Змініть пошуковий запит або фільтр.</span>
              </div>
            )}
          </div>
        </section>

        <aside className={styles.quickAddPanel}>
          <div className={styles.quickAddHeader}>
            <span className={styles.panelIcon}>
              <SmmIcon name="plus" size={19} />
            </span>
            <div>
              <h2>Новий матеріал</h2>
              <p>Коротка форма для всієї команди</p>
            </div>
          </div>

          <form className={styles.quickForm} onSubmit={handleSubmit}>
            <label className={styles.formField}>
              <span>Подія або проєкт</span>
              <input
                name="event"
                onChange={updateField}
                placeholder="Наприклад, гуманітарний виїзд"
                value={form.event}
              />
            </label>

            <label className={styles.formField}>
              <span>Короткий опис</span>
              <textarea
                name="description"
                onChange={updateField}
                placeholder="Що є на фото або відео?"
                rows="3"
                value={form.description}
              />
            </label>

            <div className={styles.formRow}>
              <label className={styles.formField}>
                <span>Дата зйомки</span>
                <input
                  name="shootingDate"
                  onChange={updateField}
                  type="date"
                  value={form.shootingDate}
                />
              </label>

              <label className={styles.formField}>
                <span>Тип</span>
                <select
                  name="mediaType"
                  onChange={updateField}
                  value={form.mediaType}
                >
                  <option>Фото</option>
                  <option>Відео</option>
                  <option>Фото і відео</option>
                </select>
              </label>
            </div>

            <label className={styles.formField}>
              <span>Автор</span>
              <input
                name="author"
                onChange={updateField}
                placeholder="Ім’я та прізвище"
                value={form.author}
              />
            </label>

            <label className={styles.formField}>
              <span>Дозвіл на публікацію</span>
              <select
                name="permission"
                onChange={updateField}
                value={form.permission}
              >
                <option value="yes">Так</option>
                <option value="no">Ні</option>
                <option value="unknown">Невідомо</option>
              </select>
            </label>

            <label className={styles.formField}>
              <span>Посилання на Google Drive</span>
              <input
                name="driveUrl"
                onChange={updateField}
                placeholder="https://drive.google.com/..."
                type="url"
                value={form.driveUrl}
              />
              <small>Рекомендовано для великих файлів</small>
            </label>

            <label className={styles.fileField}>
              <input
                accept="image/*,video/*"
                key={fileInputKey}
                multiple
                onChange={updateFiles}
                type="file"
              />
              <span className={styles.fileDrop}>
                <SmmIcon name="camera" size={20} />
                <span>
                  <strong>Додати фото або відео</strong>
                  <small>
                    {form.fileNames.length > 0
                      ? `Обрано файлів: ${form.fileNames.length}`
                      : 'або використайте посилання вище'}
                  </small>
                </span>
              </span>
            </label>

            {message && (
              <p
                className={
                  message.startsWith('Матеріал')
                    ? styles.formSuccess
                    : styles.formError
                }
                role="status"
              >
                {message}
              </p>
            )}

            <button className={styles.primaryButton} type="submit">
              <SmmIcon name="plus" size={18} />
              Додати матеріал
            </button>
          </form>
        </aside>
      </div>
    </main>
  );
}

export default MaterialsPage;
