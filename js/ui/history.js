/* =====================================================
 * 历史系统：撤销/重做（内存快照）、版本记录、历史项目
 * 版本与历史项目存 IndexedDB（大容量，不受 localStorage 5MB 限制）
 * ===================================================== */
(function () {
  const U = LC.U;

  const History = {
    stack: [], idx: -1, MAX: 40,
    _t: null, _last: '',
    _pushT: null, _pushForce: false,   // push 节流：250ms 内多次合并为一次，减少大 JSON.stringify 调用

    /* ---------- 撤销 / 重做 ---------- */
    snapshot() {
      return JSON.stringify(LC.App.graph.toJSON());
    },
    /* 节流 push：连续操作（如批量拖入资产、批量删除）合并为一次快照，避免 N 次 stringify 阻塞主线程 */
    push(force = false) {
      this._pushForce = force || this._pushForce;
      if (this._pushT) clearTimeout(this._pushT);
      this._pushT = setTimeout(() => {
        this._pushT = null;
        const f = this._pushForce; this._pushForce = false;
        this._doPush(f);
      }, 250);
    },
    _doPush(force = false) {
      const s = this.snapshot();
      if (!force && s === this._last) return;
      // 截断 redo 分支
      this.stack = this.stack.slice(0, this.idx + 1);
      this.stack.push(s);
      if (this.stack.length > this.MAX) this.stack.shift();
      this.idx = this.stack.length - 1;
      this._last = s;
    },
    /* flush 待执行的节流 push：undo/redo 前必须调用，确保最新操作已入栈 */
    _flush() {
      if (this._pushT) {
        clearTimeout(this._pushT); this._pushT = null;
        const f = this._pushForce; this._pushForce = false;
        this._doPush(f);
      }
    },
    undo() {
      this._flush();
      if (this.idx <= 0) { LC.App.toast('已到最早操作', 'warn'); return; }
      this.idx--;
      this.apply(this.stack[this.idx], '已撤销');
    },
    redo() {
      this._flush();
      if (this.idx >= this.stack.length - 1) { LC.App.toast('已到最新操作', 'warn'); return; }
      this.idx++;
      this.apply(this.stack[this.idx], '已重做');
    },
    apply(json, msg) {
      LC.App.graph.fromJSON(JSON.parse(json));
      LC.App.nodes.rebuild();
      LC.App.edges.refresh();
      LC.App.fitView();
      LC.App.toast(msg, 'ok');
      LC.App.saveSoon();
    },

    /* ---------- 版本记录（手动打点，存 IndexedDB） ---------- */
    async versions() {
      const raw = await LC.Store.get('versions');
      try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
    },
    async saveVersion(name) {
      const data = this.snapshot();
      let list = await this.versions();
      list.unshift({ id: U.uid('v'), name: name || '版本 ' + (list.length + 1), time: U.formatTime(), data });
      list = list.slice(0, 12);
      try {
        await LC.Store.set('versions', JSON.stringify(list));
        LC.App.toast(`版本「${name}」已记录`, 'ok');
      } catch (e) {
        LC.App.toast('版本保存失败：' + (e.message || e), 'err');
      }
    },
    async openVersions() {
      const list = await this.versions();
      const html = list.length ? `<div class="hist-list">
        ${list.map((v) => `
          <div class="hist-item">
            <span class="hi-time">${v.time}</span>
            <span class="hi-name">${U.icon('bookmark', 13)} ${U.esc(v.name)}</span>
            <button data-restore="${v.id}">回退到此版本</button>
          </div>`).join('')}
        <div class="rev-logs"><div class="p-section">操作日志（当前会话）</div>
        ${this.stack.length ? `<div class="rev-log">共 ${Math.max(0, this.idx + 1)} 步可撤销 · ${this.stack.length - this.idx - 1} 步可重做</div>` : '<div class="rev-log">暂无操作</div>'}</div>
      </div>` : `<div class="tpl-empty">暂无版本记录。<br>在「文件」菜单或 Ctrl+S 保存时自动记录版本，也可在编辑后用快照打点回退。</div>`;
      const m = LC.Modal.open(html, { title: `${U.icon('clock', 15)} 版本记录 — 回退节点状态`, width: '620px' });
      m.body.innerHTML += `<div class="p-row" style="margin-top:14px"><input type="text" id="ver-name" placeholder="当前状态打点命名…"><button class="p-btn primary" id="ver-save" style="margin-top:8px">${U.icon('pin', 13)} 记录当前版本</button></div>`;
      U.$('#ver-save', m.body).onclick = async () => {
        const nm = U.$('#ver-name', m.body).value.trim() || '手动版本';
        await this.saveVersion(nm);
        m.close(); this.openVersions();
      };
      U.$$('[data-restore]', m.body).forEach((b) => {
        b.onclick = async () => {
          const v = list.find((x) => x.id === b.dataset.restore);
          if (!v) return;
          if (await LC.Modal.confirm('回退版本', `回退到「${v.name}」（${v.time}）？当前状态将先自动记录一个版本。`)) {
            await this.saveVersion('回退前自动备份');
            this.apply(v.data, '已回退版本');
            m.close();
          }
        };
      });
    },

    /* ---------- 历史项目（存 IndexedDB） ---------- */
    async projects() {
      const raw = await LC.Store.get('projects');
      try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
    },
    async archiveProject() {
      const g = LC.App.graph;
      if (g.nodes.size === 0) return;
      // 大工程（>200 节点）跳过自动归档：避免每个 40MB+ 快照反复覆盖 10 个 IndexedDB 槽位造成 400MB+ 占用；
      // 当前画布仍由 Home.saveCurrent 写单文件保存，不丢数据
      if (g.nodes.size > 200) return;
      const data = this.snapshot();
      let list = await this.projects();
      const same = list.find((p) => p.name === LC.App.projectName);
      const rec = { id: same ? same.id : U.uid('p'), name: LC.App.projectName, time: U.formatTime(), data };
      if (same) same.data = data, same.time = U.formatTime();
      else list.unshift(rec);
      list = list.slice(0, 10);   // 滚动上限：保留最近 10 个项目快照
      try { await LC.Store.set('projects', JSON.stringify(list)); } catch (e) { /* 归档失败不影响当前工程 */ }
    },
    async openProjects() {
      const list = await this.projects();
      const rows = list.map((p) => {
        let count = 0;
        try { count = JSON.parse(p.data || '{}').nodes?.length || 0; } catch (e) { count = 0; }
        return `<div class="hist-item">
          <span class="hi-time">${U.esc(p.time || '')}</span>
          <span class="hi-name">${U.icon('folder', 13)} ${U.esc(p.name)} <small style="color:var(--text3)">(${count} 节点)</small></span>
          <button data-open="${U.esc(p.id)}">打开</button>
          <button data-delp="${U.esc(p.id)}" style="background:#3d1f2b;border-color:#8c2f4a;color:#ff8ba7">✕</button>
        </div>`;
      }).join('');
      const html = list.length ? `<div class="hist-list">${rows}</div>` : `<div class="tpl-empty">暂无历史项目。<br>每次保存会自动在本地留档，可随时打开继续制作。</div>`;
      const m = LC.Modal.open(html, { title: `${U.icon('clock', 15)} 历史项目 — 继续之前的工作`, width: '640px' });
      U.$$('[data-open]', m.body).forEach((b) => {
        b.onclick = async () => {
          const p = list.find((x) => x.id === b.dataset.open);
          if (!p) return;
          let d;
          try { d = JSON.parse(p.data || ''); } catch (e) {
            LC.App.toast('历史项目数据损坏，无法打开', 'err');
            return;
          }
          if (!d || !Array.isArray(d.nodes)) {
            LC.App.toast('历史项目格式无效，无法打开', 'err');
            return;
          }
          LC.App.projectName = d.name || p.name;
          this.apply(JSON.stringify(d), '已打开历史项目');
          m.close();
        };
      });
      U.$$('[data-delp]', m.body).forEach((b) => {
        b.onclick = async () => {
          const arr = list.filter((x) => x.id !== b.dataset.delp);
          await LC.Store.set('projects', JSON.stringify(arr));
          m.close(); this.openProjects();
        };
      });
    },
  };

  LC.History = History;
})();
