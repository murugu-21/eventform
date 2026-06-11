import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { exchangeCode } from "@/lib/pkce";
import type { CognitoConfig } from "@/lib/pkce";

function getCognitoCfg(): CognitoConfig {
  return {
    domain: import.meta.env.VITE_COGNITO_DOMAIN ?? "",
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
    redirectUri:
      import.meta.env.VITE_REDIRECT_URI ??
      (typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : ""),
  };
}

const ACCESS_TOKEN_KEY = "eventform.accessToken";
const REFRESH_TOKEN_KEY = "eventform.refreshToken";

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function storeTokens(accessToken: string, refreshToken?: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    // Strict mode calls effect twice in dev — guard with ref
    if (ran.current) return;
    ran.current = true;

    async function handleCallback() {
      const params = new URLSearchParams(window.location.search);
      const code = params.get("code");
      const returnedState = params.get("state");
      const storedState = sessionStorage.getItem("eventform.oauthState");
      const verifier = sessionStorage.getItem("eventform.pkceVerifier");

      // Clean up session storage
      sessionStorage.removeItem("eventform.oauthState");
      sessionStorage.removeItem("eventform.pkceVerifier");

      if (!code || !returnedState || returnedState !== storedState || !verifier) {
        void navigate("/login", { replace: true });
        return;
      }

      try {
        const tokens = await exchangeCode(getCognitoCfg(), code, verifier);
        storeTokens(tokens.access_token, tokens.refresh_token);
        void navigate("/app", { replace: true });
      } catch {
        void navigate("/login", { replace: true });
      }
    }

    void handleCallback();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">Signing you in…</p>
    </div>
  );
}
