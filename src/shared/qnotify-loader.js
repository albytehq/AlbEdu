// =============================================================================
// qnotify-loader.js — AlbEdu Shared Layer · QNotify Deterministic Boot Loader
// =============================================================================
// Single responsibility: load QNotify deterministically via dynamic import,
// install legacy compatibility shims (window.QNotify, window.show, window.notify),
// and dispatch 'qnotify-ready' event exactly once.
//
// This file MUST be loaded as <script type="module"> because it uses
// dynamic import() to load QNotify's ES module entry point.
//
// Usage in HTML (canonical head, after boot.js):
//   <script type="module" src="../../src/shared/qnotify-loader.js"></script>
//
// =============================================================================

// Use export-scope (this is a module, not IIFE)
if (window.__qnotifyLoaderStarted) {
  // Already loaded — skip
} else {
window.__qnotifyLoaderStarted = true;

  // Compute the relative path to public/QNotify/api/index.js
  // based on the current page's location.
  function _resolveQNotifyPath() {
    var p = window.location.pathname;
    var base = p.substring(0, p.lastIndexOf('/') + 1);

    // Walk up past known app subfolders — same logic as auth/main.js BASE_PATH
    var subfolders = [
      '/pages/admin/pages/', '/pages/assessment/', '/pages/admin/',
      '/pages/ujian/', '/pages/', '/admin/pages/', '/ujian/', '/admin/'
    ];

    var basePath = base || '/';
    for (var i = 0; i < subfolders.length; i++) {
      var idx = base.indexOf(subfolders[i]);
      if (idx !== -1) {
        basePath = base.substring(0, idx + 1);
        break;
      }
    }

    return basePath + 'public/QNotify/api/index.js';
  }

  // Install legacy compatibility shims once QNotify is loaded
  function _installShims(QNotify) {
    // Primary API
    window.QNotify = QNotify;
    window.show    = QNotify;

    // Legacy notify.* shim — matches the old per-page bootstrap pattern
    // so all 290 call sites in the codebase keep working without changes.
    window.notify = {
      // Toast shortcuts
      success:          function(t, m, d) { return QNotify.notify.success(t, m, d); },
      error:            function(t, m, d) { return QNotify.notify.error(t, m, d); },
      warning:          function(t, m, d) { return QNotify.notify.warning(t, m, d); },
      info:             function(t, m, d) { return QNotify.notify.info(t, m, d); },

      // Bahasa Indonesia aliases
      sukses:           function(t, m, d) { return QNotify.notify.sukses(t, m, d); },
      gagal:            function(t, m, d) { return QNotify.notify.gagal(t, m, d); },
      peringatan:       function(t, m, d) { return QNotify.notify.peringatan(t, m, d); },
      informasi:        function(t, m, d) { return QNotify.notify.informasi(t, m, d); },

      // Dialog shortcuts
      confirm:          function(opts)    { return QNotify.dialog.confirm(opts); },
      holdConfirmAsync: function(opts)    { return QNotify.dialog.holdAsync(opts); },

      // Utility
      clearAll:         function()        { return QNotify.clearAll(); },
      dismiss:          function(id)      { return QNotify.dismiss(id); },
    };

    // Dispatch 'qnotify-ready' event — deterministic, exactly once
    // Consumers listen for this event to know QNotify is fully loaded.
    try {
      window.dispatchEvent(new Event('qnotify-ready'));
    } catch (_) {
      // Fallback for very old browsers (CustomEvent with no detail)
      try {
        var evt = document.createEvent('Event');
        evt.initEvent('qnotify-ready', true, true);
        window.dispatchEvent(evt);
      } catch (_) { /* give up silently */ }
    }
  }

  // Dynamic import — non-blocking, asynchronous, deterministic
  var qnotifyPath = _resolveQNotifyPath();

  // Use dynamic import() — returns a Promise
  // The browser loads QNotify asynchronously without blocking HTML parse.
  import(qnotifyPath)
    .then(function (module) {
      var QNotify = module.default || module;
      _installShims(QNotify);
    })
    .catch(function (err) {
      console.error('[qnotify-loader] Failed to load QNotify:', err);
      try {
        window.dispatchEvent(new CustomEvent('qnotify-error', {
          detail: { error: err.message || 'QNotify load failed' }
        }));
      } catch (_) { /* silent */ }
    });
} // end if (!__qnotifyLoaderStarted)
