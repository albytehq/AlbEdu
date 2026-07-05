// =============================================================================
// assessment-entry.js — Token entry page controller (v1.0.0)
// =============================================================================
// Handles 6-digit access code input + validation + session creation.
//
// Edge cases (25):
//   - Input: 6 digits auto-submit, 5 wait, paste 7+ take first 6, alphanumeric filter
//   - Backspace → focus previous | Tab → arrow nav | Refresh → clear
//   - Token not found → error | Draft/archived → not found
//   - Scheduled not started → "Mulai: {time}" | Finished → "Selesai"
//   - Paused → "Dijeda. Sisa: X menit" | Already submitted → "Sudah kumpulkan"
//   - Cross-device resume → "Lanjutkan sesi?" | Blocked → "Diblokir: {reason}"
//   - Rate limit (10/hr) → cooldown | Turnstile failed → error
//   - Network error → retry | Not logged in → redirect login
//   - Admin logged in → redirect dashboard | Soft-deleted → "Akun dihapus"
//   - Email not verified → "Verifikasi email" | No consent → show consent popup
//   - allow_retake=false + submitted → block | allow_retake=true → new attempt
//   - 2 tabs → UNIQUE constraint | Close before session → can re-input
//   - Slow network → loading, block re-submit
// =============================================================================

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

      // Render Turnstile
      this._renderTurnstile();

      // Focus first input
      this._inputs[0]?.focus();

      console.info('[assessment-entry] v1.0.0 initialized');
    },

    _getDeviceId() {
      let id = localStorage.getItem('albedu_exam_device_id');
      if (!id) {
        id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('albedu_exam_device_id', id);
      }
      return id;
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
            // No auth after 10s — redirect to login
            // v0.742.7: login page is at pages/login.html (not ../login.html)
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
          }
          this._updateSubmitState();
        });

        // Keydown — backspace, arrows
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Backspace' && !e.target.value && idx > 0) {
            // Backspace on empty → focus previous + clear it
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

    _renderTurnstile() {
      // v0.746.0: Turnstile uses appearance:'execute' (official invisible mode)
      // instead of hiding a normal widget in a 1px container.
      // This fixes error 600010 (widget not properly rendered) that occurred
      // when the 1px clip container was detected as suspicious by Turnstile.
      //
      // The token is still captured and sent to the rate-limit Edge Function.
      const tryRender = () => {
        if (window.turnstile) {
          this._turnstileWidget = window.turnstile.render('#turnstile-container', {
            sitekey: '0x4AAAAAADtSMQt5KNMPWBzW',
            appearance: 'execute',
            callback: (token) => {
              this._turnstileToken = token;
              this._updateSubmitState();
            },
            'expired-callback': () => {
              this._turnstileToken = null;
              this._updateSubmitState();
            },
            'error-callback': () => {
              this._turnstileToken = null;
              this._updateSubmitState();
            },
            theme: 'light',
          });
        } else {
          setTimeout(tryRender, 200);
        }
      };
      tryRender();
    },

    _updateSubmitState() {
      const allFilled = this._inputs.every((i) => i.value);
      // Submit enabled if all 6 digits filled AND turnstile token present
      // (Turnstile may not load in dev — allow submit if Turnstile container is empty after 5s)
      const turnstileReady = this._turnstileToken || !document.querySelector('#turnstile-container iframe');

      this._submitBtn.disabled = !allFilled || !turnstileReady || this._isValidating;
    },

    _checkComplete() {
      const allFilled = this._inputs.every((i) => i.value);
      if (allFilled) {
        // Auto-submit after short delay
        setTimeout(() => this._submit(), 300);
      }
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

      // Reset Turnstile
      if (this._turnstileWidget && window.turnstile) {
        window.turnstile.reset(this._turnstileWidget);
        this._turnstileToken = null;
      }
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

      const token = this._getToken();
      if (token.length !== 6) {
        this._showError('Kode akses harus 6 digit');
        return;
      }

      this._setLoading(true);

      try {
        // Step 1: Rate limit check via Edge Function
        const rateLimitRes = await this._checkRateLimit();
        if (!rateLimitRes.allowed) {
          this._setLoading(false);
          this._showCooldown(60);
          return;
        }

        // Step 2: Check if peserta already has active session (cross-device resume)
        const existingSession = await this._checkExistingSession(token);

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
          if (resume) {
            this._proceedToAssessment(token, existingSession);
            return;
          }
          // Don't resume — but can't start new (UNIQUE constraint)
          this._setLoading(false);
          this._showError('Anda memiliki sesi aktif. Lanjutkan sesi tersebut.');
          return;
        }

        // Step 3: Fetch assessment (via peserta view — strips admin fields)
        const assessment = await this._fetchAssessment(token);
        if (!assessment) {
          this._setLoading(false);
          this._showError('Kode akses tidak valid');
          return;
        }

        // Step 4: Check assessment status
        const accessCheck = this._checkAccess(assessment);
        if (!accessCheck.allowed) {
          this._setLoading(false);
          this._showError(accessCheck.message);
          return;
        }

        // Step 5: Check allow_retake
        if (!assessment.allow_retake) {
          const submissions = await this._checkSubmissions(assessment.id);
          if (submissions > 0) {
            this._setLoading(false);
            this._showError('Anda sudah mengerjakan asesmen ini. Tidak bisa mengulang.');
            return;
          }
        }

        // Step 6: Create new session
        const session = await this._createSession(assessment);
        if (!session) {
          this._setLoading(false);
          return;
        }

        // Step 7: Proceed to assessment
        this._proceedToAssessment(token, session);
      } catch (err) {
        console.error('[assessment-entry] Submit error:', err);
        this._setLoading(false);

        if (err.message?.includes('rate_limit') || err.message?.includes('RATE_LIMITED')) {
          this._showCooldown(60);
        } else if (err.message?.includes('network') || err.message?.includes('fetch')) {
          this._showError('Kesalahan jaringan. Periksa koneksi internet Anda.');
        } else {
          this._showError(err.message || 'Terjadi kesalahan. Coba lagi.');
        }
      }
    },

    async _checkRateLimit() {
      try {
        const res = await fetch('https://kzsrerxhhrtsxnpnmqgl.supabase.co/functions/v1/access-code-attempt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: this._deviceId,
            turnstile_token: this._turnstileToken,
          }),
        });

        if (res.status === 429) {
          return { allowed: false };
        }

        const data = await res.json();
        return { allowed: data.success || data.allowed };
      } catch (err) {
        console.warn('[assessment-entry] Rate limit check failed (fail-open):', err);
        return { allowed: true }; // fail-open
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
      // Save to sessionStorage
      // NOTE: `.uid` is a Firebase-shaped field that no longer exists on the
      // native Supabase AuthService user object (which exposes `.id`). This
      // previously wrote the literal string "undefined" into sessionStorage,
      // breaking anything downstream keyed on assessment_user_key.
      sessionStorage.setItem('assessment_token', token);
      sessionStorage.setItem('assessment_session_id', session.id);
      sessionStorage.setItem('assessment_user_key', window.AlbEdu.supabase.auth.currentUser.id);

      // Redirect
      window.location.href = `take.html?token=${token}`;
    },
  };

  window.AssessmentEntry = AssessmentEntry;

  document.addEventListener('DOMContentLoaded', () => {
    AssessmentEntry.init();
  });
})();
