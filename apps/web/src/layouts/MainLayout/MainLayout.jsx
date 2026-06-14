import { Link, NavLink, Outlet } from 'react-router';
import styles from './MainLayout.module.css';

const navigationItems = [
  {
    path: '/',
    label: 'Dashboard',
    description: 'Загальна інформація',
    icon: 'D',
    end: true,
  },
  {
    path: '/certificates',
    label: 'Посвідчення',
    description: 'Документи та записи',
    icon: 'П',
  },
  {
    path: '/smm',
    label: 'SMM',
    description: 'Instagram та YouTube',
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
          aria-label="Перейти на головну сторінку"
        >
          <span className={styles.brandMark}>А</span>

          <span className={styles.brandText}>
            <strong>АВКУ</strong>
            <small>Внутрішня система</small>
          </span>
        </Link>

        <nav
          className={styles.navigation}
          aria-label="Основна навігація"
        >
          <p className={styles.navigationLabel}>Розділи</p>

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
            <strong>Система працює</strong>
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
