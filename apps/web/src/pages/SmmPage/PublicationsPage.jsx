import { useMemo, useState } from 'react';
import SmmIcon from '../../features/smm/SmmIcon.jsx';
import { useSmmData } from '../../features/smm/SmmDataContext.jsx';
import {
  formatDate,
  getMaterialTitle,
  getPlatformClassName,
  getStatusClassName,
  publicationFormats,
  publicationStatuses,
} from '../../features/smm/smmUtils.js';
import styles from './SmmPage.module.css';

const emptyPublication = {
  title: '',
  materialIds: [],
  platform: 'Instagram',
  format: 'Пост',
  content: '',
  publishDate: new Date().toISOString().slice(0, 10),
  status: 'Ідея',
};

function PublicationsPage() {
  const {
    materials,
    publications,
    addPublication,
    updatePublicationStatus,
  } = useSmmData();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyPublication);
  const [platformFilter, setPlatformFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [message, setMessage] = useState('');

  const filteredPublications = useMemo(
    () =>
      publications.filter(
        (publication) =>
          (platformFilter === 'all' ||
            publication.platform === platformFilter) &&
          (statusFilter === 'all' || publication.status === statusFilter),
      ),
    [platformFilter, publications, statusFilter],
  );

  const materialMap = useMemo(
    () => new Map(materials.map((material) => [material.id, material])),
    [materials],
  );

  function updateField(event) {
    const { name, value } = event.target;

    setForm((currentForm) => {
      if (name === 'platform') {
        return {
          ...currentForm,
          platform: value,
          format: publicationFormats[value][0],
        };
      }

      return {
        ...currentForm,
        [name]: value,
      };
    });
  }

  function toggleMaterial(materialId) {
    setForm((currentForm) => ({
      ...currentForm,
      materialIds: currentForm.materialIds.includes(materialId)
        ? currentForm.materialIds.filter((id) => id !== materialId)
        : [...currentForm.materialIds, materialId],
    }));
  }

  function handleSubmit(event) {
    event.preventDefault();

    if (!form.title.trim()) {
      setMessage('Вкажіть назву публікації.');
      return;
    }

    if (form.materialIds.length === 0) {
      setMessage('Оберіть хоча б один матеріал.');
      return;
    }

    addPublication({
      ...form,
      title: form.title.trim(),
      content: form.content.trim(),
    });

    setForm({
      ...emptyPublication,
      publishDate: new Date().toISOString().slice(0, 10),
    });
    setMessage('');
    setFormOpen(false);
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Контент-план</p>
          <h1 className={styles.pageTitle}>Публікації</h1>
          <p className={styles.pageDescription}>
            Оберіть матеріали, підготуйте текст або сценарій і ведіть
            публікацію від ідеї до виходу.
          </p>
        </div>

        <button
          className={styles.primaryButton}
          onClick={() => {
            setFormOpen((currentValue) => !currentValue);
            setMessage('');
          }}
          type="button"
        >
          <SmmIcon name={formOpen ? 'close' : 'plus'} size={18} />
          {formOpen ? 'Закрити форму' : 'Створити публікацію'}
        </button>
      </header>

      {formOpen && (
        <section className={styles.publicationFormPanel}>
          <div className={styles.formPanelHeader}>
            <div>
              <span className={styles.panelIcon}>
                <SmmIcon name="spark" size={19} />
              </span>
              <div>
                <h2>Нова публікація</h2>
                <p>Усі ключові параметри в одній картці</p>
              </div>
            </div>
            <span>Крок 1 з 1</span>
          </div>

          <form className={styles.publicationForm} onSubmit={handleSubmit}>
            <div className={styles.publicationFormMain}>
              <label className={styles.formField}>
                <span>Назва публікації</span>
                <input
                  name="title"
                  onChange={updateField}
                  placeholder="Робоча назва для контент-плану"
                  value={form.title}
                />
              </label>

              <div className={styles.formRow}>
                <label className={styles.formField}>
                  <span>Платформа</span>
                  <select
                    name="platform"
                    onChange={updateField}
                    value={form.platform}
                  >
                    <option>Instagram</option>
                    <option>YouTube</option>
                  </select>
                </label>

                <label className={styles.formField}>
                  <span>Формат</span>
                  <select
                    name="format"
                    onChange={updateField}
                    value={form.format}
                  >
                    {publicationFormats[form.platform].map((format) => (
                      <option key={format}>{format}</option>
                    ))}
                  </select>
                </label>

                <label className={styles.formField}>
                  <span>Дата публікації</span>
                  <input
                    name="publishDate"
                    onChange={updateField}
                    type="date"
                    value={form.publishDate}
                  />
                </label>

                <label className={styles.formField}>
                  <span>Статус</span>
                  <select
                    name="status"
                    onChange={updateField}
                    value={form.status}
                  >
                    {publicationStatuses.map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className={styles.formField}>
                <span>Текст або сценарій</span>
                <textarea
                  name="content"
                  onChange={updateField}
                  placeholder="Текст допису, структура Stories або сценарій відео"
                  rows="5"
                  value={form.content}
                />
              </label>
            </div>

            <fieldset className={styles.materialPicker}>
              <legend>Матеріали</legend>
              <p>Оберіть контент, який використовується в публікації</p>

              <div className={styles.materialPickerList}>
                {materials.map((material) => {
                  const selected = form.materialIds.includes(material.id);

                  return (
                    <label
                      className={`${styles.materialPickerItem} ${
                        selected ? styles.materialPickerItemSelected : ''
                      }`}
                      key={material.id}
                    >
                      <input
                        checked={selected}
                        onChange={() => toggleMaterial(material.id)}
                        type="checkbox"
                      />
                      <span className={styles.pickerCheck}>
                        {selected && <SmmIcon name="check" size={14} />}
                      </span>
                      <span>
                        <strong>{getMaterialTitle(material)}</strong>
                        <small>
                          {material.mediaType} · {formatDate(material.shootingDate)}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className={styles.formFooter}>
              {message ? (
                <p className={styles.formError} role="status">
                  {message}
                </p>
              ) : (
                <span>
                  Обрано матеріалів: <strong>{form.materialIds.length}</strong>
                </span>
              )}
              <button className={styles.primaryButton} type="submit">
                Створити публікацію
                <SmmIcon name="arrow" size={17} />
              </button>
            </div>
          </form>
        </section>
      )}

      <section className={styles.contentPanel}>
        <div className={styles.publicationToolbar}>
          <div className={styles.segmentedControl}>
            {['all', 'Instagram', 'YouTube'].map((platform) => (
              <button
                className={
                  platformFilter === platform ? styles.segmentActive : ''
                }
                key={platform}
                onClick={() => setPlatformFilter(platform)}
                type="button"
              >
                {platform === 'all' && 'Усі'}
                {platform === 'Instagram' && (
                  <>
                    <SmmIcon name="instagram" size={16} />
                    Instagram
                  </>
                )}
                {platform === 'YouTube' && (
                  <>
                    <SmmIcon name="youtube" size={17} />
                    YouTube
                  </>
                )}
              </button>
            ))}
          </div>

          <select
            aria-label="Фільтр за статусом"
            className={styles.filterSelect}
            onChange={(event) => setStatusFilter(event.target.value)}
            value={statusFilter}
          >
            <option value="all">Усі статуси</option>
            {publicationStatuses.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </div>

        <div className={styles.publicationList}>
          {filteredPublications.map((publication) => (
            <article className={styles.publicationCard} key={publication.id}>
              <div
                className={`${styles.platformRail} ${
                  styles[
                    `platformRail-${getPlatformClassName(
                      publication.platform,
                    )}`
                  ]
                }`}
              >
                <SmmIcon
                  name={
                    publication.platform === 'Instagram'
                      ? 'instagram'
                      : 'youtube'
                  }
                  size={19}
                />
              </div>

              <div className={styles.publicationBody}>
                <div className={styles.publicationHeading}>
                  <div>
                    <span className={styles.publicationMeta}>
                      {publication.platform} · {publication.format}
                    </span>
                    <h2>{publication.title}</h2>
                  </div>

                  <select
                    aria-label={`Статус публікації ${publication.title}`}
                    className={`${styles.statusSelect} ${
                      styles[
                        `statusSelect-${getStatusClassName(
                          publication.status,
                        )}`
                      ]
                    }`}
                    onChange={(event) =>
                      updatePublicationStatus(
                        publication.id,
                        event.target.value,
                      )
                    }
                    value={publication.status}
                  >
                    {publicationStatuses.map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </div>

                <p className={styles.publicationText}>
                  {publication.content || 'Текст або сценарій ще не додано.'}
                </p>

                <div className={styles.publicationFooter}>
                  <span>
                    <SmmIcon name="calendar" size={16} />
                    {formatDate(publication.publishDate)}
                  </span>

                  <div className={styles.selectedMaterials}>
                    {publication.materialIds.slice(0, 2).map((materialId) => {
                      const material = materialMap.get(materialId);

                      return material ? (
                        <span key={materialId}>
                          <SmmIcon name="material" size={14} />
                          {getMaterialTitle(material)}
                        </span>
                      ) : null;
                    })}

                    {publication.materialIds.length > 2 && (
                      <span>+{publication.materialIds.length - 2}</span>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}

          {filteredPublications.length === 0 && (
            <div className={styles.emptyResults}>
              <SmmIcon name="file" size={24} />
              <strong>Публікацій не знайдено</strong>
              <span>Змініть фільтри або створіть нову публікацію.</span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export default PublicationsPage;
