/**
 * Operational alert email via Resend.
 *
 * Single-purpose helper for gateway-internal alerts (e.g. the stalled-queue
 * alarm in the reap cron). `from` is always the verified Resend sending domain
 * (`ALERTS_FROM_EMAIL`); the recipient is `ALERTS_TO_EMAIL` when set, falling
 * back to the from-address. Set `ALERTS_TO_EMAIL` to the inbox an operator
 * actually reads, since the sending address is usually a no-reply identity.
 * Never pass message bodies, tokens, or PII through here; alerts are
 * operational summaries only.
 */
import 'server-only';
import { Resend } from 'resend';
import { env } from './env';
import { logger } from './logger';

let client: Resend | null = null;
function getResend(): Resend {
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
}

/**
 * Send an operational alert email. Resolves on success; throws on failure so
 * callers can decide whether to swallow (most cron alerts are best-effort).
 * `to` defaults to `ALERTS_TO_EMAIL`, then to the from-address.
 */
export async function sendAlertEmail(args: {
  subject: string;
  text: string;
  to?: string;
}): Promise<void> {
  const to = args.to ?? env.ALERTS_TO_EMAIL ?? env.ALERTS_FROM_EMAIL;
  const { error } = await getResend().emails.send({
    from: env.ALERTS_FROM_EMAIL,
    to,
    subject: args.subject,
    text: args.text,
  });
  if (error) {
    logger.error({ err: error.message, subject: args.subject }, 'alert email send failed');
    throw new Error(`Resend send failed: ${error.message}`);
  }
}
