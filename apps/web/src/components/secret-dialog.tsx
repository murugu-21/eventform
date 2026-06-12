import { useState } from "react";
import { CheckIcon, ClipboardIcon, KeyRoundIcon } from "lucide-react";

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

/**
 * Honest security model: the secret is stored KMS-encrypted at rest and the
 * worker decrypts it to sign every webhook — so the endpoint owner can reveal
 * it again (or rotate it) at any time. No "shown once" theater.
 */
export function SecretDialog({
  open,
  secret,
  title = "Webhook signing secret",
  description = "Add this secret to your receiver to verify webhook signatures.",
  onClose,
}: SecretDialogProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleClose() {
    setCopied(false);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <KeyRoundIcon className="size-4 text-muted-foreground shrink-0" />
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
          <p className="text-xs text-muted-foreground">
            Stored encrypted with KMS. You can reveal it again from the endpoints
            table anytime, or rotate it — rotation invalidates the old secret
            immediately, so update your receiver in the same sitting.
          </p>
        </div>

        <DialogFooter>
          <Button onClick={handleClose} data-testid="secret-close">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
