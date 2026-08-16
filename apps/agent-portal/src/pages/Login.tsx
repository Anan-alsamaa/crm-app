import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, cn, FormField, Input, toast, Toaster, YijiLogo } from '@yiji/ui';
import { useAuth } from '../lib/auth/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';
import { RESET_PASSWORD_PATH } from './ResetPassword.js';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
type FormValues = z.infer<typeof schema>;

const forgotSchema = z.object({ email: z.string().email() });
type ForgotValues = z.infer<typeof forgotSchema>;

/** Which panel the card is showing. */
type View = 'signin' | 'forgot' | 'sent';

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cn('rtl:scale-x-[-1]', className)}
    >
      <path d="M3 8h10" />
      <path d="m9 4 4 4-4 4" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      {open ? (
        <>
          <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" />
          <circle cx="10" cy="10" r="2.5" />
        </>
      ) : (
        <>
          <path d="M3 3l14 14" />
          <path d="M9.5 5.1A9.6 9.6 0 0 1 10 5c5 0 8 5 8 5a13.2 13.2 0 0 1-2.4 2.8" />
          <path d="M14 14.1A9.4 9.4 0 0 1 10 15c-5 0-8-5-8-5a13 13 0 0 1 3-3.4" />
          <path d="M8.3 8.3a2.5 2.5 0 0 0 3.4 3.4" />
        </>
      )}
    </svg>
  );
}

