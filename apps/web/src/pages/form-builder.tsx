import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  PlusIcon,
  Trash2Icon,
  ChevronUpIcon,
  ChevronDownIcon,
  CheckIcon,
  ClipboardIcon,
  ArrowLeftIcon,
} from "lucide-react";

import { api, ApiError } from "@/lib/api";
import type { FieldType } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";

// ── Types ────────────────────────────────────────────────────────────────────
interface LocalField {
  /** client-side key for React list rendering */
  _key: string;
  type: FieldType;
  label: string;
  required: boolean;
  options: string[] | null;
}

function makeKey() {
  return Math.random().toString(36).slice(2);
}

function defaultField(): LocalField {
  return { _key: makeKey(), type: "text", label: "", required: false, options: null };
}

// ── Validation (mirrors API rules) ──────────────────────────────────────────
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function validateFields(fields: LocalField[]): ValidationResult {
  const errors: string[] = [];

  if (fields.length === 0) errors.push("At least one field is required.");
  if (fields.length > 50) errors.push("Maximum 50 fields allowed.");

  const labels = fields.map((f) => f.label.trim());
  labels.forEach((label, i) => {
    if (!label) errors.push(`Field ${i + 1}: label is required.`);
  });

  // Unique labels
  const seen = new Set<string>();
  labels.forEach((label) => {
    if (label) {
      if (seen.has(label.toLowerCase())) {
        errors.push(`Duplicate label: "${label}".`);
      }
      seen.add(label.toLowerCase());
    }
  });

  fields.forEach((f, i) => {
    if (f.type === "multiple_choice") {
      const opts = (f.options ?? []).filter((o) => o.trim());
      if (opts.length < 2) {
        errors.push(`Field ${i + 1} (${f.label || "untitled"}): multiple choice needs at least 2 options.`);
      }
      if (opts.length > 20) {
        errors.push(`Field ${i + 1} (${f.label || "untitled"}): maximum 20 options.`);
      }
    }
    if (f.type === "text" && f.options && f.options.length > 0) {
      errors.push(`Field ${i + 1} (${f.label || "untitled"}): text fields must not have options.`);
    }
  });

  return { valid: errors.length === 0, errors };
}

