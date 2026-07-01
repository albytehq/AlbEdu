// =============================================================================
// _shared/error.ts — Custom HTTPError + consistent error response formatter
// =============================================================================

import type { ErrorCode, ErrorResponse } from './types.ts';

export class HTTPError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'HTTPError';
  }
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: any
): Response {
  const body: ErrorResponse = {
    error: { code, message, ...(details ? { details } : {}) },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function successResponse<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Map HTTPError to Response
export function handleError(err: unknown): Response {
  if (err instanceof HTTPError) {
    return errorResponse(err.status, err.code, err.message, err.details);
  }
  console.error('[UNHANDLED_ERROR]', err);
  const message = err instanceof Error ? err.message : 'Unknown error';
  return errorResponse(500, 'INTERNAL_ERROR', 'Internal server error', { trace: message });
}
