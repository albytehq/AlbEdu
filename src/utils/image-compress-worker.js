// image-compress-worker.js — Web Worker wrapper for Magic Compress™ v2.
//
// Runs the perceptual compression pipeline off the main thread so the UI
// doesn't freeze during 2-4 second compression of large images.
//
// USAGE (from main thread — use ImageCompress.compressInWorker() helper
// which handles path resolution automatically):
//   const result = await ImageCompress.compressInWorker(file, {
//     onProgress: (stage, progress) => updateUI(stage, progress)
//   });
//
// USAGE (manual worker creation — MUST resolve URL via getBasePath()):
//   const base = window.Auth?.getBasePath?.() || '/';
//   const worker = new Worker(base + 'src/utils/image-compress-worker.js');
//   worker.postMessage({ type: 'compress', file, options: {} });
//   worker.onmessage = (e) => { /* handle result */ };
//
// PROTOCOL:
//   Main → Worker: { type: 'compress', file: File, options: object }
//   Worker → Main: { type: 'ready' } (sent on load)
//   Worker → Main: { type: 'progress', stage: string, progress: 0-1 }
//   Worker → Main: { type: 'result', success: boolean, result?: object, error?: string }
//
// GITHUB PAGES EDGE CASE:
//   AlbEdu is hosted at https://albytehq.github.io/AlbEdu/ (subpath).
//   The worker file is at .../AlbEdu/src/utils/image-compress-worker.js.
//   Inside the worker, importScripts('./image-compress.js') resolves
//   relative to the WORKER's URL (not the page URL), so it correctly
//   finds .../AlbEdu/src/utils/image-compress.js. We use self.location
//   to derive the directory, which is robust against any subpath.
//   NEVER use importScripts('/src/utils/...') — that resolves to the
//   domain root (https://albytehq.github.io/src/utils/...) which 404s.

'use strict';

// ── Load the core compression library ──────────────────────────────────────
// Derive the worker's own directory from self.location, then load
// image-compress.js from the same directory. This is subpath-safe.

let ImageCompress = null;
let _initError = null;

try {
  // self.location.href = https://albytehq.github.io/AlbEdu/src/utils/image-compress-worker.js
  // Strip filename → https://albytehq.github.io/AlbEdu/src/utils/
  const workerDir = self.location.href.replace(/\/[^/]+$/, '/');
  self.importScripts(workerDir + 'image-compress.js');
  ImageCompress = self.ImageCompress;
  if (!ImageCompress) {
    throw new Error('image-compress.js loaded but ImageCompress not found on self');
  }
} catch (err) {
  _initError = `Failed to load image-compress.js: ${err.message}`;
  console.error('[image-compress-worker]', _initError);
}

// ── Message handler ────────────────────────────────────────────────────────

self.onmessage = async function (e) {
  const msg = e.data || {};

  if (msg.type !== 'compress') {
    self.postMessage({ type: 'result', success: false, error: 'Unknown message type: ' + msg.type });
    return;
  }

  if (!ImageCompress) {
    self.postMessage({
      type: 'result',
      success: false,
      error: _initError || 'ImageCompress module not loaded',
    });
    return;
  }

  const { file, options = {} } = msg;

  if (!file) {
    self.postMessage({ type: 'result', success: false, error: 'No file provided' });
    return;
  }

  // Validate
  const validation = ImageCompress.validate(file);
  if (!validation.valid) {
    self.postMessage({ type: 'result', success: false, error: validation.error });
    return;
  }

  // Progress: decoding
  self.postMessage({ type: 'progress', stage: 'decode', progress: 0.1 });

  try {
    // Pre-warm MozJPEG WASM (non-blocking, starts download in background)
    self.postMessage({ type: 'progress', stage: 'loading-mozjpeg', progress: 0.2 });

    // Run Magic Compress
    const result = await ImageCompress.magicCompress(file, options);

    self.postMessage({ type: 'progress', stage: 'done', progress: 1.0 });

    // Send result back (transfer the blob, don't copy)
    self.postMessage({
      type: 'result',
      success: true,
      result: {
        blob: result.blob,
        width: result.width,
        height: result.height,
        originalSize: result.originalSize,
        compressedSize: result.compressedSize,
        qualityUsed: result.qualityUsed,
        compressionRatio: result.compressionRatio,
        complexity: result.complexity,
        ssim: result.ssim,
        ssimTier: result.ssimTier,
        mozjpeg: result.mozjpeg,
        format: result.format,
      },
    });
  } catch (err) {
    self.postMessage({
      type: 'result',
      success: false,
      error: err.message || 'Compression failed',
    });
  }
};

// Signal ready
self.postMessage({ type: 'ready' });
