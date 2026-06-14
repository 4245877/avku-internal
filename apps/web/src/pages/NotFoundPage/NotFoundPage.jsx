import { Link } from 'react-router';
import styles from '../SectionPage.module.css';

function NotFoundPage() {
  return (
    <main className={styles.page}>
      <section className={styles.emptyState}>
        <p className={styles.emptyCode}>ERROR 404</p>

        <h1 className={styles.title}>Сторінку не знайдено</h1>

        <p className={styles.panelText}>
          Такої сторінки не існує або її адресу було змінено.
        </p>

        <Link className={styles.homeLink} to="/">
          Повернутися на Dashboard
        </Link>
      </section>
    </main>
  );
}

export default NotFoundPage;
