import { createContext, useContext, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getDevSub, setDevSub } from "./api";
import { generateVerifier, challengeFor, authorizeUrl } from "./pkce";
import { clearTokens, getAccessToken } from "@/pages/auth-callback";
import type { CognitoConfig } from "./pkce";

export const AUTH_MODE: string = import.meta.env.VITE_AUTH_MODE ?? "dev";

function getCognitoCfg(): CognitoConfig {
  return {
    domain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
    redirectUri:
      import.meta.env.VITE_REDIRECT_URI ??
      (typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : ""),
  };
}

interface AuthContextValue {
  sub: string | null;
  signIn: (sub?: string) => void | Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // In dev mode, sub comes from localStorage dev key.
  // In cognito mode, sub is derived from the stored access token presence
  // (we treat non-null token as signed-in, sub is not needed for routing).
  const [sub, setSub] = useState<string | null>(() => {
    if (AUTH_MODE === "cognito") {
      return getAccessToken() ? "__cognito__" : null;
    }
    return getDevSub();
  });

  function signIn(newSub?: string) {
    if (AUTH_MODE === "cognito") {
      // Kick off PKCE flow — async, but we fire-and-forget the redirect
      void (async () => {
        const verifier = generateVerifier();
        const challenge = await challengeFor(verifier);
        const state = generateVerifier(); // random opaque state
        sessionStorage.setItem("eventform.pkceVerifier", verifier);
        sessionStorage.setItem("eventform.oauthState", state);
        window.location.href = authorizeUrl(getCognitoCfg(), challenge, state);
      })();
    } else {
      // Dev mode: newSub is the handle string
      if (newSub) {
        setDevSub(newSub);
        setSub(newSub);
      }
    }
  }

  function signOut() {
    // Drop every cached query — staleTime would otherwise serve the previous
    // user's data (tenant name, forms, deliveries) to the next sign-in.
    queryClient.clear();
    if (AUTH_MODE === "cognito") {
      clearTokens();
      setSub(null);
      const cfg = getCognitoCfg();
      const logoutUrl = `${cfg.domain}/logout?client_id=${cfg.clientId}&logout_uri=${encodeURIComponent(window.location.origin)}`;
      window.location.href = logoutUrl;
    } else {
      setDevSub(null);
      setSub(null);
    }
  }

  // Expose a way for the callback page to update sub after token exchange
  // by watching localStorage (simple approach — re-read on focus)
  // In practice, auth-callback navigates to /app and the component re-mounts.

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
