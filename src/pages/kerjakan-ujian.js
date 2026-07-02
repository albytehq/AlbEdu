    // Tunggu QNotify siap (di-load sebagai ES module di head -- async)
    async function _waitQNotify(ms) {
      if (window.QNotify) return;
      return new Promise(resolve => {
        window.addEventListener('qnotify-ready', resolve, { once: true });
        setTimeout(resolve, ms || 1500); // fallback timeout
      });
    }

    (async () => { try {
      await _waitQNotify(3000); // FIX: tunggu max 3 detik (2 detik terlalu sempit di koneksi lambat)
      const $loading  = document.getElementById('loadingScreen');
      const $error    = document.getElementById('errorScreen');
      const $closed   = document.getElementById('closedScreen');
      const $app      = document.getElementById('appContainer');
      const $examCont = document.getElementById('examContainer');
      const $result   = document.getElementById('resultPhase');

      let _identitasData = null;
      let _identityDone  = false;

      // F1: Submit lock — tombol kumpul dikunci sampai 10 menit terakhir.
      // Set false lagi setiap kali phase masuk ke 'exam' (termasuk setelah reset).
      let _submitUnlocked = false;

      // BUGFIX (Phase 1): _preExamTimerInterval must be declared BEFORE _beforeUnloadGuard
      // references it. Original code declared it at line ~235 (inside _startPreExamTimer
      // scope group), causing TDZ ReferenceError when beforeunload fired before that line
      // executed. Moved declaration to top of IIFE scope.
      let _preExamTimerInterval = null;

      // F2: Guard beforeunload — kita pasang/lepas secara eksplisit agar setelah
      // submit, navigasi normal tidak terhalang. Simpan referensi fungsinya.
      function _beforeUnloadGuard(e) {
        // Bersihkan pre-exam timer juga saat halaman ditutup
        if (_preExamTimerInterval) {
          clearInterval(_preExamTimerInterval);
          _preExamTimerInterval = null;
        }
        if (ExamLogic.getState().phase === 'exam') {
          // S4 fix: flush pending debounced draft save before tab close.
          // Without this, last answer (clicked <500ms before close) would be lost.
          if (typeof ExamLogic.flushDraft === 'function') {
            ExamLogic.flushDraft();
          }
          e.preventDefault();
          e.returnValue = 'Ujian belum selesai. Yakin ingin meninggalkan halaman?';
        }
      }
      window.addEventListener('beforeunload', _beforeUnloadGuard);

      // F2: Tangkap tombol Back/Forward saat ujian aktif — cegah keluar halaman.
      // Cara kerja: saat phase='exam', kita sudah push dummy history entry.
      // Saat peserta tekan Back, popstate terpanggil → kita push lagi → peserta terjebak di sini.
      window.addEventListener('popstate', (e) => {
        if (ExamLogic.getState().phase === 'exam') {
          history.pushState({ albEduExamActive: true }, '', location.href);
          _qn('warning', 'Tidak Dapat Kembali',
            'Kamu sedang mengerjakan ujian. Selesaikan atau kumpulkan terlebih dahulu.',
            4000
          );
        }
        // Phase bukan 'exam' (identity/result) → biarkan navigasi normal
      });

      /* Helper QNotify -- null-safe, tidak perlu optional chaining */
      function _qn(type, title, msg, dur) {
        const qn = window.QNotify || window.show;
        if (qn && qn.notify && typeof qn.notify[type] === 'function') {
          qn.notify[type](title, msg, dur || 4000);
        } else {
        }
      }

      // -- SUBMIT-LOCK GUARD: jika peserta sudah submit ujian ini -> tolak akses --
      // Dibaca sebelum apapun di-render. Hanya blokir jika nilai = 'true'.
      // 'violation' atau null = boleh masuk.
      (function _checkSubmitLock() {
        const token   = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
        const userKey = (typeof ExamData !== 'undefined') ? ExamData.getUserKey()    : 'anon';
        if (!token || !userKey) return;
        const submitKey = 'exam_submitted_' + token + '_' + userKey;
        if (localStorage.getItem(submitKey) === 'true') {
          // Langsung tampilkan error screen -- tidak perlu load ujian
          document.getElementById('loadingScreen').classList.add('hidden');
          const es = document.getElementById('errorScreen');
          // use dedicated submittedScreen
          const ss = document.getElementById('submittedScreen');
          if (ss) { ss.classList.add('visible'); }
          else { document.getElementById('errorMessage').textContent = 'Kamu sudah mengumpulkan ujian ini.'; es.classList.add('visible'); }
          console.warn('[kerjakan-ujian] Submit-lock aktif:', submitKey);
          // Hentikan script controller agar tidak lanjut load
          throw new Error('SUBMIT_LOCKED');
        }
      })();

      function showApp() {
        $loading.classList.add('hidden');
        $app.classList.add('visible');
      }
      function showError(msg) {
        $loading.classList.add('hidden');
        if (msg) document.getElementById('errorMessage').textContent = msg;
        $error.classList.add('visible');
      }

      // 1. Tunggu SupabaseApi.js selesai init sebelum fetch data apapun.
      if (!window.__firebaseReady) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(
              'Koneksi ke server lambat atau terputus.\n\n' +
              'Coba langkah berikut:\n' +
              '1. Pastikan Wi-Fi atau data seluler aktif\n' +
              '2. Tutup aplikasi lain yang berat\n' +
              '3. Muat ulang halaman ini\n\n' +
              'Jika masalah berlanjut, hubungi guru.'
            ));
          }, 8000);
          document.addEventListener('firebase-ready', () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
          document.addEventListener('firebase-error', () => {
            clearTimeout(timeout);
            // error bukan fatal jika sessionStorage sudah ada datanya
            resolve();
          }, { once: true });
        }).catch(e => { showError(e.message); throw e; });
      }

      // BUGFIX A: Auth gate -- wait for auth-ready, then verify the user
      // is logged in. byteward.js auto-redirects unauthenticated users
      // to login on auth-ready, but we also check here to prevent the
      // exam logic from starting before the redirect takes effect.
      if (!window.Auth?.authReady) {
        await new Promise((resolve, reject) => {
          const authTimeout = setTimeout(() => {
            reject(new Error('Sesi login tidak terdeteksi. Silakan login ulang.'));
          }, 10000);
          document.addEventListener('auth-ready', () => {
            clearTimeout(authTimeout);
            resolve();
          }, { once: true });
        }).catch(e => { showError(e.message); throw e; });
      }
      // Double-check: if no user after auth-ready, byteward should have
      // already redirected. This is a safety net.
      if (!window.Auth?.currentUser) {
        showError('Anda harus login terlebih dahulu untuk mengerjakan ujian.');
        setTimeout(() => {
          // FIX: parens to make precedence explicit. The original
          // `a + b || c` evaluates as `(a + b) || c` which happens to be
          // correct here, but is fragile. Be explicit.
          // Per rule-url-albedu.md §3, always go through window.Auth
          // BASE_PATH-aware helpers and only fall back to a relative path
          // if Auth is unavailable.
          const basePath = window.Auth?.getBasePath?.() ?? '../';
          const loginUrl = basePath + 'login.html';
          window.location.replace(loginUrl);
        }, 2000);
        return;
      }

      // Jika sessionStorage punya data ujian, tidak perlu tunggu SupabaseApi lagi
      if (!window.__firebaseReady && !sessionStorage.getItem('exam_data')) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => {
            reject(new Error(
              'Koneksi ke server lambat atau terputus.\n\n' +
              'Pastikan internet aktif lalu muat ulang halaman.\n' +
              'Jika masalah berlanjut, hubungi guru.'
            ));
          }, 8000);
          document.addEventListener('firebase-ready', () => { clearTimeout(t); resolve(); }, { once: true });
          document.addEventListener('firebase-error', () => { clearTimeout(t); resolve(); }, { once: true });
        }).catch(e => { showError(e.message); throw e; });
      }

      // 1. Fetch data ujian
      let ujianData;
      try {
        ujianData = await ExamData.getUjianData();
      } catch (e) {
        showError('Gagal memuat data ujian. ' + e.message);
        return;
      }

      // 2. Init ExamLogic
      try {
        ExamLogic.init(ujianData);
      } catch (e) {
        showError('Gagal inisialisasi ujian. ' + e.message);
        return;
      }

      // 2b. Coba restore jawaban dari draft tersimpan (HP mati, browser crash, dsb).
      // Dilakukan SETELAH init() agar _draftKey() bisa resolve token+userKey.
      // Hanya restore jika submit-lock belum aktif (artinya ujian belum dikumpulkan).
      const _draftResult = ExamLogic.restoreFromDraft();

      // F2D: Re-entry recovery — notifikasi restore ditampilkan di onPhaseChange('exam')
      // setelah peserta submit identitas (line ~993). Listener supabase-ready tidak dipakai
      // karena event tersebut sudah fired sebelum kode ini berjalan — callback tidak
      // akan pernah dipanggil. Notifikasi cukup satu tempat saja (di ExamIdentitySeparator.onSubmit).

      // 3. Apply theme
      try { ExamViewer.applyTheme(ujianData?.ujian?.theme || {}); } catch (e) {}

      // 4. Cek akses
      if (!ExamLogic.isAccessOpen()) {
        $loading.classList.add('hidden');
        $closed.classList.add('visible');
        return;
      }

      // 5. Mount layout
      try {
        ExamViewer.mount($examCont);
      } catch (e) {
        showError('Gagal render tampilan. ' + e.message);
        return;
      }

      showApp();

      const soalPages = ExamLogic.getSoalPages();
      const ujianInfo = ExamLogic.getUjianInfo();

      function _toDate(value) {
        if (!value) return null;
        if (value instanceof Date) return value;
        if (typeof value.toDate === 'function') return value.toDate();
        if (value.seconds != null) return new Date(value.seconds * 1000);
        const parsed = new Date(value);
        return isNaN(parsed.getTime()) ? null : parsed;
      }

      // FIX [TIMER PRE-EXAM]: tampilkan hitungan mundur sejak halaman identitas,
      // bukan baru setelah peserta submit identitas. Ini penting agar peserta tahu
      // waktu berjalan dan tidak santai mengisi identitas.
      //
      // Cara kerja:
      //   - Jika access_control.end ada → hitung sisa dari server deadline (akurat).
      //   - Jika tidak ada end time → gunakan durasi_menit * 60 sebagai fallback statis.
      // Timer ini berjalan sampai ExamLogic.startUjian() dipanggil, setelah itu
      // ExamLogic._startTimer() mengambil alih dan onTimerTick() yang update UI.
      // _preExamTimerInterval declared at top of IIFE (Phase 1 BUGFIX — was TDZ error)

      function _startPreExamTimer() {
        const ac  = ujianData?.access_control;
        const end = _toDate(ac?.end);

        function _tick() {
          // Jika exam sudah mulai, stop — ExamLogic timer yang pegang kendali
          if (ExamLogic.getState().phase === 'exam') {
            clearInterval(_preExamTimerInterval);
            _preExamTimerInterval = null;
            return;
          }
          if (end && !isNaN(end.getTime())) {
            const sisaDetik = Math.max(0, Math.floor((end - new Date()) / 1000));
            ExamViewer.updateTimer(sisaDetik);
          } else {
            // Tidak ada server end-time: tampilkan durasi total sebagai countdown statis.
            // Countdown hanya mulai akurat setelah startUjian() — di sini cukup perlihatkan
            // durasi agar peserta tahu berapa lama ujian, bukan '--:--' yang membingungkan.
            ExamViewer.updateTimer((ExamLogic.getState().durasi_menit || 60) * 60);
          }
        }

        _tick(); // tampilkan segera tanpa nunggu 1 detik
        _preExamTimerInterval = setInterval(_tick, 1000);
      }

      _startPreExamTimer();

      // 6. Render identitas (v2.0.0 — uses IdentityProvider facade)
      function renderIdentity(readonly) {
        const idCfg   = ExamLogic.getIdentitasConfig();
        const catatan = ujianInfo?.catatan === 'On' ? ujianInfo?.is_catatan : null;

        ExamViewer.renderIdentityPage(ujianInfo, catatan, readonly);
        // NOTE: renderSidebarTabs() was removed in ExamViewer v4.2.0 — sidebar dihapus.
        // Tidak perlu dipanggil lagi.
        window.scrollTo(0, 0);

        const mount = ExamViewer.getIdentityFormMount();
        if (!mount) return;

        // v2.0.0 — gunakan IdentityProvider (delegasi ke IdentityFormRenderer untuk manual,
        // atau custom dropdown UI untuk daftar). Support backward compat dengan idCfg.kelas
        // (legacy data yang masih pakai kelas array).
        if (window.IdentityProvider) {
          // Build exam data object untuk IdentityProvider.getIdentityConfig
          const examDataForIdentity = {
            identity_mode: idCfg?.mode || idCfg?.identity_mode,
            identity_config: {
              fields: idCfg?.fields,
              daftar_id: idCfg?.daftar_id,
              daftar_tipe: idCfg?.daftar_tipe,
              daftar_label: idCfg?.daftar_label,
              tabs: idCfg?.tabs || idCfg?.kelas,
            },
            // Legacy fallback (untuk exam lama yang belum migrate)
            PQ: { pages1: { identitas: idCfg } },
          };

          if (readonly) {
            // Readonly mode: render form tapi tanpa tombol submit (just display)
            window.IdentityProvider.render(mount, examDataForIdentity, () => {}, () => {});
          } else {
            window.IdentityProvider.render(
              mount,
              examDataForIdentity,
              (identity) => {
                _identitasData = identity;
                _identityDone = true;
                const { reshuffled } = ExamLogic.startUjian(identity);
                if (reshuffled) {
                  _qn('warning', 'Soal Diacak Ulang', 'Pelanggaran terdeteksi. Soal telah diacak ulang.', 4000);
                }
                // Tampilkan notifikasi restore SETELAH ujian berhasil dimulai,
                // bukan di loading screen — biar peserta fokus dan tidak panik saat baca.
                if (_draftResult.restored) {
                  setTimeout(() => {
                    _qn('success',
                      `${_draftResult.count} Jawaban Dipulihkan`,
                      'Progres ujian sebelumnya berhasil dimuat. Lanjutkan dari yang sudah kamu jawab.',
                      5000
                    );
                  }, 800);
                }
              },
              () => {
                // Cancel: kembali ke halaman token
                window.location.href = './index.html';
              }
            );
          }
          return;
        }

        // Fallback: legacy path (jika IdentityProvider belum load)
        console.warn('[kerjakan-ujian-controller] IdentityProvider not available, falling back to legacy ExamIdentitySeparator');
        if (readonly) {
          ExamIdentitySeparator.onKelasChange(_fetchNama);
          ExamIdentitySeparator.onSubmit(() => {});
          ExamIdentitySeparator.render(mount, idCfg?.kelas || [], _identitasData);
        } else {
          ExamIdentitySeparator.onKelasChange(_fetchNama);
          ExamIdentitySeparator.onSubmit((identitas) => {
            _identitasData = identitas;
            _identityDone = true;
            const { reshuffled } = ExamLogic.startUjian(identitas);
            if (reshuffled) {
              _qn('warning', 'Soal Diacak Ulang', 'Pelanggaran terdeteksi. Soal telah diacak ulang.', 4000);
            }
            if (_draftResult.restored) {
              setTimeout(() => {
                _qn('success',
                  `${_draftResult.count} Jawaban Dipulihkan`,
                  'Progres ujian sebelumnya berhasil dimuat. Lanjutkan dari yang sudah kamu jawab.',
                  5000
                );
              }, 800);
            }
          });
          const draftIdentitas = _draftResult.identitas || null;
          ExamIdentitySeparator.render(mount, idCfg?.kelas || [], draftIdentitas, true);
          if (draftIdentitas?.kelas) {
            _fetchNama(draftIdentitas.kelas);
          }
        }
      }

      // v2.0.0 — _fetchNama sekarang hanya dipakai oleh legacy fallback path
      async function _fetchNama(kelasDetail) {
        try {
          // Legacy: pakai getPesertaDariKelas (sudah dihapus di v2.0.0)
          // Fallback ke getPesertaDariDaftar jika idCfg punya daftar_id
          const idCfg = ExamLogic.getIdentitasConfig();
          if (idCfg?.daftar_id) {
            const list = await ExamData.getPesertaDariDaftar(idCfg.daftar_id, kelasDetail);
            ExamIdentitySeparator.updateNamaList(list);
          } else {
            ExamIdentitySeparator.updateNamaList([]);
          }
        } catch (e) {
          ExamIdentitySeparator.updateNamaList([]);
        }
      }

      // 7. Render halaman soal
      function renderSoalPage(idx, slideDir) {
        const page = soalPages[idx];
        if (!page) return;
        ExamViewer.renderSoalPage(
          page,
          (pageKey, idq) => ExamLogic.getJawaban(pageKey, idq),
          ujianInfo,
          idx,
          soalPages.length,
          slideDir || 'right'
        );
        // NOTE: renderSidebarTabs() dihapus di v4.2.0 bersama sidebar — tidak dipanggil lagi.
        _syncProgress();
        window.scrollTo(0, 0);
      }

      // 8. Sync progress
      function _syncProgress() {
        const prog = ExamLogic.getProgress();
        ExamViewer.updateProgress(prog);
        // NOTE: updateTabProgress() juga dihapus di v4.2.0 bersama sidebar tabs.
        // ExamViewer.updateTabProgress sudah tidak ada — jangan dipanggil.
      }

      // 9. Navigasi -- IDENTITY GATE: block soal access if identity not done
      ExamViewer.onNavigate((type, idx, slideDir) => {
        if (type === 'identity') {
          // ROLLBACK GUARD: saat ujian sedang berjalan, peserta tidak boleh kembali
          // ke halaman identitas. History trap (pushState) menangani tombol Back browser,
          // tapi tombol Prev di halaman soal pertama juga harus diblokir di sini.
          if (ExamLogic.getState().phase === 'exam') {
            _qn('warning', 'Tidak Dapat Kembali',
              'Kamu sedang mengerjakan ujian. Selesaikan atau kumpulkan dulu sebelum keluar.',
              3500
            );
            return; // blokir navigasi ke identitas
          }
          renderIdentity(false);
        } else if (type === 'page') {
          if (!_identityDone) {
            _qn('warning', 'Isi Identitas Dulu', 'Kamu harus mengisi data diri sebelum mengerjakan soal.', 3000);
            return;
          }
          // idx tidak pernah negatif dari soal page (page 0 prev memanggil 'identity' bukan 'page',-1)
          // tapi kita guard agar tidak ada rollback tersembunyi
          if (idx < 0) {
            _qn('warning', 'Tidak Dapat Kembali',
              'Kamu sedang mengerjakan ujian. Selesaikan atau kumpulkan dulu.',
              3000
            );
            return;
          }
          ExamLogic.goToPage(idx); renderSoalPage(idx, slideDir);
        }
      });

      // 10. Jawab soal
      ExamViewer.onAnswer((pageKey, idq, key) => {
        ExamLogic.jawab(pageKey, idq, key);
        _syncProgress();
      });

      // 11. Submit -- Confirmation Hold Async
      ExamViewer.onSubmit(() => {
        const progress = ExamLogic.getProgress();
        const sisa = progress.total - progress.dijawab;
        const _qndialog = window.QNotify || window.show;
        if (!_qndialog) {
          console.warn('[Submit] QNotify tidak tersedia, submit langsung tanpa konfirmasi.');
          _doSubmit();
          return;
        }

        // WHY deactivate SEBELUM dialog:
        // Dialog konfirmasi bisa tampil beberapa detik. Selama itu HP bisa meredupkan
        // layar, notifikasi OS muncul, atau Chrome pindah focus → visibilitychange terpanggil
        // → 'Peringatan Kecurangan' muncul saat peserta lagi klik 'Kumpulkan'. Tidak adil.
        // Jika peserta batal (onCancel), guardian langsung di-activate kembali.
        ExamGuardian.deactivate();

        _qndialog.dialog.holdAsync({
          title: 'Kumpulkan Ujian?',
          message: `Kamu telah menjawab ${progress.dijawab} dari ${progress.total} soal.` +
            (sisa > 0 ? `
Masih ${sisa} soal belum dijawab -- yakin kumpulkan?` : 'Semua soal sudah dijawab.'),
          icon: 'send',
          intent: sisa > 0 ? 'warning' : 'info',
          holdDuration: 2000,
          onAsyncConfirm: async () => { _doSubmit(); },
          onCancel: () => {
            // Peserta batal — re-activate guardian supaya ujian tetap terlindungi
            ExamGuardian.activate();
            _qn('info', 'Dibatalkan', 'Ujian belum dikumpulkan.');
          }
        });
      });

      // WHY async: ExamLogic.submitUjian() adalah async (menulis ke Firestore ViolationStore).
      // Sebelumnya dipanggil tanpa await → hasil = Promise (bukan object hasil ujian)
      // → ExamViewer.renderHasil() crash: "Cannot read properties of undefined (reading 'map')"
      // karena hasil.detailPerBagian.map() dipanggil di Promise, bukan array.
      async function _doSubmit() {
        // F2: remove beforeunload guard — peserta boleh navigasi setelah selesai
        window.removeEventListener('beforeunload', _beforeUnloadGuard);

        ExamGuardian.deactivate();
        ExamIdentitySeparator.destroy();

        // Hitung hasil SEBELUM submitUjian() karena submitUjian() set phase='result'
        // dan _stopTimer(). getHasil() masih bisa dipanggil karena state belum dihapus.
        const hasil = ExamLogic.getHasil();

        // Baru submit (fire-and-forget ke Firestore, state lokal tetap valid)
        await ExamLogic.submitUjian();

        $examCont.style.display = 'none';
        $result.style.display   = 'block';
        ExamViewer.renderHasil($result, hasil);

        // Write submit-lock to localStorage so the token page (ujian.js) also
        // blocks re-entry. ExamLogic.submitUjian() writes to ViolationStore
        // (Firestore/sessionStorage), but ujian.js reads from localStorage —
        // they were disconnected. window.setExamSubmitLock bridges both systems.
        const _token   = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
        const _userKey = (typeof ExamData !== 'undefined') ? ExamData.getUserKey()    : 'anon';
        if (typeof window.setExamSubmitLock === 'function') {
          window.setExamSubmitLock(_token, _userKey);
        } else {
          // Inline fallback if ujian.js didn't export the helper
          try { if (_token && _userKey) localStorage.setItem(`exam_submitted_${_token}_${_userKey}`, 'true'); } catch (_) {}
        }

        // Bersihkan sessionStorage setelah submit -- data ujian tidak dibutuhkan lagi
        try {
          sessionStorage.removeItem('exam_data');
          // exam_token & exam_user_key tetap disimpan untuk referensi
        } catch (_) {}

        _qn('success', 'Ujian Terkumpul', 'Nilai kamu: ' + hasil.nilai + '/' + hasil.nilaiMaksimal, 5000);
      }

      // FIX [TIMER]: onTimerTick didaftarkan SEKALI di sini, SEBELUM onPhaseChange.
      // Sebelumnya listener dipasang DI DALAM onPhaseChange('exam') — timer sudah berjalan
      // (startUjian → _startTimer) sebelum callback terpasang → tick awal hilang.
      // Dan yang kritis: saat sisa=0, ExamLogic internal submit tapi controller tidak tahu
      // → UI stuck di halaman soal selamanya. Sekarang listener ready sebelum fase apapun.
      ExamLogic.onTimerTick((sisa) => {
        ExamViewer.updateTimer(sisa);

        // F1: Unlock submit button when 10 minutes (600 seconds) remain.
        // _submitUnlocked flag prevents the notification from firing more than once.
        // Edge case: if the exam total duration is <= 10 min, _submitUnlocked is set
        // to true at phase start so this block is never entered.
        const UNLOCK_THRESHOLD = 600;
        if (!_submitUnlocked && ExamLogic.getState().phase === 'exam' && sisa <= UNLOCK_THRESHOLD) {
          _submitUnlocked = true;
          ExamViewer.setSubmitLocked(false);
          // Only notify if there was actually a locked period (durasi > 10 menit).
          // If ujian durasi <= 10 min the button was never locked — no surprise notification.
          const durasiDetik = ExamLogic.getState().durasi_menit * 60;
          if (durasiDetik > UNLOCK_THRESHOLD) {
            _qn('warning', 'Waktu Pengumpulan Dibuka!',
              '10 menit tersisa. Kamu sudah bisa mengumpulkan ujian.', 5000);
          }
        }

        // Ketika waktu habis: ExamLogic._startTimer() sudah panggil submitUjian() internal
        // (set phase='result', stop timer). Controller harus sync UI: render hasil.
        // Guard dengan cek $result visibility agar idempoten — tidak double-render.
        if (sisa <= 0 && ExamLogic.getState().phase === 'result') {
          if ($result.style.display === 'none' || $result.style.display === '') {
            ExamGuardian.deactivate();
            ExamIdentitySeparator.destroy();
            const hasilAuto = ExamLogic.getHasil();
            $examCont.style.display = 'none';
            $result.style.display   = 'block';
            ExamViewer.renderHasil($result, hasilAuto);
            const _tok = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
            const _uky = (typeof ExamData !== 'undefined') ? ExamData.getUserKey()    : 'anon';
            if (typeof window.setExamSubmitLock === 'function') window.setExamSubmitLock(_tok, _uky);
            else { try { if (_tok && _uky) localStorage.setItem(`exam_submitted_${_tok}_${_uky}`, 'true'); } catch (_) {} }
            try { sessionStorage.removeItem('exam_data'); } catch (_) {}
            _qn('warning', 'Waktu Habis', 'Ujian dikumpulkan otomatis. Nilai: ' + hasilAuto.nilai + '/' + hasilAuto.nilaiMaksimal, 6000);
          }
        }
      });

      // 12. Phase change
      ExamLogic.onPhaseChange((phase) => {
        if (phase === 'identity') {
          _identityDone  = false;
          _identitasData = null;
          // F1: Re-lock submit whenever returning to identity (e.g. after max violation reset)
          _submitUnlocked = false;
          renderIdentity(false);
        } else if (phase === 'exam') {
          // Hentikan pre-exam countdown — ExamLogic timer mengambil alih dari sini
          if (_preExamTimerInterval) {
            clearInterval(_preExamTimerInterval);
            _preExamTimerInterval = null;
          }

          ExamViewer.renderHeader(ujianInfo, _identitasData);

          // ── F1: Submit Lock initial state ─────────────────────────────────
          // Determine whether to start locked or already unlocked.
          // Unlock immediately if:
          //   a) Exam total duration is ≤ 10 min (there's no meaningful lock window)
          //   b) User joined late — remaining time already ≤ 600 s
          const UNLOCK_THRESHOLD_SEC = 600;
          const durasiDetik = (ExamLogic.getState().durasi_menit || 60) * 60;
          let sisaSaatMulai = durasiDetik;
          const acNow  = ujianData?.access_control;
          const endNow = acNow?.end ? new Date(acNow.end) : null;
          if (endNow && !isNaN(endNow.getTime())) {
            sisaSaatMulai = Math.max(0, Math.floor((endNow - Date.now()) / 1000));
          }
          if (durasiDetik <= UNLOCK_THRESHOLD_SEC || sisaSaatMulai <= UNLOCK_THRESHOLD_SEC) {
            // Already in (or past) unlock window — unlock silently, no toast
            _submitUnlocked = true;
            ExamViewer.setSubmitLocked(false);
          } else {
            _submitUnlocked = false;
            ExamViewer.setSubmitLocked(true);
          }
          // ─────────────────────────────────────────────────────────────────

          renderSoalPage(0, 'right');
          ExamGuardian.activate();

          // ── F2: History trap — push dummy entry so Back button stays here ─
          // popstate listener (registered at init) catches Back presses and
          // re-pushes this entry while phase === 'exam', creating a one-way door.
          history.pushState({ albEduExamActive: true }, '', location.href);
          // ─────────────────────────────────────────────────────────────────

          ExamGuardian.onViolation(({ pesan }) => {
            const { violations, isMaxed } = ExamLogic.addViolation();
            const MAKS = 4;

            // SIGNAL: push violation event to Firestore so admin panel gets real-time alert.
            // Fire-and-forget — must never block the warning UI for the user.
            // AdminNotificationCenter.js on admin pages listens via onSnapshot.
            (function _signalToAdmin() {
              try {
                const _tk = ExamData.getActiveToken();
                const _uk = ExamData.getUserKey();
                const _nm = ExamLogic.getState().identitas?.nama || 'Peserta';
                const _et = ujianInfo?.judul || ujianInfo?.nama_ujian || 'Ujian';
                if (_tk && _uk && window.Security?.ViolationStore) {
                  Security.ViolationStore.markWarning(_tk, _uk, violations, pesan, _et, _nm);
                }
              } catch (_) { /* signal is background telemetry — never surface to user */ }
            })();

            const qn = window.QNotify || window.show;
            if (qn && qn.label) {
              qn.label.alert({
                title: 'Peringatan Kecurangan',
                message: pesan + '\n\nPeringatan ke-' + violations + ' dari ' + MAKS + '.' +
                  (isMaxed ? '\n\nUjian akan direset dan soal diacak ulang!' : ''),
                intent: isMaxed ? 'danger' : 'warning',
                okText: 'Mengerti'
              });
            }
          });

          ExamGuardian.onMaxViolation(() => {
            const qn = window.QNotify || window.show;
            if (qn && qn.label) {
              qn.label.alert({
                title: 'Ujian Dibatalkan',
                message: 'Terlalu banyak pelanggaran!\n\nUjian akan direset ke halaman identitas dan soal diacak ulang.',
                intent: 'danger',
                okText: 'OK',
                onOk: () => { ExamGuardian.deactivate(); ExamLogic.resetUjian(); }
              });
            } else {
              console.warn('[MaxViolation] Ujian direset karena terlalu banyak pelanggaran.');
              ExamGuardian.deactivate();
              ExamLogic.resetUjian();
            }
          });

          // -- Timer display awal: sync dengan access_control.end (guru panel) --
          // Jika ada server end-time → hitung sisa real; jika tidak → durasi lokal.
          // onTimerTick sudah terdaftar di atas — ini hanya untuk render awal sebelum tick pertama.
          (function _initTimerDisplay() {
            const ac  = ujianData?.access_control;
            const end = _toDate(ac?.end);
            if (end && !isNaN(end.getTime())) {
              const sisaDetik = Math.max(0, Math.floor((end - new Date()) / 1000));
              ExamViewer.updateTimer(sisaDetik);
            } else {
              ExamViewer.updateTimer(ExamLogic.getState().durasi_menit * 60);
            }
          })();

          // -- Exam Pause Polling: deteksi guru pause ujian saat live -----------
          // Firestore onSnapshot ideal, tapi butuh koneksi persisten & quota lebih besar.
          // Polling setiap 30 detik adalah trade-off yang aman untuk exam context:
          // worst case peserta tahu terlambat 30 detik — masih jauh lebih baik dari tidak tahu.
          //
          // Kenapa tidak pakai onSnapshot dari ujianData yang ada?
          // ujianData di-fetch sekali ke sessionStorage — stale setelahnya.
          // Kita perlu hit Firestore langsung untuk baca status terkini.
          (function _startPausePolling() {
            let _isPaused       = false;
            let _pollInterval   = null;
            let _pauseLabelShown = false;

            // Cara tampilkan "Ujian dijeda" yang tidak bisa di-dismiss sendiri:
            // QNotify label.alert dengan onOk yang tidak melakukan apa-apa saat paused.
            // Ketika ujian dibuka kembali, polling akan hide label dan lanjutkan.
            // Karena label tidak bisa di-close secara programatik dari luar,
            // kita pakai overlay sederhana yang kita kontrol sendiri.
            function _showPauseBanner() {
              if (document.getElementById('examPauseBanner')) return;
              const banner = document.createElement('div');
              banner.id = 'examPauseBanner';
              banner.style.cssText = `
                position:fixed;inset:0;z-index:8000;
                background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);
                display:flex;align-items:center;justify-content:center;
                animation:overlayIn 0.25s ease;
              `;
              banner.innerHTML = `
                <div style="
                  background:white;border-radius:20px;padding:36px 32px;
                  max-width:360px;width:90%;text-align:center;
                  box-shadow:0 32px 80px rgba(0,0,0,0.4);
                ">
                  <div style="
                    width:64px;height:64px;border-radius:18px;
                    background:var(--amber-100);
                    display:flex;align-items:center;justify-content:center;
                    margin:0 auto 18px;font-size:28px;color:var(--amber-500);
                  ">
                    <i class="material-symbols-outlined">pause_circle</i>
                  </div>
                  <h2 style="font-size:18px;font-weight:800;color:var(--gray-900);margin-bottom:10px;">
                    Ujian Dijeda
                  </h2>
                  <p style="font-size:13px;color:var(--gray-500);line-height:1.65;margin-bottom:0;">
                    Guru menjeda sesi ujian ini.<br>
                    Tetap di halaman ini dan tunggu<br>
                    instruksi dari guru.
                  </p>
                  <div style="
                    margin-top:20px;padding:10px 14px;
                    background:var(--gray-100);border-radius:10px;
                    font-size:11px;color:var(--gray-400);font-weight:600;
                    display:flex;align-items:center;justify-content:center;gap:6px;
                  ">
                    <i style="font-size:10px;" class="material-symbols-outlined ms-spin">sync</i>
                    Menunggu ujian dibuka kembali...
                  </div>
                </div>
              `;
              document.body.appendChild(banner);
              _pauseLabelShown = true;
            }

            function _hidePauseBanner() {
              document.getElementById('examPauseBanner')?.remove();
              _pauseLabelShown = false;
            }

            async function _pollAccessStatus() {
              // Hanya poll saat ujian sedang aktif (bukan di result/identity phase)
              if (ExamLogic.getState().phase !== 'exam') return;

              try {
                const token = (typeof ExamData !== 'undefined') ? ExamData.getActiveToken() : null;
                if (!token) return;

                const db = window.firebaseDb;
                if (!db) return; // Firebase tidak tersedia — skip poll, jangan crash

                const snap = await db.collection('ujian').doc(token).get();
                if (!snap.exists) return;

                const ac = snap.data()?.access_control;
                if (!ac) return;

                // Evaluasi apakah akses masih terbuka berdasarkan data fresh dari server
                let isOpen = false;
                if (ac.override || ac.manual_status === 'open') {
                  // Cek juga apakah end-time belum lewat
                  if (ac.end) {
                    const end = _toDate(ac.end);
                    isOpen = !!end && new Date() < end;
                  } else {
                    isOpen = true;
                  }
                } else if (ac.mode === 'scheduled' && ac.scheduled?.active) {
                  const now   = Date.now();
                  const start = new Date(ac.scheduled.start).getTime();
                  const end   = new Date(ac.scheduled.end).getTime();
                  isOpen = now >= start && now <= end;
                }

                if (!isOpen && !_isPaused) {
                  // Baru saja di-pause
                  _isPaused = true;
                  _showPauseBanner();
                } else if (isOpen && _isPaused) {
                  // Dibuka kembali
                  _isPaused = false;
                  _hidePauseBanner();
                  _qn('success', 'Ujian Dilanjutkan', 'Guru membuka kembali sesi ujian. Lanjutkan mengerjakan soal.', 4000);
                }
              } catch (_) {
                // Gagal poll — skip diam-diam. Timer dan jawaban tetap jalan.
                // Jangan crash ujian karena polling gagal.
              }
            }

            // Poll pertama setelah 10 detik (beri waktu peserta settle),
            // lalu setiap 30 detik.
            const _firstPoll = setTimeout(_pollAccessStatus, 10_000);
            _pollInterval = setInterval(_pollAccessStatus, 30_000);

            // Bersihkan saat submit / halaman di-unload
            window.addEventListener('beforeunload', () => {
              clearTimeout(_firstPoll);
              clearInterval(_pollInterval);
            }, { once: true });

            // Juga bersihkan jika phase berubah ke identity (reset/violation)
            ExamLogic.onPhaseChange(() => {
              clearTimeout(_firstPoll);
              clearInterval(_pollInterval);
              _hidePauseBanner();
            });
          })();
        }
      });

      // 13. Page change
      ExamLogic.onPageChange((idx) => renderSoalPage(idx, 'right'));

      // Start
      renderIdentity(false);
    } catch (e) {
      if (e && e.message === 'SUBMIT_LOCKED') {
      } else { throw e; }
    }
    })();
