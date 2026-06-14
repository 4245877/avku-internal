import { Link } from 'react-router';
import styles from '../SectionPage.module.css';

function NotFoundPage() {
  return (
    <main className={styles.page}>
      <section className={styles.emptyState}>
        <p className={styles.emptyCode}>ERROR 404</p>

        <h1 className={styles.title}>Страница не найдена</h1>

        <p className={styles.panelText}>
          Такой страницы не существует или её адрес был изменён.
        </p>

        <Link className={styles.homeLink} to="/">
          Вернуться на Dashboard
        </Link>
      </section>
    </main>
  );
}

export default NotFoundPage;