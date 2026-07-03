// =============================================================================
// DaftarNama.js — AlbEdu Data Daftar v1.0.0
// =============================================================================
//
// Kelola data daftar untuk admin. Bergantung pada SelfStorage.js.
//
// RULES:
//   - Maks 3 data daftar per admin / storage.
//   - Setiap daftar punya nama (5-30 char) dan tipe (Kelas/Sekolah/Negara/Custom).
//   - Setiap daftar punya tabs (1-10). Nama tab maks 15 char. Tidak boleh duplicate.
//   - Setiap tab punya daftar nama. Nama maks 50 char. Total nama maks 150.
//   - Tab tidak boleh kosong saat save (minimal 1 nama).
//   - Nama duplikat dibolehkan tapi wajib konfirmasi sebelum save.
// =============================================================================

window.DaftarNama = (() => {
  // v2.0.0: i18n helper — falls back to Indonesian if i18n not loaded
  const t = (key, vars, fallback) => {
    if (window.i18n && typeof window.i18n.t === 'function') {
      const v = window.i18n.t(key, vars);
      return v !== undefined ? v : fallback;
    }
    return fallback;
  };
  const MAX_DAFTAR       = 3;
  const MAX_TABS         = 10;
  const MIN_TABS         = 1;
  const MAX_TAB_NAME     = 15;
  const MIN_NAMA_DAFTAR  = 5;
  const MAX_NAMA_DAFTAR  = 30;
  const MAX_NAMA_LEN     = 50;
  const MAX_TOTAL_NAMA   = 150;
  const DEFAULT_TABS     = ['[1]', '[2]', '[3]', '[4]'];

  const TIPE_OPTIONS = ['Kelas', 'Sekolah', 'Negara', 'Custom'];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _sb() { return window.AlbEdu?.supabase?.client; }

  async function _getStorageId() {
    await window.SelfStorage.ready();
    return window.SelfStorage.getStorageId();
  }

  function _getAdminId() {
    return window.Auth?.currentUser?.uid || null;
  }

  function _genTabId() {
    return 'tab_' + Math.random().toString(36).slice(2, 9);
  }

  // ── Validation ────────────────────────────────────────────────────────────

  function validateDaftarNama(namaDaftar, tipeDaftar, tipeCustom, tabs) {
    const errors = [];

    // Nama daftar
    if (!namaDaftar || namaDaftar.trim().length < MIN_NAMA_DAFTAR)
      errors.push(t('daftar_nama.name_too_short', { min: MIN_NAMA_DAFTAR }, `Nama daftar minimal ${MIN_NAMA_DAFTAR} karakter.`));
    else if (namaDaftar.trim().length > MAX_NAMA_DAFTAR)
      errors.push(t('daftar_nama.name_too_long', { max: MAX_NAMA_DAFTAR }, `Nama daftar maksimal ${MAX_NAMA_DAFTAR} karakter.`));

    // Tipe
    if (!tipeDaftar)
      errors.push(t('daftar_nama.type_required', null, 'Tipe daftar harus dipilih.'));
    if (tipeDaftar === 'Custom' && (!tipeCustom || tipeCustom.trim().length < 2))
      errors.push(t('daftar_nama.custom_type_required', null, 'Nama tipe custom harus diisi minimal 2 karakter.'));

    if (!Array.isArray(tabs) || tabs.length < MIN_TABS)
      errors.push(t('daftar_nama.min_tabs', { min: MIN_TABS }, `Minimal ${MIN_TABS} tab harus ada.`));
    else if (tabs.length > MAX_TABS)
      errors.push(t('daftar_nama.max_tabs', { max: MAX_TABS }, `Maksimal ${MAX_TABS} tab.`));
    else {
      // Tab name uniqueness
      const tabNames = tabs.map(t => (t.nama_tab || '').trim().toLowerCase());
      const dupTabNames = tabNames.filter((n, i) => tabNames.indexOf(n) !== i);
      if (dupTabNames.length > 0)
        errors.push(t('daftar_nama.duplicate_tab', { names: [...new Set(dupTabNames)].join(', ') }, `Nama tab duplikat: ${[...new Set(dupTabNames)].join(', ')}`));

      // Tab name length
      tabs.forEach(t => {
        if ((t.nama_tab || '').trim().length > MAX_TAB_NAME)
          errors.push(t('daftar_nama.tab_name_too_long', { name: t.nama_tab, max: MAX_TAB_NAME }, `Nama tab "${t.nama_tab}" melebihi ${MAX_TAB_NAME} karakter.`));
      });

      // Empty tabs
      const emptyTabs = tabs.filter(t => !Array.isArray(t.anggota) || t.anggota.length === 0);
      if (emptyTabs.length > 0)
        errors.push(t('daftar_nama.empty_tab', { names: emptyTabs.map(t => t.nama_tab).join(', ') }, `Tab kosong: ${emptyTabs.map(t => t.nama_tab).join(', ')}. Setiap tab harus berisi minimal 1 nama.`));

      // Total name count
      const totalNama = tabs.reduce((s, t) => s + (t.anggota?.length || 0), 0);
      if (totalNama > MAX_TOTAL_NAMA)
        errors.push(t('daftar_nama.total_too_many', { max: MAX_TOTAL_NAMA, current: totalNama }, `Total nama melebihi batas ${MAX_TOTAL_NAMA} (sekarang: ${totalNama}).`));
    }

    return errors;
  }

  /**
   * Periksa apakah ada nama duplikat di dalam satu tab.
   * Return { hasDup, details } di mana details adalah array { tabNama, nama }.
   */
  function checkDuplicateNama(tabs) {
    const details = [];
    tabs.forEach(tab => {
      const names = (tab.anggota || []).map(n => n.trim().toLowerCase());
      const seen  = new Set();
      names.forEach(n => {
        if (seen.has(n))
          details.push({ tabNama: tab.nama_tab, nama: n });
        seen.add(n);
      });
    });
    return { hasDup: details.length > 0, details };
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async function getAll() {
    const sb        = _sb();
    const storageId = await _getStorageId();
    if (!sb || !storageId) return [];

    const { data, error } = await sb
      .from('daftar_nama')
      .select('*')
      .eq('storage_id', storageId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[DaftarNama] getAll:', error.message);
      return [];
    }
    return data || [];
  }

  async function getById(id) {
    const sb = _sb();
    if (!sb || !id) return null;
    const { data, error } = await sb
      .from('daftar_nama')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) { console.error('[DaftarNama] getById:', error.message); return null; }
    return data;
  }

  async function canCreateMore() {
    const all = await getAll();
    return all.length < MAX_DAFTAR;
  }

  async function create(namaDaftar, tipeDaftar, tipeCustom, initialTabs = null, forceSaveWithDup = false) {
    const sb        = _sb();
    const storageId = await _getStorageId();
    const adminId   = _getAdminId();
    if (!sb || !storageId || !adminId) throw new Error('Storage belum siap.');

    const all = await getAll();
    if (all.length >= MAX_DAFTAR)
      throw new Error(`Maksimal ${MAX_DAFTAR} data daftar per admin.`);

    const resolvedTipe = tipeDaftar === 'Custom' ? (tipeCustom?.trim() || 'Custom') : tipeDaftar;

    const tabs = Array.isArray(initialTabs) ? initialTabs : DEFAULT_TABS.map(n => ({
      id:       _genTabId(),
      nama_tab: n,
      anggota:  [],
    }));

    if (Array.isArray(initialTabs)) {
      const errors = validateDaftarNama(namaDaftar, tipeDaftar, tipeCustom, tabs);
      if (errors.length > 0) throw new Error(errors.join('\n'));

      if (!forceSaveWithDup) {
        const { hasDup } = checkDuplicateNama(tabs);
        if (hasDup) {
          const dupErr = new Error('DUPLICATE_NAMA');
          dupErr.isDuplicateWarning = true;
          throw dupErr;
        }
      }
    }

    const { data, error } = await sb
      .from('daftar_nama')
      .insert({
        storage_id:   storageId,
        admin_id:     adminId,
        nama_daftar:  namaDaftar.trim(),
        tipe_daftar:  resolvedTipe,
        tabs:         tabs,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Simpan seluruh state daftar (nama, tipe, tabs).
   * Validasi penuh dijalankan di sini.
   * Untuk duplikat nama: caller harus konfirmasi dulu via checkDuplicateNama,
   * lalu pass forceSaveWithDup = true.
   */
  async function save(id, namaDaftar, tipeDaftar, tipeCustom, tabs, forceSaveWithDup = false) {
    const sb = _sb();
    if (!sb || !id) throw new Error('Parameter tidak lengkap.');

    const resolvedTipe = tipeDaftar === 'Custom' ? (tipeCustom?.trim() || 'Custom') : tipeDaftar;

    const errors = validateDaftarNama(namaDaftar, tipeDaftar, tipeCustom, tabs);
    if (errors.length > 0) throw new Error(errors.join('\n'));

    if (!forceSaveWithDup) {
      const { hasDup } = checkDuplicateNama(tabs);
      if (hasDup) {
        // Caller harus handle ini — lihat checkDuplicateNama()
        const dupErr = new Error('DUPLICATE_NAMA');
        dupErr.isDuplicateWarning = true;
        throw dupErr;
      }
    }

    const { data, error } = await sb
      .from('daftar_nama')
      .update({
        nama_daftar: namaDaftar.trim(),
        tipe_daftar: resolvedTipe,
        tabs:        tabs,
        updated_at:  new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  async function remove(id) {
    const sb = _sb();
    if (!sb || !id) throw new Error('ID tidak valid.');
    const { error } = await sb
      .from('daftar_nama')
      .delete()
      .eq('id', id);
    if (error) throw new Error(error.message);
  }

  // ── Tab helpers ───────────────────────────────────────────────────────────

  function addTab(tabs) {
    if (tabs.length >= MAX_TABS) throw new Error(`Maksimal ${MAX_TABS} tab.`);
    return [...tabs, { id: _genTabId(), nama_tab: '', anggota: [] }];
  }

  function removeTab(tabs, tabId) {
    if (tabs.length <= MIN_TABS) throw new Error('Minimal 1 tab harus ada.');
    return tabs.filter(t => t.id !== tabId);
  }

  function renameTab(tabs, tabId, newName) {
    const trimmed = (newName || '').trim();
    if (trimmed.length > MAX_TAB_NAME)
      throw new Error(`Nama tab maksimal ${MAX_TAB_NAME} karakter.`);
    return tabs.map(t => t.id === tabId ? { ...t, nama_tab: trimmed } : t);
  }

  function addNama(tabs, tabId, nama) {
    const trimmed = (nama || '').trim();
    if (!trimmed)           throw new Error('Nama tidak boleh kosong.');
    if (trimmed.length > MAX_NAMA_LEN) throw new Error(`Nama maksimal ${MAX_NAMA_LEN} karakter.`);

    const totalNama = tabs.reduce((s, t) => s + (t.anggota?.length || 0), 0);
    if (totalNama >= MAX_TOTAL_NAMA)
      throw new Error(`Total nama sudah mencapai batas ${MAX_TOTAL_NAMA}.`);

    return tabs.map(t => t.id === tabId
      ? { ...t, anggota: [...(t.anggota || []), trimmed] }
      : t
    );
  }

  function editNama(tabs, tabId, namaIndex, newNama) {
    const trimmed = (newNama || '').trim();
    if (!trimmed)           throw new Error('Nama tidak boleh kosong.');
    if (trimmed.length > MAX_NAMA_LEN) throw new Error(`Nama maksimal ${MAX_NAMA_LEN} karakter.`);
    return tabs.map(t => {
      if (t.id !== tabId) return t;
      const anggota = [...(t.anggota || [])];
      anggota[namaIndex] = trimmed;
      return { ...t, anggota };
    });
  }

  function removeNama(tabs, tabId, namaIndex) {
    return tabs.map(t => {
      if (t.id !== tabId) return t;
      const anggota = (t.anggota || []).filter((_, i) => i !== namaIndex);
      return { ...t, anggota };
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    // Constants
    MAX_DAFTAR, MAX_TABS, MIN_TABS, MAX_TAB_NAME,
    MIN_NAMA_DAFTAR, MAX_NAMA_DAFTAR, MAX_NAMA_LEN, MAX_TOTAL_NAMA,
    TIPE_OPTIONS,

    // CRUD
    getAll, getById, canCreateMore, create, save, remove,

    // Tab helpers (pure functions — return new tabs array)
    addTab, removeTab, renameTab, addNama, editNama, removeNama,

    // Validation
    validateDaftarNama, checkDuplicateNama,
  };
})();
