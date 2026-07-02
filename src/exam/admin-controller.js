// exam-admin-controller.js
// Controller untuk mengelola ujian dari Supabase secara real-time
// Version: 2.2.0 | Migrated: Firebase → Supabase (window.firebaseDb/firebaseAuth shim)

class ExamAdminController {
    constructor() {
        // Lazy init: SupabaseApi.js init async via fetch.
        // Defer all DB access to init() which is called after 'firebase-ready'.
        this.db           = null;
        this.auth         = null;
        this.currentUser  = null;
        this.exams        = new Map();   // kode_id → exam data
        this.activeTimers = {};          // kode_id → interval ID
        this.unsubscribe  = null;
        this.onExamUpdateCallback = null;
    }

    // Init is called AFTER firebase-ready and AFTER auth state is confirmed.
    async init(authenticatedUser) {
        this.db   = window.firebaseDb;
        this.auth = window.firebaseAuth;

        if (authenticatedUser) {
            this.currentUser = authenticatedUser;
            this.loadExamsRealtime();
            return;
        }

        // Fallback one-shot listener for edge cases where caller has no user ref
        return new Promise((resolve, reject) => {
            const unsub = this.auth.onAuthStateChanged(user => {
                unsub(); // critical: unsubscribe immediately, this is one-shot only
                if (user) {
                    this.currentUser = user;
                    this.loadExamsRealtime();
                    resolve();
                } else {
                    reject(new Error('Not authenticated'));
                }
            });
        });
    }

    loadExamsRealtime() {
        if (!this.currentUser || !this.db) return;

        // WHY no .where('createdBy') filter: ujian bersifat fully shared antar semua admin.
        // Setiap admin bisa lihat, kelola, dan monitor ujian dari admin manapun.
        // createdBy tetap tersimpan di dokumen untuk audit trail — kita hanya tidak filter by it.
        const query = this.db.collection('ujian')
            .orderBy('createdAt', 'desc');

        this.unsubscribe = query.onSnapshot(snapshot => {
            snapshot.docChanges().forEach(change => {
                const doc     = change.doc;
                const data    = doc.data();
                const kode_id = doc.id;

                if (change.type === 'added' || change.type === 'modified') {
                    data._status = this.calculateExamStatus(data.access_control);
                    // Pre-compute true question count so views don't need to re-derive it.
                    // PQ is a page-slot map: { pages1: identity, pages2: {questions:[...]}, ... }
                    // Object.keys().length gives PAGE count, not question count.
                    data._totalQuestions = this._countPQQuestions(data.PQ);
                    this.exams.set(kode_id, data);
                } else if (change.type === 'removed') {
                    this.exams.delete(kode_id);
                    this.stopCountdown(kode_id);
                }
            });

            this.onExamUpdateCallback?.(this.getExamsList());
        }, () => {
            if (window.notify) window.notify.error('Error', 'Gagal memuat ujian');
        });
    }

    calculateExamStatus(access_control) {
        if (!access_control) return 'NOT_STARTED';

        const { mode, manual_status, end, remaining_time, scheduled } = access_control;
        const now = new Date();

        // WHY: Supabase returns ISO strings; Firestore returned Timestamp objects.
        // Safely coerce any date value to a Date — handles both.
        if (mode === 'manual') {
            if (manual_status === 'open') {
                const endDate = this._coerceDate(end);
                return (endDate && endDate > now) ? 'RUNNING' : 'FINISHED';
            } else if (manual_status === 'closed') {
                return (remaining_time != null && remaining_time > 0) ? 'PAUSED' : 'NOT_STARTED';
            }
        } else if (mode === 'scheduled') {
            if (scheduled?.active) {
                const start  = this._coerceDate(scheduled.start);
                const endSch = this._coerceDate(scheduled.end);
                if (!start || !endSch) return 'NOT_STARTED';
                if (now < start)                   return 'NOT_STARTED';
                if (now >= start && now <= endSch) return 'RUNNING';
                return 'FINISHED';
            }
        }

        return 'NOT_STARTED';
    }

