import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, FormField, Input, YijiLogo } from '@yiji/ui';
import { useAuth } from '../lib/auth/AuthContext.js';
import { LanguageToggle } from '../components/LanguageToggle.js';

/**
 * FR-001 — reset completion page.
 *
 * The user lands here from the link Directus emails after a "Forgot password?"
 * request: `<origin>/reset-password?token=<one-time JWT>`. The token is signed
 * and validated by Directus — nothing is hand-rolled here; we only post it back
 * with the new password (`passwordReset` in the shared auth client).
 *
 * OPS: mail is only delivered when SMTP is configured on the Directus server
 * (EMAIL_TRANSPORT / EMAIL_SMTP_* / EMAIL_FROM), and this page's origin must be
 * in PASSWORD_RESET_URL_ALLOW_LIST for the custom reset URL to be accepted.
 */

/** Route path — shared with Login (builds the reset_url) and the router. */
export const RESET_PASSWORD_PATH = '/reset-password';

/** Minimum length for a self-service password. */
export const MIN_PASSWORD_LENGTH = 8;

/** Minimal translate signature so the schema factory stays typed and testable. */
type Translate = (key: string, defaultValue: string) => string;

const makeSchema = (tr: Translate) =>
  z
    .object({
      password: z.string().min(MIN_PASSWORD_LENGTH, {
        message: tr('reset.tooShort', 'Use at least 8 characters.'),
      }),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, {
      path: ['confirm'],
      message: tr('reset.mismatch', 'Passwords do not match.'),
    });

type FormValues = { password: string; confirm: string };

export function ResetPassword() {
  const { t } = useTranslation();
  const { resetPassword } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [submitError, setSubmitError] = useState<string | null>(null);

  const schema = useMemo(() => makeSchema((key, defaultValue) => t(key, { defaultValue })), [t]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await resetPassword(token, values.password);
      // Toast is raised on the login page (it mounts the toaster).
      navigate('/login', { replace: true, state: { passwordReset: true } });
    } catch {
      // Directus rejects expired / already-used / malformed tokens the same way;
      // point the user back at requesting a fresh link.
      setSubmitError(
        t('reset.invalidToken', {
          defaultValue: 'This reset link is invalid or has expired. Request a new one.',
        }),
      );
    }
  });

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12">
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
        <div className="overflow-hidden rounded-3xl bg-card shadow-2xl shadow-black/40 ring-1 ring-foreground/[0.08]">
          <div className="overflow-hidden rounded-3xl bg-card">
            <div className="flex flex-col items-center gap-4 px-8 pb-2 pt-8 text-center">
              <YijiLogo size={72} />
              <div className="space-y-1.5">
                <h1 className="text-2xl font-bold text-display tracking-[-0.02em]">
                  {t('reset.title', { defaultValue: 'Choose a new password' })}
                </h1>
                <p className="text-sm text-muted-foreground">
                  {t('reset.subtitle', {
                    defaultValue: 'Your new password replaces the old one immediately.',
                  })}
                </p>
              </div>
            </div>

            {token ? (
              <form onSubmit={onSubmit} className="space-y-4 px-8 py-7" noValidate>
                <FormField
                  label={t('reset.newPassword', { defaultValue: 'New password' })}
                  htmlFor="password"
                  error={errors.password?.message}
                >
                  <Input
                    id="password"
                    type="password"
                    autoComplete="new-password"
                    autoFocus
                    invalid={!!errors.password}
                    {...register('password')}
                  />
                </FormField>

                <FormField
                  label={t('reset.confirmPassword', { defaultValue: 'Confirm new password' })}
                  htmlFor="confirm"
                  error={errors.confirm?.message}
                >
                  <Input
                    id="confirm"
                    type="password"
                    autoComplete="new-password"
                    invalid={!!errors.confirm}
                    {...register('confirm')}
                  />
                </FormField>

                {submitError && (
                  <p
                    role="alert"
                    className="flex items-start gap-2.5 rounded-2xl bg-destructive/10 ring-1 ring-destructive/20 px-3.5 py-2.5 text-sm text-destructive"
                  >
                    {submitError}
                  </p>
                )}

                <Button type="submit" loading={isSubmitting} fullWidth size="lg">
                  {t('reset.submit', { defaultValue: 'Update password' })}
                </Button>
              </form>
            ) : (
              <div className="space-y-4 px-8 py-7">
                <p
                  role="alert"
                  className="rounded-2xl bg-destructive/10 ring-1 ring-destructive/20 px-3.5 py-2.5 text-sm text-destructive"
                >
                  {t('reset.missingToken', {
                    defaultValue: 'This reset link is incomplete. Request a new one from sign in.',
                  })}
                </p>
              </div>
            )}

            <div className="px-8 py-3 text-center text-2xs text-muted-foreground">
              <Link
                to="/login"
                className="rounded-sm transition-colors duration-fast ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('login.backToSignIn', { defaultValue: 'Back to sign in' })}
              </Link>
            </div>
          </div>
        </div>
      </div>

      <p className="absolute bottom-4 inset-x-0 z-10 text-center text-2xs text-muted-foreground">
        © CRM
      </p>
    </div>
  );
}
