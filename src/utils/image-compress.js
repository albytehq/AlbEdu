// image-compress.js — client-side image compression.
// Accepts any image format/size, outputs a JPEG File ≤ 500 KB with best-effort
// quality preservation.
//
// Strategy: draw onto <canvas>, binary-search JPEG quality 0.92 → 0.30 until
// size ≤ TARGET_BYTES; if still over limit, halve dimensions and retry.
//
// Public API:
//   await ImageCompress.compress(file)        → File (JPEG ≤ 500 KB)
//   await ImageCompress.compressAll(fileList) → File[]

const ImageCompress = (() => {

    const TARGET_BYTES    = 500 * 1024;   // 500 KB hard ceiling
    const MAX_DIMENSION   = 2048;         // cap longest side — prevents absurd canvases
    const QUALITY_HIGH    = 0.92;
    const QUALITY_LOW     = 0.30;
    const QUALITY_STEPS   = 8;            // binary-search iterations

    function _loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Cannot load image: ${file.name}`)); };
            img.src = url;
        });
    }

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

    function _canvasToBlob(canvas, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(
                blob => blob ? resolve(blob) : reject(new Error('toBlob returned null')),
                'image/jpeg',
                quality
            );
        });
    }

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

    /**
     * Compress many files. A single corrupted or non-image file no longer
     * fails the entire batch — bad files fall back to the original File
     * so the caller can still proceed (the upload step will reject them).
     *
     * @param   {File[]} files
     * @returns {Promise<{ok: File[], failed: {file: File, error: Error}[]}>}
     */
    async function compressAll(files) {
        const results = await Promise.allSettled(files.map(compress));
        const ok = [];
        const failed = [];
        results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
                ok.push(r.value);
            } else {
                // Fall back to the original file so a single bad apple
                // doesn't spoil the batch. The caller decides whether to
                // re-attempt compression or upload the original.
                ok.push(files[i]);
                failed.push({ file: files[i], error: r.reason });
            }
        });
        if (failed.length) {
            console.warn('[image-compress] ' + failed.length + ' file(s) failed compression, using originals');
        }
        return { ok, failed };
    }

    return { compress, compressAll };
})();
