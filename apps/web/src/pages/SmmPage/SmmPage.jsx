import styles from '../SectionPage.module.css';

function SmmPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Социальные сети</p>

          <h1 className={styles.title}>SMM</h1>

          <p className={styles.description}>
            Раздел для подготовки публикаций, контроля контент-плана
            и работы с материалами для социальных сетей.
          </p>
        </div>
      </header>

      <section className={styles.emptyState}>
        <p className={styles.emptyCode}>SMM MODULE</p>

        <h2 className={styles.panelTitle}>
          Раздел находится в разработке
        </h2>

        <p className={styles.panelText}>
          Функциональность будет добавлена после уточнения требований.
        </p>
      </section>
    </main>
  );
}

export default SmmPage;