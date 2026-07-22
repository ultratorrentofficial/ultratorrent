import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '@/lib/format';

/**
 * Ticking "time left before this is permanently deleted" label for a Trash entry.
 *
 * The server sends an absolute `expiresAt` instant and this counts down to it
 * locally, so the display stays live without polling and cannot be made wrong by a
 * stale response. When the countdown reaches zero the row is no longer restorable,
 * so `onExpire` fires once to let the owning list refetch — the backend withholds
 * expired entries, so that refetch is what makes the row disappear on cue.
 *
 * `expiresAt` of null means retention is switched off; the item is kept until
 * someone removes it by hand, and we say so rather than showing a fake deadline.
 */
export function TrashCountdown({
  expiresAt,
  onExpire,
  className,
}: {
  expiresAt: string | null;
  onExpire?: () => void;
  className?: string;
}) {
  const { t } = useTranslation('files');
  const [now, setNow] = useState(() => Date.now());
  // Guards against firing onExpire on every subsequent tick once past the deadline.
  const firedRef = useRef(false);

  const target = expiresAt ? Date.parse(expiresAt) : NaN;
  const valid = Number.isFinite(target);

  useEffect(() => {
    firedRef.current = false;
  }, [expiresAt]);

  useEffect(() => {
    if (!valid) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [valid, expiresAt]);

  useEffect(() => {
    if (!valid || firedRef.current) return;
    if (target - now <= 0) {
      firedRef.current = true;
      onExpire?.();
    }
  }, [valid, target, now, onExpire]);

  if (!expiresAt || !valid) {
    return <span className={className}>{t('trash.noExpiry')}</span>;
  }

  const left = formatCountdown(target - now);
  if (!left) return <span className={className}>{t('trash.expiring')}</span>;

  return (
    <span className={className}>
      {t('trash.expiresIn')} <span className="font-mono tabular-nums">{left}</span>
    </span>
  );
}
