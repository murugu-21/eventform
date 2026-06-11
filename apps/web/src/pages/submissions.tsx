import { useParams, Link } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Submission, FormWithFields } from "@/lib/types";

// ── Relative time helper ─────────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Derive ordered column labels ─────────────────────────────────────────────
// Primary order: form field labels in position order.
// Defensive: include any extra keys from submissions not in form fields.
function deriveColumns(form: FormWithFields, submissions: Submission[]): string[] {
  const orderedLabels = [...form.fields]
    .sort((a, b) => a.position - b.position)
    .map((f) => f.label);

  const labelSet = new Set(orderedLabels);

  // Collect any extra answer keys not in form fields
  const extraKeys: string[] = [];
  for (const sub of submissions) {
    for (const key of Object.keys(sub.answers)) {
      if (!labelSet.has(key) && !extraKeys.includes(key)) {
        extraKeys.push(key);
      }
    }
  }

  return [...orderedLabels, ...extraKeys];
}

// ── Empty state ──────────────────────────────────────────────────────────────
function EmptyState({ form }: { form: FormWithFields }) {
  const publicUrl = `${window.location.origin}/forms/${form.publicSlug}`;

  if (form.status === "published") {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center text-muted-foreground">
        <p className="text-base">No submissions yet.</p>
        <p className="text-sm">
          Share the public link to start collecting responses:
        </p>
        <a
          href={publicUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-primary underline underline-offset-2 hover:opacity-80 font-mono"
        >
          {publicUrl}
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 py-20 text-center text-muted-foreground">
      <p className="text-base">No submissions.</p>
      <p className="text-sm">
        Publish the form first to start accepting submissions.
      </p>
      <Link
        to={`/app/forms/${form.id}`}
        className="text-sm text-primary underline underline-offset-2 hover:opacity-80"
      >
        Go to form builder →
      </Link>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function SubmissionsPage() {
  const { id } = useParams<{ id: string }>();

  const { data: form, isLoading: formLoading, isError: formError } = useQuery({
    queryKey: ["form", id],
    queryFn: () => api.getForm(id!),
    enabled: !!id,
  });

  const {
    data: submissions,
    isLoading: subLoading,
    isError: subError,
  } = useQuery({
    queryKey: ["submissions", id],
    queryFn: () => api.listSubmissions(id!),
    enabled: !!id,
  });

  const isLoading = formLoading || subLoading;
  const isError = formError || subError;

  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm">
        Loading submissions…
      </div>
    );
  }

  if (isError || !form) {
    return (
      <div className="p-6 text-center text-destructive text-sm">
        Failed to load submissions.{" "}
        <Link to="/app" className="underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const cols = deriveColumns(form, submissions ?? []);

  return (
    <div className="p-6 max-w-7xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex flex-col gap-1 flex-1 min-w-0">
          <Link
            to={`/app/forms/${form.id}`}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
          >
            ← Back to builder
          </Link>
          <h1 className="text-2xl font-bold truncate">
            {form.title} — Submissions
          </h1>
          <p className="text-sm text-muted-foreground">
            {submissions?.length ?? 0}{" "}
            {submissions?.length === 1 ? "response" : "responses"}
          </p>
        </div>
      </div>

      {/* Empty state */}
      {(!submissions || submissions.length === 0) && (
        <EmptyState form={form} />
      )}

      {/* Table */}
      {submissions && submissions.length > 0 && (
        <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
          <table className="w-full text-sm whitespace-nowrap">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Submitted
                </th>
                {cols.map((col) => (
                  <th
                    key={col}
                    className="text-left px-4 py-3 font-medium text-muted-foreground"
                  >
                    {col}
                  </th>
                ))}
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Source IP
                </th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((sub, i) => (
                <tr
                  key={sub.id}
                  className={`border-t border-border/60 ${i % 2 === 0 ? "" : "bg-muted/20"}`}
                >
                  {/* Submitted time — relative with absolute on hover */}
                  <td className="px-4 py-3 text-muted-foreground">
                    <span
                      title={new Date(sub.submittedAt).toLocaleString()}
                    >
                      {relativeTime(sub.submittedAt)}
                    </span>
                  </td>

                  {/* One column per field label */}
                  {cols.map((col) => (
                    <td key={col} className="px-4 py-3">
                      {sub.answers[col] != null ? (
                        <span className="max-w-[300px] truncate block" title={sub.answers[col]}>
                          {sub.answers[col]}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  ))}

                  {/* Source IP */}
                  <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                    {sub.sourceIp ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
