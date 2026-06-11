import { useState } from "react";
import { useParams, Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, ApiError } from "@/lib/api";
import type { PublicForm, FormField } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

// ── Not-found / error state ──────────────────────────────────────────────────
function FormNotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="max-w-md w-full p-8 flex flex-col items-center gap-4 text-center">
        <div className="text-5xl">🔍</div>
        <h1 className="text-2xl font-bold">Form not found</h1>
        <p className="text-muted-foreground text-sm">
          This form doesn't exist or is no longer available. Check the link and try again.
        </p>
        <Link
          to="/"
          className="text-sm text-primary underline underline-offset-2 hover:opacity-80"
        >
          Go to homepage
        </Link>
      </Card>
    </div>
  );
}

// ── Thank-you state ──────────────────────────────────────────────────────────
function ThankYou() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="max-w-md w-full p-8 flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-bold">Response recorded</h1>
        <p className="text-muted-foreground text-sm">
          Thanks for your submission. Your response has been saved.
        </p>
        <p className="text-xs text-muted-foreground mt-4">
          Powered by{" "}
          <Link
            to="/"
            className="text-primary underline underline-offset-2 hover:opacity-80"
          >
            eventform
          </Link>
        </p>
      </Card>
    </div>
  );
}

// ── Field renderer ────────────────────────────────────────────────────────────
function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: FormField;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const labelId = `field-${field.id}`;
  const hasError = !!error;

  if (field.type === "text") {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={labelId} className="font-medium text-sm">
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </Label>
        <Input
          id={labelId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={hasError || undefined}
          aria-describedby={hasError ? `${labelId}-error` : undefined}
          placeholder={`Enter ${field.label.toLowerCase()}`}
        />
        {hasError && (
          <p id={`${labelId}-error`} className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (field.type === "multiple_choice" && field.options) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label className="font-medium text-sm">
          {field.label}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </Label>
        <RadioGroup
          value={value || undefined}
          onValueChange={onChange}
          aria-labelledby={labelId}
          aria-invalid={hasError || undefined}
        >
          {field.options.map((opt) => (
            <div key={opt} className="flex items-center gap-2">
              <RadioGroupItem
                id={`${field.id}-${opt}`}
                value={opt}
              />
              <Label
                htmlFor={`${field.id}-${opt}`}
                className="text-sm font-normal cursor-pointer"
              >
                {opt}
              </Label>
            </div>
          ))}
        </RadioGroup>
        {hasError && (
          <p className="text-xs text-destructive">{error}</p>
        )}
      </div>
    );
  }

  return null;
}

// ── Form renderer (after data loaded) ────────────────────────────────────────
function FormView({ form }: { form: PublicForm }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.label, ""]))
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);

  // Sort fields by position
  const sortedFields = [...form.fields].sort((a, b) => a.position - b.position);

  function validate(): boolean {
    const errors: Record<string, string> = {};
    for (const field of sortedFields) {
      const val = answers[field.label] ?? "";
      if (field.required && !val.trim()) {
        errors[field.label] = "This field is required.";
      }
      if (field.type === "multiple_choice" && field.options && val && !field.options.includes(val)) {
        errors[field.label] = "Please select a valid option.";
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setRateError(null);

    if (!validate()) return;

    setSubmitting(true);
    try {
      await api.publicSubmit(form.slug, answers);
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setRateError("Too many submissions — try again in a minute.");
        } else if (err.status === 400 && err.errors) {
          // Map server errors to inline field errors where possible
          const serverErrors = err.errors as { path?: string; message: string }[] | string[];
          const newFieldErrors: Record<string, string> = {};
          let hasInline = false;

          for (const serverErr of serverErrors) {
            const msg = typeof serverErr === "string" ? serverErr : serverErr.message;
            // Match error message against field labels
            const matchedField = sortedFields.find(
              (f) => msg.toLowerCase().includes(f.label.toLowerCase())
            );
            if (matchedField) {
              newFieldErrors[matchedField.label] = msg;
              hasInline = true;
            }
          }

          if (Object.keys(newFieldErrors).length > 0) {
            setFieldErrors(newFieldErrors);
          }
          if (!hasInline) {
            toast.error(err.message || "Submission failed. Please check your answers.");
          }
        } else {
          toast.error(err.message || "Submission failed. Please try again.");
        }
      } else {
        toast.error("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) return <ThankYou />;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <Card className="max-w-lg w-full p-8 flex flex-col gap-6">
        {/* Form header */}
        <div>
          <h1 className="text-2xl font-bold">{form.title}</h1>
          {form.fields.some((f) => f.required) && (
            <p className="text-xs text-muted-foreground mt-1">
              Fields marked <span className="text-destructive">*</span> are required.
            </p>
          )}
        </div>

        {/* Rate limit error */}
        {rateError && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {rateError}
          </div>
        )}

        {/* Fields */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
          {sortedFields.map((field) => (
            <FieldInput
              key={field.id}
              field={field}
              value={answers[field.label] ?? ""}
              error={fieldErrors[field.label] ?? null}
              onChange={(v) =>
                setAnswers((prev) => ({ ...prev, [field.label]: v }))
              }
            />
          ))}

          <Button type="submit" disabled={submitting} className="w-full mt-2">
            {submitting ? "Submitting…" : "Submit"}
          </Button>
        </form>

        {/* Footer */}
        <p className="text-xs text-center text-muted-foreground">
          Powered by{" "}
          <Link
            to="/"
            className="text-primary underline underline-offset-2 hover:opacity-80"
          >
            eventform
          </Link>
        </p>
      </Card>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PublicFormPage() {
  const { slug } = useParams<{ slug: string }>();

  const { data: form, isLoading, isError, error } = useQuery({
    queryKey: ["public-form", slug],
    queryFn: () => api.publicGetForm(slug!),
    enabled: !!slug,
    retry: (failureCount, err) => {
      // Don't retry 404s
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 1;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Loading form…</p>
      </div>
    );
  }

  // 404 or any error → friendly not-found
  if (isError || !form) {
    const is404 = error instanceof ApiError && error.status === 404;
    // Non-404 errors show not-found too (defensive — form may not exist)
    void is404;
    return <FormNotFound />;
  }

  return <FormView form={form} />;
}
