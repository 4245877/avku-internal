import styles from '../SectionPage.module.css';

function SmmPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Соціальні мережі</p>

          <h1 className={styles.title}>SMM</h1>

          <p className={styles.description}>
            Розділ для підготовки публікацій, контролю контент-плану та
            роботи з матеріалами для соціальних мереж.
          </p>
        </div>
      </header>

      <section className={styles.emptyState}>
        <p className={styles.emptyCode}>SMM MODULE</p>

        <h2 className={styles.panelTitle}>
          Розділ перебуває у розробці
        </h2>

        <p className={styles.panelText}>
          Функціональність буде додано після уточнення вимог.
        </p>
      </section>
    </main>
  );
}

export default SmmPage;
