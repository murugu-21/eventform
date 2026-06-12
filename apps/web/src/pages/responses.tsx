import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "@/lib/api";
import type { SubmissionWithForm } from "@/lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function answersPreview(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

export default function ResponsesPage() {
  const { data: responses, isLoading } = useQuery({
    queryKey: ["responses"],
    queryFn: () => api.listAllSubmissions(),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Responses</h1>
        <p className="text-sm text-muted-foreground">
          Every form submission across your account, newest first.
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !responses || responses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No responses yet. Publish a form and share its public link to start
          collecting.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Submitted</TableHead>
              <TableHead className="w-48">Form</TableHead>
              <TableHead>Answers</TableHead>
              <TableHead className="w-32 text-right">Source IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {responses.map((r: SubmissionWithForm) => (
              <TableRow key={r.id}>
                <TableCell
                  className="text-muted-foreground whitespace-nowrap"
                  title={new Date(r.submittedAt).toLocaleString()}
                >
                  {relativeTime(r.submittedAt)}
                </TableCell>
                <TableCell>
                  <Link
                    to={`/app/forms/${r.formId}/submissions`}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {r.formTitle}
                  </Link>
                </TableCell>
                <TableCell
                  className="max-w-md truncate text-muted-foreground"
                  title={answersPreview(r.answers)}
                >
                  {answersPreview(r.answers)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {r.sourceIp ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <p className="text-xs text-muted-foreground">Showing latest 200.</p>
    </div>
  );
}