export function Login() {
  const { t } = useTranslation();
  const { login, requestPasswordReset } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [authError, setAuthError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [capsOn, setCapsOn] = useState(false);
  const [view, setView] = useState<View>('signin');
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });
  const forgotForm = useForm<ForgotValues>({ resolver: zodResolver(forgotSchema) });

  // Arriving here from a completed reset (see ResetPassword) — confirm it.
  const resetDone = (location.state as { passwordReset?: boolean } | null)?.passwordReset === true;
  useEffect(() => {
    if (!resetDone) return;
    toast.success(
      t('login.resetDone', { defaultValue: 'Password updated. Sign in with your new password.' }),
    );
    // Clear the flag so a refresh doesn't replay the toast.
    navigate(location.pathname, { replace: true, state: null });
    // Intentionally keyed on `resetDone` only — re-running on t/navigate identity
    // changes would replay the toast.
  }, [resetDone]);

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    try {
      await login(values.email, values.password);
      navigate('/');
    } catch {
      setAuthError(t('login.error'));
    }
  });

  /**
   * FR-001 — self-service reset request.
   *
   * SECURITY: we ALWAYS land on the same 'sent' panel with the same wording.
   * `requestPasswordReset` never throws (see shared-config/auth.ts), so an
   * unknown address is indistinguishable from a registered one — no account
   * enumeration. Requires SMTP on the Directus server for mail to arrive.
   */
  const onForgotSubmit = forgotForm.handleSubmit(async (values) => {
    await requestPasswordReset(values.email, `${window.location.origin}${RESET_PASSWORD_PATH}`);
    setView('sent');
  });

  const openForgot = () => {
    setAuthError(null);
    forgotForm.reset({ email: '' });
    setView('forgot');
  };
  const backToSignIn = () => {
    setView('signin');
  };

  return (
    // No solid fill here: the body already paints the near-black canvas with
    // the ambient brand wash, and covering it flattened the welcome screen.
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-12">
      {/* Jade glow pooled behind the card — the accent light of the board
          language. Logical/centered positioning so RTL needs nothing extra. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto h-[30rem] w-full max-w-[36rem] -translate-y-1/2 rounded-full bg-primary/[0.08] blur-3xl"
      />

      {/* Top-end utilities */}
      <div className="absolute end-5 top-5 z-10">
        <LanguageToggle />
      </div>

      {/* Top-start wordmark */}
      <div className="absolute start-6 top-5 z-10 flex items-center gap-2">
        <YijiLogo size={28} />
        <span className="text-[15px] font-semibold tracking-[-0.015em] text-display">CRM</span>
      </div>

      {/* Centered board card — elevated surface, hairline ring, deep shadow. */}
      <div className="relative z-10 w-full max-w-[420px] animate-fade-in">
        <div className="overflow-hidden rounded-2xl bg-card shadow-xl shadow-black/40 ring-1 ring-foreground/[0.06]">
          <div className="overflow-hidden rounded-2xl bg-card">
            {/* Top brand panel inside the card — the logo sits in a tinted tile
                chip, the board's icon-chip move at welcome scale. */}
            <div className="flex flex-col items-center gap-4 px-8 pb-2 pt-8 text-center">
              <span className="grid h-16 w-16 place-items-center rounded-2xl bg-secondary/70 ring-1 ring-foreground/[0.06]">
                <YijiLogo size={44} />
              </span>
              <div className="space-y-1.5">
                <h1 className="text-2xl font-bold text-display tracking-[-0.02em]">
                  {view === 'signin'
                    ? t('login.title', { defaultValue: 'Sign in to CRM' })
                    : t('login.forgotTitle', { defaultValue: 'Reset your password' })}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {view === 'signin'
                    ? t('login.subtitle', { defaultValue: 'Continue helping your customers.' })
                    : view === 'forgot'
                      ? t('login.forgotSubtitle', {
                          defaultValue: "Enter your work email and we'll send you a reset link.",
                        })
                      : t('login.forgotSentSubtitle', { defaultValue: 'Check your inbox.' })}
                </p>
              </div>
            </div>

            {/* Form */}
            {view === 'signin' && (
              <form onSubmit={onSubmit} className="space-y-4 px-8 py-7" noValidate>
                <FormField
                  label={t('auth.email', { ns: 'common' })}
                  htmlFor="email"
                  error={errors.email?.message}
                >
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    placeholder={t('login.emailPlaceholder')}
                    invalid={!!errors.email}
                    {...register('email')}
                  />
                </FormField>

                <FormField
                  label={
                    <span className="flex items-baseline justify-between gap-3">
                      <span>{t('auth.password', { ns: 'common' })}</span>
                      <button
                        type="button"
                        onClick={openForgot}
                        className="rounded-sm text-xs font-medium normal-case tracking-normal text-muted-foreground transition-colors duration-fast ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {t('login.forgot', { defaultValue: 'Forgot password?' })}
                      </button>
                    </span>
                  }
                  htmlFor="password"
                  error={errors.password?.message}
                  hint={
                    capsOn ? t('login.capsLock', { defaultValue: 'Caps Lock is on.' }) : undefined
                  }
                >
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPw ? 'text' : 'password'}
                      autoComplete="current-password"
                      invalid={!!errors.password}
                      className="pe-10"
                      onKeyDown={(e) => setCapsOn(e.getModifierState('CapsLock'))}
                      onKeyUp={(e) => setCapsOn(e.getModifierState('CapsLock'))}
                      {...register('password', {
                        onBlur: () => setCapsOn(false),
                      })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      aria-pressed={showPw}
                      aria-label={
                        showPw
                          ? t('login.hidePassword', { defaultValue: 'Hide password' })
                          : t('login.showPassword', { defaultValue: 'Show password' })
                      }
                      className="absolute end-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <EyeIcon open={showPw} />
                    </button>
                  </div>
                </FormField>

                {authError && (
                  <p
                    role="alert"
                    className="flex items-start gap-2.5 rounded-2xl bg-destructive/10 ring-1 ring-destructive/20 px-3.5 py-2.5 text-sm text-destructive"
                  >
                    {authError}
                  </p>
                )}

                <Button
                  type="submit"
                  loading={isSubmitting}
                  fullWidth
                  size="lg"
                  iconEnd={<ArrowRight className="h-4 w-4" />}
                >
                  {t('login.submit')}
                </Button>
              </form>
            )}

            {/* FR-001 — request a reset link. */}
            {view === 'forgot' && (
              <form onSubmit={onForgotSubmit} className="space-y-4 px-8 py-7" noValidate>
                <FormField
                  label={t('auth.email', { ns: 'common' })}
                  htmlFor="forgot-email"
                  error={forgotForm.formState.errors.email?.message}
                >
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    placeholder={t('login.emailPlaceholder')}
                    invalid={!!forgotForm.formState.errors.email}
                    {...forgotForm.register('email')}
                  />
                </FormField>
                <Button
                  type="submit"
                  loading={forgotForm.formState.isSubmitting}
                  fullWidth
                  size="lg"
                  iconEnd={<ArrowRight className="h-4 w-4" />}
                >
                  {t('login.forgotSubmit', { defaultValue: 'Send reset link' })}
                </Button>
                <button
                  type="button"
                  onClick={backToSignIn}
                  className="mx-auto block rounded-sm text-xs font-medium text-muted-foreground transition-colors duration-fast ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('login.backToSignIn', { defaultValue: 'Back to sign in' })}
                </button>
              </form>
            )}

            {/* Neutral confirmation — identical for known and unknown addresses. */}
            {view === 'sent' && (
              <div className="space-y-4 px-8 py-7">
                <p
                  role="status"
                  className="rounded-2xl bg-primary-subtle px-3.5 py-3 text-sm text-foreground ring-1 ring-primary/20"
                >
                  {t('login.forgotSent', {
                    defaultValue:
                      'If that email matches an account, we just sent a reset link. It expires shortly — check your spam folder if it does not arrive.',
                  })}
                </p>
                <Button type="button" variant="outline" fullWidth size="lg" onClick={backToSignIn}>
                  {t('login.backToSignIn', { defaultValue: 'Back to sign in' })}
                </Button>
              </div>
            )}

            {/* Footer inside card */}
            <div className="px-8 py-3 text-center text-2xs text-muted-foreground">
              <div className="flex items-center justify-center gap-2">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-3 w-3"
                  aria-hidden
                >
                  <rect x="3" y="7" width="10" height="6" rx="1" />
                  <path d="M5 7V5a3 3 0 0 1 6 0v2" />
                </svg>
                <span>{t('login.secure', { defaultValue: 'Encrypted connection' })}</span>
                <span className="text-border" aria-hidden>
                  ·
                </span>
                <span>CRM · Agent</span>
              </div>
            </div>
          </div>
        </div>

        {/* Below-card help link */}
        <p className="mt-4 text-center text-2xs text-muted-foreground">
          {t('login.help', {
            defaultValue: 'Trouble signing in? Talk to your administrator.',
          })}
        </p>
      </div>

      {/* Bottom-end footer */}
      <p className="absolute bottom-4 inset-x-0 z-10 text-center text-2xs text-muted-foreground">
        © CRM
      </p>

      {/* Login sits outside the app shell, so it mounts its own toaster (used by
          the "password updated" confirmation after a completed reset). */}
      <Toaster position="top" />
    </div>
  );
}
