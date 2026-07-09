// image-compress-worker.js — Web Worker wrapper for Magic Compress™ v2.
//
// Runs the perceptual compression pipeline off the main thread so the UI
// doesn't freeze during 2-4 second compression of large images.
//
// USAGE (from main thread):
//   const worker = new Worker('src/utils/image-compress-worker.js');
//   worker.postMessage({ file, options: { targetMaxBytes: 300*1024 } });
//   worker.onmessage = (e) => {
//     if (e.data.success) {
//       const { blob, compressedSize, ssim, complexity } = e.data.result;
//       // use result
//     } else {
//       console.error(e.data.error);
//     }
//   };
//
// PROTOCOL:
//   Main → Worker: { type: 'compress', file: File, options: object }
//   Worker → Main: { type: 'progress', stage: string, progress: 0-1 }
//   Worker → Main: { type: 'result', success: boolean, result?: object, error?: string }
//
// The worker loads image-compress.js via importScripts (classic worker)
// or dynamic import (module worker). Falls back gracefully.

'use strict';

// ── Load the core compression library ──────────────────────────────────────
// In a classic Worker, importScripts is available synchronously.
// In a Module Worker, we'd use dynamic import — but importScripts is simpler
// and works in all browsers that support Workers.

let ImageCompress = null;
let _initError = null;

try {
  // Resolve relative to the worker file location
  self.importScripts('./image-compress.js');
  ImageCompress = self.ImageCompress;
} catch (err) {
  // Try absolute path (worker might be loaded from different origin)
  try {
    self.importScripts('/src/utils/image-compress.js');
    ImageCompress = self.ImageCompress;
  } catch (err2) {
    _initError = `Failed to load image-compress.js: ${err2.message}`;
    console.error('[image-compress-worker]', _initError);
  }
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
