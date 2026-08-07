// qnotify-loader.js — load QNotify via dynamic import(), install legacy shims
// (window.QNotify / window.show / window.notify), dispatch 'qnotify-ready' once.
// Must be loaded as <script type="module"> because it uses dynamic import().

if (window.__qnotifyLoaderStarted) {
  // Already loaded — skip
} else {
window.__qnotifyLoaderStarted = true;

  // Resolve relative path to public/QNotify/api/index.js based on page location.
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

  // Install legacy shims so the ~290 existing call sites keep working.
  function _installShims(QNotify) {
    window.QNotify = QNotify;
    window.show    = QNotify;

    window.notify = {
      success:          function(t, m, d) { return QNotify.notify.success(t, m, d); },
      error:            function(t, m, d) { return QNotify.notify.error(t, m, d); },
      warning:          function(t, m, d) { return QNotify.notify.warning(t, m, d); },
      info:             function(t, m, d) { return QNotify.notify.info(t, m, d); },

      sukses:           function(t, m, d) { return QNotify.notify.sukses(t, m, d); },
      gagal:            function(t, m, d) { return QNotify.notify.gagal(t, m, d); },
      peringatan:       function(t, m, d) { return QNotify.notify.peringatan(t, m, d); },
      informasi:        function(t, m, d) { return QNotify.notify.informasi(t, m, d); },

      confirm:          function(opts)    { return QNotify.dialog.confirm(opts); },
      holdConfirmAsync: function(opts)    { return QNotify.dialog.holdAsync(opts); },

      clearAll:         function()        { return QNotify.clearAll(); },
      dismiss:          function(id)      { return QNotify.dismiss(id); },
    };

    try {
      window.dispatchEvent(new Event('qnotify-ready'));
    } catch (_) {
      // Fallback for very old browsers
      try {
        var evt = document.createEvent('Event');
        evt.initEvent('qnotify-ready', true, true);
        window.dispatchEvent(evt);
      } catch (_) { /* give up silently */ }
    }
  }

  var qnotifyPath = _resolveQNotifyPath();

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
}
