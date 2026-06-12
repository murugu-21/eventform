import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";

import { api, ApiError } from "@/lib/api";
import type { Delivery, DeliveryAttempt } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

// ── Status badge helpers ──────────────────────────────────────────────────────

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

function statusVariant(status: Delivery["status"]): BadgeVariant {
  switch (status) {
    case "delivered":
      return "default"; // will override class for green
    case "retrying":
      return "secondary"; // will override for amber
    case "failed":
      return "destructive";
    case "pending":
    default:
      return "secondary";
  }
}

function statusClass(status: Delivery["status"]): string {
  switch (status) {
    case "delivered":
      return "bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900";
    case "retrying":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900";
    case "failed":
      return ""; // destructive variant handles it
    case "pending":
    default:
      return "";
  }
}

export function StatusBadge({ status }: { status: Delivery["status"] }) {
  return (
    <Badge
      variant={statusVariant(status)}
      className={statusClass(status)}
    >
      {status}
    </Badge>
  );
}

// ── Countdown helper ─────────────────────────────────────────────────────────

function RetryCountdown({ nextRetryAt }: { nextRetryAt: string }) {
  const delta = new Date(nextRetryAt).getTime() - Date.now();
  if (delta <= 0) return <span className="text-xs text-muted-foreground">soon</span>;
  const s = Math.ceil(delta / 1000);
  if (s < 60) return <span className="text-xs text-amber-600 dark:text-amber-400">in {s}s</span>;
  const m = Math.floor(s / 60);
  return <span className="text-xs text-amber-600 dark:text-amber-400">in {m}m</span>;
}

// ── Attempts timeline ────────────────────────────────────────────────────────

function AttemptsTimeline({ deliveryId }: { deliveryId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["delivery", deliveryId],
    queryFn: () => api.getDelivery(deliveryId),
  });

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        Loading attempts…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="px-4 py-3 text-xs text-destructive">
        Failed to load attempts.
      </div>
    );
  }

  const attempts = data.attempts ?? [];

  return (
    <div className="px-4 py-3 flex flex-col gap-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Attempt history
      </p>
      {attempts.length === 0 && (
        <p className="text-xs text-muted-foreground">No attempts yet.</p>
      )}
      <div className="flex flex-col gap-1.5">
        {attempts.map((attempt: DeliveryAttempt) => (
          <div
            key={attempt.id}
            className="flex items-start gap-3 text-xs rounded-lg bg-muted/50 px-3 py-2"
          >
            {/* Attempt # */}
            <span className="shrink-0 font-mono font-medium text-muted-foreground w-5">
              #{attempt.attemptNo}
            </span>
            {/* Time */}
            <span
              className="shrink-0 text-muted-foreground"
              title={new Date(attempt.requestedAt).toLocaleString()}
            >
              {new Date(attempt.requestedAt).toLocaleTimeString()}
            </span>
            {/* Response code */}
            <span
              className={`shrink-0 font-mono font-medium ${
                attempt.responseCode && attempt.responseCode >= 200 && attempt.responseCode < 300
                  ? "text-green-700 dark:text-green-400"
                  : attempt.responseCode
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {attempt.responseCode ?? "—"}
            </span>
            {/* Error */}
            {attempt.error && (
              <span
                className="text-destructive truncate flex-1"
                title={attempt.error}
              >
                {attempt.error}
              </span>
            )}
            {/* Duration */}
            {attempt.durationMs != null && (
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                {attempt.durationMs}ms
              </span>
            )}
          </div>
        ))}
      </div>

      <PayloadViewer payload={data.payload} />
    </div>
  );
}

// ── Webhook payload viewer ───────────────────────────────────────────────────

function PayloadViewer({ payload }: { payload: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(payload, null, 2);

  function copy() {
    void navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Webhook payload
        </p>
        <button
          type="button"
          onClick={copy}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <pre className="text-xs font-mono rounded-lg bg-muted/50 px-3 py-2 overflow-x-auto max-h-64">
        {json}
      </pre>
    </div>
  );
}

// ── Delivery row ─────────────────────────────────────────────────────────────

export function DeliveryRow({
  delivery,
  index,
}: {
  delivery: Delivery;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const retryMutation = useMutation({
    mutationFn: () => api.retryDelivery(delivery.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deliveries"] });
      toast.success("Retry queued");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Retry failed");
    },
  });

  const shortId = delivery.submissionId.slice(0, 8);
  const stripe = index % 2 === 0 ? "" : "bg-muted/20";

  return (
    <>
      <tr
        className={`border-t border-border/60 cursor-pointer hover:bg-accent/30 transition-colors ${stripe}`}
        onClick={() => setExpanded((e) => !e)}
      >
        {/* Expand chevron */}
        <td className="w-8 pl-4 pr-0 py-3">
          {expanded ? (
            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          )}
        </td>

        {/* Status */}
        <td className="px-4 py-3">
          <StatusBadge status={delivery.status} />
        </td>

        {/* Endpoint name */}
        <td className="px-4 py-3 font-medium text-sm">
          {delivery.endpointName}
        </td>

        {/* Short submission id */}
        <td className="px-4 py-3">
          <span
            className="font-mono text-xs text-muted-foreground"
            title={delivery.submissionId}
          >
            {shortId}…
          </span>
        </td>

        {/* Attempts */}
        <td className="px-4 py-3 text-center tabular-nums text-sm">
          {delivery.attemptCount}
        </td>

        {/* Last response / error */}
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {delivery.responseCode != null && (
              <span
                className={`font-mono text-xs font-medium ${
                  delivery.responseCode >= 200 && delivery.responseCode < 300
                    ? "text-green-700 dark:text-green-400"
                    : "text-destructive"
                }`}
              >
                {delivery.responseCode}
              </span>
            )}
            {delivery.lastError && (
              <span
                className="text-xs text-muted-foreground truncate max-w-[180px]"
                title={delivery.lastError}
              >
                {delivery.lastError}
              </span>
            )}
            {!delivery.responseCode && !delivery.lastError && (
              <span className="text-muted-foreground text-xs">—</span>
            )}
          </div>
        </td>

        {/* Next retry countdown */}
        <td className="px-4 py-3">
          {delivery.status === "retrying" && delivery.nextRetryAt ? (
            <RetryCountdown nextRetryAt={delivery.nextRetryAt} />
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </td>

        {/* Created */}
        <td className="px-4 py-3 text-muted-foreground text-xs">
          <span title={new Date(delivery.createdAt).toLocaleString()}>
            {new Date(delivery.createdAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </td>

        {/* Actions */}
        <td
          className="px-4 py-3"
          onClick={(e) => e.stopPropagation()} // prevent row toggle when clicking retry
        >
          {delivery.status === "failed" && (
            <Button
              size="xs"
              variant="outline"
              disabled={retryMutation.isPending}
              onClick={() => retryMutation.mutate()}
            >
              <RefreshCwIcon className="size-3" />
              {retryMutation.isPending ? "…" : "Retry"}
            </Button>
          )}
        </td>
      </tr>

      {/* Expanded attempts */}
      {expanded && (
        <tr className={`border-t border-border/40 ${stripe}`}>
          <td colSpan={9} className="p-0">
            <AttemptsTimeline deliveryId={delivery.id} />
          </td>
        </tr>
      )}
    </>
  );
}
