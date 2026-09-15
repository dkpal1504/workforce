import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthCapabilities } from "./api/client";
import { useAuth } from "./auth/AuthContext";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";
import { SectionSelectionPage } from "./pages/SectionSelectionPage";
import { SelectTeamPage } from "./pages/SelectTeamPage";
import { TimesheetPage } from "./pages/TimesheetPage";
import { SummaryPage } from "./pages/SummaryPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { SupervisorsPage } from "./pages/SupervisorsPage";
import { AllocationsPage } from "./pages/AllocationsPage";
import { DepartmentsPage } from "./pages/DepartmentsPage";
import { CsvUploadPage } from "./pages/CsvUploadPage";
import { EmployeesPage } from "./pages/EmployeesPage";
import { RoleAssignmentPage } from "./pages/RoleAssignmentPage";

function LoadingSession() {
  return <div className="loading-state" style={{ margin: "20vh auto", maxWidth: 420 }}>Checking your session…</div>;
}

function RequireAuth() {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <LoadingSession />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (user.requiresSectionSelection) return <Navigate to="/select-section" replace />;
  return <Outlet />;
}

function RequirePasswordChange() {
  const { user, ready } = useAuth();
  if (!ready) return <LoadingSession />;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.mustChangePassword) return <Navigate to={user.landingPath} replace />;
  return <ChangePasswordPage />;
}

function RequireSectionSelection() {
  const { user, ready } = useAuth();
  if (!ready) return <LoadingSession />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!user.requiresSectionSelection) return <Navigate to={user.landingPath} replace />;
  return <SectionSelectionPage />;
}

function RequireCapability({ capability }: { capability: keyof AuthCapabilities }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!user.capabilities[capability]) return <Navigate to={user.landingPath} replace />;
  return <Outlet />;
}

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={user?.landingPath || "/login"} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<RequirePasswordChange />} />
      <Route path="/select-section" element={<RequireSectionSelection />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route element={<RequireCapability capability="selectTeam" />}>
            <Route path="/select-team" element={<SelectTeamPage />} />
          </Route>
          <Route element={<RequireCapability capability="editTimesheet" />}>
            <Route path="/timesheet" element={<TimesheetPage />} />
          </Route>
          <Route element={<RequireCapability capability="viewSummary" />}>
            <Route path="/summary" element={<SummaryPage />} />
          </Route>
          <Route element={<RequireCapability capability="approveTimesheets" />}>
            <Route path="/approvals" element={<ApprovalsPage />} />
          </Route>
          <Route element={<RequireCapability capability="manageSupervisors" />}>
            <Route path="/supervisors" element={<SupervisorsPage />} />
          </Route>
          <Route element={<RequireCapability capability="allocateHours" />}>
            <Route path="/allocations" element={<AllocationsPage />} />
          </Route>
          <Route element={<RequireCapability capability="manageEmployees" />}>
            <Route path="/employees" element={<EmployeesPage />} />
          </Route>
          <Route element={<RequireCapability capability="uploadEmployees" />}>
            <Route path="/csv-upload" element={<CsvUploadPage />} />
          </Route>
          <Route element={<RequireCapability capability="manageMasterData" />}>
            <Route path="/departments" element={<DepartmentsPage />} />
          </Route>
          {/* Offered, not forced: accounts on the shared dev password can change it
              whenever they like, and are not trapped in the flow. */}
          <Route path="/account/password" element={<ChangePasswordPage />} />
          <Route element={<RequireCapability capability="assignRoles" />}>
            <Route path="/role-assignment" element={<RoleAssignmentPage />} />
          </Route>
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<HomeRedirect />} />
        </Route>
      </Route>
    </Routes>
  );
}
