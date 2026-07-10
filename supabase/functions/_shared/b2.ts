// _shared/b2.ts — BackBlaze B2 S3-compatible API helpers (AWS Signature V4).
//
// Used by asset-upload EF (PUT objects) and asset-gc EF (DELETE objects).
// The Cloudflare Worker also has S3 signing logic (for GET), but Edge Functions
// need their own implementation since they run on Deno, not Cloudflare Workers.

import type { Env } from './types.ts';

const encoder = new TextEncoder();

async function sha256Hex(message: string | Uint8Array): Promise<string> {
  const data = typeof message === 'string' ? encoder.encode(message) : message;
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacSha256(key: string | Uint8Array, message: string): Promise<Uint8Array> {
  const keyData = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sign an S3 request using AWS Signature V4.
 * Works for PUT, GET, DELETE methods.
 *
 * @param method - HTTP method (PUT, GET, DELETE)
 * @param url - Full B2 S3 URL (e.g. https://s3.us-west-002.backblazeb2.com/bucket/path)
 * @param body - Request body (for PUT) or empty string (for GET/DELETE)
 * @param env - Edge Function environment with B2_KEY_ID, B2_APPLICATION_KEY, B2_REGION
 * @returns Authorization header value
 */
export async function signS3Request(
  method: string,
  url: string,
  body: string | Uint8Array | null,
  env: Env
): Promise<string> {
  const keyId = env.B2_KEY_ID!;
  const appKey = env.B2_APPLICATION_KEY!;
  const region = env.B2_REGION!;

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';

  const u = new URL(url);
  const host = u.host;
  const path = u.pathname || '/';

  // For PUT, body is the file bytes. For GET/DELETE, body is empty.
  const bodyHash = body
    ? await sha256Hex(typeof body === 'string' ? body : body)
    : await sha256Hex('');

  // Canonical request
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    path,
    '', // canonical query string
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  // String to sign
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Signing key chain
  const kDate = await hmacSha256('AWS4' + appKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');

  // Signature
  const sigBytes = await hmacSha256(kSigning, stringToSign);
  const signature = toHex(sigBytes);

  return `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/**
 * Upload a file to B2 via S3 PUT.
 *
 * @param path - Object path within bucket (e.g. "a3/a3f1c9...jpg")
 * @param data - File bytes
 * @param contentType - MIME type (e.g. "image/jpeg")
 * @param env - Edge Function environment
 * @returns true if upload succeeded, throws on error
 */
export async function b2PutObject(
  path: string,
  data: Uint8Array,
  contentType: string,
  env: Env
): Promise<boolean> {
  const bucket = env.B2_BUCKET_NAME!;
  const endpoint = env.B2_ENDPOINT!;
  const url = `https://${endpoint}/${bucket}/${path}`;

  const bodyStr = ''; // For PUT, we hash the actual body, not a string
  const bodyHash = await sha256Hex(data);

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = dateStamp + 'T' + now.toISOString().slice(11, 19).replace(/:/g, '') + 'Z';

  const u = new URL(url);
  const host = u.host;
  const urlPath = u.pathname || '/';

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    urlPath,
    '',
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${env.B2_REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256('AWS4' + env.B2_APPLICATION_KEY, dateStamp);
  const kRegion = await hmacSha256(kDate, env.B2_REGION!);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const sigBytes = await hmacSha256(kSigning, stringToSign);
  const signature = toHex(sigBytes);

  const authHeader = `AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': authHeader,
      'x-amz-content-sha256': bodyHash,
      'x-amz-date': amzDate,
      'Content-Type': contentType,
      'Content-Length': String(data.length),
    },
    body: data,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`B2 PUT failed (${res.status}): ${text}`);
  }

  return true;
}

/**
 * Delete a file from B2 via S3 DELETE.
 *
 * @param path - Object path within bucket
 * @param env - Edge Function environment
 * @returns true if deleted, false if not found (404)
 */
export async function b2DeleteObject(
  path: string,
  env: Env
): Promise<boolean> {
  const bucket = env.B2_BUCKET_NAME!;
  const endpoint = env.B2_ENDPOINT!;
  const url = `https://${endpoint}/${bucket}/${path}`;

  const authHeader = await signS3Request('DELETE', url, null, env);

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': authHeader,
    },
  });

  if (res.ok) return true;
  if (res.status === 404) return false; // already gone — idempotent

  const text = await res.text().catch(() => '');
  throw new Error(`B2 DELETE failed (${res.status}): ${text}`);
}

/**
 * Check if B2 is configured (all 5 env vars set).
 */
export function isB2Configured(env: Env): boolean {
  return !!(env.B2_KEY_ID && env.B2_APPLICATION_KEY && env.B2_BUCKET_NAME &&
            env.B2_ENDPOINT && env.B2_REGION);
}
