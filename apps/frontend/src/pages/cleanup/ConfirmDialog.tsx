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
  checkbox,
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
  /**
   * An extra yes/no that belongs to the SAME decision — e.g. "overwrite an
   * existing file" on a restore. It exists because the alternative in the wild
   * was a second `window.confirm`, where Cancel meant "no, but proceed anyway"
   * rather than "abort" — a question whose most obvious reading was wrong.
   */
  checkbox?: { label: string; defaultChecked?: boolean };
  busy?: boolean;
  onConfirm: (result: { reason: string; checked: boolean }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('cleanup');
  const [text, setText] = useState('');
  const [checked, setChecked] = useState(checkbox?.defaultChecked ?? false);

  // Reopening must not inherit the last answer — a reason typed for one plan
  // is not a reason for the next.
  useEffect(() => {
    if (!open) return;
    setText('');
    setChecked(checkbox?.defaultChecked ?? false);
  }, [open, checkbox?.defaultChecked]);

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
              if (e.key === 'Enter' && !blocked) onConfirm({ reason: text.trim(), checked });
            }}
          />
        </div>
      )}

      {checkbox && (
        <label className="flex items-center gap-2 py-2 text-sm">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="h-4 w-4 accent-sky-400"
          />
          {checkbox.label}
        </label>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant={destructive ? 'destructive' : 'primary'}
          disabled={blocked}
          loading={busy}
          onClick={() => onConfirm({ reason: text.trim(), checked })}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
