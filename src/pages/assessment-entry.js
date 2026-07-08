// assessment-entry.js — 6-digit access-code entry page. Validates the token,
// resolves the assessment, runs anti-bot checks, creates/resumes a session,
// then redirects to take.html.

(function () {
  'use strict';

  const t = (key, vars, fallback) => fallback;

  const AssessmentEntry = {
    _inputs: [],
    _submitBtn: null,
    _submitText: null,
    _cooldownBanner: null,
    _cooldownText: null,
    _turnstileWidget: null,
    _turnstileToken: null,
    _isValidating: false,
    _deviceId: null,
    _formOpenTime: 0,
    _honeypotFilled: false,
    _autoSubmitTimer: null,
    _submitGeneration: 0,

    async init() {
      this._inputs = Array.from(document.querySelectorAll('.token-input'));
      this._submitBtn = document.getElementById('token-submit');
      this._submitText = document.getElementById('submit-text');
      this._cooldownBanner = document.getElementById('cooldown-banner');
      this._cooldownText = document.getElementById('cooldown-text');

      // Get or create device ID
      this._deviceId = this._getDeviceId();

      // Wait for auth
      await this._waitForAuth();

      // Check consent (UU PDP)
      const consentOk = await window.Consent?.check();
      if (!consentOk) return; // consent rejected, user logged out

      // Wire events
      this._wireEvents();

      // Record form open time for timing check (anti-bot)
      this._formOpenTime = Date.now();

      // Setup honeypot (hidden field that bots fill, humans don't)
      this._setupHoneypot();

      // Focus first input
      this._inputs[0]?.focus();

      console.info('[assessment-entry] initialized');
    },

    _getDeviceId() {
      // Safari Private Mode throws on setItem when quota=0. Fall back to
      // an in-memory value so the rest of the flow doesn't crash.
      try {
        let id = localStorage.getItem('albedu_exam_device_id');
        if (!id) {
          id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
          localStorage.setItem('albedu_exam_device_id', id);
        }
        return id;
      } catch (err) {
        if (!this._fallbackDeviceId) {
          this._fallbackDeviceId = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
        return this._fallbackDeviceId;
      }
    },

    _waitForAuth() {
      return new Promise((resolve) => {
        let attempts = 0;
        const check = () => {
          attempts++;
          if (window.AlbEdu?.supabase?.auth?.currentUser) {
            resolve();
          } else if (window.Auth?.authReady === false && attempts < 100) {
            setTimeout(check, 100);
          } else if (attempts >= 100) {
            // No auth after 10s — redirect to login.
            console.warn('[assessment-entry] Auth timeout, redirecting to login');
            const basePath = window.Auth?.getBasePath?.() || '/';
            window.location.href = basePath + 'pages/login.html';
            resolve();
          } else {
            setTimeout(check, 100);
          }
        };
        check();
      });
    },

    _wireEvents() {
      // Input events
      this._inputs.forEach((input, idx) => {
        // Input — auto-advance
        input.addEventListener('input', (e) => {
          const val = e.target.value;
          // Filter digits only
          const digit = val.replace(/\D/g, '').slice(-1);
          e.target.value = digit;

          if (digit) {
            e.target.classList.add('filled');
            // Auto-advance to next
            if (idx < this._inputs.length - 1) {
              this._inputs[idx + 1].focus();
            } else {
              // Last digit — check if all filled
              this._checkComplete();
            }
          } else {
            e.target.classList.remove('filled');
            clearTimeout(this._autoSubmitTimer);
          }
          this._updateSubmitState();
        });

        // Keydown — backspace, arrows
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && idx > 0) {
            // Backspace on empty → focus previous + clear it
            clearTimeout(this._autoSubmitTimer);
            this._inputs[idx - 1].focus();
            this._inputs[idx - 1].value = '';
            this._inputs[idx - 1].classList.remove('filled');
            this._updateSubmitState();
            e.preventDefault();
          } else if (e.key === 'ArrowLeft' && idx > 0) {
            this._inputs[idx - 1].focus();
            e.preventDefault();
          } else if (e.key === 'ArrowRight' && idx < this._inputs.length - 1) {
            this._inputs[idx + 1].focus();
            e.preventDefault();
          } else if (e.key === 'Enter') {
            this._submit();
          }
        });

        // Paste — distribute digits
        input.addEventListener('paste', (e) => {
          e.preventDefault();
          const pasted = (e.clipboardData || window.clipboardData).getData('text');
          const digits = pasted.replace(/\D/g, '').slice(0, 6);

          // Distribute digits across inputs starting from current
          digits.split('').forEach((d, i) => {
            if (idx + i < this._inputs.length) {
              this._inputs[idx + i].value = d;
              this._inputs[idx + i].classList.add('filled');
            }
          });

          // Focus last filled or next empty
          const lastFilled = Math.min(idx + digits.length, this._inputs.length - 1);
          this._inputs[lastFilled]?.focus();

          this._updateSubmitState();
          this._checkComplete();
        });

        // Focus — select content
        input.addEventListener('focus', (e) => {
          e.target.select();
        });
      });

      // Submit button
      this._submitBtn.addEventListener('click', () => this._submit());
    },

    _setupHoneypot() {
      // Create hidden honeypot field — if filled, it's a bot
      const honeypot = document.createElement('input');
      honeypot.type = 'text';
      honeypot.name = 'website_url'; // bots love filling "website" fields
      honeypot.setAttribute('autocomplete', 'off');
      honeypot.setAttribute('tabindex', '-1');
      honeypot.setAttribute('aria-hidden', 'true');
      honeypot.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
      honeypot.addEventListener('input', () => { this._honeypotFilled = true; });
      document.body.appendChild(honeypot);
    },

    _updateSubmitState() {
      const allFilled = this._inputs.every((i) => i.value);
      this._submitBtn.disabled = !allFilled || this._isValidating;
    },

    _checkComplete() {
      const allFilled = this._inputs.every((i) => i.value);
      this._updateSubmitState();
      if (allFilled) {
        // Auto-submit once all 6 digits are present (typed or pasted). The
        // minimum-interaction anti-bot timing used to reject fast completions,
        // which is why auto-submit was removed before. We now wait out the
        // remainder of that window inside _submit() instead of failing — so
        // real users get an auto-submit and bots still can't shortcut the
        // timing signal.
        this._autoSubmit();
      }
    },

    _autoSubmit() {
      // Small debounce so the last digit's UI state settles and so rapid
      // fill/backspace/re-fill sequences don't queue up multiple submits.
      clearTimeout(this._autoSubmitTimer);
      this._autoSubmitTimer = setTimeout(() => {
        const stillFilled = this._inputs.every((i) => i.value);
        if (stillFilled && !this._isValidating) {
          this._submit();
        }
      }, 150);
    },

    _getToken() {
      return this._inputs.map((i) => i.value).join('');
    },

    _setLoading(loading) {
      this._isValidating = loading;
      this._submitBtn.disabled = loading;
      const submittingText = 'Memvalidasi...';
      const submitText = 'Masuk Asesmen';
      this._submitText.textContent = loading ? submittingText : submitText;
      this._inputs.forEach((i) => (i.disabled = loading));
    },

    _showError(message) {
      // Cancel any pending auto-submit so it can't fire again right after
      // the inputs are cleared below.
      clearTimeout(this._autoSubmitTimer);

      // Shake animation on inputs
      this._inputs.forEach((i) => {
        i.classList.add('error');
        setTimeout(() => i.classList.remove('error'), 400);
      });

      window.notify?.error(t('wizard.title_failed', null, 'Gagal'), message, 4000);

      // Clear all inputs
      this._inputs.forEach((i) => {
        i.value = '';
        i.classList.remove('filled');
      });
      this._inputs[0].focus();
      this._updateSubmitState();
    },

    _showCooldown(seconds) {
      this._cooldownBanner.classList.add('show');
      const update = () => {
        if (seconds <= 0) {
          this._cooldownBanner.classList.remove('show');
          return;
        }
        const tmpl = 'Terlalu banyak percobaan. Coba lagi dalam {{seconds}} detik.';
        this._cooldownText.textContent = tmpl.replace('{{seconds}}', seconds);
        seconds--;
        setTimeout(update, 1000);
      };
      update();
    },

    async _submit() {
      if (this._isValidating) return;

      let token = this._getToken();
      if (token.length !== 6) {
        this._showError('Kode akses harus 6 digit');
        return;
      }

      // Anti-bot check 1: Honeypot — if filled, silently reject
      if (this._honeypotFilled) {
        console.warn('[assessment-entry] Honeypot triggered — likely bot');
        this._showError('Kode akses tidak valid');
        return;
      }

      // Lock the form immediately. This guards against a double-submit race
      // between the auto-submit timer and a manual button click (or two
      // auto-submit triggers), since _isValidating is checked at the top of
      // this function and _setLoading() is what flips it to true.
      this._setLoading(true);

      // Anti-bot check 2: Timing — the form must have been open at least
      // MIN_INTERACTION_MS before we contact the backend. Bots that fill all
      // 6 digits programmatically do it in well under this window; real
      // users typing or pasting fast should never be shown an error for it.
      // Instead of rejecting a fast completion, wait out whatever remains of
      // the window — this is what makes auto-submit-on-6-digits safe.
      const MIN_INTERACTION_MS = 800;
      const elapsed = Date.now() - this._formOpenTime;
      if (elapsed < MIN_INTERACTION_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_INTERACTION_MS - elapsed));
      }

      // The token can change while we were waiting out the timing window
      // (for example the user hit backspace right after auto-submit queued) —
      // re-read and re-validate before doing any network work.
      token = this._getToken();
      if (token.length !== 6) {
        this._setLoading(false);
        return;
      }
      if (this._honeypotFilled) {
        this._setLoading(false);
        console.warn('[assessment-entry] Honeypot triggered — likely bot');
        this._showError('Kode akses tidak valid');
        return;
      }

      // Hard watchdog so no matter what hangs downstream (slow query,
      // misbehaving RLS, dead endpoint), the user gets their UI back within
      // SUBMIT_WATCHDOG_MS instead of staring at "Memvalidasi..." forever.
      const myGen = ++this._submitGeneration;
      const SUBMIT_WATCHDOG_MS = 15000;

      try {
        await this._withTimeout(this._runSubmitFlow(token, myGen), SUBMIT_WATCHDOG_MS, 'SUBMIT_WATCHDOG');
      } catch (err) {
        if (myGen !== this._submitGeneration) return; // a newer attempt has already taken over

        console.error('[assessment-entry] Submit error:', err);
        this._setLoading(false);

        if (err.message === 'SUBMIT_WATCHDOG') {
          this._showError('Server tidak merespons. Periksa koneksi internet Anda dan coba lagi.');
        } else if (err.message?.includes('rate_limit') || err.message?.includes('RATE_LIMITED')) {
          this._showCooldown(60);
        } else if (err.message?.includes('network') || err.message?.includes('fetch')) {
          this._showError('Kesalahan jaringan. Periksa koneksi internet Anda.');
        } else {
          this._showError(err.message || 'Terjadi kesalahan. Coba lagi.');
        }
      }
    },

    // True if a newer submit attempt has started since `myGen` began.
    _isStale(myGen) {
      return myGen !== this._submitGeneration;
    },

    async _runSubmitFlow(token, myGen) {
      // Rate limit check via Edge Function
      const rateLimitRes = await this._checkRateLimit();
      if (this._isStale(myGen)) return;
      if (!rateLimitRes.allowed) {
        this._setLoading(false);
        this._showCooldown(rateLimitRes.retry_after || 60);
        return;
      }

      // Cross-device resume: peserta may already have an active session.
      const existingSession = await this._checkExistingSession(token);
      if (this._isStale(myGen)) return;

      if (existingSession) {
        if (existingSession.status === 'submitted') {
          this._setLoading(false);
          this._showError('Anda sudah mengumpulkan asesmen ini.');
          return;
        }
        if (existingSession.status === 'blocked') {
          this._setLoading(false);
          this._showError(`Akses diblokir: ${existingSession.blocked_reason || 'Diblokir admin'}`);
          return;
        }
        // Active or paused session — offer resume
        const resume = await this._confirmResume();
        if (this._isStale(myGen)) return;
        if (resume) {
          this._proceedToAssessment(token, existingSession);
          return;
        }
        // Don't resume — but can't start new (UNIQUE constraint)
        this._setLoading(false);
        this._showError('Anda memiliki sesi aktif. Lanjutkan sesi tersebut.');
        return;
      }

      // Fetch assessment via peserta view (strips admin fields like total_score, ac_override).
      const assessment = await this._fetchAssessment(token);
      if (this._isStale(myGen)) return;
      if (!assessment) {
        this._setLoading(false);
        this._showError('Kode akses tidak valid');
        return;
      }

      // Check assessment access (open / closed / paused / scheduled)
      const accessCheck = this._checkAccess(assessment);
      if (!accessCheck.allowed) {
        this._setLoading(false);
        this._showError(accessCheck.message);
        return;
      }

      // allow_retake=false: has the peserta already submitted?
      if (!assessment.allow_retake) {
        const submissions = await this._checkSubmissions(assessment.id);
        if (this._isStale(myGen)) return;
        if (submissions > 0) {
          this._setLoading(false);
          this._showError('Anda sudah mengerjakan asesmen ini. Tidak bisa mengulang.');
          return;
        }
      }

      // Create new session
      const session = await this._createSession(assessment);
      if (this._isStale(myGen)) return;
      if (!session) {
        this._setLoading(false);
        return;
      }

      // Hand off to the exam runtime.
      this._proceedToAssessment(token, session);
    },

    async _checkRateLimit() {
      // This used to fetch a HARDCODED Supabase project URL
      // ('kzsrerxhhrtsxnpnmqgl.supabase.co') that has nothing to do with the
      // project this app actually connects to (that URL is loaded dynamically
      // from the Cloudflare Worker config in supabase-client.js). If that
      // hardcoded project is unreachable, paused, or simply not yours, the
      // fetch had NO TIMEOUT and could hang indefinitely — which is exactly
      // what froze the submit button on "Memvalidasi..." forever.
      //
      // We now call the Edge Function through window.AlbEdu.supabase (which
      // always targets the correctly configured project) AND wrap it in a
      // hard timeout so this check can never block the submit flow again.
      try {
        const fingerprintHash = await this._generateFingerprintHash();
        const body = {
          device_id: this._deviceId,
          fingerprint_hash: fingerprintHash,
          form_open_ms: Date.now() - this._formOpenTime,
        };

        if (!window.AlbEdu?.supabase?.rpc?.invoke) {
          throw new Error('Supabase client not ready');
        }

        const { data, error } = await this._withTimeout(
          window.AlbEdu.supabase.rpc.invoke('access-code-attempt', body),
          8000,
          'RATE_LIMIT_TIMEOUT'
        );

        if (error) {
          // supabase-js surfaces non-2xx Edge Function responses as `error`,
          // with the actual HTTP response reachable via error.context.
          const status = error.context?.status;
          if (status === 429) {
            const payload = await error.context?.json?.().catch(() => ({})) || {};
            return { allowed: false, retry_after: payload.retry_after || 60 };
          }
          throw error;
        }

        return { allowed: data?.success ?? data?.allowed ?? true };
      } catch (err) {
        console.warn('[assessment-entry] Rate limit check failed (fail-open):', err);
        return { allowed: true }; // fail-open — don't block legit users on network error
      }
    },

    // Race a promise against a timeout so slow/hanging network calls can
    // never freeze the UI forever. Rejects with an Error whose message is
    // `label` if the timeout wins.
    _withTimeout(promise, ms, label) {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    },

    async _generateFingerprintHash() {
      // Lightweight client fingerprint — NOT for tracking, for bot detection only
      // Combines screen + timezone + language + platform into a simple hash
      try {
        const parts = [
          screen.width + 'x' + screen.height,
          screen.colorDepth,
          Intl.DateTimeFormat().resolvedOptions().timeZone,
          navigator.language,
          navigator.platform,
          navigator.hardwareConcurrency || 0,
          new Date().getTimezoneOffset(),
        ];
        const str = parts.join('|');
        // Simple hash (not crypto-secure, just for uniqueness)
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
          const char = str.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash; // Convert to 32bit integer
        }
        return 'fp_' + Math.abs(hash).toString(36);
      } catch {
        return 'fp_unknown';
      }
    },

    async _checkExistingSession(token) {
      const repo = window.AlbEdu?.repository;
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      if (!repo || !user) return null;

      try {
        // Find assessment by access_code (view is keyed by access_code)
        const assessmentDoc = await repo.getDoc('assessment_view_peserta', token, 'access_code');
        if (!assessmentDoc.exists) return null;

        const assessmentId = assessmentDoc.id;

        // Check for existing session
        const sessionSnap = await repo.getDocs('assessment_sessions', {
          eq: { assessment_id: assessmentId, user_id: user.id },
          order: { column: 'created_at', ascending: false },
          limit: 1,
        });

        if (sessionSnap.empty) return null;

        const doc = sessionSnap.docs[0];
        return { id: doc.id, ...doc.data() };
      } catch (err) {
        console.warn('[assessment-entry] checkExistingSession error:', err);
        return null;
      }
    },

    async _confirmResume() {
      return new Promise((resolve) => {
        if (window.notify?.confirm) {
          window.notify.confirm({
            title: t('assessment.resume_title', null, 'Lanjutkan sesi?'),
            message: t('assessment.resume_msg', null, 'Anda memiliki sesi sebelumnya yang belum selesai. Lanjutkan?'),
            intent: 'primary',
            onYes: () => resolve(true),
            onNo: () => resolve(false),
            onClose: () => resolve(false),
          });
        } else {
          resolve(confirm(t('assessment.resume_short', null, 'Lanjutkan sesi sebelumnya?')));
        }
      });
    },

    async _fetchAssessment(token) {
      const repo = window.AlbEdu?.repository;
      if (!repo) return null;

      try {
        // Use peserta view (strips admin fields like total_score, ac_override)
        const doc = await repo.getDoc('assessment_view_peserta', token, 'access_code');
        if (!doc.exists) return null;
        return { id: doc.id, ...doc.data() };
      } catch (err) {
        console.error('[assessment-entry] fetchAssessment error:', err);
        return null;
      }
    },

    _checkAccess(assessment) {
      const now = Date.now();

      // Check assessment status
      if (assessment.status !== 'active') {
        return { allowed: false, message: t('assessment.not_found_msg', null, 'Asesmen tidak ditemukan') };
      }

      // Check access mode
      if (assessment.access_mode === 'manual') {
        if (assessment.ac_manual_status === 'closed') {
          if (assessment.ac_end && new Date(assessment.ac_end).getTime() < now) {
            return { allowed: false, message: t('assessment.closed_session_ended_msg', null, 'Asesmen sudah selesai') };
          }
          if (assessment.ac_remaining_time && assessment.ac_remaining_time > 0) {
            const mins = Math.floor(assessment.ac_remaining_time / 60);
            return { allowed: false, message: t('assessment.paused_msg', { mins }, `Asesmen dijeda. Sisa waktu: ${mins} menit.`) };
          }
          return { allowed: false, message: t('assessment.closed_session_msg', null, 'Asesmen belum dimulai. Tunggu admin memulai.') };
        }
        if (assessment.ac_manual_status === 'finished') {
          return { allowed: false, message: t('assessment.closed_session_ended_msg', null, 'Asesmen sudah selesai') };
        }
        // ac_manual_status === 'open'
        if (assessment.ac_end && new Date(assessment.ac_end).getTime() < now) {
          return { allowed: false, message: t('assessment.closed_session_ended_msg', null, 'Asesmen sudah selesai') };
        }
      } else if (assessment.access_mode === 'scheduled') {
        const start = assessment.ac_scheduled_start ? new Date(assessment.ac_scheduled_start).getTime() : null;
        const end = assessment.ac_scheduled_end ? new Date(assessment.ac_scheduled_end).getTime() : null;

        if (start && now < start) {
          const locale = ('id' || 'id') === 'en' ? 'en-US' : 'id-ID';
          const startStr = new Date(start).toLocaleString(locale, {
            day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
          });
          return { allowed: false, message: t('assessment.not_started_with_time', { time: startStr }, `Asesmen belum dimulai. Mulai: ${startStr}`) };
        }
        if (end && now > end) {
          return { allowed: false, message: t('assessment.closed_session_ended_msg', null, 'Asesmen sudah selesai') };
        }
      }

      return { allowed: true };
    },

    async _checkSubmissions(assessmentId) {
      const repo = window.AlbEdu?.repository;
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      if (!repo || !user) return 0;

      try {
        const snap = await repo.getDocs('submissions', {
          eq: { assessment_id: assessmentId, user_id: user.id },
        });
        return snap.size;
      } catch {
        return 0;
      }
    },

    async _createSession(assessment) {
      const repo = window.AlbEdu?.repository;
      const user = window.AlbEdu?.supabase?.auth?.currentUser;
      if (!repo || !user) return null;

      try {
        // Determine attempt_number
        const existingSnap = await repo.getDocs('assessment_sessions', {
          eq: { assessment_id: assessment.id, user_id: user.id },
        });
        const attemptNumber = existingSnap.size + 1;

        const nowIso = new Date().toISOString();
        const sessionData = {
          assessment_id: assessment.id,
          user_id: user.id,
          user_email: user.email,
          identity_snapshot: null, // filled when peserta submits identity form
          device_id: this._deviceId,
          ip_address: null, // server fills via Edge Function
          user_agent: navigator.userAgent,
          status: 'active',
          started_at: nowIso,
          last_heartbeat_at: nowIso,
          current_section: 0,
          current_question: 0,
          progress_pct: 0,
          violation_count: 0,
          draft_answers: {},
          attempt_number: attemptNumber,
          created_at: nowIso,
          updated_at: nowIso,
        };

        const docRef = await repo.addDoc('assessment_sessions', sessionData);
        return { id: docRef.id, ...sessionData };
      } catch (err) {
        console.error('[assessment-entry] createSession error:', err);

        // Check for UNIQUE constraint violation (active session already exists)
        if (err.message?.includes('unique') || err.message?.includes('23505')) {
          this._showError(t('assessment.active_session_exists', null, 'Anda sudah memiliki sesi aktif. Lanjutkan sesi tersebut.'));
        } else {
          this._showError(t('assessment.create_session_failed', null, 'Gagal membuat sesi. Coba lagi.'));
        }
        return null;
      }
    },

    _proceedToAssessment(token, session) {
      // `.uid` is a Firebase-shaped field that no longer exists on the native
      // Supabase user object (which exposes `.id`). Storing the literal
      // string "undefined" here would break downstream lookups.
      const userId = window.AlbEdu?.supabase?.auth?.currentUser?.id;
      try {
        sessionStorage.setItem('assessment_token', token);
        sessionStorage.setItem('assessment_session_id', session.id);
        if (userId) sessionStorage.setItem('assessment_user_key', userId);
      } catch (err) {
        console.warn('[assessment-entry] sessionStorage unavailable, continuing without cache:', err);
      }

      window.location.href = `take.html?token=${token}`;
    },
  };

  window.AssessmentEntry = AssessmentEntry;

  document.addEventListener('DOMContentLoaded', () => {
    AssessmentEntry.init();
  });
})();
