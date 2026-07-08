//  image-cleanup.js — release uploaded images from the Cloudflare Worker
//  (new { url, hash } entries) or the legacy GitHub CDN (plain URL strings).
//
//  Public API:
//    ImageCleanup.deleteImage(urlOrEntry)
//    ImageCleanup.deleteExamImages(examData)
//    ImageCleanup.deleteImages(urlsOrEntries)

const ImageCleanup = (() => {


  const getWorkerBase = () =>
    (window.ALBYTE_WORKER_URL || 'https://edu.albyte-inc.workers.dev/upload')
      .replace(/\/upload$/, '');

  const getLegacyBase = () =>
    window.ALBYTE_UPLOAD_API_URL?.replace('/api/upload', '')
    || 'https://albyte-upload-api.vercel.app';

  // Accepts a plain URL string (legacy) or a { url, hash } object (current).
  // Returns { url, hash } — hash may be null for legacy entries.
  function _normalize(entry) {
    if (typeof entry === 'object' && entry !== null) {
      return { url: entry.url || '', hash: entry.hash || null };
    }
    return { url: entry || '', hash: null };
  }

  async function _workerRelease(hash) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${getWorkerBase()}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Worker /release error (${res.status})`);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  async function _legacyDelete(url) {
    if (!url || !url.startsWith('https://raw.githubusercontent.com/')) {
      console.warn('[ImageCleanup] Not a legacy CDN URL, skipping:', url);
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${getLegacyBase()}/api/delete-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      const data = await res.json();
      return data.success === true;
    } finally {
      clearTimeout(timer);
    }
  }

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

  /**
   * Walks the full examData object and releases every image entry found.
   * Compatible with both legacy string arrays and current object arrays.
   *
   * @param {object} examData  - Full exam record from Supabase
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

  /**
   * @param {Array<string | { url: string, hash: string }>} entries
   * @returns {Promise<{ deleted: number, failed: number }>}
   */
  async function deleteImages(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { deleted: 0, failed: 0 };
    let deleted = 0, failed = 0;
    // allSettled so one slow Worker doesn't block the rest of the batch.
    const results = await Promise.allSettled(entries.map((entry) => deleteImage(entry)));
    results.forEach((r) => { r.status === 'fulfilled' && r.value ? deleted++ : failed++; });
    return { deleted, failed };
  }

  return { deleteImage, deleteExamImages, deleteImages };
})();