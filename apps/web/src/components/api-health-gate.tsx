import { useCallback, useEffect, useState } from "react";
import { Link, Outlet } from "react-router";
import { Button } from "@/components/ui/button";
import { checkApiHealth } from "@/lib/api";

const CONTACT_EMAIL = "murugu2001@gmail.com";
const POLL_INTERVAL_MS = 8000;

type Status = "checking" | "up" | "down";

/**
 * Wraps the routes that need the backend (login, public forms, the app shell).
 * The SPA itself is served from Cloudflare Pages and is always up; this gate
 * probes the API and, when it's unreachable, shows a friendly "instance is
 * starting" page that reconnects on its own instead of rendering broken pages.
 * The landing page and 404 sit OUTSIDE this gate so they always render.
 */
export function ApiHealthGate() {
  const [status, setStatus] = useState<Status>("checking");
  const [retrying, setRetrying] = useState(false);

  // Probe once on mount. setState lives in the .then callback (not the effect
  // body), and the cancelled guard prevents a late update after unmount.
  useEffect(() => {
    let cancelled = false;
    checkApiHealth().then((ok) => {
      if (!cancelled) setStatus(ok ? "up" : "down");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-poll only while the backend is down; flips to "up" the moment it
  // recovers, which tears this effect down (status leaves "down").
  useEffect(() => {
    if (status !== "down") return;
    let cancelled = false;
    const id = window.setInterval(() => {
      checkApiHealth().then((ok) => {
        if (!cancelled && ok) setStatus("up");
      });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status]);

  // Manual retry adds button feedback; setState here is in an event handler,
  // not an effect body, so it's safe.
  const handleRetry = useCallback(async () => {
    setRetrying(true);
    const ok = await checkApiHealth();
    setStatus(ok ? "up" : "down");
    setRetrying(false);
  }, []);

  if (status === "up") return <Outlet />;
  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
      </div>
    );
  }
  return <InstanceStarting onRetry={handleRetry} retrying={retrying} />;
}

function InstanceStarting({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted">
          <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        </div>
        <h1 className="text-xl font-semibold">Waking up the backend</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The EventForm instance is being started up — this usually takes a
          minute. This page will reconnect automatically once it&rsquo;s ready.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Button onClick={onRetry} disabled={retrying}>
            {retrying ? "Checking…" : "Retry now"}
          </Button>
          <Link
            to="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to home
          </Link>
        </div>
        <p className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
          Still not loading after a few minutes?{" "}
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=EventForm%20appears%20to%20be%20down`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {CONTACT_EMAIL}
          </a>
        </p>
      </div>
    </div>
  );
}
