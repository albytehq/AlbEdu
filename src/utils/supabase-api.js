// =============================================================
//  SupabaseApi.js — AlbEdu Supabase Bridge v1.1.0
//
//  Drop-in replacement untuk FirebaseApi.js.
//
//  TUGAS (sama persis dengan FirebaseApi.js):
//    1. Ambil Supabase config dari Cloudflare Worker (/api/supabase-config)
//    2. Init Supabase client dengan config tersebut
//    3. Expose window.sb (Supabase native client)
//    4. Expose window.firebaseAuth, window.firebaseDb (Firestore-compatible shims)
//       → semua file lain (auth.js, security.js, dll) tidak perlu diubah dulu
//    5. Dispatch 'supabase-ready' DAN 'firebase-ready' saat siap
//       → 'firebase-ready' dipertahankan agar listener existing tidak perlu diubah
//    6. Dispatch 'firebase-error' jika gagal (sama seperti sebelumnya)
//
//  SHIM COVERAGE — semua Firestore API yang dipakai codebase ini:
//    collection(t).doc(id).get / set / update / delete / onSnapshot
//    collection(t).where(...).orderBy(...).limit(...).get / onSnapshot
//    collection(t).orderBy(...).get / onSnapshot
//    runTransaction(fn)
//    db.batch() → batch.delete / batch.commit
//    FieldValue.serverTimestamp()
//    FieldValue.arrayUnion(item)
//    auth.currentUser
//    auth.onAuthStateChanged(cb)
//    auth.signInWithPopup(provider)
//    auth.signOut()
//    firebase.auth.GoogleAuthProvider  (class stub untuk new GoogleAuthProvider())
//
//  REALTIME:
//    onSnapshot pada collection 'violations' pakai Supabase Realtime channel.
//    onSnapshot pada collection lain (ujian, users) emulate dengan polling
//    ringan — ujian tidak butuh sub-second sync; violations yang butuh realtime.
//
//  CATATAN MIGRASI:
//    File ini adalah fase pertama — compatibility layer.
//    Fase berikutnya: migrasi satu per satu file untuk pakai window.sb langsung.
// =============================================================

// Worker yang sama dengan upload/release — sekarang juga serve /api/supabase-config.
// Ganti nilai ini jika Worker URL berubah (custom domain, staging, dll).
const WORKER_BASE        = 'https://edu.albyte-inc.workers.dev';
const FETCH_RETRY_COUNT  = 3;
const FETCH_RETRY_DELAY  = 1_500; // ms — base delay, doubled each attempt

// Polling interval untuk onSnapshot non-realtime (ujian list, user profile).
// 8 detik cukup untuk admin panel yang tidak butuh sub-second update.
const SNAPSHOT_POLL_MS   = 8_000;

// Supabase Realtime hanya diaktifkan untuk tabel ini — yang butuh live update.
const REALTIME_TABLES    = new Set(['violations']);

// Flag global — sama dengan FirebaseApi.js agar semua file bisa cek ini
window.__firebaseReady = false;
window.__firebaseError = null;

// ── Bootstrap ─────────────────────────────────────────────────
;(async function initSupabaseApi() {
  try {
    const config = await _fetchSupabaseConfig();

    await _waitForSupabaseSDK();

    // Init Supabase client. window.supabase tersedia dari CDN.
    // Simpan di window.sb sebagai canonical global — lebih pendek, tidak clash.
    window.sb = supabase.createClient(config.url, config.anonKey, {
      auth: {
        // Persist session ke localStorage agar user tidak logout setiap refresh.
        // Sama dengan behavior Firebase Auth persistent default.
        persistSession:    true,
        autoRefreshToken:  true,
        // Supabase akan handle Google OAuth redirect & PKCE flow.
        detectSessionInUrl: true,
      },
      realtime: {
        // Hanya violations yang butuh realtime — matikan global untuk hemat quota.
        // Per-tabel diaktifkan saat onSnapshot dipanggil.
        params: { eventsPerSecond: 10 },
      },
    });

    // Pasang shim layer sebelum dispatch event —
    // jika ada listener yang langsung pakai window.firebaseDb setelah event, sudah siap.
    _installShims(window.sb, config.url, config.anonKey);

    window.__firebaseReady = true;

    // Online reconnect: saat device kembali online setelah offline,
    // dispatch event agar polling snapshot tahu untuk reset backoff dan segera fetch.
    window.addEventListener('online', () => {
      document.dispatchEvent(new CustomEvent('supabase-reconnected'));
    }, { passive: true });

    // Dispatch dua event: native baru + backward compat lama.
    // File yang sudah di-migrasi bisa listen 'supabase-ready'.
    // File lama tetap dengar 'firebase-ready' — keduanya fire bersamaan.
    document.dispatchEvent(new CustomEvent('supabase-ready', {
      detail: { sb: window.sb },
    }));
    document.dispatchEvent(new CustomEvent('firebase-ready', {
      detail: {
        auth: window.firebaseAuth,
        db:   window.firebaseDb,
        sb:   window.sb,
      },
    }));

  } catch (err) {
    window.__firebaseError = err.message;
    _installFallbackShims();
    document.dispatchEvent(new CustomEvent('firebase-error', {
      detail: { error: err.message },
    }));
  }
})();

// ── Fetch Supabase config dari Vercel ──────────────────────────
// Endpoint yang sama dengan firebase-config — tinggal tambah endpoint baru
// Endpoint /api/supabase-config di Cloudflare Worker membaca SUPABASE_URL
// dan SUPABASE_ANON_KEY dari Worker secrets — tidak pernah hardcode di sini.
//
// Shape yang diharapkan: { url: "https://xxx.supabase.co", anonKey: "eyJ..." }
//
// Cache strategy: simpan di sessionStorage selama 1 jam (sama dengan
// Cache-Control Worker). Saat Worker cold-start atau flaky CDN, kita tetap
// bisa boot dari cache daripada gagal total.
const _CONFIG_CACHE_KEY = 'albedu_sb_config';
const _CONFIG_CACHE_TTL = 60 * 60 * 1000; // 1 jam

function _readConfigCache() {
  try {
    const raw = sessionStorage.getItem(_CONFIG_CACHE_KEY);
    if (!raw) return null;
    const { ts, config } = JSON.parse(raw);
    if (Date.now() - ts > _CONFIG_CACHE_TTL) { sessionStorage.removeItem(_CONFIG_CACHE_KEY); return null; }
    if (!config?.url || !config?.anonKey) return null;
    return config;
  } catch (_) { return null; }
}

function _writeConfigCache(config) {
  try { sessionStorage.setItem(_CONFIG_CACHE_KEY, JSON.stringify({ ts: Date.now(), config })); } catch (_) {}
}

