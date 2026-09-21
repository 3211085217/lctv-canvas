/* =====================================================
 * 左侧节点库面板 / 分镜大纲 / 右侧资产库
 * ===================================================== */
(function () {
  const U = LC.U;
  const T = LC.NODE_TYPES;

  const Library = {
    /* ---------- 左：节点库 ---------- */
    buildNodeLib() {
      ['basic', 'ai', 'tool'].forEach((cat) => {
        const box = U.$('#lib-' + cat);
        (LC.NODE_LIB[cat] || []).forEach(([type, name]) => {
          const t = T[type];
          const card = document.createElement('div');
          card.className = 'lib-card';
          card.dataset.type = type;
          card.innerHTML = `<span class="ic">${U.icon(t.icon, 20)}</span><span class="nm">${name}</span>`;
          card.draggable = true;
          card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/node-type', type);
            e.dataTransfer.effectAllowed = 'copy';
          });
          card.addEventListener('click', () => LC.App.createNodeNearCenter(type));
          box.appendChild(card);
        });
      });
      // 左侧面板标签切换（节点库 / 分镜大纲 / 资产库）
      U.$$('.ptab').forEach((tab) => {
        tab.addEventListener('click', () => {
          const panel = tab.closest('#left-panel');
          if (!panel) return;
          U.$$('.ptab', panel).forEach((t) => t.classList.remove('active'));
          tab.classList.add('active');
          U.$$('.tab-body', panel).forEach((b) => b.classList.remove('active'));
          const body = U.$('#tab-' + tab.dataset.tab, panel);
          if (body) body.classList.add('active');
        });
      });
      // 画布接收拖放（节点库 / 资产 / 模板 / 本地图片视频文件）
      const canvasEl = U.$('#canvas');
      canvasEl.addEventListener('dragover', (e) => {
        if (e.dataTransfer.types.includes('text/node-type') ||
            e.dataTransfer.types.includes('text/asset-id') ||
            e.dataTransfer.types.includes('text/tpl-id') ||
            [...(e.dataTransfer.types || [])].includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      canvasEl.addEventListener('drop', (e) => {
        e.preventDefault();
        // 立即清理资产库拖拽状态（安全网）
        const list = U.$('#assets-list');
        if (list) {
          list.classList.remove('dragging');
          console.log('[Canvas] drop: removed .dragging class from assets-list');
        }
        const w = LC.App.view.worldAt(e.clientX, e.clientY);
        // 本地文件：拖到图片/视频节点上直接替换，拖空白处新建节点
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
          e.stopPropagation();
          LC.NodeUpload.dropFiles(e.dataTransfer.files, e.clientX, e.clientY);
          return;
        }
        const type = e.dataTransfer.getData('text/node-type');
        const assetId = e.dataTransfer.getData('text/asset-id');
        const tplId = e.dataTransfer.getData('text/tpl-id');
        if (type) LC.App.createNodeAt(type, null, { x: w.x - 120, y: w.y - 40 });
        else if (assetId) AssetLibrary.dropAsset(assetId, w);
        else if (tplId) LC.Templates.instantiateById(tplId, w);
      });
      // 拖拽离开画布时也清理（防止拖出窗口导致 dragend 未触发）
      canvasEl.addEventListener('dragleave', (e) => {
        // 只在真正离开画布时触发（不是子元素间切换）
        if (e.target === canvasEl) {
          const list = U.$('#assets-list');
          if (list) list.classList.remove('dragging');
        }
      });
    },

    /* ---------- 左：分镜大纲 ---------- */
    renderOutline(node, out) {
      const list = U.$('#outline-list');
      if (!out || !out.shots) return;
      list.innerHTML = `<div class="outline-head">${U.icon('script', 13)} ${U.esc(node.title)} · ${out.shots.length} 镜头 × ${out.meta?.duration || ''}s</div>`;
      out.shots.forEach((s) => {
        const d = document.createElement('div');
        d.className = 'outline-item';
        d.innerHTML = `
          <div class="oi-head"><b>#${s.no}</b> ${s.size} · ${s.move} · ${s.lens}</div>
          <div class="oi-txt">${U.esc(s.desc)}</div>
          <div class="oi-tags"><span>${s.duration || ''}s</span>${s.dialogue ? `<span>台词：${U.esc(s.dialogue.slice(0, 14))}</span>` : ''}</div>`;
        d.onclick = () => {
          LC.App.view.centerOn(node.x + node.w / 2, node.y + 40, 1);
          LC.App.nodes.select([node.id]);
        };
        list.appendChild(d);
      });
    },
  };

  /* ---------- 右：资产库 ---------- */
  const AssetLibrary = {
    items: [],  // {id, type, name, thumb, dataURL, nodeId, time}

    // 拖拽清理：模块级单函数 + 单例 ghost + 单一 _boundCleaner 引用，
    // 避免每次 dragstart 叠加 window drop/blur 监听器（dragend 异常未触发时残留累积导致卡死）
    _assetGhost: null,
    _boundCleaner: null,
    _assetCleanup() {
      const list = U.$('#assets-list');
      if (list) list.classList.remove('dragging');
      if (AssetLibrary._assetGhost && AssetLibrary._assetGhost.parentNode) {
        AssetLibrary._assetGhost.remove();
      }
      AssetLibrary._assetGhost = null;
      if (AssetLibrary._boundCleaner) {
        window.removeEventListener('drop', AssetLibrary._boundCleaner);
        window.removeEventListener('blur', AssetLibrary._boundCleaner);
        AssetLibrary._boundCleaner = null;
      }
    },
    _ensureAssetCleanupListener() {
      // 先解绑上次的 cleaner（若有），再绑一次：保证全局只有一个待触发的 cleaner
      if (this._boundCleaner) {
        window.removeEventListener('drop', this._boundCleaner);
        window.removeEventListener('blur', this._boundCleaner);
      }
      this._boundCleaner = () => this._assetCleanup();
      window.addEventListener('drop', this._boundCleaner, { once: true });
      window.addEventListener('blur', this._boundCleaner, { once: true });
    },

    init() {
      this._ready = this.reload();
    },

    /* 从云端数据仓库列资产（资产库 = 共享云资产文件夹） */
    async reload() {
      try {
        const files = await LC.Cloud.assets();
        if (!Array.isArray(files)) { this.items = []; this.render(); return; }
        this.items = files.map((f) => {
          const ext = (f.name.split('.').pop() || '').toLowerCase();
          const type = ({ png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
            mp4: 'video', webm: 'video', mov: 'video',
            mp3: 'audio', wav: 'audio', ogg: 'audio' })[ext] || 'file';
          return { id: f.url, type, name: f.name, url: f.url, thumb: f.url, size: f.size, time: '云端', meta: f.size ? Math.round(f.size / 1024) + 'KB' : '' };
        });
      } catch (e) { this.items = []; }
      this.render();
    },

    /* 生成完成或落盘后刷新资产库（重新扫描 assets 目录） */
    async register(node) {
      await this._ready;
      // 延迟 500ms 等落盘完成，再重新扫描
      clearTimeout(this._reloadTimer);
      this._reloadTimer = setTimeout(() => this.reload(), 500);
    },

    render() {
      const box = U.$('#assets-list');
      if (!this.items.length) {
        box.innerHTML = `<div class="assets-empty">${U.icon('image', 26)}<br>资产库为空<br>节点执行成功后，图片 / 音频 / 角色设定图会出现在这里，可随时拖回画布复用</div>`;
        return;
      }
      box.innerHTML = '';
      const icons = { image: 'image', video: 'video', audio: 'audio', shots: 'script', report: 'check' };
      const typeText = { image: '图片', video: '视频', audio: '音频', file: '文件' };
      this.items.forEach((a) => {
        const d = document.createElement('div');
        d.className = 'asset-card';
        d.draggable = true;
        // 优先用原图 dataURL 显示，没有则回退 thumb（视频首帧等）；lazy+async 解码避免一次性 160 张大图卡死
        // img 必须 draggable=false：否则按下图片会启动 img 原生拖拽（拖出图片副本），不触发 .asset-card 的 dragstart，画布收不到 text/asset-id
        const imgSrc = a.url || a.thumb || '';
        // 视频/音频不能用 <img> 加载（img 解码 mp4 失败→空白+误报"素材缺失"）；视频用 video 元素取首帧，音频只显示图标
        const thumbHtml = a.type === 'video'
          ? `<video src="${U.esc(a.url)}#t=0.1" muted preload="metadata" playsinline width="56" height="56"></video>`
          : (a.type === 'audio'
            ? `<span class="ph">${U.icon('audio', 20)}</span>`
            : (imgSrc ? `<img src="${imgSrc}" loading="lazy" decoding="async" draggable="false" width="56" height="56">` : `<span class="ph">${U.icon(icons[a.type], 20)}</span>`));
        // 类型角标：一眼区分图片 / 视频 / 音频
        const badge = a.type === 'video' ? `<span class="ac-badge bad-video">${U.icon('play', 9)} 视频</span>`
          : a.type === 'audio' ? `<span class="ac-badge bad-audio">${U.icon('audio', 9)} 音频</span>`
          : a.type === 'image' ? `<span class="ac-badge bad-image">${U.icon('image', 9)} 图片</span>`
          : `<span class="ac-badge">${U.icon('file', 9)} 文件</span>`;
        // 名称去扩展名显示，扩展名用小字跟在后面
        const lastDot = a.name.lastIndexOf('.');
        const base = lastDot > 0 ? a.name.slice(0, lastDot) : a.name;
        const ext = lastDot > 0 ? a.name.slice(lastDot) : '';
        d.innerHTML = `
          <div class="ac-thumb">${thumbHtml}${badge}</div>
          <div class="ac-info">
            <div class="ac-name" title="${U.esc(a.name)}">${U.esc(base)}${ext ? `<span class="ac-ext">${U.esc(ext)}</span>` : ''}</div>
            <div class="ac-meta">${typeText[a.type] || a.type}${a.meta ? ' · ' + U.esc(a.meta) : ''} · ${a.time}</div>
          </div>`;
        // 自定义小尺寸 ghost + 全局单 cleaner：避免浏览器克隆含大 base64 图的整张卡片导致拖动卡顿
        d.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/asset-id', a.id);
          e.dataTransfer.effectAllowed = 'copy';
          // 拖拽期间隐藏整个资产列表的 img，浏览器不再解码大图，主线程腾出来响应 dragover/drop
          const list = U.$('#assets-list');
          if (list) list.classList.add('dragging');
          // 上次 dragend 异常未触发时先清理残留 ghost / 监听器（避免累积）
          if (AssetLibrary._assetGhost && AssetLibrary._assetGhost.parentNode) AssetLibrary._assetGhost.remove();
          AssetLibrary._assetGhost = document.createElement('div');
          const ghost = AssetLibrary._assetGhost;
          ghost.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:36px;height:36px;background:#1a1a1a;border:1px solid #2e2e32;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#d0b88a;padding:0;pointer-events:none;';
          ghost.innerHTML = U.icon(icons[a.type] || 'image', 18);
          document.body.appendChild(ghost);
          e.dataTransfer.setDragImage(ghost, 18, 18);
          AssetLibrary._ensureAssetCleanupListener();
        });
        d.addEventListener('dragend', () => AssetLibrary._assetCleanup());
        d.addEventListener('drop', () => AssetLibrary._assetCleanup());
        d.addEventListener('click', () => {
          // 点击不再跳转节点（资产库已独立于节点），仅高亮
          d.classList.add('flash');
          setTimeout(() => d.classList.remove('flash'), 600);
        });
        box.appendChild(d);
      });
    },

    dropAsset(id, w) {
      const a = this.items.find((x) => x.id === id);
      if (!a) return;
      if (a.type === 'image') {
        const n = LC.App.createNodeAt('image', { mode: 'ref', localURL: '', prompt: '' }, { x: w.x - 120, y: w.y - 40 });
        requestAnimationFrame(() => {
          n.state.output = { kind: 'image', dataURL: a.url, url: a.url, meta: { type: '资产复用' } };
          n.state.status = 'done';
          LC.App.nodes.updateNode(n.id);
        });
      } else if (a.type === 'video' || a.type === 'audio') {
        const typeMap = { video: 'video', audio: 'audio' };
        const n = LC.App.createNodeAt(typeMap[a.type], {}, { x: w.x - 120, y: w.y - 40 });
        n.state.output = { kind: a.type, dataURL: a.url, url: a.url };
        n.state.status = 'done';
        LC.App.nodes.updateNode(n.id);
      } else {
        const typeMap = { shots: 'script', report: 'check' };
        LC.App.createNodeAt(typeMap[a.type] || 'text', {}, { x: w.x - 120, y: w.y - 40 });
      }
      LC.App.toast(`已从资产库复用「${a.name}」`, 'ok');
    },

    async clear() {
      await this._ready;
      this.items = [];
      this.render();
    },
  };

  LC.Library = Library;
  LC.AssetLibrary = AssetLibrary;
})();