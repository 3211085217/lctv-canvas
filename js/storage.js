/* =====================================================
 * 存储层：IndexedDB KV 存储（大容量，存放工程/版本/资产等大数据）
 * localStorage 仅保留小体量设置（lc_settings），并自动迁移旧数据
 * ===================================================== */
(function () {
  const DB_NAME = 'lctv_canvas';
  const STORE = 'kv';

  /* 需要迁入 IndexedDB 的 localStorage 键（迁移后从 localStorage 清除，释放 5MB 配额） */
  const MIGRATE_KEYS = {
    lc_current: 'current',
    lc_versions: 'versions',
    lc_projects: 'projects',
    lc_assets: 'assets',
    lc_templates: 'templates',
  };

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => {
      console.error('IndexedDB 打开失败：', e);
      return null;
    });
    return dbPromise;
  }

  const Store = {
    /* 读（不存在返回 null） */
    async get(key) {
      const db = await openDB();
      if (!db) return this._lsFallback(key);
      return new Promise((resolve) => {
        const t = db.transaction(STORE, 'readonly');
        const r = t.objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result ?? null);
        r.onerror = () => resolve(null);
      });
    },
    /* 写（value 为字符串/JSON；失败抛错，由调用方可见提示） */
    async set(key, value) {
      const db = await openDB();
      if (!db) { this._lsSetFallback(key, value); return; }
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).put(value, key);
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('写入被中断'));
      });
    },
    async del(key) {
      const db = await openDB();
      if (!db) return;
      return new Promise((resolve) => {
        const t = db.transaction(STORE, 'readwrite');
        t.objectStore(STORE).delete(key);
        t.oncomplete = () => resolve();
        t.onerror = () => resolve();
      });
    },

    /* localStorage 兜底（IndexedDB 被禁用的极端环境） */
    _lsFallback(key) {
      try { return localStorage.getItem('lsfb_' + key); } catch (e) { return null; }
    },
    _lsSetFallback(key, value) {
      try { localStorage.setItem('lsfb_' + key, String(value)); }
      catch (e) { if (LC.App?.toast) LC.App.toast('本地存储不可用，工程数据仅保留在当前页面', 'err'); }
    },

    /* ---------- 启动迁移：localStorage 大数据 → IndexedDB ---------- */
    async migrate() {
      try {
        const db = await openDB();
        if (!db) return;
        const done = await new Promise((resolve) => {
          const t = db.transaction(STORE, 'readonly');
          const r = t.objectStore(STORE).get('__migrated__');
          r.onsuccess = () => resolve(!!r.result);
          r.onerror = () => resolve(false);
        });
        if (done) {
          // 保险起见仍清理 localStorage 旧键（迁移早已完成却残留的极端情况）
          Object.keys(MIGRATE_KEYS).forEach((k) => localStorage.removeItem(k));
          return;
        }
        for (const [lsKey, idbKey] of Object.entries(MIGRATE_KEYS)) {
          const raw = localStorage.getItem(lsKey);
          if (raw == null) continue;
          try {
            if (raw.trim()) await this.set(idbKey, raw);   // 原样字符串保存，损坏的旧数据跳过
          } catch (e) { /* 旧数据损坏则跳过 */ }
          localStorage.removeItem(lsKey);
        }
        await this.set('__migrated__', '1');
      } catch (e) {
        console.warn('存储迁移失败（不影响使用）：', e);
      }
    },
  };

  window.LC = window.LC || {};
  LC.Store = Store;
  Store.ready = Store.migrate();
})();
