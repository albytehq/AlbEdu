/**
 * WizardValidation — AlbEdu v0.4.1
 *
 * SOFT validation system:
 *   - validateStep(n) → { isValid, errors }        (hard blocking errors only)
 *   - validateStepWarnings(n) → { warnings }       (non-critical issues)
 *   - validateAllBackground() → { steps }          (full scan, runs in bg)
 *
 * Status taxonomy per step:
 *   'complete'      → all required fields valid, no warnings
 *   'warning'       → required valid, but soft issues exist
 *   'incomplete'    → required fields missing/invalid
 *   'empty'         → step untouched
 */
const WizardValidation = (() => {

    const stripHtml = (html) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        return div.textContent || div.innerText || '';
    };

    // ── Step 1: Identitas ────────────────────────────────────────────────────
    const validateStep1 = () => {
        const errors   = {};
        const warnings = {};
        const state    = WizardState.getState();
        const ujian    = state.examData.ujian;
        const ac       = state.examData.access_control;

        if (!ujian.judul)           errors.judul         = 'Judul ujian harus diisi';
        else if (ujian.judul.length < 5) warnings.judul  = 'Judul sangat pendek (min. 5 karakter)';

        if (!ujian.mata_pelajaran)  errors.mataPelajaran = 'Mata pelajaran harus diisi';

        // v2.0.0 — identity_mode + identity_config validation (replaces kelas)
        const mode = ujian.identity_mode;
        if (!mode || (mode !== 'manual' && mode !== 'daftar')) {
            errors.identityMode = 'Mode identitas harus dipilih (Manual atau Daftar)';
        } else if (mode === 'manual') {
            const fields = ujian.identity_config?.fields || [];
            if (!Array.isArray(fields) || fields.length === 0) {
                errors.identityFields = 'Manual mode: minimal 1 field harus dibuat';
            } else {
                // Minimal 1 field dengan label mengandung "nama"
                const hasNamaField = fields.some(f =>
                    (f.label || '').toLowerCase().includes('nama')
                );
                if (!hasNamaField) {
                    errors.identityFields = 'Minimal 1 field harus punya label yang mengandung kata "nama"';
                }
            }
        } else if (mode === 'daftar') {
            if (!ujian.identity_config?.daftar_id) {
                errors.identityDaftar = 'Daftar mode: pilih daftar nama terlebih dahulu';
            }
        }

        if (!ujian.mode_pembuka)    errors.modePembuka   = 'Mode pembuka harus dipilih';

        const waktu = parseInt(ujian.time) || 0;
        if (isNaN(waktu) || waktu < 1 || waktu > 120)
            errors.waktuUjian = 'Waktu ujian harus diisi antara 1–120 menit';

        if (ujian.catatan === 'On') {
            if (!ujian.is_catatan || ujian.is_catatan.trim() === '')
                errors.catatan = 'Isi catatan harus diisi jika catatan aktif';
            else if (ujian.is_catatan.length > 500)
                errors.catatan = 'Catatan maksimal 500 karakter';
        }

        if (ujian.mode_pembuka === 'Otomatis') {
            const { start, end } = ac.scheduled || {};
            if (!start)        errors.tanggalMulai   = 'Tanggal dan jam mulai harus diisi';
            if (!end)          errors.tanggalSelesai = 'Tanggal dan jam selesai harus diisi';
            if (start && end) {
                const s = new Date(start), e = new Date(end);
                if (!isNaN(s) && !isNaN(e)) {
                    if (e <= s) {
                        errors.tanggalSelesai = 'Waktu selesai harus setelah waktu mulai';
                    } else {
                        const diffMin = Math.round((e - s) / 60000);
                        if (!isNaN(waktu) && diffMin !== waktu)
                            errors.waktuUjian = `Durasi ujian (${waktu} mnt) ≠ jadwal (${diffMin} mnt)`;
                    }
                }
            }
        }

        return { errors, warnings };
    };

    // ── Step 2: Tema (always valid, no requirements) ──────────────────────────
    const validateStep2 = () => ({ errors: {}, warnings: {} });

    // ── Step 3: Soal ─────────────────────────────────────────────────────────
    const validateStep3 = () => {
        const errors   = {};
        const warnings = {};
        const sections = WizardState.getSections();

        if (sections.length === 0) {
            errors.sections = 'Minimal 1 bagian soal';
            return { errors, warnings };
        }

        sections.forEach((section, idx) => {
            if (!section.type_question)
                errors[`sectionType-error-${idx}`] = `Tipe soal bagian ${idx + 1} harus dipilih`;

            if (section.questions.length < 3)
                errors[`questions-min-${idx}`] = `Bagian ${idx + 1} minimal 3 soal (sekarang ${section.questions.length})`;

            // Duplicate question text across section
            const pertanyaanTexts = section.questions.map(q => stripHtml(q.pertanyaan || '').trim().toLowerCase());
            const seen = new Set();
            pertanyaanTexts.forEach((txt, qIdx) => {
                if (txt && seen.has(txt))
                    warnings[`pertanyaan-dup-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Pertanyaan duplikat di bagian ${idx + 1}`;
                seen.add(txt);
            });

            section.questions.forEach((q, qIdx) => {
                const cleanQ = stripHtml(q.pertanyaan || '').trim();
                if (!cleanQ)          errors[`pertanyaan-${idx}-${qIdx}`]  = `Soal ${qIdx + 1}: Pertanyaan harus diisi`;
                else if (cleanQ.length < 3) errors[`pertanyaan-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Pertanyaan terlalu pendek`;

                // Media validation (same behavior as before — not modified per spec)
                if (q.media) {
                    if (q.media.video?.enabled) {
                        const src = (q.media.video.src || '').trim();
                        if (!src) {
                            errors[`video-src-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Video aktif tapi sumber kosong`;
                        } else {
                            try {
                                const url = new URL(src);
                                if (!['http:', 'https:'].includes(url.protocol))
                                    errors[`video-url-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: URL video harus http/https`;
                            } catch {
                                errors[`video-url-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: URL video tidak valid`;
                            }
                        }
                    }
                    if (Array.isArray(q.media.gambar)) {
                        if (q.media.gambar.length > 4)
                            errors[`gambar-count-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Maksimal 4 gambar`;
                        const hasInvalid = q.media.gambar.some(img => {
                            const isCdn    = typeof img === 'string' && img.startsWith('https://raw.githubusercontent.com/');
                            const isBase64 = typeof img === 'string' && img.startsWith('data:image/');
                            return !isCdn && !isBase64;
                        });
                        if (hasInvalid)
                            errors[`gambar-format-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Format gambar tidak valid`;
                        const MAX_B64 = 3 * 1024 * 1024 * (4 / 3);
                        const hasOversize = q.media.gambar.some(img =>
                            typeof img === 'string' && img.startsWith('data:image/') && img.length > MAX_B64);
                        if (hasOversize)
                            errors[`gambar-size-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Gambar melebihi 3MB`;
                        else {
                            const hasLegacy = q.media.gambar.some(img =>
                                typeof img === 'string' && img.startsWith('data:image/'));
                            if (hasLegacy)
                                warnings[`gambar-legacy-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Gambar masih Base64, upload ulang`;
                        }
                    }
                }

                if (section.type_question === 'PG') {
                    const pilihan = q.pilihan || {};
                    const vals    = ['A', 'B', 'C', 'D'].map(l => (pilihan[l] || '').trim());

                    ['A', 'B', 'C', 'D'].forEach((l, i) => {
                        if (!vals[i])
                            errors[`pilihan-${l}-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Opsi ${l} harus diisi`;
                    });

                    const nonEmpty = vals.filter(v => v !== '');
                    if (new Set(nonEmpty).size !== nonEmpty.length)
                        warnings[`pilihan-duplicate-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Ada pilihan jawaban yang sama`;

                    if (!q.jawaban_benar || !['A', 'B', 'C', 'D'].includes(q.jawaban_benar)) {
                        errors[`jawabanBenar-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Jawaban benar harus A, B, C, atau D`;
                    } else {
                        const jIdx = ['A', 'B', 'C', 'D'].indexOf(q.jawaban_benar);
                        if (!vals[jIdx])
                            errors[`jawabanBenar-${idx}-${qIdx}`] = `Soal ${qIdx + 1}: Jawaban benar mengacu opsi kosong`;
                    }
                }
            });
        });

        const totalSkor = sections.reduce((s, sec) =>
            s + sec.questions.reduce((ss, q) => ss + (q.skor || 0), 0), 0);
        if (sections.some(s => s.questions.length > 0) && totalSkor !== 100)
            errors.totalSkor = `Total skor harus 100 (sekarang ${totalSkor})`;

        return { errors, warnings };
    };

    // ── Step 4: Publish (no hard errors at step level — reviewed in Publish UI) ──
    const validateStep4 = () => ({ errors: {}, warnings: {} });

    // ── Step status derivation ────────────────────────────────────────────────
    /**
     * Returns 'complete' | 'warning' | 'incomplete' | 'empty'
     * Used by progress bar for rich status icons.
     *
     * W3 fix: now accepts optional pre-computed errors/warnings to avoid re-running
     * validateStepN (which was called twice per validateAllBackground invocation —
     * once in the loop, once inside getStepStatus). For 100 questions this saves
     * ~200 <div> allocations per Add Question click.
     */
    const getStepStatus = (step, preComputed) => {
        let errors, warnings;
        if (preComputed) {
            errors   = preComputed.errors;
            warnings = preComputed.warnings;
        } else {
            ({ errors, warnings } = (() => {
                if (step === 1) return validateStep1();
                if (step === 2) return validateStep2();
                if (step === 3) return validateStep3();
                return validateStep4();
            })());
        }

        const hasErrors   = Object.keys(errors).length > 0;
        const hasWarnings = Object.keys(warnings).length > 0;

        // Check if step has any data at all (to distinguish 'empty' from 'incomplete')
        if (step === 1) {
            // W4 fix: use getStateRef() (read-only, no deepClone) instead of getState()
            const state = WizardState.getStateRef?.() ?? WizardState.getState();
            const { ujian } = state.examData;
            // v2.0.0: cek judul/mapel + identity_mode (bukan kelas lagi)
            const isEmpty = !ujian.judul && !ujian.mata_pelajaran && !ujian.identity_mode;
            if (isEmpty && hasErrors) return 'empty';
        }
        if (step === 3) {
            // W4 fix: avoid deepClone — just check array length on state ref
            const state = WizardState.getStateRef?.() ?? WizardState.getState();
            if (!state.sections || state.sections.length === 0) return 'empty';
        }

        if (hasErrors)   return 'incomplete';
        if (hasWarnings) return 'warning';
        return 'complete';
    };

    /**
     * Full background validation of all steps.
     * Returns per-step breakdown for progress bar + publish reviewer.
     *
     * W3 fix: each validateStepN is now called ONCE per validateAllBackground
     * invocation (was 2× — once in the loop, once via getStepStatus(step) without
     * passing preComputed result).
     */
    const validateAllBackground = () => {
        const results = {};
        for (let step = 1; step <= 4; step++) {
            const { errors, warnings } = (() => {
                if (step === 1) return validateStep1();
                if (step === 2) return validateStep2();
                if (step === 3) return validateStep3();
                return validateStep4();
            })();
            // W3: pass pre-computed errors/warnings to getStepStatus — eliminates the 2nd call
            results[step] = {
                status:   getStepStatus(step, { errors, warnings }),
                errors,
                warnings,
                errorCount:   Object.keys(errors).length,
                warningCount: Object.keys(warnings).length
            };
        }
        return results;
    };

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        validateStep: (step) => {
            const { errors } = (() => {
                if (step === 1) return validateStep1();
                if (step === 2) return validateStep2();
                if (step === 3) return validateStep3();
                return validateStep4();
            })();
            return { isValid: Object.keys(errors).length === 0, errors };
        },

        validateStepFull: (step) => {
            if (step === 1) return validateStep1();
            if (step === 2) return validateStep2();
            if (step === 3) return validateStep3();
            return validateStep4();
        },

        getStepStatus,
        validateAllBackground
    };
})();
