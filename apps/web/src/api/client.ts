const TOKEN_KEY = "workforce_token";
const USER_KEY = "workforce_user";
export const SESSION_CLEARED_EVENT = "workforce:session-cleared";

export type AuthCapabilities = {
  selectTeam: boolean;
  editTimesheet: boolean;
  viewSummary: boolean;
  approveTimesheets: boolean;
  manageSupervisors: boolean;
  manageMasterData: boolean;
  manageEmployees: boolean;
  uploadEmployees: boolean;
  allocateHours: boolean;
};

export type AuthUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  departmentId: number | null;
  employeeId: number | null;
  active: boolean;
  employeeActive: boolean | null;
  mustChangePassword: boolean;
  passwordExpiresAt: string | null;
  credentialProvisionedAt: string | null;
  credentialSentAt: string | null;
  department: { id: number; name: string; code: string } | null;
  employee: { id: number; ecNo: string; active: boolean; terminatedAt: string | null } | null;
  section: {
    id: number;
    code: string;
    name: string;
    departmentId: number;
    costCenter: { id: number; code: string; name: string; active: boolean } | null;
  } | null;
  requiresSectionSelection: boolean;
  capabilities: AuthCapabilities;
  landingPath: string;
};

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(notify = false) {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
  if (notify && typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_CLEARED_EVENT));
}

export class ApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body) headers.set("Content-Type", "application/json");
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const url = path.startsWith("/api") || path.startsWith("http") ? path : `/api${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data?.code === "string" ? data.code : "";
    if (res.status === 401 && !url.includes("/auth/login")) clearSession(true);
    // Keep the restricted session for the forced-change redirect.
    if (res.status === 403 && code === "PASSWORD_CHANGE_REQUIRED" && typeof window !== "undefined") {
      if (!window.location.pathname.startsWith("/change-password")) window.location.assign("/change-password");
    }
    const err = data.error;
    const message = typeof err === "string" ? err : err?.formErrors?.[0] || err?.message || res.statusText || "Request failed";
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}
