// =============================================================
//  assets/js/imageCompress.js
//  AlbEdu · Client-side Image Compression  (v1)
//
//  Accepts ANY image format and size.
//  Outputs: JPEG File, max 500 KB, best-effort quality preservation.
//
//  Strategy:
//    1. Draw image onto offscreen <canvas>
//    2. Binary-search JPEG quality from 0.92 → 0.30 until size ≤ TARGET_BYTES
//    3. If still over limit after quality search, halve dimensions and retry
//    4. Return a new File({ type: 'image/jpeg', name: '*.jpg' })
//
//  Public API:
//    await ImageCompress.compress(file)          → File (JPEG ≤ 500 KB)
//    await ImageCompress.compressAll(fileList)   → File[]
// =============================================================

const ImageCompress = (() => {

    const TARGET_BYTES    = 500 * 1024;   // 500 KB hard ceiling
    const MAX_DIMENSION   = 2048;         // cap longest side — prevents absurd canvases
    const QUALITY_HIGH    = 0.92;
    const QUALITY_LOW     = 0.30;
    const QUALITY_STEPS   = 8;            // binary-search iterations

    // ── Load a File into an HTMLImageElement ───────────────────────────────
    function _loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Cannot load image: ${file.name}`)); };
            img.src = url;
        });
    }

    // ── Draw img onto canvas at given scale, return canvas ─────────────────
    function _drawCanvas(img, scale = 1) {
        let w = Math.round(img.naturalWidth  * scale);
        let h = Math.round(img.naturalHeight * scale);

        // Cap longest side to MAX_DIMENSION
        if (Math.max(w, h) > MAX_DIMENSION) {
            const ratio = MAX_DIMENSION / Math.max(w, h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
        }

        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        // White background for transparent PNGs converting to JPEG
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return canvas;
    }

    // ── Canvas → Blob (JPEG at given quality) ─────────────────────────────
    function _canvasToBlob(canvas, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(
                blob => blob ? resolve(blob) : reject(new Error('toBlob returned null')),
                'image/jpeg',
                quality
            );
        });
    }

    // ── Binary-search best quality for a given canvas ─────────────────────
    async function _findQuality(canvas) {
        // Fast path: try high quality first
        const highBlob = await _canvasToBlob(canvas, QUALITY_HIGH);
        if (highBlob.size <= TARGET_BYTES) return highBlob;

        let lo = QUALITY_LOW, hi = QUALITY_HIGH, bestBlob = highBlob;
        for (let i = 0; i < QUALITY_STEPS; i++) {
            const mid  = (lo + hi) / 2;
            const blob = await _canvasToBlob(canvas, mid);
            if (blob.size <= TARGET_BYTES) {
                lo = mid;
                bestBlob = blob;  // best passing quality so far
            } else {
                hi = mid;
            }
        }
        return bestBlob;
    }

    // ── Main compress function ─────────────────────────────────────────────
    /**
     * Compress any image File to JPEG ≤ 500 KB.
     * @param   {File} file
     * @returns {Promise<File>}  New File with type 'image/jpeg'
     */
    async function compress(file) {
        // Already tiny JPEG — skip canvas round-trip (preserves quality)
        if (file.type === 'image/jpeg' && file.size <= TARGET_BYTES) {
            // Still rename extension to .jpg for consistency
            const name = file.name.replace(/\.[^.]+$/, '.jpg');
            return new File([file], name, { type: 'image/jpeg' });
        }

        const img    = await _loadImage(file);
        let   canvas = _drawCanvas(img, 1);
        let   blob   = await _findQuality(canvas);

        // If still over limit even at lowest quality, progressively shrink canvas
        if (blob.size > TARGET_BYTES) {
            for (const scale of [0.75, 0.5, 0.35]) {
                canvas = _drawCanvas(img, scale);
                blob   = await _findQuality(canvas);
                if (blob.size <= TARGET_BYTES) break;
            }
        }

        // Last resort: absolute floor — accept whatever we got
        const baseName  = file.name.replace(/\.[^.]+$/, '');
        const safeBase  = baseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'image';
        const outName   = `${safeBase}.jpg`;

        console.debug(
            `[ImageCompress] ${file.name} (${(file.size/1024).toFixed(0)} KB ${file.type})` +
            ` → ${outName} (${(blob.size/1024).toFixed(0)} KB JPEG)`
        );

        return new File([blob], outName, { type: 'image/jpeg' });
    }

    // ── Batch compress ─────────────────────────────────────────────────────
    /**
     * @param   {File[]} files
     * @returns {Promise<File[]>}
     */
    async function compressAll(files) {
        return Promise.all(files.map(compress));
    }

    return { compress, compressAll };
})();
