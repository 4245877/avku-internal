import { Route, Routes } from 'react-router';

import MainLayout from '../layouts/MainLayout/MainLayout.jsx';
import DashboardPage from '../pages/DashboardPage/DashboardPage.jsx';
import CertificatesPage from '../pages/CertificatesPage/CertificatesPage.jsx';
import SmmPage from '../pages/SmmPage/SmmPage.jsx';
import NotFoundPage from '../pages/NotFoundPage/NotFoundPage.jsx';

function AppRoutes() {
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route index element={<DashboardPage />} />
        <Route path="certificates" element={<CertificatesPage />} />
        <Route path="smm" element={<SmmPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default AppRoutes;