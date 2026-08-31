import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api/client";
import type { User } from "./api/types";

interface Bootstrap {
  needs_setup: boolean;
  instance_name: string;
}

interface AuthState {
  loading: boolean;
  user: User | null;
  bootstrap: Bootstrap | null;
  setUser: (user: User | null) => void;
  refreshBootstrap: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);

  const refreshBootstrap = useCallback(async () => {
    setBootstrap(await api.get<Bootstrap>("/api/bootstrap"));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const boot = await api.get<Bootstrap>("/api/bootstrap");
        setBootstrap(boot);
        if (!boot.needs_setup) {
          try {
            setUser(await api.get<User>("/api/me"));
          } catch {
            setUser(null);
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <AuthContext.Provider value={{ loading, user, bootstrap, setUser, refreshBootstrap }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
