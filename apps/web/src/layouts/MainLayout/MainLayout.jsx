import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import styles from './MainLayout.module.css';

const iconProps = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const SunIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const MoonIcon = () => (
  <svg {...iconProps}>
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const getInitialTheme = () =>
  (typeof document !== 'undefined' &&
    document.documentElement.dataset.theme === 'dark')
    ? 'dark'
    : 'light';

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
    path: '/warehouse-aid',
    label: 'Склад',
    description: 'Матеріальна допомога',
    icon: 'W',
  },
  {
    path: '/logistics-transfers',
    label: 'Логістика',
    description: 'Передачі допомоги',
    icon: 'L',
  },
  {
    path: '/smm',
    label: 'SMM',
    description: 'Instagram та YouTube',
    icon: 'S',
  },
];

function MainLayout() {
  const [theme, setTheme] = useState(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('avku-theme', theme);
    } catch {
      /* storage may be unavailable (private mode) — non-fatal */
    }
  }, [theme]);

  const isDark = theme === 'dark';
  const toggleTheme = () => setTheme((current) => (current === 'dark' ? 'light' : 'dark'));

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

        <button
          type="button"
          className={styles.themeToggle}
          onClick={toggleTheme}
          aria-pressed={isDark}
          aria-label={isDark ? 'Перемкнути на світлу тему' : 'Перемкнути на темну тему'}
        >
          <span className={styles.themeToggleIcon} aria-hidden="true">
            {isDark ? <SunIcon /> : <MoonIcon />}
          </span>
          <span className={styles.themeToggleLabel}>
            {isDark ? 'Світла тема' : 'Темна тема'}
          </span>
        </button>

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