async function _fetchSupabaseConfig(retryLeft = FETCH_RETRY_COUNT) {
  // Fast path: gunakan cache jika masih segar — hindari fetch ke Worker di setiap page load
  const cached = _readConfigCache();
  if (cached) return cached;

  const url = `${WORKER_BASE}/api/supabase-config`;

  try {
    const res = await fetch(url, {
      method:  'GET',
      headers: { 'Content-Type': 'application/json' },
      cache:   'default', // browser cache — tidak perlu fetch tiap page load
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const config = await res.json();

    // Shape check — gagal cepat daripada crash saat createClient
    if (!config.url || !config.anonKey) {
      throw new Error('Supabase config tidak lengkap dari server (butuh url + anonKey).');
    }

    // Cache berhasil — page load berikutnya langsung boot tanpa fetch
    _writeConfigCache(config);
    return config;

  } catch (err) {
    if (retryLeft > 0) {
      // Exponential backoff: 1.5s → 3s → 6s — jangan hammer Worker saat down
      const delay = FETCH_RETRY_DELAY * Math.pow(2, FETCH_RETRY_COUNT - retryLeft);
      await new Promise(r => setTimeout(r, delay));
      return _fetchSupabaseConfig(retryLeft - 1);
    }
    // Last resort: coba cache meskipun expired daripada gagal total
    const staleCache = (() => {
      try {
        const raw = sessionStorage.getItem(_CONFIG_CACHE_KEY);
        if (!raw) return null;
        const { config } = JSON.parse(raw);
        return (config?.url && config?.anonKey) ? config : null;
      } catch (_) { return null; }
    })();
    if (staleCache) {
      console.warn('[SupabaseApi] Worker tidak bisa dijangkau — menggunakan config cache lama');
      return staleCache;
    }
    throw new Error(`Gagal ambil Supabase config: ${err.message}`);
  }
}

// ── Tunggu Supabase SDK dari CDN ───────────────────────────────
// CDN: <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js">
function _waitForSupabaseSDK(timeout = 10_000) {
  return new Promise((resolve, reject) => {
    // Fast path — SDK sudah ada (script dimuat sebelum file ini)
    if (typeof supabase !== 'undefined' && supabase.createClient) return resolve();

    const interval = setInterval(() => {
      if (typeof supabase !== 'undefined' && supabase.createClient) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 100);

    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(
        'Supabase SDK tidak dimuat dalam 10 detik. ' +
        'Pastikan <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/..."> ada di HTML.'
      ));
    }, timeout);
  });
}

// ── Install shim layer ─────────────────────────────────────────
//
// Ini adalah jantung dari compatibility strategy:
// buat window.firebaseDb dan window.firebaseAuth yang expose
// Firestore-shaped API, tapi di balik layar pakai Supabase.
//
// Lalu expose alias backward-compat (window.auth, window.db)
// sama persis dengan apa yang FirebaseApi.js lakukan.
function _installShims(sb, supabaseUrl, anonKey) {
  window.firebaseAuth = _buildAuthShim(sb);
  window.firebaseDb   = _buildDbShim(sb);

  // backward compat — auth.js dan file lain pakai nama pendek ini juga
  window.auth = window.firebaseAuth;
  window.db   = window.firebaseDb;

  // Stub global 'firebase' object yang dipakai langsung di beberapa file
  // (wizard-controller.js: firebase.auth().currentUser, firebase.firestore.FieldValue, dll)
  window.firebase = _buildFirebaseStub(sb);
}

// ── Auth Shim ──────────────────────────────────────────────────
//
// Emulate Firebase Auth API yang dipakai codebase ini:
//   - onAuthStateChanged(callback)
//   - signInWithPopup(provider)     ← Google OAuth via Supabase
//   - signOut()
//   - currentUser                   ← getter, sync
//
// Supabase auth events pakai onAuthStateChange — kita bridge ke callback style Firebase.
function _buildAuthShim(sb) {
  // Cache currentUser sync — diisi saat onAuthStateChange fires
  let _currentUser = null;
  const _listeners = new Set();

  // Normalisasi Supabase session ke shape yang mirip Firebase User
  function _toFirebaseUser(session) {
    if (!session?.user) return null;
    const u = session.user;
    return {
      uid:         u.id,
      email:       u.email || '',
      displayName: u.user_metadata?.full_name || u.user_metadata?.name || '',
      photoURL:    u.user_metadata?.avatar_url || null,
      // Expose raw Supabase user juga — file yang sudah di-migrasi bisa pakai ini
      _supabaseUser: u,
    };
  }

  // Track apakah onAuthStateChange sudah fire minimal sekali.
  // Dipakai untuk mencegah getSession() fire listeners duplikat
  // jika onAuthStateChange sudah handle session yang sama.
  let _authEventFired = false;
  let _sessionResolved = false;

  // Subscribe ke Supabase auth state changes.
  // onAuthStateChange adalah source of truth — ini yang kita andalkan.
  // Fires: SIGNED_IN (termasuk dari OAuth redirect token), SIGNED_OUT, TOKEN_REFRESHED.
  sb.auth.onAuthStateChange((_event, session) => {
    _authEventFired = true;
    _currentUser = _toFirebaseUser(session);
    _listeners.forEach(cb => {
      try { cb(_currentUser); } catch (_) {}
    });
  });

  // getSession() sebagai fallback HANYA jika onAuthStateChange belum fire.
  // WHY: saat user refresh halaman dengan session aktif, onAuthStateChange
  // mungkin fire lebih lambat dari DOMContentLoaded. getSession() handle gap itu.
  // Tapi jika ada token OAuth di URL, onAuthStateChange akan fire SIGNED_IN —
  // kita tidak mau getSession() fire null dulu dan interrupt flow itu.
  //
  // FIX v0.9.1: Jika getSession() return null DAN ada OAuth code/token di URL,
  // berarti Supabase masih proses PKCE exchange — jangan notify listeners dengan null.
  // onAuthStateChange akan fire SIGNED_IN setelah exchange selesai.
  const _hasOAuthParams = () =>
    window.location.search.includes('code=') ||
    window.location.hash.includes('access_token=');

  sb.auth.getSession().then(({ data }) => {
    _sessionResolved = true;
    // Hanya notify listeners jika onAuthStateChange belum fire sama sekali.
    // Jika sudah fire, onAuthStateChange sudah handle state dengan benar.
    if (!_authEventFired) {
      // Guard: jika session null tapi ada OAuth params di URL, tunggu
      // onAuthStateChange yang akan handle exchange — jangan interrupt dengan null.
      if (!data?.session && _hasOAuthParams()) return;

      _currentUser = _toFirebaseUser(data?.session);
      _listeners.forEach(cb => {
        try { cb(_currentUser); } catch (_) {}
      });
    }
  });

  return {
    get currentUser() { return _currentUser; },

    // Daftarkan listener — returns unsubscribe function (sama dengan Firebase)
    onAuthStateChanged(callback) {
      _listeners.add(callback);

      // WHY delay 100ms bukan microtask:
      // Promise.resolve() (microtask) fire sebelum getSession() dan onAuthStateChange
      // settle — callback dapat _currentUser = null, yang trigger cabang logout
      // di _handleAuthStateChange dan interrupt OAuth redirect flow.
      // 100ms memberi waktu onAuthStateChange atau getSession() settle dulu.
      // Jika keduanya sudah resolve (_authEventFired || _sessionResolved),
      // fire segera dengan state yang sudah benar.
      //
      // FIX v0.9.1: Saat ada OAuth code di URL (post-redirect dari Google),
      // Supabase butuh lebih lama untuk exchange PKCE code jadi session.
      // Naikkan delay ke 500ms agar onAuthStateChange sempat fire SIGNED_IN
      // sebelum callback ini jalan — mencegah flash error 'reading user' di login page.
      const _oauthDelay = _hasOAuthParams() ? 500 : 100;
      setTimeout(() => {
        try { callback(_currentUser); } catch (_) {}
      }, _authEventFired || _sessionResolved ? 0 : _oauthDelay);

      // Return unsubscribe function
      return () => _listeners.delete(callback);
    },

    // Google OAuth via Supabase — pakai signInWithOAuth, bukan popup
    // Supabase tidak support popup mode natively; redirect adalah cara standar.
    // WHY: Firebase Auth popup bisa diblokir browser juga, redirect lebih reliable.
    async signInWithPopup(_provider) {
      // Determine the correct redirect URL based on current page.
      // Users start from index.html (peserta) or login.html (admin) — return them
      // to whichever page initiated the flow so onAuthStateChanged can route by role.
      const _resolveRedirectUrl = () => {
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          return window.location.href;
        }
        // Derive BASE_PATH from current pathname (same logic as auth.js)
        // v0.742.2: sync subfolder list with src/auth/main.js — added
        // `/pages/` family so BASE_PATH is consistent everywhere.
        const p = window.location.pathname;
        const base = p.substring(0, p.lastIndexOf('/') + 1);
        const subfolders = ['/pages/admin/pages/', '/pages/assessment/', '/pages/admin/', '/pages/ujian/', '/pages/', '/admin/pages/', '/ujian/', '/admin/'];
        let basePath = base || '/';
        for (const sub of subfolders) {
          const idx = base.indexOf(sub);
          if (idx !== -1) { basePath = base.substring(0, idx + 1); break; }
        }
        // Return to the page the user was actually on — Supabase needs
        // this exact URL registered in its allowed redirect URLs.
        return window.location.origin + window.location.pathname;
      };

      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: _resolveRedirectUrl(),
          queryParams: { access_type: 'offline', prompt: 'select_account' },
        },
      });

      if (error) {
        // BUGFIX G: Removed dead Firebase-style error mapping.
        // Supabase signInWithOAuth uses redirect mode and never returns
        // 'popup_closed_by_user' or 'access_denied' -- those were Firebase
        // popup-mode error codes. Just pass through the real Supabase error.
        throw new Error(error.message || 'Login Google gagal.');
      }

      // signInWithOAuth redirect — tidak ada return value langsung.
      // onAuthStateChange akan fire saat user kembali dari Google.
      return null;
    },

    async signOut() {
      const { error } = await sb.auth.signOut();
      if (error) throw new Error(error.message);
    },
  };
}

