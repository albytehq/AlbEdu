// tests/setup.js — Global test setup
// Reads env vars, validates required ones, exposes helpers

import { beforeAll, afterEach } from 'vitest';

// Required env vars
const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

for (const v of REQUIRED) {
  if (!process.env[v]) {
    console.error(`Missing required env var: ${v}`);
    console.error('Set: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
}

// Global helpers exposed via globalThis
globalThis.SUPA_URL = process.env.SUPABASE_URL;
globalThis.ANON_KEY = process.env.SUPABASE_ANON_KEY;
globalThis.SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
globalThis.ORIGIN = 'https://albytehq.github.io';

// Test user credentials — generated per test run
globalThis.TEST_TS = Date.now();
globalThis.TEST_PASSWORD = 'SmokeTest#2026';
