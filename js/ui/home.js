/* =====================================================
 * 首页视图：画布项目管理（新建 / 打开 / 重命名 / 删除）
 * 存储：磁盘文件（projects/<id>.json，经 serve.py /api/* 端点）
 * ===================================================== */
(function () {
  const U = LC.U;

  const Home = {
    _currentId: null,   // 当前打开的画布 id
    _deleted: new Set((() => { try { return JSON.parse(localStorage.getItem('lc_deleted') || '[]'); } catch (e) { return []; } })( )), // 已删除id：持久化，跨页面阻止复活

    /* 已删除标记：内存 + localStorage 双检查（跨页面共享，任何页面都不能把已删画布写回云端/复活） */
    _isDeleted(id) {
      if (this._deleted.has(id)) return true;
      try { if ((JSON.parse(localStorage.getItem('lc_deleted') || '[]')).includes(id)) return true; } catch (e) {}
      return false;
    },
    _markDeleted(id) {
      this._deleted.add(id);
      try {
        const arr = JSON.parse(localStorage.getItem('lc_deleted') || '[]');
        if (!arr.includes(id)) { arr.push(id); localStorage.setItem('lc_deleted', JSON.stringify(arr.slice(-300))); }
      } catch (e) {}
    },
    _unmarkDeleted(id) {
      this._deleted.delete(id);
      try {
        const arr = (JSON.parse(localStorage.getItem('lc_deleted') || '[]')).filter((x) => x !== id);
        localStorage.setItem('lc_deleted', JSON.stringify(arr));
      } catch (e) {}
    },

    /* ---------- 磁盘 API ---------- */
    async _list() {
      let disk = [];
      let cloudOk = false;
      try {
        disk = await LC.Cloud.list();
        cloudOk = true;
      } catch (e) {}
      if (!Array.isArray(disk)) disk = [];
      let cached = [];
      try {
        const raw = await LC.Store.get('projects');
        const rows = JSON.parse(raw || '[]');
        cached = rows.map((p) => {
          let data = null;
          try { data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data; } catch (e) {}
          return {
            id: p.canvasId || p.id,
            name: data?.name || p.name || '未命名画布',
            createdAt: data?.createdAt || p.time || '',
            updatedAt: p.time || data?.updatedAt || '',
            cached: true,
          };
        }).filter((p) => p.id);
      } catch (e) {}
      const byId = new Map();
      if (cloudOk) {
        // 在线：以云端为准（删除即消失）；本地缓存仅补充展示信息，杜绝"云端已删、缓存复活"
        disk.forEach((p) => {
          const c = cached.find((x) => x.id === p.id);
          byId.set(p.id, { ...(c || {}), ...p, cached: false });
        });
      } else {
        // 离线：退回本地缓存
        cached.forEach((p) => byId.set(p.id, p));
      }
      return Array.from(byId.values())
        .filter((p) => !this._isDeleted(p.id))
        .sort((a, b) =>
        String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
      );
    },
    async _getCached(id) {
      try {
        const raw = await LC.Store.get('projects');
        const rows = JSON.parse(raw || '[]');
        const p = rows.find((x) => x.canvasId === id || x.id === id);
        if (!p) return null;
        const data = typeof p.data === 'string' ? JSON.parse(p.data) : p.data;
        return data && Array.isArray(data.nodes) ? data : null;
      } catch (e) { return null; }
    },
    async _cache(id, data) {
      try {
        const raw = await LC.Store.get('projects');
        let rows = JSON.parse(raw || '[]');
        const now = U.formatTime();
        const old = rows.find((p) => p.canvasId === id);
        const rec = { id: old?.id || U.uid('p'), canvasId: id, name: data.name || '未命名画布', time: now, data: JSON.stringify(data) };
        rows = rows.filter((p) => p.canvasId !== id && p.id !== id);
        rows.unshift(rec);
        await LC.Store.set('projects', JSON.stringify(rows.slice(0, 30)));
      } catch (e) {}
    },
    async _removeCache(id) {
      try {
        const raw = await LC.Store.get('projects');
        const rows = JSON.parse(raw || '[]').filter((p) => p.canvasId !== id && p.id !== id);
        await LC.Store.set('projects', JSON.stringify(rows));
      } catch (e) {}
    },
    async _saveFile(id, obj, options = {}) {
      await LC.Cloud.save(id, obj);
    },
    async _loadFile(id) {
      // 本地缓存优先 → 秒开（避免每个画布都要等一次云端请求，国内网络往返 3-10s）；
      // 本地没有（如同学新建的）才走云端
      const cached = await this._getCached(id);
      if (cached) return cached;
      try {
        const d = await LC.Cloud.load(id);
        if (d && Array.isArray(d.nodes)) return d;
      } catch (e) {}
      return null;
    },

    /* ---------- 元信息 ---------- */
    async list() { return this._list(); },

    /* ---------- 新建画布 ---------- */
    async create(name) {
      const id = U.uid('c');
      const empty = { nodes: [], edges: [], groups: [], name: name || '未命名画布', createdAt: U.formatTime() };
      await this._cache(id, empty);                 // 本地立刻可见
      this._saveFile(id, empty).catch(() => {});    // 云端保存后台异步，不阻塞进入画布（网络慢也不卡新建）
      return id;
    },

    /* ---------- 打开画布 ---------- */
    async open(id) {
      const data = await this._loadFile(id);
      if (!data || !Array.isArray(data.nodes)) { LC.App.toast('画布数据不存在，可能已损坏', 'err'); return false; }
      try {
        this.hide();               // 先切到画布视图：渲染时节点可见，offsetHeight 才能被正确测量（否则组框按兜底高度算，包不住子节点）
        this._currentId = id;
        LC.App.applyLoaded(data, `已打开「${data.name}」`);
        return true;
      } catch (e) {
        console.error('[Home.open] 打开画布失败:', e);
        console.error('[Home.open] 数据内容:', data);
        // 回滚 _currentId 并回到首页：避免后续 saveCurrent 把损坏内容写到该 id 下造成永久损坏
        this._currentId = null;
        this.show();
        LC.App.toast('画布数据损坏，无法打开: ' + e.message, 'err');
        return false;
      }
    },

    /* ---------- 删除画布 ---------- */
    async del(id) {
      this._markDeleted(id);
      if (this._currentId === id) this._currentId = null;
      await this._removeCache(id);
      this.render();                       // 立即从列表消失（乐观删除），云端删除在后台执行
      LC.Cloud.del(id).then(() => {
        LC.App?.toast?.('画布已删除', 'ok');
      }).catch(() => {
        this._unmarkDeleted(id);           // 云端失败：允许列表恢复，提示重试
        LC.App?.toast?.('云端删除失败，请重试', 'err');
        if (LC.Home && LC.Home.render) LC.Home.render();
      });
      return true;
    },

    /* ---------- 重命名 ---------- */
    async rename(id, name) {
      // 读文件 → 改 name → 写回
      const d = await this._loadFile(id);
      if (d) {
        d.name = name;
        await this._saveFile(id, d).catch(() => {});
        await this._cache(id, d);
      }
      // 若是当前画布也同步顶栏
      if (this._currentId === id) {
        LC.App.projectName = name;
        const inp = U.$('#project-name');
        if (inp) inp.value = name;
      }
      this.render();
    },

    /* ---------- 保存当前画布到对应存储 ----------
     * 可选 snapshot：调用方提前抓取的 JSON 快照（避免异步保存期间 graph 被替换，写到旧 id 的内容变成新画布）
     */
    async saveCurrent(id = this._currentId, options = {}, snapshot = null) {
      if (!id || !LC.App.graph) return false;
      if (this._isDeleted(id)) return false;   // 已删除的画布：任何页面都不能再写回云端/复活
      const json = snapshot || LC.App.sanitizeJSON();
      json.name = LC.App.projectName;
      try {
        await this._saveFile(id, json, options);
        await this._cache(id, json);
        return true;
      } catch (e) {
        await this._cache(id, json);
        if (!options.silent) {
          const message = e?.message === 'Failed to fetch'
            ? '网络连接失败，已保存到本地缓存（联网后重开可同步）'
            : '云端保存失败，已保存到本地缓存';
          LC.App.toast(message, 'warn');
        }
        return false;
      }
    },

    /* ---------- 渲染画布卡片列表 ---------- */
    async render() {
      const list = await this.list();
      const container = U.$('#home-canvas-list');
      const empty = U.$('#home-empty');
      if (!list.length) {
        container.innerHTML = '';
        empty.hidden = false;
        return;
      }
      empty.hidden = true;
      container.innerHTML = list.map((c) => `
        <div class="hc-card" data-id="${c.id}">
          <div class="hc-thumb">${U.icon('grid', 28)}</div>
          <div class="hc-info">
            <div class="hc-name">${U.esc(c.name)}</div>
            <div class="hc-meta">更新于 ${U.esc(c.updatedAt || c.createdAt)}</div>
          </div>
          <div class="hc-actions">
            <button class="hc-btn primary" data-open>${U.icon('play', 13)} 打开</button>
            <button class="hc-btn" data-rename>${U.icon('pen', 13)} 重命名</button>
            <button class="hc-btn danger" data-del>${U.icon('trash', 13)} 删除</button>
          </div>
        </div>
      `).join('');
      // 绑定事件
      U.$$('.hc-card', container).forEach((card) => {
        const id = card.dataset.id;
        card.querySelector('[data-open]').onclick = () => this.open(id);
        card.querySelector('[data-rename]').onclick = async () => {
          const c = (await this.list()).find((x) => x.id === id);
          const name = await LC.Modal.prompt('重命名画布', c?.name || '', { className: 'home-prompt' });
          if (name) { await this.rename(id, name); LC.App.toast('已重命名', 'ok'); }
        };
        card.querySelector('[data-del]').onclick = async () => {
          const c = (await this.list()).find((x) => x.id === id);
          if (await LC.Modal.confirm('删除画布', `确定删除「${c?.name}」？此操作不可撤销。`)) {
            this.del(id);
          }
        };
      });
    },

    /* ---------- 显隐控制 ---------- */
    show() {
      const hv = U.$('#home-view');
      if (!hv) return;
      hv.hidden = false;
      U.$('#topbar').style.display = 'none';
      U.$('#workspace').style.display = 'none';
      U.hydrateIcons(hv);
      this.render();
    },
    hide() {
      U.$('#home-view').hidden = true;
      U.$('#topbar').style.display = '';
      U.$('#workspace').style.display = '';
    },

    /* ---------- 新建画布流程 ---------- */
    async newCanvas() {
      const name = await LC.Modal.prompt('新建画布', '', { className: 'home-prompt' });
      if (!name) return;
      const id = await this.create(name);
      if (await this.open(id)) {
        LC.App.toast(`已创建画布「${name}」`, 'ok');
      }
    },

    /* ---------- 返回首页（先切换视图，后台保存） ----------
     * 关键：先同步抓快照再 show，避免用户在首页新建/打开别的画布后，
     * saveCurrent 异步执行时 graph 已被替换，把新画布的内容写到旧 id 下覆盖旧画布
     */
    back() {
      const id = this._currentId;
      this._currentId = null;
      const snapshot = id && LC.App.graph ? LC.App.sanitizeJSON() : null;
      this.show();
      if (id && snapshot) {
        this.saveCurrent(id, {}, snapshot).then(() => {
          LC.App.toast('画布已保存', 'ok');
        }).catch((e) => {
          console.error('保存失败：', e);
        });
      }
    },

    /* ---------- 初始化 ---------- */
    init() {
      const btn = U.$('#home-new');
      if (btn) btn.onclick = () => this.newCanvas();
      const logo = U.$('#logo-home');
      if (logo) {
        logo.style.cursor = 'pointer';
        logo.addEventListener('click', (e) => {
          e.stopPropagation();
          this.back();
        });
      }
    },

    get currentId() { return this._currentId; },
    set currentId(v) { this._currentId = v; },
  };

  LC.Home = Home;
})();
