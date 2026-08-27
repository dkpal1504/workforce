import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { ThemePanel } from "./ThemePanel";

function titleForPath(pathname: string, role?: string) {
  if (pathname.startsWith("/timesheet")) return "Daily Timesheet";
  if (pathname.startsWith("/summary")) return "Summary";
  if (pathname.startsWith("/approvals")) {
    if (role === "PM") return "Project Head Approvals";
    if (role === "HOD") return "HOD Approvals";
    if (role === "ADMIN") return "Approvals";
    return "Approvals";
  }
  if (pathname.startsWith("/supervisors")) return "Supervisor Registration";
  return "Select Team for Today";
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { openPanel } = useTheme();
  const showApprovals = user && ["HOD", "PM", "ADMIN"].includes(user.role);
  const showSupervisors = user && ["ADMIN", "HR"].includes(user.role);
  const roleDisplay = user?.role === "PM" ? "Project Head" : user?.role;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__top">
          <div className="app-header__brand">
            <div className="app-header__mark" aria-hidden>
              <span />
            </div>
            <div className="app-header__titles">
              <p className="app-header__product">Workforce</p>
              <h1 className="app-header__title">{titleForPath(location.pathname, user?.role)}</h1>
            </div>
          </div>
          <button
            type="button"
            className="app-header__menu-btn"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="app-primary-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className={`app-header__menu-icon ${menuOpen ? "open" : ""}`} aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>
        </div>
        <nav
          id="app-primary-nav"
          className={`app-header__nav ${menuOpen ? "is-open" : ""}`}
        >
          <NavLink to="/select-team" className={({ isActive }) => (isActive ? "active" : "")}>
            Select Team
          </NavLink>
          <NavLink to="/timesheet" className={({ isActive }) => (isActive ? "active" : "")}>
            Timesheet
          </NavLink>
          <NavLink to="/summary" className={({ isActive }) => (isActive ? "active" : "")}>
            Summary
          </NavLink>
          {showApprovals && (
            <NavLink to="/approvals" className={({ isActive }) => (isActive ? "active" : "")}>
              Approvals
            </NavLink>
          )}
          {showSupervisors && (
            <NavLink to="/supervisors" className={({ isActive }) => (isActive ? "active" : "")}>
              Supervisors
            </NavLink>
          )}
          <span className="app-header__user">
            {user?.name} · {roleDisplay}
          </span>
          <div className="app-header__actions">
            <button type="button" className="btn-header" onClick={openPanel}>
              Themes
            </button>
            <button
              type="button"
              className="btn-header"
              onClick={async () => {
                await logout();
                navigate("/login");
              }}
            >
              Logout
            </button>
          </div>
        </nav>
      </header>
      <main className="page">
        <Outlet />
      </main>
      <ThemePanel />
    </div>
  );
}

export function HeaderOnly({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <div className="app-header__mark" aria-hidden>
            <span />
          </div>
          <div className="app-header__titles">
            <p className="app-header__product">Workforce</p>
            <h1 className="app-header__title">{title}</h1>
          </div>
        </div>
        <nav className="app-header__nav is-open">
          <Link to="/select-team">Select Team</Link>
          <Link to="/timesheet">Timesheet</Link>
          <Link to="/summary">Summary</Link>
          <Link to="/approvals">Approvals</Link>
        </nav>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
