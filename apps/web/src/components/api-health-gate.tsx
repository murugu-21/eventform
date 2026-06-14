import { useCallback, useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { CheckIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { checkApiHealth, requestWake } from "@/lib/api";

const CONTACT_EMAIL = "murugu2001@gmail.com";
const POLL_INTERVAL_MS = 8000;

// Heuristic cold-start phases (keyed to elapsed seconds). The box can't report
// real boot progress to a page that can't reach it, so this is an honest estimate
// matching the actual sequence; the gate flips to the app the instant /health 200s.
const BOOT_PHASES = [
  { at: 0, label: "Waking up a server" },
  { at: 20, label: "Pulling container images (~3 GB)" },
  { at: 110, label: "Starting the pipeline — Postgres, Redpanda, Debezium, API" },
  { at: 165, label: "Reconnecting" },
] as const;

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
  // Count elapsed seconds so the screen shows motion + an honest "how long" cue.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const phaseIdx = BOOT_PHASES.reduce((acc, p, i) => (elapsed >= p.at ? i : acc), 0);
  const overtime = elapsed > 210;
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="text-center">
          <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-full bg-muted">
            <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
          </div>
          <h1 className="text-xl font-semibold">
            {isPublicForm ? "This form is waking up" : "Waking up EventForm"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            To stay (nearly) free to host, EventForm runs on a single small server
            that <strong>powers down when idle</strong>. Your visit is waking it —
            the first load takes about <strong>2&ndash;3 minutes</strong> while it
            boots and pulls ~3&nbsp;GB of container images, then it&rsquo;s instant
            until it idles again.
          </p>
          {isPublicForm && (
            <p className="mt-2 text-xs text-muted-foreground">
              Only a signed-in user can start it — if it doesn&rsquo;t come up, ask
              whoever shared this link to sign in.
            </p>
          )}
        </div>

        {/* Heuristic progress — advances on elapsed time; gives a sense of motion
            and explains where the 2–3 min goes (the image pull is the long part). */}
        <ol className="mt-6 space-y-2.5">
          {BOOT_PHASES.map((p, i) => {
            const done = i < phaseIdx;
            const active = i === phaseIdx;
            return (
              <li key={p.label} className="flex items-center gap-3 text-sm">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {done ? (
                    <CheckIcon className="size-4 text-green-600 dark:text-green-400" />
                  ) : active ? (
                    <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                  )}
                </span>
                <span
                  className={
                    done
                      ? "text-muted-foreground"
                      : active
                        ? "font-medium text-foreground"
                        : "text-muted-foreground/50"
                  }
                >
                  {p.label}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 text-center text-xs tabular-nums text-muted-foreground">
          {overtime
            ? "Taking longer than usual — it should still come up; you can retry below."
            : `${mmss} elapsed · usually ~2–3 min · reconnects on its own`}
        </p>

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
            className="text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Back to home
          </Link>
        </div>

        <p className="mt-6 border-t border-border pt-4 text-center text-xs text-muted-foreground">
          Still nothing after a few minutes?{" "}
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
