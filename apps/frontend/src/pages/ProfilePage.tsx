import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Download,
  KeyRound,
  ShieldCheck,
  ShieldOff,
  UserCircle,
} from 'lucide-react';
import { ApiError, api, type TwoFactorSetup } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CenteredSpinner } from '@/components/ui/feedback';

export function ProfilePage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['account', 'profile'],
    queryFn: api.account.profile,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['account', 'profile'] });

  if (isLoading || !data) return <CenteredSpinner label="Loading account…" />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile, password, and two-factor authentication.
        </p>
      </div>

      <ProfileSection
        username={data.username}
        email={data.email}
        displayName={data.displayName}
        roles={data.roles}
        lastLoginAt={data.lastLoginAt}
        onSaved={refresh}
      />
      <PasswordSection />
      <TwoFactorSection enabled={data.twoFactorEnabled} onChanged={refresh} />
    </div>
  );
}

function ProfileSection({
  username,
  email,
  displayName,
  roles,
  lastLoginAt,
  onSaved,
}: {
  username: string;
  email: string;
  displayName: string | null;
  roles: string[];
  lastLoginAt: string | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [emailValue, setEmailValue] = useState(email);
  const [name, setName] = useState(displayName ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.account.updateProfile({ email: emailValue.trim(), displayName: name.trim() });
      toast.success('Profile updated');
      onSaved();
    } catch (err) {
      toast.error('Could not update profile', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserCircle className="h-5 w-5 text-primary" /> Profile
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label>Username</Label>
            <Input value={username} disabled className="opacity-70" />
          </div>
          <div>
            <Label htmlFor="pf-email">Email</Label>
            <Input id="pf-email" type="email" value={emailValue} onChange={(e) => setEmailValue(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="pf-name">Display name</Label>
            <Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-1.5 pt-2">
              {roles.map((r) => (
                <Badge key={r} variant="secondary">{r.replace(/_/g, ' ').toLowerCase()}</Badge>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Last sign-in {formatRelativeTime(lastLoginAt)}
          </p>
          <Button onClick={save} loading={saving}>Save changes</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordSection() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 10;
  const canSave = current && next.length >= 10 && next === confirm && !saving;

  const save = async () => {
    setSaving(true);
    try {
      await api.account.changePassword(current, next);
      toast.success('Password changed', 'Use your new password next time you sign in.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      toast.error('Could not change password', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" /> Password
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="pw-cur">Current password</Label>
            <Input id="pw-cur" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div>
            <Label htmlFor="pw-new">New password</Label>
            <Input id="pw-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            {tooShort && <p className="mt-1 text-xs text-warning">At least 10 characters.</p>}
          </div>
          <div>
            <Label htmlFor="pw-confirm">Confirm new password</Label>
            <Input id="pw-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            {mismatch && <p className="mt-1 text-xs text-destructive">Passwords don’t match.</p>}
          </div>
        </div>
        <div className="flex justify-end">
          <Button onClick={save} disabled={!canSave} loading={saving}>Change password</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TwoFactorSection({ enabled, onChanged }: { enabled: boolean; onChanged: () => void }) {
  const [enableOpen, setEnableOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Two-factor authentication
          <Badge variant={enabled ? 'success' : 'secondary'} dot>
            {enabled ? 'On' : 'Off'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {enabled
            ? 'Your account is protected with an authenticator app. You’ll be asked for a code when you sign in.'
            : 'Add a second step to sign-in using an authenticator app (Google Authenticator, Authy, 1Password, …).'}
        </p>
        <div className="flex justify-end">
          {enabled ? (
            <Button variant="destructive" onClick={() => setDisableOpen(true)}>
              <ShieldOff className="h-4 w-4" /> Disable 2FA
            </Button>
          ) : (
            <Button onClick={() => setEnableOpen(true)}>
              <ShieldCheck className="h-4 w-4" /> Enable 2FA
            </Button>
          )}
        </div>
      </CardContent>

      {enableOpen && (
        <EnableTwoFactorDialog
          onClose={() => setEnableOpen(false)}
          onDone={() => {
            setEnableOpen(false);
            onChanged();
          }}
        />
      )}
      {disableOpen && (
        <DisableTwoFactorDialog
          onClose={() => setDisableOpen(false)}
          onDone={() => {
            setDisableOpen(false);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function EnableTwoFactorDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  // Start TOTP setup once when the dialog opens.
  useEffect(() => {
    api.account
      .setupTwoFactor()
      .then(setSetup)
      .catch((err) =>
        toast.error('Could not start setup', err instanceof ApiError ? err.message : undefined),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async () => {
    setBusy(true);
    try {
      const res = await api.account.enableTwoFactor(code.trim());
      setRecovery(res.recoveryCodes);
      toast.success('Two-factor enabled');
    } catch (err) {
      toast.error('Invalid code', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={recovery ? onDone : onClose} className="max-w-lg">
      {!recovery ? (
        <>
          <DialogHeader>
            <DialogTitle>Enable two-factor authentication</DialogTitle>
            <DialogDescription>
              Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {!setup ? (
              <CenteredSpinner label="Generating secret…" />
            ) : (
              <>
                <div className="flex flex-col items-center gap-3">
                  <img src={setup.qrDataUrl} alt="2FA QR code" className="h-44 w-44 rounded-lg bg-white p-2" />
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground">Or enter this key manually:</p>
                    <code className="select-all break-all font-mono text-xs">{setup.secret}</code>
                  </div>
                </div>
                <div>
                  <Label htmlFor="enable-code">Verification code</Label>
                  <Input
                    id="enable-code"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="font-mono tracking-widest"
                    placeholder="123456"
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={verify} loading={busy} disabled={!setup || code.trim().length < 6}>
              Verify & enable
            </Button>
          </DialogFooter>
        </>
      ) : (
        <RecoveryCodesView codes={recovery} onDone={onDone} />
      )}
    </Dialog>
  );
}

function RecoveryCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(codes.join('\n'));
    setCopied(true);
    toast.success('Recovery codes copied');
    setTimeout(() => setCopied(false), 2000);
  };
  const download = () => {
    const blob = new Blob([codes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ultratorrent-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Save your recovery codes</DialogTitle>
        <DialogDescription>
          Each code works once if you lose your authenticator. Store them somewhere safe — they won’t be shown again.
        </DialogDescription>
      </DialogHeader>
      <div className="py-2">
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-white/[0.02] p-4 font-mono text-sm">
          {codes.map((c) => (
            <span key={c} className="select-all text-center">{c}</span>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <Download className="h-4 w-4" /> Download
          </Button>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={onDone}>I’ve saved them</Button>
      </DialogFooter>
    </>
  );
}

function DisableTwoFactorDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const disable = async () => {
    setBusy(true);
    try {
      await api.account.disableTwoFactor(password);
      toast.success('Two-factor disabled');
      onDone();
    } catch (err) {
      toast.error('Could not disable', err instanceof ApiError ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>Disable two-factor authentication</DialogTitle>
        <DialogDescription>
          Confirm your password to turn off 2FA. Your account will be less protected.
        </DialogDescription>
      </DialogHeader>
      <div className="py-2">
        <Label htmlFor="disable-pw">Password</Label>
        <Input
          id="disable-pw"
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="destructive" onClick={disable} loading={busy} disabled={!password}>
          Disable 2FA
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
