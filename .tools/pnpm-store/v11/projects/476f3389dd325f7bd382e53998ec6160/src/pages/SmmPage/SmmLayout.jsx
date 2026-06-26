import { Link, NavLink, Outlet } from 'react-router';
import SmmIcon from '../../features/smm/SmmIcon.jsx';
import { SmmDataProvider } from '../../features/smm/SmmDataContext.jsx';
import styles from './SmmPage.module.css';

const navigationItems = [
  { path: '/smm', label: 'Огляд', end: true },
  { path: '/smm/materials', label: 'Матеріали' },
  { path: '/smm/publications', label: 'Публікації' },
  { path: '/smm/calendar', label: 'Календар' },
];

function SmmLayout() {
  return (
    <SmmDataProvider>
      <div className={styles.smmShell}>
        <header className={styles.sectionHeader}>
          <Link className={styles.sectionBrand} to="/smm">
            <span className={styles.sectionBrandMark}>
              <SmmIcon name="spark" size={18} />
            </span>

            <span>
              <strong>SMM</strong>
              <small>Instagram та YouTube</small>
            </span>
          </Link>

          <nav className={styles.sectionNavigation} aria-label="Навігація SMM">
            {navigationItems.map((item) => (
              <NavLink
                className={({ isActive }) =>
                  [
                    styles.sectionNavigationLink,
                    isActive ? styles.sectionNavigationLinkActive : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                }
                end={item.end}
                key={item.path}
                to={item.path}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <Outlet />
      </div>
    </SmmDataProvider>
  );
}

export default SmmLayout;
