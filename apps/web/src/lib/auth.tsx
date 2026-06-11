import { createContext, useContext, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { getDevSub, setDevSub } from "./api";

interface AuthContextValue {
  sub: string | null;
  signIn: (sub: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sub, setSub] = useState<string | null>(() => getDevSub());

  function signIn(newSub: string) {
    setDevSub(newSub);
    setSub(newSub);
  }

  function signOut() {
    setDevSub(null);
    setSub(null);
  }

  return (
    <AuthContext.Provider value={{ sub, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { sub } = useAuth();
  if (!sub) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
