import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AuthUser, Permission } from '@ultratorrent/shared';
import { SystemRole } from '@ultratorrent/shared';
import { api, getTokens, onAuthChange } from '@/lib/api';
import { wsClient } from '@/lib/ws';

interface AuthContextValue {
  user: AuthUser | null;
  status: 'loading' | 'authenticated' | 'unauthenticated';
  login: (username: string, password: string, totp?: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (perm: Permission | string) => boolean;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const mounted = useRef(true);

  const loadUser = useCallback(async () => {
    if (!getTokens()) {
      setUser(null);
      setStatus('unauthenticated');
      return;
    }
    try {
      const me = await api.auth.me();
      if (!mounted.current) return;
      setUser(me);
      setStatus('authenticated');
      wsClient.connect();
    } catch {
      if (!mounted.current) return;
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  // Bootstrap from any persisted token.
  useEffect(() => {
    mounted.current = true;
    void loadUser();
    return () => {
      mounted.current = false;
    };
  }, [loadUser]);

  // React to token changes from the API layer (refresh failure -> forced logout).
  useEffect(() => {
    return onAuthChange((tokens) => {
      if (!tokens) {
        setUser(null);
        setStatus('unauthenticated');
        wsClient.disconnect();
      } else {
        // Token was (re)issued — make sure the socket uses the latest token.
        wsClient.reauthenticate();
      }
    });
  }, []);

  const login = useCallback(
    async (username: string, password: string, totp?: string) => {
      const res = await api.auth.login(username, password, totp);
      setUser(res.user);
    setStatus('authenticated');
    wsClient.connect();
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
    setStatus('unauthenticated');
    wsClient.disconnect();
  }, []);

  const hasPermission = useCallback(
    (perm: Permission | string): boolean => {
      if (!user) return false;
      if (user.roles?.includes(SystemRole.SUPER_ADMIN)) return true;
      return user.permissions?.includes(perm) ?? false;
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, logout, hasPermission, refreshUser: loadUser }),
    [user, status, login, logout, hasPermission, loadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/** Convenience hook returning a single permission check. */
export function usePermission(perm: Permission | string): boolean {
  return useAuth().hasPermission(perm);
}
