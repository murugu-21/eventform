import { useState } from "react";
import { useNavigate, Link } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PlusIcon, Trash2Icon, ExternalLinkIcon, ClipboardIcon, CheckIcon } from "lucide-react";

import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

// ── Copyable link ────────────────────────────────────────────────────────────
function CopyableLink({ href }: { href: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-sm text-primary underline underline-offset-2 hover:opacity-80 truncate max-w-[200px]"
        title={href}
      >
        {href}
      </a>
      <button
        onClick={copy}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        title="Copy link"
        type="button"
      >
        {copied ? <CheckIcon className="size-3.5" /> : <ClipboardIcon className="size-3.5" />}
      </button>
    </span>
  );
}

// ── New Form Dialog ──────────────────────────────────────────────────────────
function NewFormDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (t: string) => api.createForm(t),
    onSuccess: (form) => {
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      onClose();
      setTitle("");
      navigate(`/app/forms/${form.id}`);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to create form");
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  }

  function handleOpenChange(o: boolean) {
    if (!o) {
      setTitle("");
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>New form</DialogTitle>
          <DialogDescription>Give your form a title to get started.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-form-title">Title</Label>
            <Input
              id="new-form-title"
              placeholder="e.g. Job application"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={!title.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete Confirm Dialog ────────────────────────────────────────────────────
function DeleteFormDialog({
  formId,
  formTitle,
  open,
  onClose,
}: {
  formId: string;
  formTitle: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteForm(formId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      toast.success("Form deleted");
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Failed to delete form";
      toast.error(msg);
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Delete form</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>&quot;{formTitle}&quot;</strong>? This
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

// ── Main Page ────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [newFormOpen, setNewFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  const { data: forms, isLoading, isError } = useQuery({
    queryKey: ["forms"],
    queryFn: () => api.listForms(),
  });

  function handleDeleteClick(id: string, title: string, status: string) {
    if (status === "published") {
      toast.error("Published forms cannot be deleted.");
      return;
    }
    setDeleteTarget({ id, title });
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Forms</h1>
        <Button onClick={() => setNewFormOpen(true)}>
          <PlusIcon className="size-4 mr-1" />
          New form
        </Button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="text-muted-foreground text-sm py-12 text-center">
          Loading forms…
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="text-destructive text-sm py-12 text-center">
          Failed to load forms. Please try again.
        </div>
      )}

      {/* Empty */}
      {!isLoading && !isError && forms?.length === 0 && (
        <div className="flex flex-col items-center gap-4 py-20 text-center text-muted-foreground">
          <p className="text-base">No forms yet.</p>
          <Button variant="outline" onClick={() => setNewFormOpen(true)}>
            <PlusIcon className="size-4 mr-1" />
            Create your first form
          </Button>
        </div>
      )}

      {/* Table */}
      {forms && forms.length > 0 && (
        <div className="rounded-xl ring-1 ring-foreground/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Title</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Created</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Public link</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {forms.map((form, i) => {
                const publicUrl = `${window.location.origin}/forms/${form.publicSlug}`;
                return (
                  <tr
                    key={form.id}
                    className={`border-t border-border/60 ${i % 2 === 0 ? "" : "bg-muted/20"}`}
                  >
                    {/* Title + builder link */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <Link
                          to={`/app/forms/${form.id}`}
                          className="font-medium hover:underline underline-offset-2"
                        >
                          {form.title}
                        </Link>
                        <div className="flex gap-3 text-xs text-muted-foreground">
                          <Link to={`/app/forms/${form.id}`} className="hover:text-foreground">
                            Edit
                          </Link>
                          {form.status === "published" && (
                            <Link
                              to={`/app/forms/${form.id}/submissions`}
                              className="hover:text-foreground"
                            >
                              Submissions
                            </Link>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Status badge */}
                    <td className="px-4 py-3">
                      <Badge
                        variant={form.status === "published" ? "default" : "secondary"}
                      >
                        {form.status}
                      </Badge>
                    </td>

                    {/* Created date */}
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(form.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </td>

                    {/* Public link (published only) */}
                    <td className="px-4 py-3">
                      {form.status === "published" ? (
                        <CopyableLink href={publicUrl} />
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        {form.status === "published" && (
                          <a
                            href={publicUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            title="Open public form"
                          >
                            <ExternalLinkIcon className="size-3.5" />
                          </a>
                        )}
                        <button
                          onClick={() => handleDeleteClick(form.id, form.title, form.status)}
                          className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title={form.status === "published" ? "Cannot delete published form" : "Delete form"}
                          type="button"
                        >
                          <Trash2Icon className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Dialogs */}
      <NewFormDialog open={newFormOpen} onClose={() => setNewFormOpen(false)} />
      {deleteTarget && (
        <DeleteFormDialog
          formId={deleteTarget.id}
          formTitle={deleteTarget.title}
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
