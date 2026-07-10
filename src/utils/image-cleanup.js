//  image-cleanup.js — release uploaded images (soal/assessment images).
//
//  v0.819.0: Avatar deletion moved to Supabase Storage directly (deleteAvatar).
//  Soal image deletion (deleteImage/deleteExamImages/deleteImages) is currently
//  DEPRECATED — the old Worker /release endpoint is decommissioned. Phase 2
//  will rewire these to call the new asset-release Supabase Edge Function.
//
//  Public API:
//    ImageCleanup.deleteAvatar(userId, opts)  — ACTIVE (Phase 1, Supabase Storage)
//    ImageCleanup.deleteImage(entry)          — DEPRECATED (Phase 2 will rewire)
//    ImageCleanup.deleteExamImages(examData)  — DEPRECATED (Phase 2 will rewire)
//    ImageCleanup.deleteImages(entries)       — DEPRECATED (Phase 2 will rewire)

const ImageCleanup = (() => {

  // v0.819.0: Worker /release endpoint decommissioned. These helpers are kept
  // as no-ops with warnings until Phase 2 wires them to the asset-release
  // Supabase Edge Function. Calling them now is safe (returns false) but logs
  // a deprecation warning so developers know images aren't actually released.

  /**
   * @deprecated since v0.819.0 — Phase 2 will rewire to asset-release Edge Function.
   * Currently a no-op (returns false). Worker /release endpoint is decommissioned.
   *
   * @param {string | { url: string, hash: string }} entry
   * @returns {Promise<boolean>}
   */
  async function deleteImage(entry) {
    console.warn('[ImageCleanup] deleteImage() is deprecated since v0.819.0.',
      'Worker /release decommissioned. Phase 2 will rewire to asset-release Edge Function.',
      'Entry:', entry);
    return false;
  }

  /**
   * @deprecated since v0.819.0 — Phase 2 will rewire.
   * Walks the full examData object and would release every image entry found.
   * Currently a no-op (returns {deleted: 0, failed: 0}).
   *
   * @param {object} examData  - Full exam record from Supabase
   * @returns {Promise<{ deleted: number, failed: number }>}
   */
  async function deleteExamImages(examData) {
    console.warn('[ImageCleanup] deleteExamImages() is deprecated since v0.819.0.',
      'Phase 2 will rewire to asset-release Edge Function.');
    return { deleted: 0, failed: 0 };
  }

  /**
   * @deprecated since v0.819.0 — Phase 2 will rewire.
   * Currently a no-op.
   *
   * @param {Array<string | { url: string, hash: string }>} entries
   * @returns {Promise<{ deleted: number, failed: number }>}
   */
  async function deleteImages(entries) {
    console.warn('[ImageCleanup] deleteImages() is deprecated since v0.819.0.',
      'Phase 2 will rewire to asset-release Edge Function.');
    return { deleted: 0, failed: 0 };
  }

  /**
   * Delete a user's avatar from Supabase Storage `avatars` bucket.
   * Used by DSR handler (UU PDP right-to-be-forgotten) and profile editor
   * (when user replaces avatar — old one can be deleted after new one uploaded).
   *
   * v0.819.0: Phase 1 — avatars now live in Supabase Storage, not GitHub repos.
   *
   * @param {string} userId — Supabase auth.uid() of the avatar owner
   * @param {object} [opts] — { deleteAll: true (default) — delete ALL files in
   *                          user's folder; false — delete only the latest }
   * @returns {Promise<{ deleted: number, failed: number, paths: string[] }>}
   */
  async function deleteAvatar(userId, opts = {}) {
    const { deleteAll = true } = opts;
    const supabase = window.AlbEdu?.supabase?.client;
    if (!supabase) {
      console.warn('[ImageCleanup] Supabase client not available — cannot delete avatar');
      return { deleted: 0, failed: 0, paths: [] };
    }
    if (!userId) {
      console.warn('[ImageCleanup] userId required for deleteAvatar');
      return { deleted: 0, failed: 0, paths: [] };
    }

    // List all files in the user's avatar folder
    const { data: fileList, error: listErr } = await supabase.storage
      .from('avatars')
      .list(userId, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });

    if (listErr) {
      console.error('[ImageCleanup] Failed to list avatar files:', listErr.message);
      return { deleted: 0, failed: 0, paths: [] };
    }

    if (!fileList || fileList.length === 0) {
      // No avatars to delete — not an error
      return { deleted: 0, failed: 0, paths: [] };
    }

    // Filter: delete all, or just the latest
    const toDelete = deleteAll
      ? fileList.map((f) => `${userId}/${f.name}`)
      : [`${userId}/${fileList[0].name}`];

    const { data: delResult, error: delErr } = await supabase.storage
      .from('avatars')
      .remove(toDelete);

    if (delErr) {
      console.error('[ImageCleanup] Failed to delete avatar files:', delErr.message);
      return { deleted: 0, failed: toDelete.length, paths: toDelete };
    }

    const deletedCount = delResult?.length || toDelete.length;
    console.info('[ImageCleanup] Avatars deleted:', { userId, count: deletedCount, paths: toDelete });
    return { deleted: deletedCount, failed: 0, paths: toDelete };
  }

  return { deleteImage, deleteExamImages, deleteImages, deleteAvatar };
})();