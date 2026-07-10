#!/usr/bin/env node
/**
 * migrate-base64-avatars.js — One-time migration script.
 *
 * Scans the `users` table for rows where `avatar_url` starts with `data:image/`
 * (base64-encoded avatar). For each:
 *   1. Decodes the base64 to a Buffer
 *   2. Uploads to Supabase Storage `avatars` bucket at path `{user_id}/avatar-migrated-{timestamp}.jpg`
 *   3. Updates `users.avatar_url` to the public URL
 *
 * WHY: v0.821.0 Phase 1 changed avatar storage from base64-in-DB to Supabase
 * Storage. Existing base64 avatars bloat the database (each ~50-200 KB) and
 * can't be CDN-cached. This script migrates them out of the DB.
 *
 * RUNTIME: ~5 minutes for 50 users, ~30 minutes for 1000 users.
 *
 * USAGE:
 *   node scripts/migrate-base64-avatars.js
 *
 * ENV (set in .env or shell):
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...  (service role, NOT anon)
 *
 * SAFETY:
 *   • Idempotent — skips users whose avatar_url already starts with http
 *   • Dry-run mode: set DRY_RUN=true to log what would be migrated without changes
 *   • Verifies each upload succeeded before updating DB
 *   • Logs progress every 10 users
 *   • On error: logs the user_id + error, continues to next user
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

// ── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH_SIZE = 50;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  // Try .env file
  try {
    const env = readFileSync('.env', 'utf8');
    const match = (key) => env.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
    if (!SUPABASE_URL) process.env.SUPABASE_URL = match('SUPABASE_URL');
    if (!SUPABASE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = match('SUPABASE_SERVICE_ROLE_KEY');
  } catch {}
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  console.error('   Or create a .env file with those values.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Helpers ────────────────────────────────────────────────────────────────

function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  const out = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
  out(JSON.stringify(entry));
}
const info = (m, meta) => log('INFO', m, meta);
const warn = (m, meta) => log('WARN', m, meta);
const error = (m, meta) => log('ERROR', m, meta);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Parse a data URI: data:image/jpeg;base64,/9j/4AAQSkZJRg...
 * Returns { mimeType, buffer } or null if not a valid data URI.
 */
function parseDataUri(dataUri) {
  const match = String(dataUri).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = match[1];
  const base64 = match[2];
  try {
    const buffer = Buffer.from(base64, 'base64');
    return { mimeType, buffer };
  } catch {
    return null;
  }
}

/**
 * Determine file extension from MIME type.
 */
function extFromMime(mime) {
  switch (mime) {
    case 'image/jpeg': case 'image/jpg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'jpg';
  }
}

// ── Migration logic ────────────────────────────────────────────────────────

async function fetchBase64Users(offset = 0) {
  const { data, error } = await supabase
    .from('users')
    .select('id, avatar_url')
    .like('avatar_url', 'data:image/%')
    .range(offset, offset + BATCH_SIZE - 1);

  if (error) throw new Error(`Fetch error: ${error.message}`);
  return data || [];
}

async function migrateUser(user) {
  const { id, avatar_url } = user;
  const parsed = parseDataUri(avatar_url);
  if (!parsed) {
    warn('Could not parse data URI, skipping', { userId: id });
    return { status: 'skipped', reason: 'invalid_data_uri' };
  }

  const { mimeType, buffer } = parsed;
  const ext = extFromMime(mimeType);
  const path = `${id}/avatar-migrated-${Date.now()}.${ext}`;

  if (DRY_RUN) {
    info('[DRY RUN] Would upload', { userId: id, path, size: buffer.length });
    return { status: 'dry_run', path, size: buffer.length };
  }

  // Upload to Supabase Storage
  const { error: uploadErr } = await supabase.storage
    .from('avatars')
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: false,
      cacheControl: '3600',
    });

  if (uploadErr) {
    error('Upload failed', { userId: id, err: uploadErr.message });
    return { status: 'failed', reason: uploadErr.message };
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('avatars')
    .getPublicUrl(path);

  if (!urlData?.publicUrl) {
    error('Failed to get public URL', { userId: id });
    return { status: 'failed', reason: 'no_public_url' };
  }

  // Update users.avatar_url
  const { error: updateErr } = await supabase
    .from('users')
    .update({ avatar_url: urlData.publicUrl })
    .eq('id', id);

  if (updateErr) {
    error('DB update failed (file uploaded but DB not updated)', {
      userId: id,
      path,
      err: updateErr.message,
    });
    return { status: 'failed', reason: updateErr.message, partial: true };
  }

  return { status: 'migrated', path, url: urlData.publicUrl };
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  info('AlbEdu base64 avatar migration starting', { dryRun: DRY_RUN, batchSize: BATCH_SIZE });

  const summary = { total: 0, migrated: 0, skipped: 0, failed: 0, dryRun: 0 };
  let offset = 0;

  while (true) {
    let users;
    try {
      users = await fetchBase64Users(offset);
    } catch (err) {
      error('Failed to fetch users batch', { offset, err: err.message });
      break;
    }

    if (users.length === 0) {
      info('No more base64 avatars found', { offset });
      break;
    }

    info(`Processing batch of ${users.length}`, { offset });

    for (const user of users) {
      summary.total++;
      try {
        const result = await migrateUser(user);
        if (result.status === 'migrated') summary.migrated++;
        else if (result.status === 'dry_run') summary.dryRun++;
        else if (result.status === 'skipped') summary.skipped++;
        else if (result.status === 'failed') summary.failed++;

        if (summary.total % 10 === 0) {
          info('Progress', { ...summary, current: user.id });
        }

        // Small delay to avoid rate limiting
        await sleep(100);
      } catch (err) {
        summary.failed++;
        error('Unexpected error for user', { userId: user.id, err: err.message });
      }
    }

    offset += BATCH_SIZE;
  }

  info('Migration complete', summary);
  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  error('Fatal error', { err: err.message, stack: err.stack });
  process.exit(1);
});
