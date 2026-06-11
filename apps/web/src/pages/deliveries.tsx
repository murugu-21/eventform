import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { DeliveryStatus } from "@/lib/types";
import { DeliveryRow, StatusBadge } from "@/components/delivery-row";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── Status options ────────────────────────────────────────────────────────────

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "delivered", label: "Delivered" },
  { value: "retrying", label: "Retrying" },
  { value: "failed", label: "Failed" },
];

// ── Per-status count chips ────────────────────────────────────────────────────

function StatusChips({
  counts,
}: {
  counts: Record<DeliveryStatus | "total", number>;
}) {
  if (counts.total === 0) return null;

  return (
    <div className="flex gap-2 flex-wrap items-center">
      <Badge variant="outline">{counts.total} total</Badge>
      {counts.pending > 0 && (
        <Badge variant="secondary">
          {counts.pending} pending
        </Badge>
      )}
      {counts.delivered > 0 && (
        <Badge
          variant="secondary"
          className="bg-green-100 text-green-800 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900"
        >
          {counts.delivered} delivered
        </Badge>
      )}
      {counts.retrying > 0 && (
        <Badge
          variant="secondary"
          className="bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900"
        >
          {counts.retrying} retrying
        </Badge>
      )}
      {counts.failed > 0 && (
        <Badge variant="destructive">
          {counts.failed} failed
        </Badge>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DeliveriesPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [endpointFilter, setEndpointFilter] = useState<string>("all");

  // Endpoints list (for filter dropdown)
  const { data: endpoints } = useQuery({
    queryKey: ["endpoints"],
    queryFn: () => api.listEndpoints(),
  });

  // Deliveries with polling
  const filter: { status?: string; endpointId?: string } = {};
  if (statusFilter !== "all") filter.status = statusFilter;
  if (endpointFilter !== "all") filter.endpointId = endpointFilter;

  const {
    data: deliveries,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["deliveries", filter],
    queryFn: () => api.listDeliveries(filter),
    refetchInterval: 5000,
  });

  // Per-status counts
  const counts: Record<DeliveryStatus | "total", number> = {
    total: 0,
    pending: 0,
    delivered: 0,
    retrying: 0,
    failed: 0,
  };
  if (deliveries) {
    counts.total = deliveries.length;
    for (const d of deliveries) {
      counts[d.status] = (counts[d.status] ?? 0) + 1;
    }
  }

  return (
    <div className="p-6 max-w-7xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Deliveries</h1>
        <p className="text-sm text-muted-foreground">
          Webhook delivery attempts — auto-refreshes every 5 seconds.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.value !== "all" ? (
                  <span className="flex items-center gap-2">
                    <StatusBadge status={opt.value as DeliveryStatus} />
                  </span>
                ) : (
                  opt.label
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={endpointFilter} onValueChange={(v) => setEndpointFilter(v ?? "all")}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="All endpoints" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All endpoints</SelectItem>
            {endpoints?.map((ep) => (
              <SelectItem key={ep.id} value={ep.id}>
                {ep.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Per-status summary chips */}
      {deliveries && <StatusChips counts={counts} />}

      {/* Loading */}
      {isLoading && (
        <div className="text-muted-foreground text-sm py-12 text-center">
          Loading deliveries…
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="text-destructive text-sm py-12 text-center">
          Failed to load deliveries. Please try again.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && deliveries?.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-20 text-center text-muted-foreground">
          <p className="text-base">No deliveries found.</p>
          {statusFilter === "all" && endpointFilter === "all" ? (
            <p className="text-sm max-w-sm">
              Deliveries appear here once you submit a form with at least one active endpoint
              configured.
            </p>
          ) : (
            <p className="text-sm">
              No deliveries match the current filters. Try broadening your selection.
            </p>
          )}
        </div>
      )}

      {/* Table */}
      {deliveries && deliveries.length > 0 && (
        <div className="rounded-xl ring-1 ring-foreground/10 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="w-8 pl-4 pr-0 py-3" />
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Status
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Endpoint
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Submission
                </th>
                <th className="text-center px-4 py-3 font-medium text-muted-foreground">
                  Attempts
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Last response
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Next retry
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  Created
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery, i) => (
                <DeliveryRow key={delivery.id} delivery={delivery} index={i} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer note */}
      {deliveries && deliveries.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing latest 200 deliveries.
        </p>
      )}
    </div>
  );
}
