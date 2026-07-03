// =============================================================================
// repository.js — AlbEdu Platform Layer · Table access helpers
// =============================================================================
// Native Supabase table access, with a tiny ergonomic API so consumer code
// doesn't have to repeat the .from().select().eq() chain.
//
// All async methods return native Supabase { data, error } shapes (or throw
// on auth/network errors). Callers choose how to handle errors.
//
// The goal is NOT to emulate Firestore. The goal is to give callers a thin,
// predictable native API so the call sites stay short and readable.
// =============================================================================

(function () {
  'use strict';

  function _requireClient() {
    const sb = window.AlbEdu?.supabase;
    if (!sb?.client) {
      throw new Error('[platform] supabase client not ready — await window.AlbEdu.supabase.ready');
    }
    return sb.client;
  }

  // ── DocResult: normalized row result ───────────────────────────────────
  // Mimics the parts of Firestore DocumentSnapshot that consumers actually
  // read: { id, exists, data() } — but with native Supabase semantics.
  function _rowToDoc(row, idCol = 'id') {
    if (!row) {
      return { exists: false, id: null, data: () => null, _raw: null };
    }
    const id = row[idCol] ?? row.id ?? null;
    return {
      exists: true,
      id,
      data: () => row,
      _raw: row,
    };
  }

  function _rowsToQuery(rows, idCol = 'id') {
    const docs = (rows || []).map(r => _rowToDoc(r, idCol));
    return {
      docs,
      forEach: (cb) => docs.forEach(cb),
      empty: docs.length === 0,
      size: docs.length,
      // docChanges() — simple diff for legacy callers (AdminNotificationCenter)
      // Returns 'added' for all on first fetch; subsequent calls can pass prevRows.
      docChanges: (prevRows) => {
        if (!prevRows) return docs.map(doc => ({ type: 'added', doc }));
        const prevIds = new Set(prevRows.map(r => r[idCol]));
        const currIds = new Set((rows || []).map(r => r[idCol]));
        const changes = [];
        for (const r of (rows || [])) {
          const doc = _rowToDoc(r, idCol);
          changes.push({ type: prevIds.has(r[idCol]) ? 'modified' : 'added', doc });
        }
        for (const r of (prevRows || [])) {
          if (!currIds.has(r[idCol])) {
            changes.push({ type: 'removed', doc: _rowToDoc(r, idCol) });
          }
        }
        return changes;
      },
    };
  }

  // ── Repository public API ──────────────────────────────────────────────
  const Repository = {
    /**
     * Fetch a single row by its primary key.
     * @param {string} table
     * @param {string|number} id — primary key value
     * @param {string} [idCol='id'] — name of the identity column
     *   (use 'access_code' for assessments, 'kode_id' for legacy ujian, etc.)
     * @param {string} [columns='*'] — comma-separated column names
     * @returns {Promise<{exists:boolean, id, data:()=>object, _raw}>}
     */
    async getDoc(table, id, idCol = 'id', columns = '*') {
      const client = _requireClient();
      const { data, error } = await client.from(table)
        .select(columns)
        .eq(idCol, id)
        .maybeSingle();
      if (error) throw error;
      return _rowToDoc(data, idCol);
    },

    /**
     * Fetch multiple rows with optional filter / order / limit.
     * @param {string} table
     * @param {{
     *   columns?: string,
     *   eq?: Object<string,*>,         — multiple eq filters (AND-ed)
     *   order?: { column: string, ascending?: boolean },
     *   limit?: number,
     *   range?: { from: number, to: number },
     * }} [opts]
     * @returns {Promise<{docs, forEach, empty, size, docChanges}>}
     */
    async getDocs(table, opts = {}) {
      const client = _requireClient();
      let q = client.from(table).select(opts.columns || '*');
      if (opts.eq) {
        for (const [col, val] of Object.entries(opts.eq)) q = q.eq(col, val);
      }
      if (opts.order) {
        q = q.order(opts.order.column, { ascending: opts.order.ascending ?? false });
      }
      if (opts.limit != null) q = q.limit(opts.limit);
      if (opts.range) q = q.range(opts.range.from, opts.range.to);
      const { data, error } = await q;
      if (error) throw error;
      return _rowsToQuery(data, opts.idCol || 'id');
    },

    /**
     * Insert a single row. Returns the inserted row (with PK).
     */
    async addDoc(table, payload) {
      const client = _requireClient();
      const { data, error } = await client.from(table).insert(payload).select().single();
      if (error) throw error;
      return _rowToDoc(data);
    },

    /**
     * Update a single row by PK. Returns the updated row.
     */
    async updateDoc(table, id, payload, idCol = 'id') {
      const client = _requireClient();
      const { data, error } = await client.from(table)
        .update(payload)
        .eq(idCol, id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return _rowToDoc(data, idCol);
    },

    /**
     * Upsert (insert-or-update) a row by PK.
     */
    async setDoc(table, id, payload, idCol = 'id') {
      const client = _requireClient();
      const body = { ...payload, [idCol]: id };
      const { data, error } = await client.from(table)
        .upsert(body, { onConflict: idCol })
        .select()
        .maybeSingle();
      if (error) throw error;
      return _rowToDoc(data, idCol);
    },

    /**
     * Delete a single row by PK.
     */
    async deleteDoc(table, id, idCol = 'id') {
      const client = _requireClient();
      const { error } = await client.from(table).delete().eq(idCol, id);
      if (error) throw error;
    },

    /**
     * Bulk delete rows by PK list. Returns count deleted.
     */
    async bulkDelete(table, ids, idCol = 'id') {
      const client = _requireClient();
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      const { data, error } = await client.from(table)
        .delete()
        .in(idCol, ids)
        .select(idCol);
      if (error) throw error;
      return data?.length || 0;
    },

    /**
     * Subscribe to realtime changes on a table.
     * @param {string} name — channel name (unique per subscription)
     * @param {string} table
     * @param {function} callback — (payload) => void
     *   payload.event: 'INSERT' | 'UPDATE' | 'DELETE'
     *   payload.new: new row (for INSERT/UPDATE)
     *   payload.old: old row (for DELETE/UPDATE)
     * @param {string} [filter] — e.g. 'access_code=eq.ABC123'
     * @returns unsubscribe function
     */
    subscribe(name, table, callback, filter) {
      const sb = window.AlbEdu?.supabase;
      if (!sb?.realtime) {
        console.warn('[platform] realtime service not ready — subscription skipped');
        return () => {};
      }
      return sb.realtime.subscribe(name, table, '*', (payload) => {
        callback({
          event: payload.eventType,
          new: payload.new,
          old: payload.old,
          _raw: payload,
        });
      }, filter);
    },

    /** Unsubscribe all realtime channels (used on logout). */
    unsubscribeAll() {
      window.AlbEdu?.supabase?.realtime?.unsubscribeAll();
    },

    /**
     * Server timestamp sentinel — use in payloads to mark "set this column to now()"
     * at the database. Implemented as a no-op marker since Supabase REST sets
     * timestamp columns via DB defaults / triggers; callers can simply omit
     * the field and let the default fire.
     */
    serverTimestamp: null,

    /**
     * Convenience: read raw client for advanced queries.
     * Use sparingly — prefer the helpers above for readability.
     */
    raw() {
      return _requireClient();
    },
  };

  // Expose
  if (!window.AlbEdu) window.AlbEdu = {};
  window.AlbEdu.repository = Repository;
})();
