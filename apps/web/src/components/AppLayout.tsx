import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { AuthCapabilities } from "../api/client";
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
  if (pathname.startsWith("/allocations")) return role === "SUPERVISOR" || role === "EMPLOYEE" ? "My Hours" : "Manhour Allocation";
  if (pathname.startsWith("/employees")) return "Employee Registration";
  if (pathname.startsWith("/departments")) return "Organisation Masters";
  if (pathname.startsWith("/role-assignment")) return "Role Assignment";
  if (pathname.startsWith("/account/password")) return "Change Password";
  if (pathname.startsWith("/csv-upload")) return "Employee CSV Upload";
  if (pathname.startsWith("/master-data")) return "Project Master Data";
  if (pathname.startsWith("/job-order-upload")) return "Job Order Upload";
  if (pathname.startsWith("/job-order-progress")) return "Quantity Progress";
  return "Select Team for Today";
}


/* ============================================================================
   Desktop navigation rail (rendered at every width, visible only at >=1200px by
   CSS - see the min-width:1200px block in styles/global.css). It reuses the same
   capability flags and the same route targets as the top-bar nav, so the two
   cannot drift apart.

   The rail hides itself when the pointer leaves it to the right, so the content
   gets the full window width. It stays open while it holds keyboard focus or when
   the user pins it with the pin button (remembered in localStorage).
   ============================================================================ */

const RAIL_PIN_KEY = "workforce_rail_pinned";

type RailIconName =
  | "team" | "clock" | "chart" | "check" | "hours"
  | "supervisor" | "people" | "building" | "star"
  | "folder" | "upload" | "trend" | "file" | "palette" | "logout" | "pin" | "chevron";

const RAIL_ICONS: Record<RailIconName, string> = {
  team: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20c0-3 2.5-5 5-5s5 2 5 5M14 15.5c2.6.3 5 2.2 5 4.5",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  chart: "M5 20V9M12 20V4M19 20v-7",
  check: "M9 12.5 11 15l4.5-5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  hours: "M12 21s-7-4.3-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.7-7 10-7 10Z",
  supervisor: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-3.3 3.6-6 8-6s8 2.7 8 6",
  people: "M15 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM21 21v-2a4 4 0 0 0-3-3.9",
  building: "M4 21V7l5-3 5 3v14M14 21V11l6-2v12M7 9h.01M7 13h.01M7 17h.01",
  star: "M12 3l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 8.7l5.4-.8L12 3Z",
  folder: "M3 7h6l2 2h10v10H3V7Z",
  upload: "M12 16V4m0 0-4 4m4-4 4 4M4 20h16",
  trend: "M4 17l5-5 4 3 7-8M20 7h-4m4 0v4",
  file: "M6 3h8l4 4v14H6V3Zm8 0v4h4M9 13h6M9 17h6",
  palette: "M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4h3a6 6 0 0 0-3-11Zm-3.5 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm3-3a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z",
  logout: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h9",
  pin: "M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z",
  chevron: "M9 6l6 6-6 6",
};

type RailItem = { to: string; label: string; cap: keyof AuthCapabilities; icon: RailIconName };

/** Grouped exactly like the reference design; the order matches the top bar. */
const RAIL_GROUPS: Array<{ label: string; items: RailItem[] }> = [
  {
    label: "Time tracking",
    items: [
      { to: "/select-team", label: "Select team", cap: "selectTeam", icon: "team" },
      { to: "/timesheet", label: "Timesheet", cap: "editTimesheet", icon: "clock" },
      { to: "/summary", label: "Summary", cap: "viewSummary", icon: "chart" },
      { to: "/approvals", label: "Approvals", cap: "approveTimesheets", icon: "check" },
      { to: "/allocations", label: "My hours", cap: "allocateHours", icon: "hours" },
    ],
  },
  {
    label: "People",
    items: [
      { to: "/supervisors", label: "Supervisors", cap: "manageSupervisors", icon: "supervisor" },
      { to: "/employees", label: "Employees", cap: "manageEmployees", icon: "people" },
    ],
  },
  {
    label: "Organisation",
    items: [
      { to: "/departments", label: "Organisation", cap: "manageMasterData", icon: "building" },
      { to: "/role-assignment", label: "Role assignment", cap: "assignRoles", icon: "star" },
    ],
  },
  {
    label: "Project setup",
    items: [
      { to: "/master-data", label: "Project master", cap: "manageJobOrderMaster", icon: "folder" },
      { to: "/job-order-upload", label: "Job order upload", cap: "manageJobOrderMaster", icon: "upload" },
      { to: "/job-order-progress", label: "Qty progress", cap: "manageJobOrderProgress", icon: "trend" },
      { to: "/csv-upload", label: "CSV upload", cap: "uploadEmployees", icon: "file" },
    ],
  },
];

