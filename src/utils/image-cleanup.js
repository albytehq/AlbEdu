//  image-cleanup.js — release uploaded images (soal/assessment images).
//
//  v0.821.0: Phase 2 — deleteImage/deleteImages/deleteExamImages now call
//  the asset-release Supabase Edge Function (ref_count decrement).
//  deleteAvatar remains on Supabase Storage (Phase 1).
//
//  Public API:
//    ImageCleanup.deleteAvatar(userId, opts)  — Avatar deletion (Supabase Storage)
//    ImageCleanup.deleteImage(entry)          — Single image release (asset-release EF)
//    ImageCleanup.deleteExamImages(examData)  — All images in an exam (asset-release EF)
//    ImageCleanup.deleteImages(entries)       — Batch release (asset-release EF)

const ImageCleanup = (() => {

  /**
   * Release a single image via asset-release Edge Function.
   * @param {string | { url: string, hash: string }} entry
   * @returns {Promise<boolean>}
   */
  async function deleteImage(entry) {
    const hash = typeof entry === 'object' ? entry?.hash : null;
    if (!hash) { console.warn('[ImageCleanup] deleteImage: no hash', entry); return false; }
    const r = await deleteImages([entry]);
    return r.deleted > 0;
  }

  /**
   * Walks examData and releases every image found.
   * @param {object} examData
   * @returns {Promise<{ deleted: number, failed: number }>}
   */
  async function deleteExamImages(examData) {
    const entries = [];
    try {
      const sections = examData?.soal || examData?.sections || [];
      for (const section of sections) {
        const questions = section?.questions || section?.soal || [];
        for (const q of questions) {
          const gambar = q?.media?.gambar || [];
          for (const g of gambar) entries.push(g);
        }
      }
    } catch (err) { console.error('[ImageCleanup] parse error:', err); }
    return deleteImages(entries);
  }

  /**
   * Batch release via asset-release Edge Function.
   * @param {Array} entries
   * @returns {Promise<{ deleted: number, failed: number }>}
   */
  async function deleteImages(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { deleted: 0, failed: 0 };
    const hashes = entries.map((e) => typeof e === 'object' ? e?.hash : null).filter((h) => h && /^[a-f0-9]{64}$/.test(h));
    if (hashes.length === 0) return { deleted: 0, failed: 0 };

    const supabase = window.AlbEdu?.supabase?.client;
    if (!supabase) { console.warn('[ImageCleanup] no Supabase client'); return { deleted: 0, failed: hashes.length }; }

    try {
      // Use raw fetch() — same pattern as asset-upload (avoids FormData/JSON issues in SDK wrapper)
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) { return { deleted: 0, failed: hashes.length }; }

      const supabaseUrl = supabase.supabaseUrl || supabase?._config?.url || '';
      if (!supabaseUrl) { return { deleted: 0, failed: hashes.length }; }

      const res = await fetch(`${supabaseUrl}/functions/v1/asset-release`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ hashes }),
      });

      if (!res.ok) { console.error('[ImageCleanup] EF error:', res.status); return { deleted: 0, failed: hashes.length }; }

      const json = await res.json();
      const data = json?.data || json;
      const released = data?.released || 0;
      console.info('[ImageCleanup] Released:', { total: hashes.length, released, pending: data?.pending_delete || 0 });
      return { deleted: released, failed: hashes.length - released };
    } catch (err) { console.error('[ImageCleanup] error:', err); return { deleted: 0, failed: hashes.length }; }
  }

  /**
   * Delete a user's avatar from Supabase Storage `avatars` bucket.
   * @param {string} userId
   * @param {object} [opts] — { deleteAll: true (default) }
   * @returns {Promise<{ deleted: number, failed: number, paths: string[] }>}
   */
  async function deleteAvatar(userId, opts = {}) {
    const { deleteAll = true } = opts;
    const supabase = window.AlbEdu?.supabase?.client;
    if (!supabase || !userId) { return { deleted: 0, failed: 0, paths: [] }; }

    const { data: fileList, error: listErr } = await supabase.storage.from('avatars').list(userId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (listErr || !fileList?.length) { return { deleted: 0, failed: 0, paths: [] }; }

    const toDelete = deleteAll ? fileList.map((f) => `${userId}/${f.name}`) : [`${userId}/${fileList[0].name}`];
    const { data: delResult, error: delErr } = await supabase.storage.from('avatars').remove(toDelete);
    if (delErr) { return { deleted: 0, failed: toDelete.length, paths: toDelete }; }

    return { deleted: delResult?.length || toDelete.length, failed: 0, paths: toDelete };
  }

  return { deleteImage, deleteExamImages, deleteImages, deleteAvatar };
})();
