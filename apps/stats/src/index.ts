/**
 * Phase 30: the Worker's entry point -- the real Cloudflare bindings handed to `handler.ts`.
 *
 * Bindings (`wrangler.jsonc`): D1 `DB`, R2 `REPORTS`, Email Routing `MAILER` (`send_email`), rate limiters
 * `EVENT_LIMIT` and `REPORT_LIMIT`. Variables: `ALLOWED_ORIGINS`, `REPORTS_ENABLED`, `MAIL_FROM` (an address on
 * the zone, e.g. `stats@tnec.io`). Secret: `MAIL_TO`, the verified address reports go to -- a secret so that it
 * stays out of this public repository.
 */
import { EmailMessage } from 'cloudflare:email';
import { cleanUp, handle, type Database, type Limiter, type ReportStore } from './handler.js';

interface Env {
  DB: Database;
  REPORTS: ReportStore;
  MAILER?: { send(message: EmailMessage): Promise<void> };
  EVENT_LIMIT?: Limiter;
  REPORT_LIMIT?: Limiter;
  ALLOWED_ORIGINS: string;
  REPORTS_ENABLED?: string;
  MAIL_FROM?: string;
  MAIL_TO?: string;
}

/** RFC 2047: a header value that may hold any UTF-8 text. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

function mailer(env: Env): ((subject: string, text: string) => Promise<void>) | null {
  const { MAILER, MAIL_FROM, MAIL_TO } = env;
  if (!MAILER || !MAIL_FROM || !MAIL_TO) return null;
  return async (subject, text) => {
    const raw = [
      `From: Wesnoth web reports <${MAIL_FROM}>`,
      `To: ${MAIL_TO}`,
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${MAIL_FROM.split('@')[1] ?? 'localhost'}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      text.replace(/\r?\n/g, '\r\n'),
    ].join('\r\n');
    await MAILER.send(new EmailMessage(MAIL_FROM, MAIL_TO, raw));
  };
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, {
      db: env.DB,
      reports: env.REPORTS,
      mail: mailer(env),
      eventLimiter: env.EVENT_LIMIT ?? null,
      reportLimiter: env.REPORT_LIMIT ?? null,
      allowedOrigins: env.ALLOWED_ORIGINS,
      reportsEnabled: env.REPORTS_ENABLED !== 'false',
    });
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await cleanUp(env.DB);
  },
};
