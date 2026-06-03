import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, cn, FormField, Input, YijiLogo } from '@yiji/ui';
import { useAuth, isAdmin } from '../lib/auth/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

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
  const { login, logout } = useAuth();
  const navigate = useNavigate();
  const [authError, setAuthError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    try {
      const user = await login(values.email, values.password);
      if (!isAdmin(user)) {
        await logout();
        setAuthError(t('login.notAdmin'));
        return;
      }
      navigate('/');
    } catch {
      setAuthError(t('login.error'));
    }
  });

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12">
      {/* Very subtle single-tone wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(at 50% 100%, oklch(var(--primary) / 0.07) 0%, transparent 55%)',
        }}
      />

      <div className="absolute end-5 top-5 z-10">
        <LanguageToggle />
      </div>
      <div className="absolute start-6 top-5 z-10 flex items-center gap-2">
        <YijiLogo size={28} />
        <span className="text-[15px] font-semibold tracking-[-0.015em] text-display">
          Yiji <span className="text-muted-foreground font-normal">CRM</span>
        </span>
      </div>

      <div className="relative z-10 w-full max-w-[420px] animate-fade-in">
        <div className="overflow-hidden rounded-3xl bg-card shadow-2xl shadow-foreground/[0.08] ring-1 ring-foreground/[0.05]">
          <div className="flex flex-col items-center gap-3 px-8 pb-2 pt-8 text-center">
            <YijiLogo size={72} />
            <div className="space-y-1.5">
              <h1 className="text-2xl font-bold text-display tracking-[-0.02em]">
                {t('login.title', { defaultValue: 'Sign in to YIJI CRM Admin' })}
              </h1>
              <p className="text-sm text-muted-foreground">
                Administrator access required.
              </p>
            </div>
          </div>

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
                placeholder={t('login.emailPlaceholder')}
                invalid={!!errors.email}
                {...register('email')}
              />
            </FormField>

            <FormField
              label={
                <span className="flex items-baseline justify-between gap-3">
                  <span>{t('auth.password', { ns: 'common' })}</span>
                  <a
                    href="#"
                    onClick={(e) => e.preventDefault()}
                    className="text-2xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {t('login.forgot', { defaultValue: 'Forgot password?' })}
                  </a>
                </span>
              }
              htmlFor="password"
              error={errors.password?.message}
            >
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete="current-password"
                  invalid={!!errors.password}
                  className="pe-10"
                  {...register('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={
                    showPw
                      ? t('login.hidePassword', { defaultValue: 'Hide' })
                      : t('login.showPassword', { defaultValue: 'Reveal' })
                  }
                  className="absolute end-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-secondary hover:text-foreground"
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

          <div className="px-8 py-3 text-center text-2xs text-muted-foreground">
            <div className="flex items-center justify-center gap-2">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden>
                <rect x="3" y="7" width="10" height="6" rx="1" />
                <path d="M5 7V5a3 3 0 0 1 6 0v2" />
              </svg>
              <span>{t('login.secure', { defaultValue: 'Every action audit-logged' })}</span>
              <span className="text-border" aria-hidden>·</span>
              <span>YIJI · Admin</span>
            </div>
          </div>
        </div>

        {/* Below-card help link */}
        <p className="mt-4 text-center text-2xs text-muted-foreground">
          {t('login.help', {
            defaultValue: 'Trouble signing in? Talk to your system administrator.',
          })}
        </p>
      </div>

      <p className="absolute bottom-4 inset-x-0 z-10 text-center text-2xs text-muted-foreground">
        © YIJI CRM
      </p>
    </div>
  );
}
