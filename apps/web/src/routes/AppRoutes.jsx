import { Route, Routes } from 'react-router';

import MainLayout from '../layouts/MainLayout/MainLayout.jsx';
import DashboardPage from '../pages/DashboardPage/DashboardPage.jsx';
import CertificatesPage from '../pages/CertificatesPage/CertificatesPage.jsx';
import SmmLayout from '../pages/SmmPage/SmmLayout.jsx';
import SmmPage from '../pages/SmmPage/SmmPage.jsx';
import MaterialsPage from '../pages/SmmPage/MaterialsPage.jsx';
import PublicationsPage from '../pages/SmmPage/PublicationsPage.jsx';
import SmmCalendarPage from '../pages/SmmPage/SmmCalendarPage.jsx';
import NotFoundPage from '../pages/NotFoundPage/NotFoundPage.jsx';

function AppRoutes() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="certificates" element={<CertificatesPage />} />
        <Route path="smm" element={<SmmLayout />}>
          <Route index element={<SmmPage />} />
          <Route path="materials" element={<MaterialsPage />} />
          <Route path="publications" element={<PublicationsPage />} />
          <Route path="calendar" element={<SmmCalendarPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default AppRoutes;