// ── Firestore DB Shim ──────────────────────────────────────────
//
// Emulate Firestore chained query API:
//   db.collection('assessments').doc('abc').get()
//   db.collection('assessments').orderBy('created_at', 'desc').onSnapshot(cb)
//   db.collection('violation_events').where('access_code', '==', 'X').get()
//   db.runTransaction(fn)
//   db.batch()
//   db.FieldValue.serverTimestamp()
//   db.FieldValue.arrayUnion(item)
//
// Di balik layar semua translate ke Supabase .from(table) query.
// onSnapshot: violation_events pakai Supabase Realtime; tabel lain polling.
function _buildDbShim(sb) {
  // Track active Realtime channels agar bisa unsubscribe
  const _channels = new Map();

  // ── Special values yang tidak jalan di-serialize ───────────────
  // Dipakai sebagai sentinel saat build payload, lalu di-resolve saat write.
  const _SENTINEL_TIMESTAMP = Symbol('serverTimestamp');
  const _SENTINEL_ARRAY_UNION = (item) => ({ __arrayUnion: true, item });

  // ── camelCase → snake_case translation layer ──────────────────
  // WHY: auth.js (dan file Firestore-era lain) masih pakai camelCase field names.
  // Supabase schema pakai snake_case. Daripada ubah semua caller sekarang,
  // kita translate otomatis di sini — compatibility-first, migrate caller nanti.
  //
  // Contoh: createdAt → created_at, profilLengkap → profil_lengkap
  //
  // Rule: konversi hanya key-level string. Value tidak disentuh kecuali
  // value itu sendiri object (recurse). Array of objects juga di-translate.
  //
  // SKIP list: key yang sudah snake_case atau yang sengaja dibiarkan apa adanya.
  // Kita tidak perlu skip list explicit — algoritma idempoten:
  //   snake_case → snake_case (tidak berubah, karena tidak ada uppercase)
  //   camelCase  → snake_case (dikonversi)
  //   __arrayUnion_xxx → dipreserve (prefix __ tidak disentuh)

  function _toSnakeCase(str) {
    // Preserve internal sentinel prefix (__arrayUnion_fieldName)
    if (str.startsWith('__')) return str;

    return str
      // "createdAt"    → "created_At"  → "created_at"
      // "profilLengkap" → "profil_Lengkap" → "profil_lengkap"
      // "updatedAt"    → "updated_at"
      // Already snake_case like "profil_lengkap" → tidak berubah (no uppercase)
      .replace(/([A-Z])/g, '_$1')
      .toLowerCase()
      // Edge case: jika string sudah mulai dengan underscore ganda dari replace,
      // strip leading underscore yang tidak diinginkan (e.g. "_myField" → "my_field")
      .replace(/^_/, '');
  }

  // Translate semua keys dalam object secara rekursif.
  // Value dibiarkan apa adanya kecuali value itu object/array of objects.
  function _translateKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Array: translate tiap element jika element adalah object
    if (Array.isArray(obj)) {
      return obj.map(item =>
        (item && typeof item === 'object') ? _translateKeys(item) : item
      );
    }

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const snakeKey = _toSnakeCase(k);
      if (v && typeof v === 'object' && !Array.isArray(v)
          && v !== _SENTINEL_TIMESTAMP
          && !v.__arrayUnion) {
        // Recurse untuk nested object — tapi BUKAN sentinel values
        out[snakeKey] = _translateKeys(v);
      } else if (Array.isArray(v)) {
        out[snakeKey] = _translateKeys(v);
      } else {
        out[snakeKey] = v;
      }
    }
    return out;
  }

  // Resolve sentinel values ke nilai konkret sebelum dikirim ke Supabase.
  // _translateKeys dipanggil PERTAMA agar semua key sudah snake_case
  // sebelum sentinel-check berjalan — urutan ini penting.
  function _resolvePayload(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Step 1: translate semua camelCase keys → snake_case
    const translated = _translateKeys(obj);

    // Step 2: resolve sentinel values pada keys yang sudah di-translate
    const out = {};
    for (const [k, v] of Object.entries(translated)) {
      if (v === _SENTINEL_TIMESTAMP) {
        // Supabase pakai ISO string untuk timestamp di REST API.
        // Server-side: pakai now(). Di client, ISO sudah cukup akurat.
        out[k] = new Date().toISOString();
      } else if (v && typeof v === 'object' && v.__arrayUnion) {
        // arrayUnion → kita handle dengan fetch dulu lalu merge di client.
        // Flag ini di-strip dari payload; caller yang pakai arrayUnion
        // harus lewat _doArrayUnion helper.
        out[`__arrayUnion_${k}`] = v.item;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = v; // sudah di-translate dan di-resolve oleh _translateKeys di atas
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  // Pisahkan arrayUnion fields dari payload biasa
  function _splitArrayUnions(raw) {
    const payload    = {};
    const arrayUnions = {}; // fieldName → item to append

    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('__arrayUnion_')) {
        arrayUnions[k.slice('__arrayUnion_'.length)] = v;
      } else {
        payload[k] = v;
      }
    }
    return { payload, arrayUnions };
  }

  // ── Dot-notation expander ─────────────────────────────────────────
  // WHY this is needed:
  //   Firestore .update() accepts dot-notation paths to surgically patch
  //   nested fields without replacing the whole document:
  //     { "access_control.mode": "manual", "access_control.manual_status": "closed" }
  //
  //   Supabase/PostgREST treats every top-level key as a column name.
  //   Sending "access_control.mode" as a key → Postgres looks for a
  //   column literally named "access_control.mode" → throws:
  //     "Could not find the 'access_control.mode' column"
  //
  //   The fix: expand dot-notation keys into nested objects BEFORE
  //   _resolvePayload() (and _translateKeys() inside it) run.
  //   _translateKeys() then snake_cases the expanded keys normally.
  //
  //   Pipeline for _docRef.update():
  //     rawData
  //       → _expandDotNotation()   ← this function (dot paths → nested obj)
  //       → _resolvePayload()      ← camelCase→snake_case + sentinel resolve
  //       → _splitArrayUnions()    ← separate arrayUnion fields
  //       → sb.from(table).update()
  //
  // Behaviour:
  //   • Keys without a dot pass through completely unchanged.
  //   • Keys with a dot are split on '.' and built into a nested object.
  //   • Multiple dot-paths sharing the same top-level key are deep-merged,
  //     so { "a.b": 1, "a.c": 2 } → { a: { b: 1, c: 2 } } — not { a: { c: 2 } }.
  //   • Arbitrary depth is supported (a.b.c.d), though current callers only
  //     use single-level nesting (access_control.mode, ujian.judul, etc.).
  //   • Only keys are expanded — values are never touched here.
  function _expandDotNotation(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

    const out = {};

    for (const [key, value] of Object.entries(payload)) {
      if (!key.includes('.')) {
        // Flat key — no expansion. If a nested object already occupies this
        // slot (from a prior dot-path in the same payload), shallow-merge
        // rather than clobber, so mixed payloads stay consistent.
        if (out[key] !== undefined && out[key] !== null && typeof out[key] === 'object'
            && !Array.isArray(out[key]) && typeof value === 'object' && value !== null
            && !Array.isArray(value)) {
          Object.assign(out[key], value);
        } else {
          out[key] = value;
        }
        continue;
      }

      // Dot-notation path: split and walk/build the nested structure.
      // "access_control.mode"         → out.access_control.mode
      // "access_control.scheduled.start" → out.access_control.scheduled.start
      const parts  = key.split('.');
      let   cursor = out;

      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        // If an intermediate node doesn't exist yet, or was overwritten by a
        // flat value, create a fresh object. Never clobber an existing object.
        if (cursor[part] === undefined || cursor[part] === null
            || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
          cursor[part] = {};
        }
        cursor = cursor[part];
      }

      cursor[parts[parts.length - 1]] = value;
    }

    return out;
  }

  // ── Row ID normalization ────────────────────────────────────────
  // Firestore pakai string doc ID; Supabase PK bisa UUID atau string.
  // users table: id = auth.uid (UUID dari Supabase Auth)
  // ujian table:  id = kode_id (string, e.g. "U-ABCD-1234")
  // violations:   id = token_userKey (string, buat dari _docId)
  //
  // Kita map Firestore .doc(id) ke Supabase .eq('id', id) untuk semua tabel.

  // ── snake_case → camelCase reverse translation (READ path) ──────
  // Mirror dari _toSnakeCase/_translateKeys di write path.
  // Supabase returns snake_case columns; Firestore-era callers expect camelCase.
  //
  // Idempoten sama seperti write path:
  //   already_camel → alreadyCamel (converted)
  //   alreadyCamel  → alreadyCamel (no underscore → unchanged)
  //
  // Fields yang TIDAK disentuh:
  //   - 'id' (primary key — dibiarkan di luar data() anyway)
  //   - keys tanpa underscore (sudah camelCase atau single-word)
  //   - value tidak disentuh, hanya keys

  function _toCamelCase(str) {
    // fast path — no underscore means nothing to convert
    if (!str.includes('_')) return str;

    return str.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
    // e.g. profil_lengkap → profilLengkap
    //      created_at     → createdAt
    //      updated_at     → updatedAt
    //      foto_profil    → fotoProfil
    //      violation_events → violationEvents
  }

  // Rekursif — nested objects dan array of objects ikut di-translate.
  function _untranslateKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    if (Array.isArray(obj)) {
      return obj.map(item =>
        (item && typeof item === 'object') ? _untranslateKeys(item) : item
      );
    }

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const camelKey = _toCamelCase(k);
      let normalized;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        normalized = _untranslateKeys(v);
      } else if (Array.isArray(v)) {
        normalized = _untranslateKeys(v);
      } else {
        normalized = v;
      }

      // Preserve Firestore-era / DB key first, then add a camelCase alias.
      out[k] = normalized;
      if (camelKey !== k && out[camelKey] === undefined) {
        out[camelKey] = normalized;
      }
    }
    return out;
  }

  function _firstDefined(...values) {
    return values.find(v => v !== undefined && v !== null);
  }

  // Runtime code should read ujian.{judul,mata_pelajaran,kelas}; top-level
  // summary columns stay mirrored for older rows and fast listing queries.
  function _normalizeExamRecord(data) {
    if (!data || typeof data !== 'object') return data;

    const ujian = (data.ujian && typeof data.ujian === 'object' && !Array.isArray(data.ujian))
      ? _translateKeys(data.ujian)
      : {};
    const normalized = { ...data, ujian };

    // Recover old cached payloads produced by the earlier read translator,
    // which exposed accessControl/manualStatus but dropped access_control.
    if (!normalized.access_control && normalized.accessControl) {
      normalized.access_control = _translateKeys(normalized.accessControl);
    }

    ['judul', 'mata_pelajaran', 'kelas'].forEach((field) => {
      const camelField = _toCamelCase(field);
      const value = _firstDefined(
        ujian[field],
        ujian[camelField],
        normalized[field],
        normalized[camelField]
      );

      if (value === undefined) return;

      ujian[field] = value;
      normalized[field] = value;

      if (camelField !== field) {
        if (ujian[camelField] === undefined) ujian[camelField] = value;
        if (normalized[camelField] === undefined) normalized[camelField] = value;
      }
    });

    // Bridge: Supabase column p_q → runtime key PQ.
    // _toCamelCase('p_q') produces 'pQ' (not 'PQ') because the regex only
    // upcases the single letter immediately after an underscore.  All exam
    // runtime consumers (ExamLogic, ujian-peserta, ExamData._isValidExamData)
    // read exam.PQ, so we must promote whichever casing arrived to the
    // canonical PQ key.  Guard with !normalized.PQ so this is a no-op for
    // any future rows that already carry the correct key.
    if (!normalized.PQ) {
      normalized.PQ = normalized.pQ ?? normalized.p_q ?? null;
    }

    return normalized;
  }

  function _getExamMeta(data) {
    return _normalizeExamRecord(data)?.ujian || {};
  }

  // Shared accessor so every reader merges legacy flat + nested values the
  // same way instead of growing one-off fallback chains.
  window.ExamRecordCompat = {
    normalize: _normalizeExamRecord,
    getMeta:   _getExamMeta,
  };

  // ── Snapshot normalization ─────────────────────────────────────
  // Firestore DocumentSnapshot shape: { exists, data(), id }
  // Firestore QuerySnapshot shape: { forEach(cb), docs: [{id, data(), exists}], docChanges() }
  function _toDocSnap(row, table) {
    if (!row) return { exists: false, id: null, data: () => null };
    const idCol   = _identityCol(table);
    const snapId  = String(row[idCol] ?? row.id ?? '');
    return {
      exists: true,
      id: snapId,
      data: () => {
        // Strip UUID PK 'id' dari data() — Firestore-era callers tidak expect ini.
        // Identity column (kode_id untuk ujian) tetap masuk data() karena
        // Firestore-era code mungkin baca doc.data().kodeId untuk display.
        const { id, ...rest } = row;
        const normalized = _untranslateKeys(rest);
        return table === 'ujian' ? _normalizeExamRecord(normalized) : normalized;
      },
      _raw: row,
    };
  }

  function _toQuerySnap(rows, table, prevRows) {
    const docs = (rows || []).map(r => _toDocSnap(r, table));

    // docChanges() — dibutuhkan oleh AdminNotificationCenter.js
    // Untuk non-realtime (polling), kita diff dengan snapshot sebelumnya
    let changes = [];
    if (prevRows) {
      const prevIds = new Set(prevRows.map(r => String(r.id)));
      const currIds = new Set((rows || []).map(r => String(r.id)));

      changes = [
        ...(rows || []).map(r => ({
          type: prevIds.has(String(r.id)) ? 'modified' : 'added',
          doc:  _toDocSnap(r, table),
        })),
        ...(prevRows || [])
          .filter(r => !currIds.has(String(r.id)))
          .map(r => ({ type: 'removed', doc: _toDocSnap(r, table) })),
      ];
    } else {
      // First snapshot — semua dianggap 'added'
      changes = docs.map(d => ({ type: 'added', doc: d }));
    }

    return {
      docs,
      forEach: (cb) => docs.forEach(cb),
      docChanges: () => changes,
      empty: docs.length === 0,
      size:  docs.length,
    };
  }

  // ── Collection identity mapping ────────────────────────────────
  //
  // WHY ini diperlukan:
  //   Firestore menggunakan document ID sebagai identity. Supabase punya UUID
  //   internal PK, tapi legacy code Firestore-era memakai kode_id sebagai doc ID
  //   untuk koleksi 'ujian' (contoh: '63938', bukan UUID).
  //
  //   Tanpa mapping ini, .doc('63938') menghasilkan:
  //     WHERE id = '63938'  ← invalid, id kolom adalah UUID
  //   Dengan mapping:
  //     WHERE kode_id = '63938'  ← benar
  //
  //   users pakai 'id' karena doc ID mereka adalah UUID dari Supabase Auth.
  //   violations pakai 'doc_id' — kolom text UNIQUE untuk composite string
  //   (token_userKey). Kolom 'id' tetap UUID PK internal Postgres.
  //
  // Tambahkan collection baru di sini jika ada tabel dengan identity non-UUID.
  const COLLECTION_IDENTITY = {
    ujian:      'kode_id', // doc ID = kode ujian (string), bukan UUID
    users:      'id',      // doc ID = auth.uid (UUID)
    violations: 'doc_id',  // doc ID = composite string (token_userKey), bukan UUID
  };

  // Kembalikan nama kolom yang dipakai sebagai identity untuk .doc(id) lookup.
  // Default ke 'id' jika tabel tidak ada di map — aman untuk tabel baru.
  function _identityCol(table) {
    return COLLECTION_IDENTITY[table] ?? 'id';
  }

  // ── Doc reference ──────────────────────────────────────────────
  function _docRef(table, docId) {
    return {
      // --- READ ---
      async get() {
        const idCol = _identityCol(table);
        const { data, error } = await sb
          .from(table)
          .select('*')
          .eq(idCol, docId)
          .maybeSingle();

        if (error) throw new Error(`[Supabase] ${table}.get(${docId}): ${error.message}`);
        return _toDocSnap(data, table);
      },

      // --- WRITE (set) ---
      // options.merge → upsert; tanpa merge → insert atau replace
      async set(rawData, options = {}) {
        const resolved = _resolvePayload(rawData);
        const { payload, arrayUnions } = _splitArrayUnions(resolved);

        // Selalu sertakan identity column agar upsert bisa match
        const idCol = _identityCol(table);
        const row = { [idCol]: docId, ...payload };

        if (options.merge) {
          // WHY upsert FIRST:
          // _applyArrayUnions does UPDATE, not UPSERT. On first violation write
          // the row does not exist yet — PostgREST UPDATE on a non-existent row
          // is a silent no-op (200 OK, 0 rows affected, no error returned).
          // The violation_events array would be permanently lost for that write.
          // Upsert creates/updates the row first; _applyArrayUnions can then
          // safely UPDATE the now-guaranteed-existing row.
          const { error } = await sb
            .from(table)
            .upsert(row, { onConflict: idCol });
          if (error) throw new Error(`[Supabase] ${table}.set(merge): ${error.message}`);
          if (Object.keys(arrayUnions).length > 0) {
            await _applyArrayUnions(table, docId, arrayUnions);
          }
        } else {
          const { error } = await sb
            .from(table)
            .upsert(row, { onConflict: idCol });
          if (error) throw new Error(`[Supabase] ${table}.set: ${error.message}`);
        }
      },

      // --- WRITE (update) ---
      // Hanya update field yang diberikan, tidak replace seluruh row.
      //
      // JSONB MERGE STRATEGY:
      //   Supabase/PostgREST's .update() REPLACES the entire JSONB column value.
      //   So if access_control = { mode, manual_status, end, scheduled, ... }
      //   and we send { access_control: { mode: 'manual' } }, PostgREST will
      //   REPLACE the whole column with { mode: 'manual' } — losing end, scheduled, etc.
      //
      //   The fix: detect which top-level keys are nested objects (from dot-notation
      //   expansion), fetch the current row, deep-merge those JSONB columns, then
      //   send the merged result. Flat scalar keys are sent as-is — no fetch needed.
      //
      //   Pipeline:
      //     rawData
      //       → _expandDotNotation()   — "a.b": v  →  { a: { b: v } }
      //       → _resolvePayload()      — camelCase→snake_case + sentinel resolve
      //       → _splitArrayUnions()    — separate arrayUnion ops
      //       → _mergeJsonbColumns()   — fetch current row, deep-merge JSONB fields
      //       → sb.from(table).update()
      async update(rawData) {
        // Step 1 — Identify which keys originally had dot-notation (they'll become
        // nested objects after expansion and need JSONB merge). Collect them before
        // expansion so we know which top-level keys to deep-merge later.
        const dotKeys = new Set(
          Object.keys(rawData)
            .filter(k => k.includes('.'))
            .map(k => _toSnakeCase(k.split('.')[0]))
        );

        // Step 2 — Expand dot-notation, translate keys, resolve sentinels.
        const expanded = _expandDotNotation(rawData);
        const resolved = _resolvePayload(expanded);
        const { payload, arrayUnions } = _splitArrayUnions(resolved);

        if (Object.keys(arrayUnions).length > 0) {
          await _applyArrayUnions(table, docId, arrayUnions);
        }

        if (Object.keys(payload).length === 0) return;

        // Step 3 — JSONB deep-merge for any column that was a dot-notation target.
        // These columns need a fetch-then-merge because Supabase .update() replaces
        // the whole column value — it does NOT do a partial field patch inside JSONB.
        const jsonbKeys = Object.keys(payload).filter(k => dotKeys.has(k) && payload[k] !== null && typeof payload[k] === 'object' && !Array.isArray(payload[k]));

        if (jsonbKeys.length > 0) {
          // Fetch the current row to get existing JSONB column values.
          const idCol = _identityCol(table);
          const { data: currentRow, error: fetchErr } = await sb
            .from(table)
            .select(jsonbKeys.join(','))
            .eq(idCol, docId)
            .maybeSingle();

          if (fetchErr) throw new Error(`[Supabase] ${table}.update fetch for merge: ${fetchErr.message}`);

          // Deep-merge: existing JSONB column value ← patch from dot-notation keys.
          // WHY Object.assign and not spread: we only want one level of merge.
          // Firestore dot-notation only patches specific paths, not replaces objects.
          if (currentRow) {
            for (const col of jsonbKeys) {
              const existing = (currentRow[col] && typeof currentRow[col] === 'object' && !Array.isArray(currentRow[col]))
                ? currentRow[col]
                : {};
              // Merge: existing fields survive, patch fields override.
              payload[col] = Object.assign({}, existing, payload[col]);
            }
          }
          // If currentRow is null (doc doesn't exist yet), payload[col] stays as-is —
          // the update will fail anyway because there's nothing to update, which is correct.
        }

        const { error } = await sb
          .from(table)
          .update(payload)
          .eq(_identityCol(table), docId);

        if (error) throw new Error(`[Supabase] ${table}.update: ${error.message}`);
      },

      // --- DELETE ---
      async delete() {
        const { error } = await sb
          .from(table)
          .delete()
          .eq(_identityCol(table), docId);

        if (error) throw new Error(`[Supabase] ${table}.delete: ${error.message}`);
      },

      // --- REALTIME (onSnapshot) ---
      // violations pakai Supabase Realtime channel.
      // Tabel lain pakai polling karena tidak butuh sub-second sync.
      onSnapshot(onNext, onError) {
        if (REALTIME_TABLES.has(table)) {
          return _realtimeDocSnapshot(table, docId, onNext, onError);
        }
        return _pollingDocSnapshot(table, docId, onNext, onError);
      },
    };
  }

  // ── Collection reference builder ───────────────────────────────
  // Returns chainable object yang accumulate filter/orderBy/limit
  // sebelum .get() atau .onSnapshot() dipanggil.
  function _collectionRef(table) {
    // State untuk chained calls
    const _filters  = []; // [{ col, op, val }]
    let   _orderBy  = null; // { col, dir }
    let   _limitN   = null; // number

    // Firestore operator → Supabase PostgREST operator map
    const OP_MAP = {
      '==':                'eq',
      '!=':                'neq',
      '<':                 'lt',
      '<=':                'lte',
      '>':                 'gt',
      '>=':                'gte',
      'array-contains':    null, // handled specially → Supabase .contains()
      'in':                'in',
    };

    function _buildQuery() {
      let q = sb.from(table).select('*');

      for (const f of _filters) {
        // WHY translate col: caller pakai camelCase (createdAt, kodeId, dll).
        // Supabase schema pakai snake_case. Tanpa translate, filter tidak match.
        const col = _toSnakeCase(f.col);
        const op  = OP_MAP[f.op];
        if (f.op === 'array-contains') {
          q = q.contains(col, [f.val]);
        } else if (op) {
          // v0.742.5 FIX: NULL comparisons must use .is() / .not.is(),
          // NOT .eq() / .neq(). PostgREST translates .eq(col, null) to
          // ?col=eq.null — the STRING "null", not SQL NULL — which causes
          // HTTP 400 "invalid input syntax for type timestamp with time
          // zone: 'null'" on timestamptz columns.
          if (f.val === null) {
            if (f.op === '==')      q = q.is(col, null);
            else if (f.op === '!=') q = q.not.is(col, null);
            else                    q = q[op](col, f.val); // <, <=, >, >= with null → no-op
          } else {
            q = q[op](col, f.val);
          }
        }
      }

      if (_orderBy) {
        // WHY translate: orderBy('createdAt') → order=created_at.asc
        // Tanpa ini → order=createdAt.asc → Supabase error column not found
        const col = _toSnakeCase(_orderBy.col);
        q = q.order(col, { ascending: _orderBy.dir !== 'desc' });
      }

      if (_limitN) {
        q = q.limit(_limitN);
      }

      return q;
    }

    const ref = {
      // ── Chaining ──────────────────────────────────────────────
      where(col, op, val) {
        _filters.push({ col, op, val });
        return ref; // chainable
      },

      orderBy(col, dir = 'asc') {
        _orderBy = { col, dir };
        return ref;
      },

      limit(n) {
        _limitN = n;
        return ref;
      },

      // ── doc(id) shortcut ──────────────────────────────────────
      doc(id) {
        return _docRef(table, id);
      },

      // ── READ ──────────────────────────────────────────────────
      async get() {
        const { data, error } = await _buildQuery();
        if (error) throw new Error(`[Supabase] ${table}.get: ${error.message}`);
        return _toQuerySnap(data, table, null);
      },

      // ── INSERT (v0.742.5) ───────────────────────────────────
      // Firestore's collection.add(doc) ≈ Supabase's from(table).insert(doc).
      // Returns a doc-ref-like object with .id + .get() for parity.
      // Previously .add() was not implemented on the shim, so callers
      // (e.g. consent.js v1.0.0) threw "db.collection(...).add is not a
      // function". Now implemented as a thin wrapper.
      async add(doc) {
        const insertPayload = _translateKeys(doc);
        const { data, error } = await sb.from(table).insert(insertPayload).select().single();
        if (error) throw new Error(`[Supabase] ${table}.add: ${error.message}`);
        return _docRef(table, data?.id ?? null);
      },

      // ── REALTIME / POLLING ────────────────────────────────────
      onSnapshot(onNext, onError) {
        if (REALTIME_TABLES.has(table)) {
          return _realtimeCollectionSnapshot(table, _buildQuery, onNext, onError);
        }
        return _pollingCollectionSnapshot(table, _buildQuery, onNext, onError);
      },
    };

    return ref;
  }

  // ── Realtime collection snapshot (violations) ──────────────────
  // Supabase Realtime channel → bridge ke Firestore onSnapshot shape.
  //
  // Strategy: initial fetch → deliver first snapshot → subscribe Realtime channel
  // → on change, re-fetch seluruh collection (simpler than diffing at event level).
  // Re-fetch OK untuk violations karena koleksi kecil (< 300 doc, sesuai limit query).
  function _realtimeCollectionSnapshot(table, buildQuery, onNext, onError) {
    let prevRows  = null;
    let destroyed = false;

    // Initial fetch
    buildQuery().then(({ data, error }) => {
      if (destroyed) return;
      if (error) { onError?.(error); return; }
      prevRows = data || [];
      onNext(_toQuerySnap(prevRows, table, null));
    }).catch(onError);

    // Setup Realtime channel — broadcast semua perubahan tabel
    const channelName = `${table}_collection_${Date.now()}`;
    const channel = window.sb.channel(channelName)
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        table,
      }, async () => {
        if (destroyed) return;

        // Re-fetch saat ada perubahan
        try {
          const { data, error } = await buildQuery();
          if (destroyed) return;
          if (error) { onError?.(error); return; }
          const newRows = data || [];
          onNext(_toQuerySnap(newRows, table, prevRows));
          prevRows = newRows;
        } catch (err) {
          if (!destroyed) onError?.(err);
        }
      })
      .subscribe();

    _channels.set(channelName, channel);

    // Return unsubscribe function — sama persis dengan Firestore behavior
    return function unsubscribe() {
      destroyed = true;
      window.sb.removeChannel(channel);
      _channels.delete(channelName);
    };
  }

  // ── Polling collection snapshot (ujian, users, dll) ────────────
  function _pollingCollectionSnapshot(table, buildQuery, onNext, onError) {
    let prevRows    = null;
    let destroyed   = false;
    let timer       = null;
    let failCount   = 0; // track consecutive failures for backoff

    async function _fetch() {
      if (destroyed) return;
      try {
        const { data, error } = await buildQuery();
        if (destroyed) return;
        if (error) {
          failCount++;
          onError?.(error);
        } else {
          failCount = 0; // reset on success
          const newRows = data || [];
          onNext(_toQuerySnap(newRows, table, prevRows));
          prevRows = newRows;
        }
      } catch (err) {
        failCount++;
        if (!destroyed) onError?.(err);
      }
      if (!destroyed) {
        // Exponential backoff: 8s → 16s → 32s → cap 300s
        // Cegah banjir request saat Supabase sedang bermasalah
        const backoff = failCount > 0
          ? Math.min(SNAPSHOT_POLL_MS * Math.pow(2, failCount - 1), 300_000)
          : SNAPSHOT_POLL_MS;
        timer = setTimeout(_fetch, backoff);
      }
    }

    _fetch(); // immediate first run

    // Saat device kembali online, reset backoff dan fetch segera
    // agar user tidak tunggu 5 menit setelah koneksi balik
    function _onReconnect() { failCount = 0; clearTimeout(timer); _fetch(); }
    document.addEventListener('supabase-reconnected', _onReconnect);

    return function unsubscribe() {
      destroyed = true;
      clearTimeout(timer);
      document.removeEventListener('supabase-reconnected', _onReconnect);
    };
  }
  function _realtimeDocSnapshot(table, docId, onNext, onError) {
    let destroyed = false;
    const idCol   = _identityCol(table);

    // Initial fetch
    sb.from(table).select('*').eq(idCol, docId).maybeSingle()
      .then(({ data, error }) => {
        if (destroyed) return;
        if (error) { onError?.(error); return; }
        onNext(_toDocSnap(data, table));
      }).catch(onError);

    const channelName = `${table}_doc_${docId}_${Date.now()}`;
    const channel = window.sb.channel(channelName)
      .on('postgres_changes', {
        event:  '*',
        schema: 'public',
        table,
        filter: `${idCol}=eq.${docId}`,
      }, async (payload) => {
        if (destroyed) return;
        // payload.new berisi row terbaru untuk INSERT/UPDATE
        // payload.eventType === 'DELETE' → row hilang
        if (payload.eventType === 'DELETE') {
          onNext(_toDocSnap(null, table));
        } else {
          onNext(_toDocSnap(payload.new, table));
        }
      })
      .subscribe();

    _channels.set(channelName, channel);

    return function unsubscribe() {
      destroyed = true;
      window.sb.removeChannel(channel);
      _channels.delete(channelName);
    };
  }

  // ── Polling doc snapshot ───────────────────────────────────────
  function _pollingDocSnapshot(table, docId, onNext, onError) {
    let destroyed = false;
    let timer     = null;
    let failCount = 0;
    const idCol   = _identityCol(table);

    async function _fetch() {
      if (destroyed) return;
      try {
        const { data, error } = await sb
          .from(table).select('*').eq(idCol, docId).maybeSingle();
        if (destroyed) return;
        if (error) {
          failCount++;
          onError?.(error);
        } else {
          failCount = 0;
          onNext(_toDocSnap(data, table));
        }
      } catch (err) {
        failCount++;
        if (!destroyed) onError?.(err);
      }
      if (!destroyed) {
        const backoff = failCount > 0
          ? Math.min(SNAPSHOT_POLL_MS * Math.pow(2, failCount - 1), 300_000)
          : SNAPSHOT_POLL_MS;
        timer = setTimeout(_fetch, backoff);
      }
    }

    _fetch();
    function _onReconnect() { failCount = 0; clearTimeout(timer); _fetch(); }
    document.addEventListener('supabase-reconnected', _onReconnect);
    return () => {
      destroyed = true;
      clearTimeout(timer);
      document.removeEventListener('supabase-reconnected', _onReconnect);
    };
  }

  // ── arrayUnion helper ──────────────────────────────────────────
  // Firestore arrayUnion: append item ke array field tanpa duplikat.
  // Di Supabase: fetch row → merge array → update.
  // Fire-and-forget agar tidak block caller (sama dengan Firestore behavior).
  async function _applyArrayUnions(table, docId, arrayUnions) {
    const idCol = _identityCol(table);
    const { data: row } = await sb
      .from(table).select('*').eq(idCol, docId).maybeSingle();

    const updates = {};
    for (const [field, newItem] of Object.entries(arrayUnions)) {
      const existing = (row && Array.isArray(row[field])) ? row[field] : [];
      const newJson  = JSON.stringify(newItem);
      const isDup    = existing.some(e => JSON.stringify(e) === newJson);
      updates[field] = isDup ? existing : [...existing, newItem];
    }

    const { error } = await sb.from(table).update(updates).eq(idCol, docId);
    if (error) throw new Error(`[Supabase] arrayUnion ${table}: ${error.message}`);
  }

  // ── runTransaction ─────────────────────────────────────────────
  // Firestore transaction API: fn({ get, set, update }) → Promise
  //
  // Supabase tidak punya client-side transaction API yang equivalent.
  // Alternatif: PostgreSQL function via .rpc(), atau optimistic concurrency.
  //
  // Untuk use case di codebase ini (wizard saveExamToSupabase: check-then-insert),
  // kita emulate dengan SELECT + INSERT dalam satu roundtrip menggunakan
  // upsert dengan conflict check. Tidak perfect, tapi cukup untuk production
  // karena token ujian unique, collision sangat jarang.
  //
  // NOTE: runTransaction di Supabase shim ini BUKAN atomic — operasi berjalan sequential
  // bukan dalam satu Postgres transaction. Race condition bisa terjadi jika dua admin
  // publish ujian dengan token yang sama secara bersamaan.
  //
  // Mitigasi saat ini: upsert dengan onConflict check di _docRef.set({merge:true}) —
  // token ujian bersifat unique (kode_id PRIMARY KEY), sehingga insert kedua akan
  // menjadi upsert (tidak duplikat data). False-duplicate tapi tidak corrupt.
  //
  // TODO (fase 2): pindah ke Postgres function via .rpc() untuk true atomicity.
  async function runTransaction(fn) {
    // Build transaction-like proxy object
    const txGets = {};

    const tx = {
      async get(docRefLike) {
        const snap = await docRefLike.get();
        txGets[snap.id] = snap;
        return snap;
      },
      async set(docRefLike, data, options) {
        await docRefLike.set(data, options);
      },
      async update(docRefLike, data) {
        await docRefLike.update(data);
      },
    };

    return fn(tx);
  }

  // ── batch() ────────────────────────────────────────────────────
  // Dipakai di AdminNotificationCenter untuk batch delete violations.
  // Supabase tidak punya batch API, tapi kita bisa collect ops lalu
  // jalankan semua secara parallel dengan Promise.all.
  function batch() {
    const _ops = [];

    return {
      delete(docRefLike) {
        _ops.push(() => docRefLike.delete());
        return this; // chainable
      },
      set(docRefLike, data, options) {
        _ops.push(() => docRefLike.set(data, options));
        return this;
      },
      update(docRefLike, data) {
        _ops.push(() => docRefLike.update(data));
        return this;
      },
      async commit() {
        // Jalankan semua ops parallel — Supabase tidak punya atomic batch,
        // ini best-effort. Untuk violations delete, non-atomic OK.
        const results = await Promise.allSettled(_ops.map(op => op()));
        const failed  = results.filter(r => r.status === 'rejected');
        if (failed.length > 0) {
          // Jangan throw — caller (ANC) sudah handle error dengan catch.
          // Cukup log untuk debugging.
          // WHY log di semua env: batch failure (mis. delete violations) adalah
          // anomali yang perlu diketahui. Tidak throw agar satu failure
          // tidak rollback seluruh batch — Supabase memang tidak atomic.
          console.warn('[SupabaseApi] batch.commit: beberapa operasi gagal:', failed.map(r => r.reason?.message));
        }
      },
    };
  }

  // ── Public DB shim object ──────────────────────────────────────
  return {
    collection: _collectionRef,
    runTransaction,
    batch,

    // FieldValue sentinels — dipakai oleh banyak file:
    //   firebase.firestore.FieldValue.serverTimestamp()
    //   firebase.firestore.FieldValue.arrayUnion(item)
    //
    // Kita expose di sini (window.firebaseDb.FieldValue) DAN
    // di window.firebase.firestore.FieldValue agar kedua pattern kerja.
    FieldValue: {
      serverTimestamp: () => _SENTINEL_TIMESTAMP,
      arrayUnion:      (item) => _SENTINEL_ARRAY_UNION(item),
      // Tidak dipakai di codebase ini tapi defensif expose
      arrayRemove:     (item) => ({ __arrayRemove: true, item }),
    },
  };
}

