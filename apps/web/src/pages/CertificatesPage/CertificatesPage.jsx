import styles from '../SectionPage.module.css';

function CertificatesPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Документы</p>

          <h1 className={styles.title}>Удостоверения</h1>

          <p className={styles.description}>
            Хранение, добавление и управление удостоверениями.
            Документы можно будет создавать вручную или загружать
            в формате PDF.
          </p>
        </div>

        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            disabled
            title="Функция будет добавлена позднее"
          >
            Добавить вручную
          </button>

          <button
            className={styles.secondaryButton}
            type="button"
            disabled
            title="Функция будет добавлена позднее"
          >
            Загрузить PDF
          </button>
        </div>
      </header>

      <section className={styles.grid}>
        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>Реестр</h2>

          <p className={styles.panelText}>
            Здесь появится таблица удостоверений с поиском,
            фильтрацией и сортировкой.
          </p>
        </article>

        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>Загрузка PDF</h2>

          <p className={styles.panelText}>
            Документы можно будет загружать, просматривать
            и связывать с записью удостоверения.
          </p>
        </article>

        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>Управление</h2>

          <p className={styles.panelText}>
            Для каждой записи будут доступны просмотр,
            редактирование и удаление.
          </p>
        </article>
      </section>
    </main>
  );
}

export default CertificatesPage;