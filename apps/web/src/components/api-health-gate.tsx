import { useCallback, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import { checkApiHealth, requestWake } from "@/lib/api";

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
  // Public form links (`/forms/:slug`) are opened by anonymous visitors who
  // CAN'T wake the box (wake is Cognito-only). On those routes the down screen
  // tells them to get the link's owner to sign in. (Excludes /app/forms/:id.)
  const isPublicForm = useLocation().pathname.startsWith("/forms/");

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
    // Fire one wake nudge per down-episode (this effect runs once on entering
    // "down"; the poll below doesn't re-fire it). Scale-to-zero: starts the box
    // if it's off. Fire-and-forget — the poll loop drives recovery regardless.
    void requestWake();
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
  return (
    <InstanceStarting
      variant={isPublicForm ? "publicForm" : "default"}
      onRetry={handleRetry}
      retrying={retrying}
    />
  );
}

function InstanceStarting({
  variant,
  onRetry,
  retrying,
}: {
  variant: "default" | "publicForm";
  onRetry: () => void;
  retrying: boolean;
}) {
  const isPublicForm = variant === "publicForm";
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted">
          <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
        </div>
        <h1 className="text-xl font-semibold">
          {isPublicForm ? "This form is waking up" : "Waking up the backend"}
        </h1>
        {isPublicForm ? (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            To save resources, EventForm&rsquo;s backend powers down when idle.
            Ask whoever shared this link to <strong>sign in</strong> — that starts
            it back up (a couple of minutes). If that&rsquo;s you, sign in below;
            this page loads the form on its own once it&rsquo;s running.
          </p>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            To save resources, EventForm&rsquo;s backend powers down when idle, so
            the first visit takes a minute. <strong>Sign in</strong> to wake it —
            this page reconnects automatically once it&rsquo;s up.
          </p>
        )}
        <div className="mt-6 flex flex-col gap-3">
          {/* Signing in is what fires the wake (the wake endpoint is Cognito-only),
              so the sign-in CTA shows on every down screen — a logged-out visitor
              can't wake the box without it. */}
          <Link to="/login" className={buttonVariants()}>
            Sign in to wake it
          </Link>
          <Button variant="outline" onClick={onRetry} disabled={retrying}>
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