// ── Firebase global stub ───────────────────────────────────────
//
// Beberapa file memanggil firebase.* langsung (bukan lewat window.firebaseDb):
//   firebase.auth().currentUser
//   firebase.auth().onAuthStateChanged(...)
//   firebase.firestore()                          ← return db shim
//   firebase.firestore.FieldValue.serverTimestamp()
//   new firebase.auth.GoogleAuthProvider()        ← stub class
//
// Kita buat stub global 'firebase' yang redirect semua ini ke Supabase.
function _buildFirebaseStub(sb) {
  const authShim = window.firebaseAuth;
  const dbShim   = window.firebaseDb;

  // GoogleAuthProvider stub — hanya dipakai sebagai argument ke signInWithPopup
  // Auth shim sudah ignore provider argument dan langsung pakai OAuth Supabase
  function GoogleAuthProvider() {}
  GoogleAuthProvider.prototype.addScope = function() { return this; };

  // firestore() function stub — return db shim
  function firestoreFn() { return dbShim; }

  // FieldValue harus accessible di firebase.firestore.FieldValue (static property)
  firestoreFn.FieldValue = dbShim.FieldValue;

  return {
    auth: Object.assign(
      // firebase.auth() call → return authShim
      () => authShim,
      {
        // firebase.auth.GoogleAuthProvider (class property, bukan instance)
        GoogleAuthProvider,
      }
    ),

    firestore: firestoreFn,

    // Stub apps array — dicek di beberapa tempat: firebase.apps?.length
    apps: [{}],

    // Stub app() — dipanggil di FirebaseApi.js original saat re-init
    app: () => ({}),

    // Stub initializeApp — tidak perlu lakukan apa-apa, sudah init via Supabase
    initializeApp: () => {},
  };
}

