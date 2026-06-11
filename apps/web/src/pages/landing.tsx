import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

// ── Architecture flow node ────────────────────────────────────────────────────
function FlowNode({ label, sub }: { label: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-center shadow-sm min-w-[110px]">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        {sub && (
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{sub}</p>
        )}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center text-muted-foreground select-none px-1" aria-hidden>
      <svg width="24" height="12" viewBox="0 0 24 12" fill="none" className="shrink-0">
        <path d="M0 6h20M14 1l6 5-6 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ── How it works step ────────────────────────────────────────────────────────
function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center max-w-xs">
      <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold shrink-0">
        {n}
      </div>
      <div>
        <h3 className="font-semibold text-base mb-1">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

// ── Tech badge ────────────────────────────────────────────────────────────────
function TechBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="text-xs font-mono px-2.5 py-0.5">
      {label}
    </Badge>
  );
}

const TECH = [
  "React 19",
  "NestJS",
  "PostgreSQL 16",
  "Drizzle ORM",
  "Debezium CDC",
  "Apache Kafka",
  "LocalStack KMS",
  "AWS CDK",
  "TypeScript",
  "Tailwind v4",
  "shadcn/ui",
  "Playwright",
];

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Hero ──────────────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center justify-center px-6 py-24 text-center gap-6">
        <Badge variant="outline" className="text-xs tracking-wide uppercase">
          Open-source portfolio project
        </Badge>

        <h1 className="text-5xl font-extrabold tracking-tight leading-tight max-w-2xl">
          Forms in.{" "}
          <span className="text-primary">Webhooks out.</span>
        </h1>

        <p className="text-xl text-muted-foreground max-w-xl leading-relaxed">
          Exactly once*{" "}
          <span className="text-muted-foreground/60 text-sm">(*at least once)</span>
          {" "}— build a form, collect submissions, and fan them out to every
          webhook endpoint automatically via a transactional outbox pipeline.
        </p>

        <div className="flex items-center gap-3 mt-2">
          <Button size="lg" onClick={() => void navigate("/login")}>
            Sign in &rarr;
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={() => window.open("https://github.com/murugu21/eventform", "_blank", "noreferrer")}
          >
            View on GitHub
          </Button>
        </div>
      </section>

      <Separator />

      {/* ── How it works ──────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center px-6 py-20 gap-12">
        <div className="text-center">
          <h2 className="text-3xl font-bold mb-2">How it works</h2>
          <p className="text-muted-foreground max-w-lg text-sm">
            Three steps from form to webhook, with guaranteed delivery via CDC.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-8 sm:gap-12">
          <Step
            n={1}
            title="Build &amp; Publish"
            body="Create a form with the drag-and-drop builder, add text or multiple-choice fields, then publish to get a shareable public link."
          />
          <Step
            n={2}
            title="Collect Submissions"
            body="Anyone with the link can submit anonymously. Responses land in Postgres via a transactional outbox — atomically."
          />
          <Step
            n={3}
            title="Fan Out Webhooks"
            body="Debezium tails the WAL and publishes to Kafka. The worker consumes events and delivers signed webhooks to every active endpoint."
          />
        </div>
      </section>

      <Separator />

      {/* ── Architecture flow ──────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center px-6 py-20 gap-10">
        <div className="text-center">
          <h2 className="text-3xl font-bold mb-2">Architecture</h2>
          <p className="text-muted-foreground max-w-lg text-sm">
            A CDC-based outbox pattern for durable, exactly-once-intent delivery.
          </p>
        </div>

        {/* Flow diagram */}
        <div className="w-full max-w-4xl overflow-x-auto">
          <div className="flex items-center justify-center gap-0 min-w-max mx-auto py-4">
            <FlowNode label="Form" sub="public /forms/:slug" />
            <Arrow />
            <FlowNode label="Postgres" sub="transactional outbox" />
            <Arrow />
            <FlowNode label="Debezium" sub="WAL → CDC" />
            <Arrow />
            <FlowNode label="Kafka" sub="eventform.events" />
            <Arrow />
            <FlowNode label="Worker" sub="idempotent consumer" />
            <Arrow />
            <FlowNode label="Webhook" sub="HMAC-signed POST" />
          </div>
        </div>

        {/* Key properties */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl w-full">
          <div className="rounded-lg border border-border bg-card p-5">
            <h4 className="font-semibold text-sm mb-1">Exactly-once intent</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Submission and outbox row are written in a single Postgres transaction.
              The worker deduplicates on Kafka offset.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h4 className="font-semibold text-sm mb-1">Auto-retry with backoff</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Failed deliveries are retried up to 5 times with exponential backoff.
              Manual retry is available from the deliveries dashboard.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h4 className="font-semibold text-sm mb-1">HMAC signatures</h4>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every webhook is signed with a per-endpoint{" "}
              <code className="text-xs font-mono">whsec_</code> secret.
              Rotate without downtime from the endpoints UI.
            </p>
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Tech badges ────────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center px-6 py-16 gap-6">
        <h2 className="text-2xl font-bold">Built with</h2>
        <div className="flex flex-wrap justify-center gap-2 max-w-2xl">
          {TECH.map((t) => (
            <TechBadge key={t} label={t} />
          ))}
        </div>
      </section>

      <Separator />

      {/* ── Footer CTA ────────────────────────────────────────────────────────── */}
      <section className="flex flex-col items-center px-6 py-20 gap-4 text-center">
        <h2 className="text-3xl font-bold">Ready to try it?</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          Sign in with any handle (dev mode — no password required) and build your
          first form in under a minute.
        </p>
        <Button size="lg" onClick={() => void navigate("/login")} className="mt-2">
          Sign in &rarr;
        </Button>
      </section>

      {/* ── Footer ───────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border px-6 py-6 text-center text-xs text-muted-foreground">
        eventform · MIT license
      </footer>
    </div>
  );
}