/** The desktop page head. The title itself comes from `titleForPath`, so the
 *  desktop and the phone can never show two different names for one screen. */
const PAGE_META: Array<{ prefix: string; lede: string; action?: { label: string; to: string; icon: RailIconName } }> = [
  {
    prefix: "/master-data",
    lede: "Set up the projects, work breakdown structures, units, networks and job orders that hours are booked against.",
    action: { label: "Upload job orders", to: "/job-order-upload", icon: "upload" },
  },
  { prefix: "/timesheet", lede: "Book the day's hours per employee, then save a draft or submit the day for approval." },
  { prefix: "/summary", lede: "Approved hours by project, supervisor and job order, for the date you pick." },
  { prefix: "/approvals", lede: "Review the submitted days in your chain, then approve, reject or send them back." },
  { prefix: "/select-team", lede: "Confirm who is on site today. The day's bookings are recorded against this team." },
  { prefix: "/allocations", lede: "Assign future slots to the people who will work them, before the day is booked." },
  { prefix: "/supervisors", lede: "Register supervisors and review the records that arrive from the CLMS feed." },
  { prefix: "/employees", lede: "Register payroll employees and project heads, and map each head to a scope." },
  { prefix: "/departments", lede: "Maintain departments, sections and cost centres." },
  { prefix: "/role-assignment", lede: "Search an account and set the role and scope it may act within." },
  { prefix: "/job-order-upload", lede: "Upload the job order list from the CSV the commercial team exports." },
  { prefix: "/job-order-progress", lede: "Punch the quantity achieved per job order, then approve the entries." },
  { prefix: "/csv-upload", lede: "Load the employee roster from a CSV file." },
  { prefix: "/account/password", lede: "Change the password you sign in with." },
];

function pageMetaFor(pathname: string) {
  return PAGE_META.find((entry) => pathname.startsWith(entry.prefix));
}

