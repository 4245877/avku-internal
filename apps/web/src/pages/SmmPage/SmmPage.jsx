import { Link } from 'react-router';
import SmmIcon from '../../features/smm/SmmIcon.jsx';
import { useSmmData } from '../../features/smm/SmmDataContext.jsx';
import {
  formatShortDate,
  getMaterialIssues,
  getMaterialTitle,
  getPlatformClassName,
  getStatusClassName,
} from '../../features/smm/smmUtils.js';
import styles from './SmmPage.module.css';

function SmmPage() {
  const { materials, publications } = useSmmData();
  const now = new Date();
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + 7);

  const newMaterials = [...materials]
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt))
    .slice(0, 4);

  const upcomingPublications = publications
    .filter((publication) => {
      const publicationDate = new Date(`${publication.publishDate}T23:59:59`);

      return (
        publication.status !== 'Опубліковано' &&
        publicationDate >= now &&
        publicationDate <= nextWeek
      );
    })
    .sort((first, second) =>
      first.publishDate.localeCompare(second.publishDate),
    );

  const attentionMaterials = materials
    .map((material) => ({
      ...material,
      issues: getMaterialIssues(material),
    }))
    .filter((material) => material.issues.length > 0);

  const platformCounts = publications.reduce(
    (counts, publication) => ({
      ...counts,
      [publication.platform]: counts[publication.platform] + 1,
    }),
    { Instagram: 0, YouTube: 0 },
  );

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroContent}>
          <p className={styles.eyebrow}>SMM / комунікації</p>
          <h1 className={styles.heroTitle}>Контент без втрат у чатах</h1>
          <p className={styles.heroDescription}>
            Збирайте матеріали від команди, плануйте публікації та
            контролюйте вихід контенту в Instagram і YouTube.
          </p>

          <div className={styles.heroActions}>
            <Link className={styles.primaryButton} to="/smm/materials">
              <SmmIcon name="plus" size={18} />
              Додати матеріал
            </Link>
            <Link className={styles.secondaryButton} to="/smm/publications">
              Створити публікацію
              <SmmIcon name="arrow" size={17} />
            </Link>
          </div>
        </div>

        <div className={styles.channelOverview}>
          <article className={styles.channelCard}>
            <span
              className={`${styles.channelIcon} ${styles.channelIconInstagram}`}
            >
              <SmmIcon name="instagram" size={22} />
            </span>
            <div>
              <span>Instagram</span>
              <strong>{platformCounts.Instagram} публікації</strong>
            </div>
          </article>

          <article className={styles.channelCard}>
            <span
              className={`${styles.channelIcon} ${styles.channelIconYoutube}`}
            >
              <SmmIcon name="youtube" size={23} />
            </span>
            <div>
              <span>YouTube</span>
              <strong>{platformCounts.YouTube} публікації</strong>
            </div>
          </article>
        </div>
      </section>

      <section className={styles.dashboardGrid}>
        <article className={styles.dashboardPanel}>
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.panelIcon}>
                <SmmIcon name="material" size={19} />
              </span>
              <div>
                <h2>Нові матеріали</h2>
                <p>Нещодавно доданий контент команди</p>
              </div>
            </div>
            <Link to="/smm/materials">Усі матеріали</Link>
          </div>

          <div className={styles.materialPreviewList}>
            {newMaterials.map((material) => (
              <div className={styles.materialPreview} key={material.id}>
                <span className={styles.mediaThumbnail}>
                  <SmmIcon
                    name={material.mediaType === 'Відео' ? 'camera' : 'material'}
                    size={22}
                  />
                </span>
                <div className={styles.previewBody}>
                  <strong>{getMaterialTitle(material)}</strong>
                  <span>
                    {material.author} · {formatShortDate(material.shootingDate)}
                  </span>
                </div>
                <span
                  className={`${styles.permissionDot} ${
                    styles[`permission-${material.permission}`]
                  }`}
                  title={
                    material.permission === 'yes'
                      ? 'Публікацію дозволено'
                      : material.permission === 'no'
                        ? 'Публікацію заборонено'
                        : 'Дозвіл невідомий'
                  }
                />
              </div>
            ))}
          </div>
        </article>

        <article className={styles.dashboardPanel}>
          <div className={styles.panelHeader}>
            <div>
              <span className={styles.panelIcon}>
                <SmmIcon name="calendar" size={19} />
              </span>
              <div>
                <h2>Найближчі публікації</h2>
                <p>План на наступні сім днів</p>
              </div>
            </div>
            <Link to="/smm/calendar">Календар</Link>
          </div>

          <div className={styles.upcomingList}>
            {upcomingPublications.length > 0 ? (
              upcomingPublications.map((publication) => (
                <div className={styles.upcomingItem} key={publication.id}>
                  <div className={styles.dateTile}>
                    <strong>
                      {new Date(
                        `${publication.publishDate}T12:00:00`,
                      ).getDate()}
                    </strong>
                    <span>
                      {new Intl.DateTimeFormat('uk-UA', {
                        month: 'short',
                      }).format(
                        new Date(`${publication.publishDate}T12:00:00`),
                      )}
                    </span>
                  </div>
                  <div className={styles.previewBody}>
                    <strong>{publication.title}</strong>
                    <span>
                      {publication.platform} · {publication.format}
                    </span>
                  </div>
                  <span
                    className={`${styles.statusBadge} ${
                      styles[`status-${getStatusClassName(publication.status)}`]
                    }`}
                  >
                    {publication.status}
                  </span>
                </div>
              ))
            ) : (
              <div className={styles.compactEmptyState}>
                На найближчі сім днів публікацій немає.
              </div>
            )}
          </div>
        </article>

        <article
          className={`${styles.dashboardPanel} ${styles.attentionPanel}`}
        >
          <div className={styles.panelHeader}>
            <div>
              <span className={`${styles.panelIcon} ${styles.warningIcon}`}>
                <SmmIcon name="warning" size={19} />
              </span>
              <div>
                <h2>Потребує уваги</h2>
                <p>Дані, яких бракує для роботи</p>
              </div>
            </div>
            <span className={styles.attentionCount}>
              {attentionMaterials.length}
            </span>
          </div>

          <div className={styles.attentionList}>
            {attentionMaterials.map((material) => (
              <div className={styles.attentionItem} key={material.id}>
                <span className={styles.attentionMark}>!</span>
                <div>
                  <strong>{getMaterialTitle(material)}</strong>
                  <span>{material.issues.join(' · ')}</span>
                </div>
              </div>
            ))}
          </div>

          <Link className={styles.panelAction} to="/smm/materials">
            Перевірити матеріали
            <SmmIcon name="arrow" size={17} />
          </Link>
        </article>
      </section>

      <section className={styles.workflowStrip}>
        <span>Матеріал</span>
        <SmmIcon name="arrow" size={16} />
        <span>Публікація</span>
        <SmmIcon name="arrow" size={16} />
        <span>Планування</span>
        <SmmIcon name="arrow" size={16} />
        <span>Опубліковано</span>
      </section>
    </main>
  );
}

export default SmmPage;
