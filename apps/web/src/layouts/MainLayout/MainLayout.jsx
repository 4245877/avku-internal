import { Link, NavLink, Outlet } from 'react-router';
import styles from './MainLayout.module.css';

const navigationItems = [
  {
    path: '/',
    label: 'Dashboard',
    description: 'Общая информация',
    icon: 'D',
    end: true,
  },
  {
    path: '/certificates',
    label: 'Удостоверения',
    description: 'Документы и записи',
    icon: 'У',
  },
  {
    path: '/smm',
    label: 'SMM',
    description: 'Социальные сети',
    icon: 'S',
  },
];

function MainLayout() {
  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <Link
          className={styles.brand}
          to="/"
          aria-label="Перейти на главную страницу"
        >
          <span className={styles.brandMark}>А</span>

          <span className={styles.brandText}>
            <strong>АВКУ</strong>
            <small>Внутренняя система</small>
          </span>
        </Link>

        <nav
          className={styles.navigation}
          aria-label="Основная навигация"
        >
          <p className={styles.navigationLabel}>Разделы</p>

          <ul className={styles.navigationList}>
            {navigationItems.map((item) => (
              <li key={item.path}>
                <NavLink
                  to={item.path}
                  end={item.end}
                  className={({ isActive }) =>
                    [
                      styles.navigationLink,
                      isActive ? styles.navigationLinkActive : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                  }
                >
                  <span
                    className={styles.navigationIcon}
                    aria-hidden="true"
                  >
                    {item.icon}
                  </span>

                  <span className={styles.navigationText}>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={styles.statusIndicator} />

          <span>
            <strong>Система работает</strong>
            <small>AVKU Internal</small>
          </span>
        </div>
      </aside>

      <div className={styles.content}>
        <Outlet />
      </div>
    </div>
  );
}

export default MainLayout; 
