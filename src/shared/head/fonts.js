// fonts.js — inject <link rel="preload"> for self-hosted woff2 fonts so the
// browser starts fetching them in parallel with HTML parsing.
//
// @font-face declarations are inlined in critical-css.js (no CSS roundtrip).
// @font-face alone only tells the browser "this font exists" — it doesn't
// trigger a fetch until text actually needs to render with it. <link
// rel="preload"> moves the fetch to the earliest possible moment, before
// HTML parsing even finishes.
//
// Font files (self-hosted, same origin → no DNS, no TLS):
//   public/fonts/plus-jakarta-sans-latin.woff2      (~27 KB)
//   public/fonts/plus-jakarta-sans-latin-ext.woff2  (~22 KB)
//   public/fonts/jetbrains-mono-latin.woff2         (~31 KB)

(function () {
  'use strict';

  // Mirrors critical-css.js BASE_PATH. Required so preload hints resolve
  // when AlbEdu is deployed at a subdirectory.
  var _computeBasePath = function () {
    var p = window.location.pathname;
    var base = p.substring(0, p.lastIndexOf('/') + 1);
    var APP_SUBFOLDERS = [
      '/pages/admin/pages/', '/pages/assessment/', '/pages/ujian/',
      '/pages/admin/', '/pages/', '/admin/pages/', '/ujian/', '/admin/',
    ];
    for (var i = 0; i < APP_SUBFOLDERS.length; i++) {
      var idx = base.indexOf(APP_SUBFOLDERS[i]);
      if (idx !== -1) return base.substring(0, idx + 1);
    }
    return base || '/';
  };
  var BASE_PATH = _computeBasePath();

  var FONTS = [
    BASE_PATH + 'public/fonts/plus-jakarta-sans-latin.woff2',
    BASE_PATH + 'public/fonts/plus-jakarta-sans-latin-ext.woff2',
    BASE_PATH + 'public/fonts/jetbrains-mono-latin.woff2',
  ];

  for (var i = 0; i < FONTS.length; i++) {
    var href = FONTS[i];

    var existing = document.querySelector(
      'link[rel="preload"][href="' + href + '"]'
    );
    if (existing) continue;

    var link = document.createElement('link');
    link.rel = 'preload';
    link.href = href;
    link.as = 'font';
    link.type = 'font/woff2';
    link.crossOrigin = 'anonymous';  // required for font preload
    document.head.appendChild(link);
  }
})();