    async startManualExam(kode_id, duration) {
        const now = new Date();
        const end = new Date(now.getTime() + duration * 60_000);

        await this.db.collection('ujian').doc(kode_id).update({
            'access_control.mode':             'manual',
            'access_control.manual_status':    'open',
            'access_control.manual_open_time': now.toISOString(),
            'access_control.end':              end.toISOString(),
            'access_control.override':         true,
            'access_control.scheduled.active': false,
            'access_control.remaining_time':   null,
        });
    }

    async pauseExam(kode_id) {
        const examRef = this.db.collection('ujian').doc(kode_id);
        const doc     = await examRef.get();
        if (!doc.exists) throw new Error('Ujian tidak ditemukan');

        // Reuse the same coercion path as status calculation so migrated ISO
        // strings and any legacy Timestamp-like values behave identically.
        const endRaw    = doc.data().access_control?.end;
        const end       = this._coerceDate(endRaw);
        const remaining = (end && end > new Date())
            ? Math.floor((end - Date.now()) / 1000)  // FIX BUG-17: seconds not minutes
            : 0;

        await examRef.update({
            'access_control.manual_status':  'closed',
            'access_control.remaining_time': remaining,
            'access_control.end':            null,
        });

        return remaining;
    }

    async resumeExam(kode_id) {
        const examRef = this.db.collection('ujian').doc(kode_id);
        const doc     = await examRef.get();
        if (!doc.exists) throw new Error('Ujian tidak ditemukan');

        const remaining = doc.data().access_control?.remaining_time || 0;
        if (remaining <= 0) throw new Error('Tidak ada sisa waktu');

        // FIX BUG-17: remaining_time sekarang disimpan dalam detik (bukan menit)
        // Sehingga remaining * 1000 = milliseconds yang benar untuk new Date()
        const end = new Date(Date.now() + remaining * 1000);

        await examRef.update({
            'access_control.manual_status':  'open',
            'access_control.end':            end.toISOString(),
            'access_control.remaining_time': null,
        });

        return remaining;
    }

    async finishExam(kode_id) {
        await this.db.collection('ujian').doc(kode_id).update({
            'access_control.manual_status':  'closed',
            'access_control.end':            new Date().toISOString(),
            'access_control.remaining_time': null,
        });
    }

    async updateExamMeta(kode_id, { judul, mata_pelajaran, durasi, catatan }) {
        if (!kode_id) throw new Error('kode_id diperlukan');

        const examRef = this.db.collection('ujian').doc(kode_id);
        const doc     = await examRef.get();
        if (!doc.exists) throw new Error('Ujian tidak ditemukan');

        // WHY dual-write:
        //   The ujian row has BOTH flat top-level columns (judul, mata_pelajaran)
        //   for fast listing queries AND a nested JSONB column (ujian.judul, ujian.mata_pelajaran)
        //   for the exam runtime. We must keep both in sync or the card shows
        //   stale data while the exam page shows the correct updated data.
        //
        //   Dot-notation keys ("ujian.judul") go through _expandDotNotation →
        //   JSONB deep-merge in _docRef.update(). Flat keys (judul) update the
        //   denormalized top-level column directly. Both happen in one .update() call.
        const payload = { updatedAt: this.db.FieldValue.serverTimestamp() };

        if (judul?.trim()) {
            payload.judul          = judul.trim();     // flat top-level column (listing)
            payload['ujian.judul'] = judul.trim();     // nested JSONB path (runtime)
        }
        if (mata_pelajaran?.trim()) {
            payload.mata_pelajaran          = mata_pelajaran.trim();
            payload['ujian.mata_pelajaran'] = mata_pelajaran.trim();
        }
        if (durasi != null && !isNaN(parseInt(durasi)) && parseInt(durasi) > 0) {
            const d = parseInt(durasi);
            payload['ujian.time']               = String(d);   // ujian.time stored as string
            payload['access_control.duration']  = d;
        }
        if (catatan != null) {
            const note = catatan.trim();
            payload['ujian.catatan']    = note ? 'On' : 'Off';
            payload['ujian.is_catatan'] = note;
        }

        await examRef.update(payload);
    }

