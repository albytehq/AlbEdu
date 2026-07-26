// _shared/log.ts — Structured JSON logging for Edge Functions
//
// Designed to be drained to Logtail (free tier, 1GB/month, 7-day retention)
// via Supabase EF log drains. Each log entry is a single-line JSON object
// with consistent fields for dashboard querying.
//
// Usage:
//   import { logger } from '../_shared/log.ts';
//   logger.info('submit', { userId: '...', sessionId: '...', score: 100 });
//   logger.error('db_error', { table: 'submissions', error: err.message });
//
// Output (single line JSON):
//   {"ts":"2026-07-25T14:00:00.000Z","level":"info","event":"submit","userId":"...","sessionId":"...","score":100,"fn":"submit-assessment"}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Read min level from env (default: info in prod, debug in dev)
const MIN_LEVEL: LogLevel = (() => {
  const env = (Deno.env.get('LOG_LEVEL') || '').toLowerCase();
  if (env in LOG_LEVELS) return env as LogLevel;
  // Default: debug if SUPABASE_URL is localhost, else info
  const url = Deno.env.get('SUPABASE_URL') || '';
  return url.includes('supabase.co') ? 'info' : 'debug';
})();

function emit(level: LogLevel, event: string, ctx: LogContext = {}, error?: unknown): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  };

  // Auto-extract function name from stack trace
  // (cheap — only when emitting)
  try {
    const stack = new Error().stack || '';
    const fnMatch = stack.match(/at\s+(\w+)\s+\(file:\/\/.*\/functions\/([^/]+)/);
    if (fnMatch) entry.fn = fnMatch[2];
  } catch { /* non-fatal */ }

  if (error) {
    if (error instanceof Error) {
      entry.error = error.message;
      entry.stack = error.stack?.split('\n').slice(0, 5).join(' | ');
    } else {
      entry.error = String(error);
    }
  }

  // Single-line JSON (Logtail parses newlines as separate log entries)
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, ctx: LogContext = {}) => emit('debug', event, ctx),
  info: (event: string, ctx: LogContext = {}) => emit('info', event, ctx),
  warn: (event: string, ctx: LogContext = {}, error?: unknown) => emit('warn', event, ctx, error),
  error: (event: string, ctx: LogContext = {}, error?: unknown) => emit('error', event, ctx, error),

  // Helper: wrap an async function with timing + error logging
  // Returns the original function's result. Logs duration_ms on success,
  // error details on failure.
  timed: <T>(event: string, fn: () => Promise<T>, ctx: LogContext = {}): Promise<T> => {
    const start = Date.now();
    return fn()
      .then((result) => {
        emit('info', event, { ...ctx, duration_ms: Date.now() - start });
        return result;
      })
      .catch((err) => {
        emit('error', event, { ...ctx, duration_ms: Date.now() - start }, err);
        throw err;
      });
  },
};