// ── Single-option row (for MC) ───────────────────────────────────────────────
function OptionRow({
  value,
  onChange,
  onRemove,
  canRemove,
  index,
}: {
  value: string;
  onChange: (v: string) => void;
  onRemove: () => void;
  canRemove: boolean;
  index: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        placeholder={`Option ${index + 1}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 text-sm"
      />
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        className="shrink-0 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30"
        title="Remove option"
      >
        <Trash2Icon className="size-3.5" />
      </button>
    </div>
  );
}

// ── Field Editor Row ─────────────────────────────────────────────────────────
function FieldRow({
  field,
  index,
  total,
  readOnly,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  field: LocalField;
  index: number;
  total: number;
  readOnly: boolean;
  onChange: (updated: LocalField) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  function update(patch: Partial<LocalField>) {
    onChange({ ...field, ...patch });
  }

  function handleTypeChange(t: string | null) {
    if (!t) return;
    const type = t as FieldType;
    if (type === "multiple_choice") {
      update({ type, options: ["", ""] });
    } else {
      update({ type, options: null });
    }
  }

  function updateOption(i: number, val: string) {
    const opts = [...(field.options ?? [])];
    opts[i] = val;
    update({ options: opts });
  }

  function addOption() {
    const opts = [...(field.options ?? [])];
    if (opts.length < 20) {
      opts.push("");
      update({ options: opts });
    }
  }

  function removeOption(i: number) {
    const opts = [...(field.options ?? [])];
    opts.splice(i, 1);
    update({ options: opts });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3">
      {/* Row header */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground w-6 shrink-0">
          #{index + 1}
        </span>

        {/* Type select */}
        <Select
          value={field.type}
          onValueChange={handleTypeChange}
          disabled={readOnly}
        >
          <SelectTrigger className="w-40 h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="text">Text</SelectItem>
            <SelectItem value="multiple_choice">Multiple choice</SelectItem>
          </SelectContent>
        </Select>

        {/* Label input */}
        <Input
          placeholder="Field label"
          value={field.label}
          onChange={(e) => update({ label: e.target.value })}
          disabled={readOnly}
          className="flex-1 h-7 text-sm"
          aria-label="label"
        />

        {/* Required switch */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Label
            htmlFor={`req-${field._key}`}
            className="text-xs text-muted-foreground whitespace-nowrap"
          >
            Required
          </Label>
          <Switch
            id={`req-${field._key}`}
            checked={field.required}
            onCheckedChange={(v) => update({ required: Boolean(v) })}
            disabled={readOnly}
            size="sm"
          />
        </div>

        {/* Reorder + remove */}
        {!readOnly && (
          <div className="flex items-center gap-0.5 shrink-0 ml-auto">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={index === 0}
              className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
              title="Move up"
            >
              <ChevronUpIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={index === total - 1}
              className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
              title="Move down"
            >
              <ChevronDownIcon className="size-4" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="p-0.5 text-muted-foreground hover:text-destructive transition-colors"
              title="Remove field"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Options editor (MC only) */}
      {field.type === "multiple_choice" && (
        <div className="ml-8 flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground font-medium">Options (2–20)</span>
          {(field.options ?? []).map((opt, oi) => (
            <OptionRow
              key={oi}
              index={oi}
              value={opt}
              onChange={(v) => updateOption(oi, v)}
              onRemove={() => removeOption(oi)}
              canRemove={!readOnly && (field.options?.length ?? 0) > 2}
            />
          ))}
          {!readOnly && (field.options?.length ?? 0) < 20 && (
            <button
              type="button"
              onClick={addOption}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-fit"
            >
              <PlusIcon className="size-3" />
              Add option
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Publish Confirm Dialog ────────────────────────────────────────────────────
function PublishDialog({
  open,
  onClose,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Publish form</DialogTitle>
          <DialogDescription>
            Publishing is <strong>one-way</strong>. Once published the form will be
            publicly accessible and the fields will become read-only. Are you sure?
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>
            Cancel
          </DialogClose>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Copyable URL ─────────────────────────────────────────────────────────────
function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/50 border border-border px-3 py-2">
      <span
        data-testid="public-link"
        className="flex-1 text-sm font-mono truncate"
        title={url}
      >
        {url}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        title="Copy link"
      >
        {copied ? (
          <>
            <CheckIcon className="size-3.5 text-green-600" />
            <span className="text-green-600">Copied</span>
          </>
        ) : (
          <>
            <ClipboardIcon className="size-3.5" />
            Copy
          </>
        )}
      </button>
    </div>
  );
}

// ── Inline Title Edit ─────────────────────────────────────────────────────────
function TitleEditor({
  formId,
  initialTitle,
  readOnly,
}: {
  formId: string;
  initialTitle: string;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const updateMutation = useMutation({
    mutationFn: (title: string) => api.updateForm(formId, title),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["form", formId] });
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      setEditing(false);
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to update title");
      setEditing(false);
      setValue(initialTitle);
    },
  });

  function commit() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialTitle) {
      setEditing(false);
      setValue(initialTitle);
      return;
    }
    updateMutation.mutate(trimmed);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      setEditing(false);
      setValue(initialTitle);
    }
  }

  if (readOnly || !editing) {
    return (
      <h1
        className={`text-2xl font-bold ${!readOnly ? "cursor-pointer hover:opacity-70" : ""}`}
        onClick={() => { if (!readOnly) setEditing(true); }}
        title={readOnly ? undefined : "Click to edit title"}
      >
        {value || initialTitle}
      </h1>
    );
  }

  return (
    <input
      ref={inputRef}
      className="text-2xl font-bold bg-transparent border-b-2 border-primary outline-none w-full max-w-lg"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
    />
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function FormBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  const [fields, setFields] = useState<LocalField[]>([]);
  const [lastSavedFields, setLastSavedFields] = useState<LocalField[]>([]);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);

  const { data: form, isLoading, isError } = useQuery({
    queryKey: ["form", id],
    queryFn: () => api.getForm(id!),
    enabled: !!id,
  });

  // Initialize local fields from server data (only on first load)
  const initializedRef = useRef(false);
  useEffect(() => {
    if (form && !initializedRef.current) {
      initializedRef.current = true;
      const local: LocalField[] = form.fields.map((f) => ({
        _key: makeKey(),
        type: f.type,
        label: f.label,
        required: f.required,
        options: f.options,
      }));
      setFields(local);
      setLastSavedFields(local);
      if (form.status === "published") {
        setPublicUrl(`${window.location.origin}/forms/${form.publicSlug}`);
      }
    }
  }, [form]);

  const saveFieldsMutation = useMutation({
    mutationFn: (flds: LocalField[]) =>
      api.replaceFields(
        id!,
        flds.map(({ type, label, required, options }) => ({
          type,
          label: label.trim(),
          required,
          options: type === "multiple_choice" ? (options ?? []).filter((o) => o.trim()) : null,
        })),
      ),
    onSuccess: (savedFields) => {
      // Sync local state with server IDs (keep _keys stable)
      const updated: LocalField[] = savedFields.map((sf, i) => ({
        _key: fields[i]?._key ?? makeKey(),
        type: sf.type,
        label: sf.label,
        required: sf.required,
        options: sf.options,
      }));
      setFields(updated);
      setLastSavedFields(updated);
      queryClient.invalidateQueries({ queryKey: ["form", id] });
      toast.success("Fields saved");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save fields");
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => api.publishForm(id!),
    onSuccess: (updatedForm) => {
      queryClient.invalidateQueries({ queryKey: ["form", id] });
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      const url = `${window.location.origin}/forms/${updatedForm.publicSlug}`;
      setPublicUrl(url);
      setPublishDialogOpen(false);
      toast.success("Form published!");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to publish form");
      setPublishDialogOpen(false);
    },
  });

  // ── Dirty check ────────────────────────────────────────────────────────────
  function fieldsEqual(a: LocalField[], b: LocalField[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((af, i) => {
      const bf = b[i];
      return (
        af.type === bf.type &&
        af.label === bf.label &&
        af.required === bf.required &&
        JSON.stringify(af.options) === JSON.stringify(bf.options)
      );
    });
  }

  const isDirty = !fieldsEqual(fields, lastSavedFields);
  const validation = validateFields(fields);
  const canSave = isDirty && validation.valid && !saveFieldsMutation.isPending;

  const isPublished = form?.status === "published";
  const hasSavedFields = lastSavedFields.length > 0;
  const canPublish = !isPublished && hasSavedFields && !isDirty && !publishMutation.isPending;

  // ── Field mutations ────────────────────────────────────────────────────────
  function addField() {
    if (fields.length >= 50) {
      toast.error("Maximum 50 fields allowed.");
      return;
    }
    setFields((prev) => [...prev, defaultField()]);
  }

  function updateField(index: number, updated: LocalField) {
    setFields((prev) => prev.map((f, i) => (i === index ? updated : f)));
  }

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }

  function moveField(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= fields.length) return;
    setFields((prev) => {
      const arr = [...prev];
      [arr[index], arr[next]] = [arr[next], arr[index]];
      return arr;
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm">Loading form…</div>
    );
  }

  if (isError || !form) {
    return (
      <div className="p-6 text-center text-destructive text-sm">
        Failed to load form.{" "}
        <Link to="/app" className="underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl mx-auto flex flex-col gap-6">
      {/* Back link */}
      <Link
        to="/app"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
      >
        <ArrowLeftIcon className="size-3.5" />
        Dashboard
      </Link>

      {/* Title + status */}
      <div className="flex items-center gap-3 flex-wrap">
        <TitleEditor
          formId={form.id}
          initialTitle={form.title}
          readOnly={isPublished}
        />
        <Badge variant={isPublished ? "default" : "secondary"}>{form.status}</Badge>
      </div>

      {/* Published notice + public URL */}
      {isPublished && publicUrl && (
        <div className="flex flex-col gap-2 rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/20 p-4">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Form is live — share this link:
          </p>
          <CopyableUrl url={publicUrl} />
        </div>
      )}

      {isPublished && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          This form is published. Fields are read-only.
        </div>
      )}

      {/* Field list */}
      <div className="flex flex-col gap-3">
        {fields.length === 0 && !isPublished && (
          <div className="text-center text-muted-foreground text-sm py-10 border border-dashed rounded-lg">
            No fields yet. Add one below.
          </div>
        )}
        {fields.map((field, i) => (
          <FieldRow
            key={field._key}
            field={field}
            index={i}
            total={fields.length}
            readOnly={isPublished}
            onChange={(updated) => updateField(i, updated)}
            onRemove={() => removeField(i)}
            onMoveUp={() => moveField(i, -1)}
            onMoveDown={() => moveField(i, 1)}
          />
        ))}
      </div>

      {/* Validation errors (only when attempted/dirty) */}
      {isDirty && !validation.valid && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 flex flex-col gap-1">
          {validation.errors.map((e) => (
            <p key={e} className="text-xs text-destructive">
              {e}
            </p>
          ))}
        </div>
      )}

      {/* Action bar */}
      {!isPublished && (
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="outline"
            onClick={addField}
            disabled={fields.length >= 50}
          >
            <PlusIcon className="size-4 mr-1" />
            Add field
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Button
              onClick={() => saveFieldsMutation.mutate(fields)}
              disabled={!canSave}
            >
              {saveFieldsMutation.isPending ? "Saving…" : "Save fields"}
            </Button>

            <Button
              variant="secondary"
              onClick={() => setPublishDialogOpen(true)}
              disabled={!canPublish}
              title={
                isDirty
                  ? "Save fields first"
                  : !hasSavedFields
                  ? "Add and save at least one field"
                  : undefined
              }
            >
              Publish
            </Button>
          </div>
        </div>
      )}

      {/* Publish dialog */}
      <PublishDialog
        open={publishDialogOpen}
        onClose={() => setPublishDialogOpen(false)}
        onConfirm={() => publishMutation.mutate()}
        isPending={publishMutation.isPending}
      />
    </div>
  );
}
