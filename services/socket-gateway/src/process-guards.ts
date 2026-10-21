/**
 * THE SAFETY NET FOR A FORGOTTEN `.catch()` (owner, 2026-10-20).
 *
 * Prod chat went down because the gateway crashed three times (17, 18, 19 Oct):
 * a promise rejected with a plain Directus error object while the login service
 * was briefly slow ("auth service unavailable, retrying"), nothing caught it,
 * and Node's default for an unhandled rejection is to kill the process. ECS
 * normally replaces a crashed task in seconds - but when it cannot (the AWS
 * account was blocked from placing tasks), one stray rejection takes chat down.
 *
 * A rejection nobody awaited is a lost result, not a corrupted process: log it
 * IN FULL (a plain object prints as "#<Object>", which hid the cause) and keep
 * serving. Synchronous uncaught exceptions are left to Node's default - after
 * one of those the process state really is unknown.
 */
export interface GuardLogger {
  error: (o: unknown, msg?: string) => void;
}

/** A rejection reason as something a log can show: never "#<Object>". */
export function describeReason(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return { name: reason.name, message: reason.message, stack: reason.stack };
  }
  try {
    return { value: JSON.parse(JSON.stringify(reason)) as unknown };
  } catch {
    return { value: String(reason) };
  }
}

export function installRejectionGuard(
  logger: GuardLogger,
  proc: Pick<NodeJS.Process, 'on'> = process,
): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    logger.error(
      { reason: describeReason(reason) },
      'unhandled promise rejection - logged, gateway kept running',
    );
  });
}