// ── Fallback shims (jika config fetch gagal) ───────────────────
// Sama filosofi dengan FirebaseApi.js: halaman tidak crash,
// semua operasi fail gracefully.
function _installFallbackShims() {
  const noOp  = () => Promise.resolve();
  const noDb  = {
    collection: () => ({
      doc: () => ({
        get:        () => Promise.resolve({ exists: false, id: null, data: () => null }),
        set:        noOp,
        update:     noOp,
        delete:     noOp,
        onSnapshot: () => () => {},
      }),
      where:   function() { return this; },
      orderBy: function() { return this; },
      limit:   function() { return this; },
      get:     () => Promise.resolve({ docs: [], forEach: () => {}, docChanges: () => [] }),
      onSnapshot: () => () => {},
    }),
    runTransaction: (fn) => fn({
      get:    () => Promise.resolve({ exists: false, data: () => null }),
      set:    noOp,
      update: noOp,
    }),
    batch: () => ({
      delete:  function() { return this; },
      set:     function() { return this; },
      update:  function() { return this; },
      commit:  noOp,
    }),
    FieldValue: {
      serverTimestamp: () => new Date().toISOString(),
      arrayUnion:      () => [],
    },
  };

  const noAuth = {
    currentUser: null,
    signInWithPopup: () => Promise.reject(new Error('Supabase tidak tersedia')),
    signOut:         noOp,
    onAuthStateChanged: (cb) => { cb(null); return () => {}; },
  };

  window.firebaseDb   = noDb;
  window.firebaseAuth = noAuth;
  window.auth         = noAuth;
  window.db           = noDb;
  window.sb           = null;

  window.firebase = {
    apps: [],
    auth:       Object.assign(() => noAuth, {
      // WHY not just `function() {}`:
      // auth.js calls provider.addScope() on every login attempt — even in fallback mode.
      // A bare constructor with no prototype methods throws immediately.
      // addScope is a no-op here (Supabase ignores it), but it must exist.
      GoogleAuthProvider: Object.assign(function GoogleAuthProvider() {}, {
        prototype: { addScope() { return this; }, setCustomParameters() { return this; } },
      }),
    }),
    firestore:  Object.assign(() => noDb,   { FieldValue: noDb.FieldValue }),
    app:           () => ({}),
    initializeApp: () => {},
  };
}

