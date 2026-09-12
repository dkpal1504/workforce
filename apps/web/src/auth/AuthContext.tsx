import { createContext, useContext, useMemo, useState, useCallback, useEffect, ReactNode } from "react";
import { api, AuthUser, clearSession, getToken, SESSION_CLEARED_EVENT, setSession } from "../api/client";

type AuthCtx = {
  user: AuthUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthUser>;
  selectSection: (sectionId: number) => Promise<AuthUser>;
};

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const onCleared = () => setUser(null);
    window.addEventListener(SESSION_CLEARED_EVENT, onCleared);

    async function bootstrap() {
      if (!getToken()) {
        if (!cancelled) setReady(true);
        return;
      }
      try {
        const data = await api<{ user: AuthUser }>("/auth/me");
        if (!cancelled) {
          setUser(data.user);
          // Refresh cached display data, but keep the existing validated token.
          const token = getToken();
          if (token) setSession(token, data.user);
        }
      } catch {
        clearSession();
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_CLEARED_EVENT, onCleared);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ token: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setSession(data.token, data.user);
    setUser(data.user);
    return data.user;
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const data = await api<{ token: string; user: AuthUser }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setSession(data.token, data.user);
    setUser(data.user);
    return data.user;
  }, []);

  const selectSection = useCallback(async (sectionId: number) => {
    const data = await api<{ user: AuthUser }>("/auth/section", {
      method: "PUT",
      body: JSON.stringify({ sectionId }),
    });
    const token = getToken();
    if (token) setSession(token, data.user);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* A revoked session is already logged out locally. */
    }
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, ready, login, logout, changePassword, selectSection }), [user, ready, login, logout, changePassword, selectSection]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
