import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Eye, EyeOff, KeyRound, Lock, ShieldCheck, User } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

export function LoginPage() {
  const { login, status } = useAuth();
  const { t } = useTranslation('auth');
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [code, setCode] = useState('');

  // Already authenticated — bounce to the app.
  useEffect(() => {
    if (status === 'authenticated') {
      navigate(from, { replace: true });
    }
  }, [status, from, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password, twoFactor ? code.trim() : undefined);
      navigate(from, { replace: true });
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { twoFactorRequired?: boolean } | undefined) : undefined;
      if (body?.twoFactorRequired) {
        // Password was correct — advance to the second-factor step.
        setTwoFactor(true);
        setError(null);
      } else if (err instanceof ApiError) {
        setError(
          twoFactor
            ? t('errors.invalidCode')
            : err.status === 401
              ? t('errors.invalidCredentials')
              : err.message,
        );
      } else {
        setError(t('errors.generic'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const backToCredentials = () => {
    setTwoFactor(false);
    setCode('');
    setError(null);
  };

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      {/* Decorative aurora */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[40rem] w-[40rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 right-0 h-[30rem] w-[30rem] rounded-full bg-accent/10 blur-[120px]"
      />

      <div className="relative w-full max-w-md animate-fade-in-up">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <img
            src="/logo.png"
            alt={t('logoAlt')}
            className="w-96 max-w-full object-contain drop-shadow-[0_0_55px_rgba(37,99,235,0.3)]"
          />
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-2xl glass p-6 shadow-card sm:p-8"
        >
          {!twoFactor ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="username">{t('username')}</Label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="username"
                    autoComplete="username"
                    autoFocus
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="pl-9"
                    placeholder="admin"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">{t('password')}</Label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9 pr-10"
                    placeholder="••••••••"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="h-4 w-4 text-primary" /> {t('twoFactor.title')}
              </div>
              <p className="text-xs text-muted-foreground">{t('twoFactor.hint')}</p>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="totp"
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="pl-9 font-mono tracking-widest"
                  placeholder="123456"
                />
              </div>
              <button
                type="button"
                onClick={backToCredentials}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" /> {t('twoFactor.useDifferentAccount')}
              </button>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          )}

          <Button type="submit" size="lg" className="w-full" loading={submitting}>
            {twoFactor ? t('verify') : t('signIn')}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">{t('footer')}</p>
      </div>
    </div>
  );
}
