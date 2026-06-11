import { useState } from "react";
import { CheckIcon, ClipboardIcon, ShieldAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface SecretDialogProps {
  open: boolean;
  secret: string;
  title?: string;
  description?: string;
  onClose: () => void;
}

export function SecretDialog({
  open,
  secret,
  title = "Webhook signing secret",
  description = "This secret is shown once. Store it somewhere safe — you cannot retrieve it in full again.",
  onClose,
}: SecretDialogProps) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleClose() {
    setConfirmed(false);
    setCopied(false);
    onClose();
  }

  function handleOpenChange(o: boolean) {
    if (!o && confirmed) {
      handleClose();
    }
    // If not confirmed, block implicit close (backdrop/Escape)
    // by doing nothing — user must click the button.
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ShieldAlertIcon className="size-4 text-amber-500 shrink-0" />
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Secret value */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5">
            <code
              className="flex-1 font-mono text-xs break-all text-foreground select-all"
              data-testid="secret-value"
            >
              {secret}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              title="Copy secret"
            >
              {copied ? (
                <CheckIcon className="size-4 text-green-600" />
              ) : (
                <ClipboardIcon className="size-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Shown once — store it now. After closing, you can only reveal the full secret via the
            "Reveal" button, which requires your saved copy to verify.
          </p>
        </div>

        {/* Confirmation checkbox */}
        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-0.5 accent-primary"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span className="text-sm text-muted-foreground leading-snug">
            I've stored the secret somewhere safe
          </span>
        </label>

        <DialogFooter>
          <Button
            disabled={!confirmed}
            onClick={handleClose}
            data-testid="secret-close"
          >
            I've stored it — close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
