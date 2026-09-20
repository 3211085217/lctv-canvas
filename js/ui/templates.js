/* =====================================================
 * 自定义模板：保存/复用整套节点链路，内置工作流蓝图
 * ===================================================== */
(function () {
  const U = LC.U;

  /* ---------- 内置蓝图（dx/dy 相对偏移，e 为连线索引） ---------- */
  const BUILTIN = [
    {
      id: 'b1', builtin: true, name: '角色一致性 · 定妆流',
      desc: '三视图 + 绑定提示词 → 双模型对比生图', time: '内置',
      nodes: [
        { type: 'image', title: '角色三视图', dx: 0, dy: 0, props: { mode: 'tri', prompt: '女主角定妆，正面/侧面/背面' } },
        { type: 'image', title: '定妆 · 方案A', dx: 320, dy: 0, props: { prompt: '保持三视图五官服饰一致，全身照, 庭院中景' } },
        { type: 'image', title: '定妆 · 方案B', dx: 320, dy: 260, props: { prompt: '保持三视图五官服饰一致，全身照, 庭院中景' } },
      ],
      edges: [[0, 'out', 1, 'ref'], [0, 'out', 2, 'ref']],
    },
    {
      id: 'b2', builtin: true, name: '分镜量产 · 单镜头流',
      desc: '脚本拆镜 → 首帧图 → 首尾帧生视频', time: '内置',
      nodes: [
        { type: 'script', title: '故事脚本', dx: 0, dy: 0, props: { shotCount: 8, shotDuration: 8 } },
        { type: 'image', title: '分镜首帧图', dx: 330, dy: -40, props: {} },
        { type: 'video', title: '视频生成', dx: 660, dy: -40, props: { mode: 'shouweizhen', duration: 5 } },
        { type: 'audio', title: '角色配音', dx: 330, dy: 220, props: { kind: 'voice' } },
        { type: 'subtitle', title: '自动字幕', dx: 660, dy: 220, props: {} },
        { type: 'export', title: '成片导出', dx: 990, dy: 60, props: { resolution: '1080p' } },
      ],
      edges: [[0, 'text', 1, 'prompt'], [1, 'out', 2, 'ref'], [0, 'text', 3, 'script'], [3, 'out', 5, 'audio'], [0, 'text', 4, 'text'], [4, 'out', 5, 'subtitle'], [2, 'out', 5, 'in']],
    },
    {
      id: 'b3', builtin: true, name: '导演台 · 站位构图流',
      desc: '3D 导演台构图 → 生图 → 生视频', time: '内置',
      nodes: [
        { type: 'stage', title: '3D 导演台 · 站位', dx: 0, dy: 0, props: {} },
        { type: 'image', title: '构图生图', dx: 330, dy: 0, props: { prompt: '按参考构图生成画面，保持人物站位' } },
        { type: 'video', title: '匹配运镜视频', dx: 660, dy: 0, props: { mode: 'i2v', duration: 5 } },
      ],
      edges: [[0, 'out', 1, 'ref'], [1, 'out', 2, 'ref']],
    },
  ];

  const Templates = {
    _custom: [],   // 自定义模板缓存（启动时从 IndexedDB 装载）

    async init() {
      try { this._custom = JSON.parse((await LC.Store.get('templates')) || '[]').filter((x) => !x.builtin); }
      catch (e) { this._custom = []; }
    },

    list() {
      return [...BUILTIN, ...this._custom];
    },
    listCustom() {
      return this._custom.slice();
    },

    async _persist() {
      try { await LC.Store.set('templates', JSON.stringify(this._custom.slice(0, 40))); }
      catch (e) { LC.App.toast('模板保存失败：浏览器存储被禁用或空间不足', 'err'); }
    },

    /* ---------- 保存选中为模板 ---------- */
    async save(ids) {
      const g = LC.App.graph;
      if (!ids || !ids.length) { LC.App.toast('请先框选要保存的节点链路', 'warn'); return; }
      const nodes = ids.map((id) => g.getNode(id)).filter(Boolean);
      if (!nodes.length) return;
      const name = await LC.Modal.prompt('保存为自定义模板', '我的链路模板');
      if (!name) return;
      const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
      const idSet = new Set(ids);
      const tpl = {
        id: U.uid('t'), name,
        time: U.shortTime(),
        nodes: nodes.map((n) => ({
          type: n.type, title: n.title, dx: n.x - minX, dy: n.y - minY,
          props: JSON.parse(JSON.stringify(n.props, (key, value) => {
            if (typeof value !== 'string') return value;
            if (value.startsWith('data:') || value.startsWith('blob:')) return '';
            return value;
          })),
        })),
        edges: g.edges.filter((e) => idSet.has(e.from.n) && idSet.has(e.to.n))
          .map((e) => [ids.indexOf(e.from.n), e.from.p, ids.indexOf(e.to.n), e.to.p]),
      };
      this._custom.unshift(tpl);
      this._custom = this._custom.slice(0, 40);
      await this._persist();
      LC.App.toast(`模板「${name}」已保存，新项目可直接复用`, 'ok');
    },

    /* ---------- 实例化 ---------- */
    instantiate(tpl, anchor) {
      const g = LC.App.graph;
      const idMap = [];
      const newIds = [];
      tpl.nodes.forEach((tn) => {
        const n = g.createNode(tn.type, Math.round(anchor.x + tn.dx), Math.round(anchor.y + tn.dy));
        n.title = tn.title || n.title;
        if (tn.props) n.props = JSON.parse(JSON.stringify(tn.props));
        idMap.push(n.id);
        newIds.push(n.id);
      });
      (tpl.edges || []).forEach(([fi, fp, ti, tp]) => {
        if (idMap[fi] && idMap[ti]) g.addEdge({ n: idMap[fi], p: fp || 'out' }, { n: idMap[ti], p: tp || 'in' });
      });
      g.emit('change');
      LC.App.fitView();
      LC.App.nodes.select(newIds);
      LC.App.toast(`模板「${tpl.name}」已部署（${tpl.nodes.length} 个节点）`, 'ok');
      LC.App.saveSoon();
      return newIds;
    },

    instantiateById(id, anchor) {
      const tpl = this.list().find((t) => t.id === id);
      if (tpl) this.instantiate(tpl, anchor);
    },

    /* ---------- 模板面板 ---------- */
    openPanel(anchor) {
      const list = this.list();
      const html = `<div class="tpl-grid">
        ${list.length ? list.map((t) => `
          <div class="tpl-card" data-id="${t.id}" draggable="true">
            <div class="tc-name">${t.builtin ? U.icon('zap', 13) + ' ' : U.icon('bookmark', 13) + ' '}${U.esc(t.name)}</div>
            <div class="tc-info">${U.esc(t.desc || '')}<br>${t.nodes.length} 节点 · ${t.time}</div>
            <div class="tc-actions">
              <button class="p-btn" data-apply>应用到画布</button>
              ${t.builtin ? '' : '<button class="p-btn danger" data-del>删除</button>'}
            </div>
          </div>`).join('') : '<div class="tpl-empty">还没有自定义模板。框选画布上的节点链路，Ctrl+G 编组后点击「保存为模板」，下次直接复用整套流程。</div>'}
      </div>`;
      const m = LC.Modal.open(html, { title: `${U.icon('book', 15)} 模板库 — 复用整套工作流`, width: '640px' });
      const center = () => {
        const r = LC.App.view.canvas.getBoundingClientRect();
        return LC.App.view.worldAt(r.width / 2 - 150, r.height / 2 - 100);
      };
      U.$$('.tpl-card', m.body).forEach((card) => {
        card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/tpl-id', card.dataset.id); e.dataTransfer.effectAllowed = 'copy'; });
        U.$('[data-apply]', card).onclick = () => { m.close(); this.instantiateById(card.dataset.id, anchor || center()); };
        const del = U.$('[data-del]', card);
        if (del) del.onclick = async () => {
          if (await LC.Modal.confirm('删除模板', `确定删除模板「${list.find((t) => t.id === card.dataset.id)?.name}」？`)) {
            this._custom = this._custom.filter((t) => t.id !== card.dataset.id);
            await this._persist();
            m.close(); this.openPanel(anchor);
          }
        };
      });
    },
  };

  LC.Templates = Templates;
})();