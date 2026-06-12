import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { api } from "@/lib/api";
import type { SubmissionWithForm } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

function AnswersDialog({
  response,
  onClose,
}: {
  response: SubmissionWithForm | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={response !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {response && (
          <>
            <DialogHeader>
              <DialogTitle>{response.formTitle}</DialogTitle>
              <DialogDescription>
                Submitted {new Date(response.submittedAt).toLocaleString()}
                {response.sourceIp ? ` · from ${response.sourceIp}` : ""}
              </DialogDescription>
            </DialogHeader>
            <dl className="flex flex-col gap-4 max-h-96 overflow-y-auto">
              {Object.entries(response.answers).map(([question, answer]) => (
                <div key={question} className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {question}
                  </dt>
                  <dd className="text-sm text-foreground whitespace-pre-wrap break-words">
                    {answer || <span className="text-muted-foreground">—</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ResponsesPage() {
  const [selected, setSelected] = useState<SubmissionWithForm | null>(null);
  const { data: responses, isLoading } = useQuery({
    queryKey: ["responses"],
    queryFn: () => api.listAllSubmissions(),
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">Responses</h1>
        <p className="text-sm text-muted-foreground">
          Every form submission across your account, newest first. Click a row
          to view the full response.
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
              <TableHead className="w-56">Form</TableHead>
              <TableHead>Response</TableHead>
              <TableHead className="w-32 text-right">Source IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {responses.map((r: SubmissionWithForm) => {
              const answerCount = Object.keys(r.answers).length;
              const firstAnswer = Object.values(r.answers)[0] ?? "";
              return (
                <TableRow
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(r)}
                >
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
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.formTitle}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground">
                    {firstAnswer}
                    {answerCount > 1 && (
                      <span className="ml-2 text-xs">
                        +{answerCount - 1} more
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {r.sourceIp ?? "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <p className="text-xs text-muted-foreground">Showing latest 200.</p>

      <AnswersDialog response={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
