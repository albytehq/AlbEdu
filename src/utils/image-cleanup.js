// =============================================================
//  assets/js/imageCleanup.js
//  AlbEdu · Image Cleanup Helper  (v2 — Worker + GitHub CDN)
//
//  Supports two asset generations:
//    [NEW] { url, hash } objects  → POST /release to Cloudflare Worker
//    [OLD] plain string URLs      → POST /api/delete-image to Vercel API
//
//  Call sites (unchanged public API):
//    ImageCleanup.deleteImage(urlOrEntry)
//    ImageCleanup.deleteExamImages(examData)
//    ImageCleanup.deleteImages(urlsOrEntries)
// =============================================================

const ImageCleanup = (() => {

  // ── Config ────────────────────────────────────────────────

  const getWorkerBase = () =>
    (window.ALBYTE_WORKER_URL || 'https://edu.albyte-inc.workers.dev/upload')
      .replace(/\/upload$/, '');

  const getLegacyBase = () =>
    window.ALBYTE_UPLOAD_API_URL?.replace('/api/upload', '')
    || 'https://albyte-upload-api.vercel.app';

  // ── Compat normalizer ────────────────────────────────────
  // Accepts either a plain URL string (old) or a { url, hash } object (new).
  // Returns { url, hash } — hash may be null for legacy entries.
  function _normalize(entry) {
    if (typeof entry === 'object' && entry !== null) {
      return { url: entry.url || '', hash: entry.hash || null };
    }
    return { url: entry || '', hash: null };
  }

  // ── New flow: call Worker /release ────────────────────────
  async function _workerRelease(hash) {
    const res = await fetch(`${getWorkerBase()}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash }),
    });
    if (!res.ok) throw new Error(`Worker /release error (${res.status})`);
    return true;
  }

  // ── Legacy flow: call Vercel /api/delete-image ────────────
  async function _legacyDelete(url) {
    if (!url || !url.startsWith('https://raw.githubusercontent.com/')) {
      console.warn('[ImageCleanup] Not a legacy CDN URL, skipping:', url);
      return false;
    }
    const res = await fetch(`${getLegacyBase()}/api/delete-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    return data.success === true;
  }

  // ── 1. Delete ONE image ───────────────────────────────────
  /**
   * @param {string | { url: string, hash: string }} entry
   * @returns {Promise<boolean>}
   */
  async function deleteImage(entry) {
    const { url, hash } = _normalize(entry);
    try {
      if (hash) return await _workerRelease(hash);
      return await _legacyDelete(url);
    } catch (err) {
      console.error('[ImageCleanup] deleteImage error:', err);
      return false;
    }
  }

  // ── 2. Delete ALL images in an exam ──────────────────────
  /**
   * Walks the full examData object and releases every image entry found.
   * Compatible with both old string arrays and new object arrays.
   *
   * @param {object} examData  - Full exam record from Supabase/Firestore
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
    } catch (err) {
      console.error('[ImageCleanup] deleteExamImages parse error:', err);
    }
    return deleteImages(entries);
  }

  // ── 3. Delete many entries at once ───────────────────────
  /**
   * @param {Array<string | { url: string, hash: string }>} entries
   * @returns {Promise<{ deleted: number, failed: number }>}
   */
  async function deleteImages(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { deleted: 0, failed: 0 };
    let deleted = 0, failed = 0;
    await Promise.all(entries.map(async (entry) => {
      const ok = await deleteImage(entry).catch(() => false);
      ok ? deleted++ : failed++;
    }));
    return { deleted, failed };
  }

  return { deleteImage, deleteExamImages, deleteImages };
})();