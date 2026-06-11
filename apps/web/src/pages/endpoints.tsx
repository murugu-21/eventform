import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  PlusIcon,
  Trash2Icon,
  EyeIcon,
  RotateCcwIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";

import { api, ApiError } from "@/lib/api";
import type { Endpoint } from "@/lib/types";
import { SecretDialog } from "@/components/secret-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Verify-signatures snippet ────────────────────────────────────────────────

const VERIFY_SNIPPET = `// Node.js receiver-side signature verification
import crypto from "node:crypto";

function verifyEventformSignature(
  rawBody: string,        // raw request body — before JSON.parse
  signature: string,     // X-Eventform-Signature header value
  timestamp: string,     // X-Eventform-Timestamp header value (Unix seconds)
  secret: string,        // whsec_… value stored at endpoint creation / rotation
  maxAgeSeconds = 300,
): boolean {
  // Reject stale timestamps (replay attack prevention)
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > maxAgeSeconds) {
    return false;
  }

  // Compute HMAC-SHA256 of "<timestamp>.<rawBody>"
  const mac = crypto
    .createHmac("sha256", secret)
    .update(\`\${timestamp}.\${rawBody}\`)
    .digest("hex");

  // Constant-time comparison (timing-safe)
  return crypto.timingSafeEqual(
    Buffer.from(mac, "hex"),
    Buffer.from(signature, "hex"),
  );
}`;

// ── Create Endpoint Dialog ───────────────────────────────────────────────────