function RailIcon({ name }: { name: RailIconName }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={RAIL_ICONS[name]} />
    </svg>
  );
}

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { openPanel } = useTheme();
  const capabilities = user?.capabilities;
  const roleDisplay = user?.role === "PM" ? "Project Head" : user?.role;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  /* The rail auto-hides when the pointer leaves it to the right, so the content
     gets the full window width. It stays open while it holds focus, and the pin
     button keeps it open permanently (remembered between visits). */
  const [railPinned, setRailPinned] = useState(false);
  const [railRevealed, setRailRevealed] = useState(true);
  /* Armed after the first paint: the rail may slide, but the first frame must not
     animate (that made the content slide under the rail on load). */
  const [railReady, setRailReady] = useState(false);
  const railOpen = railPinned || railRevealed;

  useEffect(() => {
    try {
      setRailPinned(window.localStorage.getItem(RAIL_PIN_KEY) === "1");
    } catch {
      /* storage can be blocked; the rail simply starts unpinned. */
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setRailReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const toggleRailPin = () => {
    setRailPinned((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(RAIL_PIN_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
    setRailRevealed(true);
  };

  const meta = pageMetaFor(location.pathname);

  return (
    <div className={`app-shell ${railOpen ? "rail-open" : ""} ${railReady ? "rail-ready" : ""}`}>
      <button
        type="button"
        className="app-rail-handle"
        aria-label="Show navigation"
        aria-controls="app-rail"
        aria-expanded={railOpen}
        title="Show navigation"
        onMouseEnter={() => setRailRevealed(true)}
        onFocus={() => setRailRevealed(true)}
        onClick={() => setRailRevealed(true)}
      >
        <RailIcon name="chevron" />
      </button>
      <aside
        id="app-rail"
        className="app-rail"
        aria-label="Primary"
        onMouseEnter={() => setRailRevealed(true)}
        onMouseLeave={() => { if (!railPinned) setRailRevealed(false); }}
        onFocusCapture={() => setRailRevealed(true)}
        onBlurCapture={(event) => {
          if (!railPinned && !event.currentTarget.contains(event.relatedTarget as Node | null)) setRailRevealed(false);
        }}
      >
        <div className="app-rail__brand">
          <div className="app-header__mark" aria-hidden>
            <span />
          </div>
          <div>
            <p className="app-rail__name">Workforce</p>
            <p className="app-rail__org">Swan Group</p>
          </div>
        </div>
        <nav className="app-rail__nav">
          {RAIL_GROUPS.map((group) => {
            const visible = group.items.filter((item) => capabilities?.[item.cap]);
            if (visible.length === 0) return null;
            return (
              <div className="app-rail__group" key={group.label}>
                <p className="app-rail__group-label">{group.label}</p>
                {visible.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => `app-rail__item ${isActive ? "is-active" : ""}`}
                  >
                    <span className="app-rail__icon"><RailIcon name={item.icon} /></span>
                    <span>{item.label}</span>
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="app-rail__foot">
          <div className="app-rail__avatar" aria-hidden>
            {(user?.name || "?").trim().slice(0, 2).toUpperCase()}
          </div>
          <div className="app-rail__who">
            <strong>{user?.name}</strong>
            <span>{roleDisplay}</span>
          </div>
          <button
            type="button"
            className="app-rail__iconbtn"
            aria-label={railPinned ? "Let the menu hide itself" : "Keep the menu open"}
            aria-pressed={railPinned}
            title={railPinned ? "Let the menu hide itself" : "Keep the menu open"}
            onClick={toggleRailPin}
          >
            <RailIcon name="pin" />
          </button>
          <button type="button" className="app-rail__iconbtn" aria-label="Themes" title="Themes" onClick={openPanel}>
            <RailIcon name="palette" />
          </button>
          <button
            type="button"
            className="app-rail__iconbtn"
            aria-label="Logout"
            title="Logout"
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
          >
            <RailIcon name="logout" />
          </button>
        </div>
      </aside>
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
          {capabilities?.selectTeam && <NavLink to="/select-team" className={({ isActive }) => (isActive ? "active" : "")}>
            Select Team
          </NavLink>}
          {capabilities?.editTimesheet && <NavLink to="/timesheet" className={({ isActive }) => (isActive ? "active" : "")}>
            Timesheet
          </NavLink>}
          {capabilities?.viewSummary && <NavLink to="/summary" className={({ isActive }) => (isActive ? "active" : "")}>
            Summary
          </NavLink>}
          {capabilities?.approveTimesheets && (
            <NavLink to="/approvals" className={({ isActive }) => (isActive ? "active" : "")}>
              Approvals
            </NavLink>
          )}
          {capabilities?.manageSupervisors && (
            <NavLink to="/supervisors" className={({ isActive }) => (isActive ? "active" : "")}>
              Supervisors
            </NavLink>
          )}
          {capabilities?.allocateHours && (
            <NavLink to="/allocations" className={({ isActive }) => (isActive ? "active" : "")}>
              My Hours
            </NavLink>
          )}
          {capabilities?.manageEmployees && (
            <NavLink to="/employees" className={({ isActive }) => (isActive ? "active" : "")}>
              Employees
            </NavLink>
          )}
          {capabilities?.manageMasterData && (
            <NavLink to="/departments" className={({ isActive }) => (isActive ? "active" : "")}>
              Organisation
            </NavLink>
          )}
          {capabilities?.manageJobOrderMaster && (
            <NavLink to="/master-data" className={({ isActive }) => (isActive ? "active" : "")}>
              Project Master
            </NavLink>
          )}
          {capabilities?.manageJobOrderMaster && (
            <NavLink to="/job-order-upload" className={({ isActive }) => (isActive ? "active" : "")}>
              Job Order Upload
            </NavLink>
          )}
          {capabilities?.manageJobOrderProgress && (
            <NavLink to="/job-order-progress" className={({ isActive }) => (isActive ? "active" : "")}>
              Qty Progress
            </NavLink>
          )}
          {capabilities?.assignRoles && (
            <NavLink to="/role-assignment" className={({ isActive }) => (isActive ? "active" : "")}>
              Role Assignment
            </NavLink>
          )}
          {capabilities?.uploadEmployees && (
            <NavLink to="/csv-upload" className={({ isActive }) => (isActive ? "active" : "")}>
              CSV Upload
            </NavLink>
          )}
          {/* Offered, not forced: the account may still be on the shared password. */}
          <NavLink to="/account/password" className={({ isActive }) => (isActive ? "active" : "")}>
            Password
          </NavLink>
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
        {/* Desktop page head: the top bar (which carries the title below 1200px) is
            hidden at >=1200px, so exactly one <h1> is visible at every width. */}
        <div className="page-head">
          <div className="page-head__text">
            <h1 className="page-head__title">{titleForPath(location.pathname, user?.role)}</h1>
            {meta && <p className="page-head__lede">{meta.lede}</p>}
          </div>
          {meta?.action && (
            <Link className="page-head__action" to={meta.action.to}>
              <span className="page-head__action-icon"><RailIcon name={meta.action.icon} /></span>
              <span>{meta.action.label}</span>
            </Link>
          )}
        </div>
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
