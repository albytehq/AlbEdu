// tests/integration/_helpers.js — Shared test helpers
// Creates test users, signs them in, returns JWTs

import { createClient } from '@supabase/supabase-js';

/**
 * Create a Supabase client with service role key (bypasses RLS).
 */
export function serviceClient() {
  return createClient(globalThis.SUPA_URL, globalThis.SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Create a Supabase client with anon key + peserta JWT.
 */
export function pesertaClient(jwt) {
  return createClient(globalThis.SUPA_URL, globalThis.ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/**
 * Create a test user (admin or peserta) via admin API.
 * Auto-confirms email so we can sign in immediately.
 * Returns { id, email, jwt }.
 */
export async function createTestUser(peran = 'peserta') {
  const admin = serviceClient();
  const ts = globalThis.TEST_TS + Math.floor(Math.random() * 1_000_000);
  const email = `test-${peran}-${ts}@test.albedu.local`;
  const password = globalThis.TEST_PASSWORD;

  // Create auth user
  const { data: authData, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Test ${peran}` },
  });
  if (authErr) throw new Error(`createUser failed: ${authErr.message}`);
  const userId = authData.user.id;

  // Insert into public.users with the given role
  const { error: profileErr } = await admin
    .from('users')
    .insert({
      id: userId,
      email,
      peran,
      profile_complete: true,
    });
  if (profileErr) {
    // Cleanup: delete auth user if profile insert failed
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`profile insert failed: ${profileErr.message}`);
  }

  // Sign in to get JWT
  const { data: signInData, error: signInErr } = await admin.auth.signInWithPassword({
    email,
    password,
  });
  if (signInErr) throw new Error(`signIn failed: ${signInErr.message}`);

  return {
    id: userId,
    email,
    jwt: signInData.session.access_token,
    password,
  };
}

/**
 * Cleanup: delete test user (auth + public.users row).
 */
export async function cleanupTestUser(userId) {
  if (!userId) return;
  const admin = serviceClient();
  await admin.from('users').delete().eq('id', userId);
  await admin.auth.admin.deleteUser(userId);
}

/**
 * Invoke a Supabase Edge Function with given JWT + body.
 */
export async function invokeEF(name, jwt, body, options = {}) {
  const url = `${globalThis.SUPA_URL}/functions/v1/${name}`;
  const headers = {
    'apikey': globalThis.ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  if (options.origin) headers['Origin'] = options.origin;
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });

  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  return { status: res.status, data, ok: res.ok };
}

/**
 * Direct PostgREST call (no EF) for verifying DB state.
 */
export async function postgrest(method, table, jwt, body, query = '') {
  const url = `${globalThis.SUPA_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const headers = {
    'apikey': globalThis.ANON_KEY,
    'Content-Type': 'application/json',
  };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;

  if (method === 'GET' || method === 'DELETE') {
    headers['Prefer'] = 'return=representation';
  } else if (body && !headers['Prefer']) {
    headers['Prefer'] = 'return=representation';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, ok: res.ok, contentRange: res.headers.get('content-range') };
}

/**
 * The known-good assessment in production: Matematika Dasar, code 912179.
 * Sections: [{ name: "Bagian 1", type_question: "PG", questions: [
 *   { idq: 1, jawaban_benar: "D", skor: 34 },
 *   { idq: 2, jawaban_benar: "B", skor: 33 },
 *   { idq: 3, jawaban_benar: "C", skor: 33 },
 * ]}]
 */
export const TEST_ASSESSMENT_ID = 'd1f005c5-d2fb-4063-b32e-296f06b631a3';
export const CORRECT_ANSWERS = { section_0: { '1': 'D', '2': 'B', '3': 'C' } };
export const WRONG_ANSWERS = { section_0: { '1': 'A', '2': 'A', '3': 'A' } };
