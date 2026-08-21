import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

/**
 * Confirmation for the cleanup surfaces, replacing `window.confirm`/`prompt`.
 *
 * The browser's own dialogs were doing this work, and they are the wrong tool
 * where the stakes are highest: they cannot show what is about to be destroyed,
 * cannot style a destructive action differently from a routine one, and a
 * `prompt` for a rejection reason cannot be validated — an empty string, a
 * cancel and a space are all indistinguishable to the caller. They are also
 * suppressible by the browser, which turns "are you sure?" into silence.
 *
 * `reason` turns this into a prompt: the confirm button stays disabled until
 * something is typed, so a required justification is actually required.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  destructive = false,
  reason = false,
  reasonLabel,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Require a free-text justification before confirming. */
  reason?: boolean;
  reasonLabel?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('cleanup');
  const [text, setText] = useState('');

  // Reopening must not inherit the last answer — a reason typed for one plan
  // is not a reason for the next.
  useEffect(() => {
    if (open) setText('');
  }, [open]);

  if (!open) return null;
  const blocked = reason && !text.trim();

  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {body && <DialogDescription>{body}</DialogDescription>}
      </DialogHeader>

      {reason && (
        <div className="space-y-1 py-2">
          <Label htmlFor="confirm-reason">{reasonLabel ?? t('common.reason')}</Label>
          <Input
            id="confirm-reason"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !blocked) onConfirm(text.trim());
            }}
          />
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant={destructive ? 'destructive' : 'primary'}
          disabled={blocked}
          loading={busy}
          onClick={() => onConfirm(text.trim())}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
