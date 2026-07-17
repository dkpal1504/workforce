import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { SelectTeamPage } from "./pages/SelectTeamPage";
import { TimesheetPage } from "./pages/TimesheetPage";
import { SummaryPage } from "./pages/SummaryPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";

function RequireAuth() {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/select-team" element={<SelectTeamPage />} />
          <Route path="/timesheet" element={<TimesheetPage />} />
          <Route path="/summary" element={<SummaryPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/" element={<Navigate to="/select-team" replace />} />
          <Route path="*" element={<Navigate to="/select-team" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}
