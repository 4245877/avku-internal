import styles from '../SectionPage.module.css';

function CertificatesPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Документи</p>

          <h1 className={styles.title}>Посвідчення</h1>

          <p className={styles.description}>
            Зберігання, додавання та керування посвідченнями. Документи
            можна буде створювати вручну або завантажувати у форматі PDF.
          </p>
        </div>

        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            disabled
            title="Функцію буде додано пізніше"
          >
            Додати вручну
          </button>

          <button
            className={styles.secondaryButton}
            type="button"
            disabled
            title="Функцію буде додано пізніше"
          >
            Завантажити PDF
          </button>
        </div>
      </header>

      <section className={styles.grid}>
        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>Реєстр</h2>

          <p className={styles.panelText}>
            Тут з&apos;явиться таблиця посвідчень із пошуком, фільтрацією
            та сортуванням.
          </p>
        </article>

        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>Завантаження PDF</h2>

          <p className={styles.panelText}>
            Документи можна буде завантажувати, переглядати та
            пов&apos;язувати із записом посвідчення.
          </p>
        </article>

        <article className={styles.panel}>
          <h2 className={styles.panelTitle}>Керування</h2>

          <p className={styles.panelText}>
            Для кожного запису будуть доступні перегляд, редагування та
            видалення.
          </p>
        </article>
      </section>
    </main>
  );
}

export default CertificatesPage;