// ── waitForFirebase — public helper ───────────────────────────
//
// Nama dipertahankan 'waitForFirebase' agar semua caller tidak perlu diubah.
// Semantically sekarang berarti "tunggu Supabase siap".
window.waitForFirebase = function(timeout = 15_000) {
  if (window.__firebaseReady) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onReady = () => {
      document.removeEventListener('firebase-ready', onReady);
      document.removeEventListener('firebase-error', onError);
      resolve();
    };
    const onError = (e) => {
      document.removeEventListener('firebase-ready', onReady);
      document.removeEventListener('firebase-error', onError);
      reject(new Error(e.detail?.error || 'Supabase gagal diinisialisasi'));
    };

    document.addEventListener('firebase-ready', onReady);
    document.addEventListener('firebase-error', onError);

    setTimeout(() => {
      document.removeEventListener('firebase-ready', onReady);
      document.removeEventListener('firebase-error', onError);
      if (window.__firebaseReady) resolve();
      else reject(new Error('waitForFirebase timeout — Supabase tidak siap dalam ' + timeout + 'ms'));
    }, timeout);
  });
};

// ── waitForSupabase — alias modern ────────────────────────────
// File yang sudah di-migrasi bisa pakai nama ini.
window.waitForSupabase = window.waitForFirebase;