function CreateEndpointDialog({
  open,
  onClose,
  onSecret,
}: {
  open: boolean;
  onClose: () => void;
  onSecret: (secret: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: () => api.createEndpoint(name.trim(), url.trim()),
    onSuccess: (ep) => {
      queryClient.invalidateQueries({ queryKey: ["endpoints"] });
      reset();
      onSecret(ep.secret);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to create endpoint");
    },
  });

  function reset() {
    setName("");
    setUrl("");
    setUrlError("");
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!isValidUrl(trimmedUrl)) {
      setUrlError("URL must start with http:// or https://");
      return;
    }
    setUrlError("");
    createMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>New endpoint</DialogTitle>
          <DialogDescription>
            Add a webhook endpoint to receive form submission events.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ep-name">Name</Label>
            <Input
              id="ep-name"
              placeholder="e.g. Production webhook"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ep-url">URL</Label>
            <Input
              id="ep-url"
              placeholder="https://example.com/webhook"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (urlError) setUrlError("");
              }}
              aria-invalid={!!urlError}
            />
            {urlError && (
              <p className="text-xs text-destructive">{urlError}</p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={!name.trim() || !url.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Rotate Confirm Dialog ────────────────────────────────────────────────────

function RotateDialog({
  endpoint,
  open,
  onClose,
  onSecret,
}: {
  endpoint: Endpoint;
  open: boolean;
  onClose: () => void;
  onSecret: (secret: string) => void;
}) {
  const rotateMutation = useMutation({
    mutationFn: () => api.rotateSecret(endpoint.id),
    onSuccess: (ep) => {
      onClose();
      onSecret(ep.secret);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to rotate secret");
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Rotate signing secret</DialogTitle>
          <DialogDescription>
            The existing secret for <strong>"{endpoint.name}"</strong> will stop working
            immediately. Any receivers using the old secret will fail signature verification
            until updated. Continue?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => rotateMutation.mutate()}
            disabled={rotateMutation.isPending}
          >
            {rotateMutation.isPending ? "Rotating…" : "Rotate secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Confirm Dialog ────────────────────────────────────────────────────

function DeleteEndpointDialog({
  endpoint,
  open,
  onClose,
}: {
  endpoint: Endpoint;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteEndpoint(endpoint.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["endpoints"] });
      toast.success("Endpoint deleted");
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(err.message || "Cannot delete: endpoint has delivery records");
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to delete endpoint");
      }
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete endpoint</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>"{endpoint.name}"</strong>? This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Active toggle (row-level) ────────────────────────────────────────────────

function ActiveSwitch({ endpoint }: { endpoint: Endpoint }) {
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: (active: boolean) => api.updateEndpoint(endpoint.id, { active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["endpoints"] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update endpoint");
    },
  });

  return (
    <Switch
      checked={endpoint.active}
      onCheckedChange={(checked) => updateMutation.mutate(checked)}
      disabled={updateMutation.isPending}
      aria-label={endpoint.active ? "Deactivate endpoint" : "Activate endpoint"}
    />
  );
}

// ── Verify Signatures Card (collapsible) ─────────────────────────────────────

function VerifySignaturesCard() {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <CardTitle>Verify signatures</CardTitle>
        </div>
        <CardDescription className="ml-6">
          How to validate incoming webhook requests on your server.
        </CardDescription>
      </CardHeader>

      {open && (
        <CardContent>
          <pre className="overflow-x-auto rounded-lg bg-muted/60 p-4 text-xs font-mono leading-relaxed text-foreground">
            <code>{VERIFY_SNIPPET}</code>
          </pre>
        </CardContent>
      )}
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function EndpointsPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [secretValue, setSecretValue] = useState<string | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Endpoint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Endpoint | null>(null);

  const queryClient = useQueryClient();

  const { data: endpoints, isLoading, isError } = useQuery({
    queryKey: ["endpoints"],
    queryFn: () => api.listEndpoints(),
  });

  function handleReveal(endpoint: Endpoint) {
    api
      .revealSecret(endpoint.id)
      .then(({ secret }) => setSecretValue(secret))
      .catch((err: unknown) => {
        toast.error(err instanceof ApiError ? err.message : "Failed to reveal secret");
      });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Endpoints</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Webhook destinations that receive form submission events.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4 mr-1" />
          New endpoint
        </Button>
      </div>

      {/* Status chips */}
      {endpoints && endpoints.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          <Badge variant="outline">
            {endpoints.length} total
          </Badge>
          <Badge variant="outline" className="text-green-700 border-green-200 bg-green-50 dark:text-green-400 dark:border-green-900 dark:bg-green-950/40">
            {endpoints.filter((e) => e.active).length} active
          </Badge>
          {endpoints.filter((e) => !e.active).length > 0 && (
            <Badge variant="secondary">
              {endpoints.filter((e) => !e.active).length} inactive
            </Badge>
          )}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="text-muted-foreground text-sm py-12 text-center">
          Loading endpoints…
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="text-destructive text-sm py-12 text-center">
          Failed to load endpoints. Please try again.
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && endpoints?.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-20 text-center text-muted-foreground">
          <p className="text-base">No endpoints yet.</p>
          <p className="text-sm max-w-sm">
            Create an endpoint to start receiving webhook notifications when a form is submitted.
          </p>
          <Button variant="outline" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4 mr-1" />
            Create your first endpoint
          </Button>
        </div>
      )}

      {/* Table */}
      {endpoints && endpoints.length > 0 && (
        <div className="rounded-xl ring-1 ring-foreground/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">URL</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Active</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {endpoints.map((ep, i) => (
                <tr
                  key={ep.id}
                  className={`border-t border-border/60 ${i % 2 === 0 ? "" : "bg-muted/20"}`}
                >
                  {/* Name */}
                  <td className="px-4 py-3 font-medium">{ep.name}</td>

                  {/* URL */}
                  <td className="px-4 py-3 text-muted-foreground">
                    <span
                      className="font-mono text-xs truncate max-w-[260px] block"
                      title={ep.url}
                    >
                      {ep.url}
                    </span>
                  </td>

                  {/* Active switch */}
                  <td className="px-4 py-3">
                    <ActiveSwitch endpoint={ep} />
                  </td>

                  {/* Created */}
                  <td className="px-4 py-3 text-muted-foreground">
                    {fmtDate(ep.createdAt)}
                  </td>

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        type="button"
                        onClick={() => handleReveal(ep)}
                        className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        title="Reveal signing secret"
                      >
                        <EyeIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRotateTarget(ep)}
                        className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        title="Rotate signing secret"
                      >
                        <RotateCcwIcon className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(ep)}
                        className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title="Delete endpoint"
                      >
                        <Trash2Icon className="size-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Verify signatures card (always shown) */}
      {!isLoading && <VerifySignaturesCard />}

      {/* ── Dialogs ─────────────────────────────────────────────────────────── */}

      <CreateEndpointDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSecret={(secret) => {
          setCreateOpen(false);
          setSecretValue(secret);
        }}
      />

      {/* Secret dialog (create + reveal + rotate) */}
      <SecretDialog
        open={secretValue !== null}
        secret={secretValue ?? ""}
        onClose={() => {
          setSecretValue(null);
          queryClient.invalidateQueries({ queryKey: ["endpoints"] });
        }}
      />

      {/* Rotate confirm */}
      {rotateTarget && (
        <RotateDialog
          endpoint={rotateTarget}
          open={!!rotateTarget}
          onClose={() => setRotateTarget(null)}
          onSecret={(secret) => {
            setRotateTarget(null);
            setSecretValue(secret);
          }}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <DeleteEndpointDialog
          endpoint={deleteTarget}
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
