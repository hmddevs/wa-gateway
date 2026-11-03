/**
 * Structured logger. JSON on Vercel, pretty locally. Never logs secrets.
 * PII redaction: phones, API keys, bearer tokens, cookies, authorization.
 */
import 'server-only';
import pino from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  'apiKey',
  'token',
  'password',
  'secret',
  'to', // E.164 phone
  'phone',
  'text',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
  base: {
    svc: 'gateway',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});