    async deleteExam(kode_id) {
        const doc      = await this.db.collection('ujian').doc(kode_id).get();
        const examData = doc.exists ? doc.data() : null;

        if (!doc.exists) throw new Error('Ujian tidak ditemukan');

        // Fully shared: admin manapun boleh hapus ujian milik siapapun.
        // Clean up CDN images first — fail silently if ImageCleanup isn't available.
        if (examData && typeof ImageCleanup !== 'undefined') {
            await ImageCleanup.deleteExamImages(examData).catch(() => {});
        }

        await this.db.collection('ujian').doc(kode_id).delete();
    }

    getExamsList() {
        return Array.from(this.exams.entries()).map(([kode_id, data]) => ({
            id: kode_id,
            ...data,
        }));
    }

    // Counts real questions across all PQ section pages.
    // Stored as data._totalQuestions on each exam for quick access.
    _countPQQuestions(PQ) {
        if (!PQ || typeof PQ !== 'object') return 0;
        let total = 0;
        Object.values(PQ).forEach(page => {
            if (page && Array.isArray(page.questions)) total += page.questions.length;
        });
        return total;
    }

    getExam(kode_id) {
        return this.exams.get(kode_id);
    }

    _coerceDate(value) {
        if (!value) return null;
        if (value instanceof Date) return value;
        if (typeof value.toDate === 'function') return value.toDate();
        if (value.seconds != null) return new Date(value.seconds * 1000);
        const parsed = new Date(value);
        return isNaN(parsed.getTime()) ? null : parsed;
    }

    getExamStats() {
        const exams = this.getExamsList();
        return {
            total:      exams.length,
            notStarted: exams.filter(e => e._status === 'NOT_STARTED').length,
            running:    exams.filter(e => e._status === 'RUNNING').length,
            paused:     exams.filter(e => e._status === 'PAUSED').length,
            finished:   exams.filter(e => e._status === 'FINISHED').length,
        };
    }

    startCountdown(kode_id, endTime, onTick, onFinish) {
        this.stopCountdown(kode_id);

        const end = new Date(endTime);
        if (isNaN(end)) return;

        const interval = setInterval(() => {
            const diff = end - Date.now();

            if (diff <= 0) {
                clearInterval(interval);
                delete this.activeTimers[kode_id];

                // Optimistically update local status while waiting for Firestore onSnapshot
                const exam = this.exams.get(kode_id);
                if (exam) {
                    exam._status = 'FINISHED';
                    this.onExamUpdateCallback?.(this.getExamsList());
                }

                onFinish?.(kode_id);
            } else {
                onTick?.(kode_id, Math.floor(diff / 60_000), Math.floor((diff % 60_000) / 1000), diff);
            }
        }, 1000);

        this.activeTimers[kode_id] = interval;
    }

    stopCountdown(kode_id) {
        if (this.activeTimers[kode_id]) {
            clearInterval(this.activeTimers[kode_id]);
            delete this.activeTimers[kode_id];
        }
    }

    stopAllCountdowns() {
        Object.keys(this.activeTimers).forEach(id => this.stopCountdown(id));
    }

    async startMultipleExams(examIds, durations = []) {
        const results = { success: [], failed: [] };
        for (let i = 0; i < examIds.length; i++) {
            try   { await this.startManualExam(examIds[i], durations[i] || 60); results.success.push(examIds[i]); }
            catch { results.failed.push(examIds[i]); }
        }
        return results;
    }

    async pauseMultipleExams(examIds) {
        const results = { success: [], failed: [] };
        for (const id of examIds) {
            try   { await this.pauseExam(id); results.success.push(id); }
            catch { results.failed.push(id); }
        }
        return results;
    }

    destroy() {
        this.stopAllCountdowns();
        this.unsubscribe?.();
        this.unsubscribe = null;
    }
}
