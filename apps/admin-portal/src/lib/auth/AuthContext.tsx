import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import type { AuthUser } from '@yiji/shared-config';
import { auth } from '../directus.js';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the session from the httpOnly refresh cookie (H-2): the access token
  // is in memory only, so refresh first on a cold load.
  useEffect(() => {
    let active = true;
    void (async () => {
      const me = await auth.restore();
      if (active) {
        setUser(me);
        setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await auth.login(email, password);
    const me = await auth.me();
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(async () => {
    await auth.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Admin portal only admits Administrator and Admin roles. */
export const ADMIN_ROLES = ['Administrator', 'Admin'];
export function isAdmin(user: AuthUser | null): boolean {
  return !!user?.role && ADMIN_ROLES.includes(user.role.name);
}
