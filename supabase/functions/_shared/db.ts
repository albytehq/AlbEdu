// =============================================================================
// _shared/db.ts — Supabase REST API helper (raw fetch, no SDK overhead)
// =============================================================================
// Uses service role key (bypasses RLS) for server-side operations.
// All methods return parsed JSON or throw HTTPError on failure.
// =============================================================================

import { HTTPError } from './error.ts';
import type { Env } from './types.ts';

export class SupabaseDB {
  constructor(private env: Env) {}

  private get headers(): Record<string, string> {
    return {
      apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  async select<T = any>(
    table: string,
    query: string,  // e.g. "id,access_code,title&status=eq.active&limit=10"
  ): Promise<T[]> {
    const res = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/${table}?select=${query}`,
      { headers: this.headers }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error(`[db.select] ${table} ${res.status}:`, text);
      throw new HTTPError(500, 'INTERNAL_ERROR', `Database query failed: ${table}`);
    }
    return await res.json();
  }

  async selectOne<T = any>(table: string, query: string): Promise<T | null> {
    const rows = await this.select<T>(table, `${query}&limit=1`);
    return rows?.[0] || null;
  }

  async insert<T = any>(
    table: string,
    data: any | any[],
    options: { returnRepresentation?: boolean } = {}
  ): Promise<T | null> {
    const headers: Record<string, string> = { ...this.headers };
    if (options.returnRepresentation) {
      headers['Prefer'] = 'return=representation';
    } else {
      headers['Prefer'] = 'return=minimal';
    }

    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[db.insert] ${table} ${res.status}:`, text);

      // Parse common errors
      if (res.status === 409) {
        throw new HTTPError(409, 'CONFLICT', 'Resource already exists');
      }
      if (text.includes('violates foreign key constraint')) {
        throw new HTTPError(400, 'VALIDATION_ERROR', 'Foreign key constraint violation');
      }
      if (text.includes('violates check constraint')) {
        throw new HTTPError(400, 'VALIDATION_ERROR', 'Check constraint violation');
      }
      if (text.includes('violates not-null constraint')) {
        throw new HTTPError(400, 'VALIDATION_ERROR', 'Required field missing');
      }
      throw new HTTPError(500, 'INTERNAL_ERROR', `Insert failed: ${table}`);
    }

    if (options.returnRepresentation) {
      const rows = await res.json();
      return Array.isArray(rows) ? rows[0] : rows;
    }
    return null;
  }

  async update<T = any>(
    table: string,
    filter: string,  // e.g. "id=eq.abc-123"
    data: any,
    options: { returnRepresentation?: boolean } = {}
  ): Promise<T | null> {
    const headers: Record<string, string> = { ...this.headers };
    if (options.returnRepresentation) {
      headers['Prefer'] = 'return=representation';
    } else {
      headers['Prefer'] = 'return=minimal';
    }

    const res = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/${table}?${filter}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[db.update] ${table} ${res.status}:`, text);
      throw new HTTPError(500, 'INTERNAL_ERROR', `Update failed: ${table}`);
    }

    if (options.returnRepresentation) {
      const rows = await res.json();
      return Array.isArray(rows) ? rows[0] : rows;
    }
    return null;
  }

  // Atomic conditional update — only updates if filter matches.
  // Returns the number of rows updated (0 = no match, 1 = success).
  async updateIf<T = any>(
    table: string,
    filter: string,
    data: any,
  ): Promise<{ updated: number; row: T | null }> {
    const res = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/${table}?${filter}`,
      {
        method: 'PATCH',
        headers: {
          ...this.headers,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify(data),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[db.updateIf] ${table} ${res.status}:`, text);
      throw new HTTPError(500, 'INTERNAL_ERROR', `Conditional update failed: ${table}`);
    }

    const rows = await res.json();
    const arr = Array.isArray(rows) ? rows : [];
    return { updated: arr.length, row: arr[0] || null };
  }

  async delete(table: string, filter: string): Promise<void> {
    const res = await fetch(
      `${this.env.SUPABASE_URL}/rest/v1/${table}?${filter}`,
      {
        method: 'DELETE',
        headers: this.headers,
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[db.delete] ${table} ${res.status}:`, text);
      throw new HTTPError(500, 'INTERNAL_ERROR', `Delete failed: ${table}`);
    }
  }

  // Call RPC function (e.g. log_audit, generate_access_code)
  async rpc<T = any>(functionName: string, params: any): Promise<T> {
    const res = await fetch(`${this.env.SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[db.rpc] ${functionName} ${res.status}:`, text);
      throw new HTTPError(500, 'INTERNAL_ERROR', `RPC failed: ${functionName}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
