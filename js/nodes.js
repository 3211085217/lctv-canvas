/* =====================================================
 * 节点视图层：DOM 渲染、拖动、选中、端口交互
 * ===================================================== */
(function () {
  const U = LC.U;
  const T = LC.NODE_TYPES;
  const LIGHTS = ['电影·低饱和', '电影·高对比', '自然光·清晨', '自然光·正午', '黄昏·暖金', '夜景·霓虹', '阴天·柔光', '烛光·暖调', '赛博·蓝紫', '恐怖·顶光'];
  const FOALS = ['24mm 广角', '35mm 人文', '50mm 标准', '85mm 人像', '135mm 长焦', '200mm 超长焦', '16mm 鱼眼'];
  const FSTOPS = ['f/1.4', 'f/1.8', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11'];
  /* 画幅比例清单（图片/视频通用；每个比例在 ai.js 都有对应隐藏提示词，确保真实按比例满幅出图） */
  const ASPECTS = [
    ['1:1', '1:1'], ['1:2', '1:2'], ['2:1', '2:1'], ['9:16', '9:16'], ['16:9', '16:9'],
    ['3:4', '3:4'], ['4:3', '4:3'], ['3:2', '3:2'], ['2:3', '2:3'], ['5:4', '5:4'],
    ['4:5', '4:5'], ['21:9', '21:9'], ['9:21', '9:21'],
  ];
  const VIDEO_ASPECTS = [
    ['adaptive', '自适应'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'],
    ['4:3', '4:3'], ['3:4', '3:4'], ['21:9', '21:9'],
  ];
  const VIDEO_DURATIONS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((s) => [s, s + 's']);
  const VIDEO_RESOLUTIONS = [['720P', '720P'], ['1080P', '1080P'], ['2K', '2K']];
  const VIDEO_MODES = [['shouweizhen', '首尾帧'], ['cankaosheng', '参考生']];

  /* 分栏式节点：与图片/视频一致的“上方显示框 + 下方浮动提示词面板”结构（专属参数控件全部移除，显示框固定 16:9） */
  const PANE_TYPES = ['text', 'audio', 'script', 'subtitle'];

  /* 按当前选的视频模型查支持的分辨率档位；未声明则回退 VIDEO_RESOLUTIONS
   * 不同模型支持的档位不同（H3：720P/2K；Vidu Q3：540P/720P/1080P；Seedance：480P/720P/1080P） */
  function videoResolutions(modelName) {
    if (!modelName) return VIDEO_RESOLUTIONS;
    // 硬编码已知模型（与 settings.js 预置同步，防止 localStorage 同步异常时仍能正确显示）
    if (/viduq3/i.test(modelName)) return [['540P', '540P'], ['720P', '720P'], ['1080P', '1080P']];
    if (/minimax.*h3|^h3|H3$/i.test(modelName)) return [['720P', '720P'], ['2K', '2K']];
    if (/seedance.*2\.5|seedance-2-5/i.test(modelName)) return [['480P', '480P'], ['720P', '720P'], ['1080P', '1080P']];
    if (/seedance.*fast|seedance.*mini/i.test(modelName)) return [['480P', '480P'], ['720P', '720P']];
    if (/seedance/i.test(modelName)) return [['480P', '480P'], ['720P', '720P'], ['1080P', '1080P'], ['4K', '4K']];
    // 自定义模型：查 settings 的 resolutions 字段；未声明则回退全部
    if (LC.Settings) {
      const m = LC.Settings.findModel(modelName, 'video');
      if (m && Array.isArray(m.resolutions) && m.resolutions.length) {
        return m.resolutions.map((r) => [r, r]);
      }
    }
    return VIDEO_RESOLUTIONS;
  }

  /* 按当前视频模型查参考素材上限：{img, vid, aud}，0 表示不支持
   * Vidu Q3：仅参考图 1-7；H3：图 9/视频 3/音频 3；Seedance：图 30/视频 10/音频 10 */
  function videoRefCaps(modelName) {
    if (!modelName) return { img: 9, vid: 3, aud: 3 };     // 兜底（H3 规格）
    if (/viduq3/i.test(modelName)) return { img: 7, vid: 0, aud: 0 };
    if (/minimax.*h3|^h3|H3$/i.test(modelName)) return { img: 9, vid: 3, aud: 3 };
    if (/seedance.*2\.5|seedance-2-5/i.test(modelName)) return { img: 30, vid: 10, aud: 10 };
    if (/seedance/i.test(modelName)) return { img: 9, vid: 3, aud: 3 };
    return { img: 9, vid: 3, aud: 3 };
  }

  /* 按当前视频模型查视频时长范围：Seedance 2.5 支持 4~30 秒，其余 4~15 秒 */
  function videoDurations(modelName) {
    const max = /seedance.*2\.5|seedance-2-5/i.test(modelName || '') ? 30 : 15;
    const arr = [];
    for (let s = 4; s <= max; s++) arr.push([s, s + 's']);
    return arr;
  }

  function setPath(obj, path, val) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts[parts.length - 1]] = val;
  }

  class NodeView {
    constructor(layer, graph) {
      this.layer = layer; this.graph = graph;
      this.els = new Map();           // id -> element
      this.selected = new Set();
      this.drag = null;
      this._zTop = 10;                // 节点置顶层级计数器（点击重叠节点时提升）
      graph.on((evt, payload) => {
        if (evt === 'node:add') this.renderNode(this.graph.getNode([...this.graph.nodes.keys()].pop()));
        if (evt === 'node:remove') this.removeEl(payload);
        if (evt === 'load') this.rebuild();
        if (evt === 'change') this.renderGroups();
      });
      // 事件委托：input/change/click 统一在 layer 上处理，减少事件监听器数量
      this.setupEventDelegation();
    }

    /* ---------- 渲染全部 ---------- */
    rebuild() {
      this.layer.innerHTML = '';
      this.els.clear(); this.selected.clear();
      this.graph.nodes.forEach((n) => this.renderNode(n));
      this.renderGroups();
      // 初次渲染时预览画幅比例等布局可能尚未稳定，下一帧重算组框，确保框包住所有子节点
      requestAnimationFrame(() => {
        this.renderGroups();
        // rebuild 后立即视口剔除，避免 N 大时浏览器渲染全部节点 60ms 后才剔除导致卡顿
        if (LC.App.view && LC.App.view.viewportCull) LC.App.view.viewportCull();
      });
    }

    /* ---------- 事件委托：统一在 layer 上处理 input/change/click ---------- */
    setupEventDelegation() {
      // change 事件（下拉框）
      this.layer.addEventListener('change', (e) => {
        const f = e.target.closest('select.n-field[data-prop]');
        if (!f) return;
        const el = f.closest('.node');
        if (!el) return;
        const n = this.graph.getNode(el.dataset.id);
        if (!n) return;
        setPath(n.props, f.dataset.prop, f.dataset.num ? Number(f.value) : f.value);
        // 视频模型切换：分辨率强制重置为新模型的最低档（第一档）
        if (f.dataset.prop === 'model' && n.type === 'video') {
          const vRes = videoResolutions(n.props.model);
          if (vRes.length) n.props.resolution = vRes[0][0];
        }
        LC.App.saveSoon();
        this.updateNode(n.id);
      });

      // input 事件（文本框 / range 滑块）
      this.layer.addEventListener('input', (e) => {
        const f = e.target.closest('textarea.n-field[data-prop], input.n-field[data-prop]');
        if (!f) return;
        const el = f.closest('.node');
        if (!el) return;
        const n = this.graph.getNode(el.dataset.id);
        if (!n) return;
        setPath(n.props, f.dataset.prop, f.dataset.num ? Number(f.value) : f.value);
        // duration range：实时更新旁边的秒数标签
        if (f.dataset.prop === 'duration' && f.type === 'range') {
          const wrap = f.closest('.nc-dur');
          if (wrap) { const lab = U.$('.nc-dur-val', wrap); if (lab) lab.textContent = f.value + 's'; }
        }
        LC.App.saveSoon();
        const ft = U.$('.n-foot', el);
        if (ft) ft.innerHTML = this.footHTML(n);
      });

      // click 事件（各种按钮和控件）
      this.layer.addEventListener('click', (e) => {
        const el = e.target.closest('.node');
        if (!el) return;
        const n = this.graph.getNode(el.dataset.id);
        if (!n) return;

        const hit = (sel) => { const t = e.target.closest(sel); return t && el.contains(t) ? t : null; };

        // chip 切换
        const chip = hit('[data-chip]');
        if (chip) {
          e.stopPropagation();
          const [prop, val] = chip.dataset.chip.split('=');
          setPath(n.props, prop, prop === 'quality' || prop === 'duration' ? (isNaN(Number(val)) ? val : Number(val)) : val);
          this.updateNode(n.id); LC.App.saveSoon();
          return;
        }

        // chip toggle（多选）
        const tg = hit('[data-chip-toggle]');
        if (tg) {
          e.stopPropagation();
          const [prop, val] = tg.dataset.chipToggle.split('=');
          const arr = n.props[prop] = n.props[prop] || [];
          const i = arr.indexOf(val);
          if (i >= 0) arr.splice(i, 1); else arr.push(val);
          this.updateNode(n.id); LC.App.saveSoon();
          return;
        }

        // 其他控件
        if (hit('[data-adv]')) { e.stopPropagation(); n.props._adv = !n.props._adv; this.updateNode(n.id); return; }
        if (hit('[data-preset]')) { e.stopPropagation(); this.openPresetMenu(n, hit('[data-preset]')); return; }
        if (hit('[data-open-settings]')) { e.stopPropagation(); LC.Settings.open(); return; }
        if (hit('[data-open-stage]')) { e.stopPropagation(); LC.App.openStage(n); return; }
        if (hit('[data-apply-shots]')) { e.stopPropagation(); LC.App.applyShotsToImages(n); return; }

        // 语音试听
        if (hit('[data-listen]')) {
          e.stopPropagation();
          const o = n.state.output;
          if (o?.dataURL && String(o.dataURL).startsWith('data:audio')) {
            try { new Audio(o.dataURL).play(); } catch (er) { LC.App.toast('播放失败：' + er.message, 'err'); }
            return;
          }
          const text = n.props.text || '你好，这是一段配音试听。';
          LC.App.toast('正在调用语音 API 试听…', 'ok');
          LC.AI.run('tts', { prompt: text, voice: n.props.voice })
            .then((r) => {
              if (r?.dataURL) {
                n.state.output = r; n.state.status = 'done';
                LC.App.nodes.updateNode(n.id);
                try { new Audio(r.dataURL).play(); } catch (er) { /* 播放失败不影响结果 */ }
              }
            })
            .catch((err) => LC.App.toast(err.message, 'err'));
          return;
        }

        // 上传按钮
        if (hit('[data-upframe]')) { e.stopPropagation(); NodeUpload.pickFrame(n); return; }
        if (hit('[data-uplast]')) { e.stopPropagation(); NodeUpload.pickLast(n); return; }
        if (hit('[data-uprefimg]')) { e.stopPropagation(); NodeUpload.pickRefImages(n); return; }
        if (hit('[data-uprefvid]')) { e.stopPropagation(); NodeUpload.pickRefVideos(n); return; }
        if (hit('[data-uprefaud]')) { e.stopPropagation(); NodeUpload.pickRefAudios(n); return; }
        if (hit('[data-upaudio]')) { e.stopPropagation(); NodeUpload.pickAudio(n); return; }

        // 本地上传/清除按钮
        if (hit('.n-up-mini')) { e.stopPropagation(); NodeUpload.pick(n); return; }
        if (hit('.n-up-clear')) { e.stopPropagation(); NodeUpload.clear(n); return; }

        // 放大查看
        if (hit('.n-zoom')) { e.stopPropagation(); this.openLightbox(n); return; }

        // "尝试："功能按钮
        if (hit('[data-try]')) {
          e.stopPropagation();
          const act = e.target.closest('[data-try]').dataset.try;
          if (act === 'ref') {
            n.props.mode = 'ref';
            this.updateNode(n.id);
            NodeUpload.pickRefImages(n);
          } else if (act === 'hd') {
            n.props.quality = 1;
            this.updateNode(n.id);
          }
          return;
        }

        // 节点控制按钮
        if (hit('.n-run')) { e.stopPropagation(); LC.Executor.run(n.id); return; }
        if (hit('.n-fold')) {
          e.stopPropagation();
          n.collapsed = !n.collapsed;
          el.classList.toggle('collapsed', n.collapsed);
          U.$('.n-fold', el).textContent = n.collapsed ? '▸' : '▾';
          this.graph.emit('change'); LC.App.saveSoon();
          return;
        }
        if (hit('.n-del')) {
          e.stopPropagation();
          this.graph.removeNode(n.id);
          LC.App.edges.refresh();
          return;
        }

        // 宫格提取
        if (hit('.gcell')) {
          e.stopPropagation();
          LC.Executor.extractCell(n.id, Number(e.target.closest('.gcell').dataset.cell));
          return;
        }
      });

      // dblclick 事件（双击节点打开详情）
      this.layer.addEventListener('dblclick', (e) => {
        const el = e.target.closest('.node');
        if (!el) return;
        const n = this.graph.getNode(el.dataset.id);
        if (!n) return;
        if (e.target.closest('.n-head,.port,.n-prompt,.n-ctrl,textarea.n-field,input.n-field')) return;
        e.stopPropagation();
        LC.App.openNodeDetail(n);
      });
    }

    /* ---------- 单节点渲染（幂等：同 id 先移除旧元素） ---------- */
    renderNode(n) {
      const t = T[n.type];
      const old = this.els.get(n.id);
      if (old) { old.remove(); this.els.delete(n.id); }
      // 旧项目的窄节点：渲染宽度兜底加宽到当前类型宽度（仅作用于样式，不修改 n.w 数据，避免渲染层副作用污染数据模型）
      const renderW = (t && n.w < t.w) ? t.w : n.w;
      const el = document.createElement('div');
      el.className = 'node' + (n.collapsed ? ' collapsed' : '') + (this.selected.has(n.id) ? ' selected' : '');
      el.dataset.id = n.id;
      el.style.width = renderW + 'px';
      if (n._z) el.style.zIndex = n._z;   // 恢复置顶层级（重渲染后保持）
      const headHTML = `
        <div class="n-head">
          <span class="n-tc" style="background:${t.color}"></span>
          <span class="n-title"><span class="n-t-txt">${U.esc(n.title)}</span></span>
          <span class="n-status"></span>
          <button class="n-run" title="执行此节点">▶</button>
          <button class="n-fold" title="折叠">${n.collapsed ? '▸' : '▾'}</button>
          <button class="n-del" title="删除 (Del)">✕</button>
        </div>`;
      if (n.type === 'image' || n.type === 'video') {
        // 节点框只含标题+预览区；提示词和控件在底部固定面板；预览图贴满不留边距
        el.classList.add('node-media');
        el.innerHTML = headHTML
          + `<div class="n-body n-body-fill">${this.bodyHTML(n)}</div>`;
      } else if (PANE_TYPES.includes(n.type)) {
        // 分栏式节点（文本/音频/脚本/字幕）：与图片/视频同构——节点框只含标题+显示框，
        // 提示词输入框与模型选择框在底部浮动面板；显示框固定 16:9
        el.classList.add('node-pane');
        el.innerHTML = headHTML
          + `<div class="n-body n-body-fill">${this.bodyHTML(n)}</div>`;
      } else {
        el.innerHTML = headHTML
          + `<div class="n-body">${this.bodyHTML(n)}</div>`
          + `<div class="n-ctrl">${this.ctrlHTML(n)}</div>`
          + `<div class="n-foot">${this.footHTML(n)}</div>`;
      }
      this.layer.appendChild(el);
      this.els.set(n.id, el);
      this.renderPorts(n, el);
      this.bindEl(n, el);
      this.position(n);
      if (n.type === 'image' || n.type === 'video') this.applyAspect(n, el);
      else if (PANE_TYPES.includes(n.type)) this.applyPaneAspect(n, el);
      this.applyState(n);
    }

    /* ---------- 画幅字符串 → 宽高比数值（如 '9:16' → 0.5625） ---------- */
    aspectRatio(asp) {
      if (!asp || typeof asp !== 'string') return null;
      const m = asp.split(':');
      if (m.length !== 2) return null;
      const w = parseFloat(m[0]), h = parseFloat(m[1]);
      if (w > 0 && h > 0) return w / h;
      return null;
    }

    /* ---------- 图片/视频预览框按所选画幅比例显示 ---------- */
    applyAspect(n, el) {
      const pre = el.querySelector('.n-preview');
      if (!pre) return;
      // 未指定画幅时按类型默认比例，确保预览始终按固定比例铺满（cover）不出现黑边
      const r = this.aspectRatio(n.props.aspect)
        || this.aspectRatio('16:9');
      if (!r) { pre.style.aspectRatio = ''; return; }
      pre.style.aspectRatio = String(r);
      pre.style.width = '100%';
      pre.style.minHeight = '0';          // 覆盖默认 min-height，让高度完全由比例决定
      const media = pre.querySelector('img, video');
      if (media) {
        media.style.maxHeight = 'none';
        media.style.height = '100%';
        media.style.objectFit = 'cover';   // 填充预览框，不留黑边
      }
    }

    /* ---------- 分栏式节点（文本/音频/脚本/字幕）：显示框固定 16:9 比例 ---------- */
    applyPaneAspect(n, el) {
      const pre = el.querySelector('.n-preview');
      if (!pre) return;
      pre.style.aspectRatio = String(16 / 9);
      pre.style.width = '100%';
      pre.style.minHeight = '0';
      const media = pre.querySelector('img, video');
      if (media) {
        media.style.maxHeight = 'none';
        media.style.height = '100%';
        media.style.objectFit = 'cover';
      }
    }

    /* ---------- 折叠态底部摘要栏（仅图片/视频节点） ---------- */
    cfootHTML(n) {
      const p = n.props;
      const parts = [];
      if (n.type === 'image') {
        parts.push(p.aspect || '1:1');
        parts.push(Number(p.quality) ? '4K 高清' : '标准版');
        const m = LC.Settings.modelNames('image');
        if (m.length && p.model) parts.push(p.model);
        const modeMap = { single: '生图', tri: '三视图', grid: '九宫格', ref: '参考图', reverse: '逆向解析' };
        if (p.mode && p.mode !== 'single') parts.push(modeMap[p.mode] || p.mode);
      } else if (n.type === 'video') {
        parts.push(p.aspect === 'adaptive' ? '自适应' : (p.aspect || '16:9'));
        parts.push((p.duration || 5) + 's');
        if (p.resolution) parts.push(p.resolution);
        const m = LC.Settings.modelNames('video');
        if (m.length && p.model) parts.push(p.model);
        const vMode = { i2v: '首尾帧', shouweizhen: '首尾帧', cankaosheng: '参考生' };
        parts.push(vMode[p.mode] || '参考生');
      }
      return `<span class="n-cfoot-info">${U.esc(parts.join(' · '))}</span>
        <span class="n-cfoot-hint">点击展开编辑</span>`;
    }

    /* ---------- body 渲染（按类型） ---------- */
    bodyHTML(n) {
      const p = n.props, o = n.state.output;
      switch (n.type) {
        case 'text': {
          // 分栏式：节点内只展示文本内容（显示框 16:9），编辑移入下方面板
          const t = (p.text || '').trim();
          return t
            ? `<div class="n-preview pane-text"><div class="pane-text-body">${U.esc(t)}</div></div>`
            : `<div class="n-preview"><div class="ph">${U.icon('text', 18)}<div class="ph-txt">输入文本内容…</div></div></div>`;
        }
        case 'image': {
          let body = '';
          const cover = (o && o.dataURL) || p.localURL;
          if (cover) {
            let grid = '';
            if (p.mode === 'grid' && o?.meta?.cells) {
              grid = `<div class="grid-overlay">${o.meta.cells.map((c, i) =>
                `<div class="gcell" data-cell="${i}"><span>${c.shot.split('·')[0]}</span></div>`).join('')}</div>`;
            }
            const tag = p.localURL && cover === p.localURL ? '<span class="cover-tag">本地图片</span>' : '';
            const zoomBtn = '<button class="n-zoom" data-zoom="image" title="放大查看">⛶</button>';
            body = `<div class="n-preview"><img src="${cover}" draggable="false" decoding="async" alt="">${grid}${tag}${zoomBtn}</div>`;
          } else {
            const ph = p.mode === 'grid' ? '九宫格生成 · 在下方输入分镜提示词' : p.mode === 'tri' ? '三视图生成 · 在下方输入提示词' : '可直接文字生图，或上传图片输入指令编辑';
            const sceneIc = `<svg class="ph-scene" viewBox="0 0 32 32" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="22" cy="9" r="3.2"/><path d="M4 24 L11 13 L16 19 L20 15 L28 24 Z"/></svg>`;
            const tryOpts = `<div class="n-try">
              <span class="n-try-label">尝试：</span>
              <div class="n-try-btns">
                <button class="n-try-opt" data-try="ref">${U.icon('image', 12)} 图生图</button>
                <button class="n-try-opt" data-try="hd">${U.icon('knob', 12)} 图片高清</button>
              </div>
            </div>`;
            body = `<div class="n-preview"><div class="ph">${sceneIc}<div class="ph-txt">${U.esc(ph)}</div></div>${tryOpts}</div>`;
          }
          return body;
        }
        case 'video': {
          let body = '';
          if (o && o.dataURL && o.kind === 'video') {
            // 视频文件（AI 生成 / 本地上传）：内嵌可播放，用首帧图做 poster 封面（否则黑屏无法辨识内容）
            const isLocal = o.meta?.mode === '本地视频';
            const zoomBtn = '<button class="n-zoom" data-zoom="video" title="放大查看">⛶</button>';
            const poster = (o.frames && o.frames[0]) || '';
            body = `<div class="n-preview"><video src="${o.dataURL}" class="n-video" controls preload="metadata" playsinline${poster ? ` poster="${poster}"` : ''}></video>
              <span class="dur-badge">${o.duration}s</span>${zoomBtn}</div>
              <div class="n-desc">${isLocal ? '本地视频' : U.esc(o.meta?.mode || 'AI 视频')} · ${U.esc(o.meta?.model || '')}</div>`;
          } else if (o && o.frames && o.frames[0]) {
            body = `<div class="n-preview"><img src="${o.frames[0]}" class="kenburns" draggable="false" decoding="async" alt="">
              <span class="dur-badge">${o.duration}s</span></div>
              <div class="n-desc">${U.esc((o.meta?.mode || '视频') + ' · ' + (o.meta?.model || ''))}</div>`;
          } else if (p.firstFrame || p.lastFrame || p.localFrame || (p.refImages && p.refImages.length) || (p.refVideos && p.refVideos.length) || (p.refAudios && p.refAudios.length)) {
            // H3 素材槽位预览：首帧图为封面，角标汇总各槽位数量
            const img = p.firstFrame || p.localFrame || '';
            const tags = [];
            if (p.firstFrame || p.localFrame) tags.push('首帧');
            if (p.lastFrame) tags.push('尾帧');
            if (p.refImages && p.refImages.length) tags.push('参考图×' + p.refImages.length);
            if (p.refVideos && p.refVideos.length) tags.push('参考视频×' + p.refVideos.length);
            if (p.refAudios && p.refAudios.length) tags.push('参考音频×' + p.refAudios.length);
            body = `<div class="n-preview">${img ? `<img src="${img}" draggable="false" decoding="async" alt="">` : `<div class="ph">参考素材已就绪</div>`}<span class="cover-tag">${U.esc(tags.join(' · '))}</span></div>`;
          } else {
            body = `<div class="n-preview"><div class="ph">点击输入提示词 · 文/图生视频</div></div>`;
          }
          return body;
        }
        case 'audio': {
          const bars = this.waveBars(n);
          return `<div class="n-preview pane-audio"><div class="waveform ${n.state.status === 'running' ? 'play' : ''}">${bars}</div></div>`;
        }
        case 'script': {
          if (o && o.shots) {
            const list = o.shots.slice(0, 4).map((s) =>
              `<div class="shot-line"><b>#${s.no}</b> ${s.size}·${s.move} <span>${U.esc(s.desc.slice(0, 18))}</span></div>`).join('');
            return `<div class="n-preview pane-script"><div class="shot-preview">${list}${o.shots.length > 4 ? `<div class="shot-more">…共 ${o.shots.length} 个镜头</div>` : ''}</div></div>`;
          }
          return `<div class="n-preview"><div class="ph">${U.icon('script', 18)}<div class="ph-txt">粘贴剧本 → 生成分镜</div></div></div>`;
        }
        case 'stage': {
          if (o && o.dataURL) return `<div class="n-preview"><img src="${o.dataURL}" decoding="async" alt=""></div>`;
          return `<div class="n-preview" style="min-height:90px"><div class="ph">${U.icon('stage', 20)} 双击进入导演台<br>摆放人物 → 截图输出</div></div>`;
        }
        case 'subtitle': {
          const demo = (o && o.text) || p.text || '示例：角色台词将自动生成字幕';
          return `<div class="n-preview pane-subtitle"><div style="color:#fff;font-size:${p.fontSize * .52}px;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.9)">${U.esc(demo.slice(0, 30))}</div></div>`;
        }
        case 'check': {
          const r = n.state.output;
          if (r && r.kind === 'report') {
            const color = r.pass ? 'var(--ok)' : 'var(--err)';
            return `<div class="n-preview" style="min-height:64px;display:block;padding:10px">
              <div style="font-size:13px;color:${color};font-weight:700">${r.pass ? '✓ 校验通过' : '✗ 检出 ' + r.report.length + ' 项风险'}</div>
              ${r.report.map((x) => `<div style="font-size:11px;color:var(--warn);margin-top:4px">${x.rule}：${x.hits.join('、')}</div>`).join('')}</div>`;
          }
          return `<div class="n-preview"><div class="ph">${U.icon('check', 20)} 版权 / 敏感词 检测</div></div>`;
        }
        case 'export': {
          const info = (o && o.meta) ? `已合成 ${o.meta.clips?.length || p.order.length} 个镜头 · ${o.meta.totalDur || 0}s` : '接入视频节点后合成成片';
          if (o && o.dataURL) return `<div class="n-preview"><video src="${o.dataURL}" controls style="width:100%"></video></div><div class="n-desc">${U.esc(info)}</div>`;
          return `<div class="n-preview" style="min-height:76px"><div class="ph">${U.icon('export', 20)} ${U.esc(info)}</div></div>`;
        }
        default: return `<div class="n-preview"><div class="ph">${U.icon(t.icon, 22)}</div></div>`;
      }
    }

    floorHTML(n) { return this.footHTML(n); }

    /* ---------- 节点内嵌控件（替代右侧属性面板，所有选择直接在节点上） ---------- */
    ctrlHTML(n) {
      const p = n.props;
      /* 小 chip 组 */
      const chips = (items, get, act) => items.map(([v, lb]) =>
        `<span class="nc-chip${get() === v ? ' on' : ''}" data-chip="${act}=${v}">${lb}</span>`).join('');
      /* 下拉（opts: [值,标签] 或字符串） */
      const sel = (prop, opts, cur, num) => `<select class="n-field" data-prop="${prop}"${num ? ' data-num' : ''}>${
        opts.map((o) => { const [v, lb] = Array.isArray(o) ? o : [o, o];
          return `<option value="${U.esc(String(v))}"${String(v) === String(cur) ? ' selected' : ''}>${U.esc(lb)}</option>`; }).join('')}</select>`;
      /* 时长滑块：range + 实时数字标签（替代 27 项下拉，左右拖动选秒） */
      const durSlider = (cur, min, max) => `<div class="nc-dur"><input class="n-field nc-dur-range" type="range" min="${min}" max="${max}" step="1" data-prop="duration" data-num value="${cur}"><span class="nc-dur-val">${cur}s</span></div>`;
      /* 模型下拉（来自设置；空则引导去添加） */
      const modelSel = (prop, kind, cur, tip) => {
        const names = LC.Settings.modelNames(kind);
        if (!names.length) return `<button class="nc-nomodel" data-open-settings>${tip} · 去设置添加</button>`;
        return sel(prop, names, names.includes(cur) ? cur : names[0]);
      };
      /* 高级参数折叠区 */
      const adv = (inner) => `<button class="nc-adv-tg" data-adv>${p._adv ? '收起参数 ▴' : '更多参数 ▾'}</button>
        ${p._adv ? `<div class="nc-adv">${inner}</div>` : ''}`;
      const ta = (prop, rows, ph, val) => `<textarea class="n-field" rows="${rows}" data-prop="${prop}" placeholder="${ph}">${U.esc(val || '')}</textarea>`;

      switch (n.type) {
        case 'text':
        case 'audio':
        case 'script':
        case 'subtitle':
          // 分栏式节点：专属参数已移至下方浮动面板，节点内不再渲染控件
          return '';

        case 'image': {
          const modes = [['single', '生图'], ['tri', '三视图'], ['grid', '九宫格'], ['ref', '参考图'], ['reverse', '逆向解析']];
          const curMode = modes.find((m) => m[0] === (p.mode || 'single')) || modes[0];
          const isRev = curMode[0] === 'reverse';
          const imgModel = LC.Settings.findModel(p.model, 'image');
          const isTt25 = !!(imgModel && /tt-image-2\.5/i.test(String(imgModel.modelId || '')));
          return `
            <div class="nc-row nc-model-row">${isRev
              ? modelSel('textModel', 'text', p.textModel, '暂无文本模型')
              : modelSel('model', 'image', p.model, '暂无生图模型')}${isRev ? '' : sel('aspect', ASPECTS, p.aspect || '16:9')}</div>
            ${isRev ? '' : `<div class="nc-row nc-dual">${sel('quality', [[0, '标准版'], [1, '4K 高清']], p.quality, true)}
              <button class="nc-btn preset" data-preset>预设 · ${curMode[1]}</button></div>
            ${adv(`
              ${isTt25 ? `<div class="nc-row nc-dual">${sel('version', [['', '标准版'], ['sunburst', '增强版']], p.version)}${sel('background', [['opaque', '不透明底'], ['transparent', '透明底 PNG']], p.background)}</div>
              <div class="nc-row nc-dual">${sel('imgQuality', [['', '画质·自动'], ['low', '画质·低'], ['medium', '画质·中'], ['high', '画质·高'], ['xhigh', '画质·超高'], ['max', '画质·极致']], p.imgQuality)}${sel('imgRes', [['1K', '1K'], ['2K', '2K'], ['4K', '4K']], p.imgRes)}</div>` : ''}
              <div class="nc-row">${sel('light', LIGHTS, p.light)}</div>
              <div class="nc-row nc-dual">${sel('camera.focal', FOALS, p.camera?.focal)}${sel('camera.fstop', FSTOPS, p.camera?.fstop)}</div>
              <div class="nc-row">${ta('negPrompt', 2, '负面提示词（可选）', p.negPrompt)}</div>`)}`}`;
        }

        case 'video': {
          const vMode = (p.mode === 'shouweizhen' || p.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';
          // 按当前模型查支持的分辨率档位；当前 p.resolution 不在支持列表则自动校正到第一档
          const vRes = videoResolutions(p.model);
          let curRes = vRes.length ? vRes[0][0] : '768P';
          if (vRes.some((r) => r[0] === p.resolution)) curRes = p.resolution;
          else if (p.resolution !== curRes) {
            n.props.resolution = curRes; LC.App.saveSoon();
          }
          // 按模型查参考素材上限，决定显示哪些上传按钮
          const caps = videoRefCaps(p.model);
          const refBtns = [];
          if (caps.img) refBtns.push(`<button class="nc-btn" data-uprefimg>参考图${caps.img > 1 ? '（≤' + caps.img + '）' : ''}</button>`);
          if (caps.vid) refBtns.push(`<button class="nc-btn" data-uprefvid>参考视频${caps.vid > 1 ? '（≤' + caps.vid + '）' : ''}</button>`);
          if (caps.aud) refBtns.push(`<button class="nc-btn" data-uprefaud>参考音频${caps.aud > 1 ? '（≤' + caps.aud + '）' : ''}</button>`);
          // 按模型查时长范围（Seedance 2.5：4~30 秒；其余：4~15 秒）；当前 duration 越界则校正
          const vDurs = videoDurations(p.model);
          const durMin = vDurs.length ? vDurs[0][0] : 4;
          const durMax = vDurs.length ? vDurs[vDurs.length - 1][0] : 15;
          let curDur = Number(p.duration) || 5;
          if (curDur < durMin || curDur > durMax) { curDur = Math.min(durMax, Math.max(durMin, curDur)); n.props.duration = curDur; LC.App.saveSoon(); }
          return `
            <div class="nc-row nc-chips">${chips(VIDEO_MODES, () => vMode, 'mode')}</div>
            ${vMode === 'shouweizhen' ? `<div class="nc-row nc-dual"><button class="nc-btn" data-upframe>⬆ 首帧</button><button class="nc-btn" data-uplast>⬆ 尾帧</button></div>` : ''}
            ${vMode === 'cankaosheng' ? `<div class="nc-row">${refBtns.join('')}</div>` : ''}
            <div class="nc-row nc-model-row">${modelSel('model', 'video', p.model, '暂无视频模型')}${sel('aspect', VIDEO_ASPECTS, p.aspect || 'adaptive')}</div>
            <div class="nc-row nc-dual">${durSlider(curDur, durMin, durMax)}${sel('resolution', vRes, curRes)}</div>`;
        }

        case 'stage':
          return `<div class="nc-row"><button class="nc-btn primary" data-open-stage>进入 3D 导演台</button></div>`;

        case 'check': {
          const rules = ['版权', '敏感词', '暴力', '肖像'];
          return `
            <div class="nc-row nc-model-row">${modelSel('model', 'text', p.model, '暂无文本模型')}</div>
            <div class="nc-row nc-chips">${rules.map((r) =>
              `<span class="nc-chip${(p.rules || []).includes(r) ? ' on' : ''}" data-chip-toggle="rules=${r}">${r}</span>`).join('')}</div>`;
        }

        case 'export':
          return `<div class="nc-row nc-dual">${sel('resolution', ['480p', '720p', '1080p', '2K', '4K'], p.resolution)}${
            sel('fps', [[24, '24fps'], [25, '25fps'], [30, '30fps'], [60, '60fps']], p.fps, true)}</div>
            <div class="nc-row">${sel('aspect', VIDEO_ASPECTS, p.aspect || '9:16')}</div>
            <div class="nc-row">${ta('orderText', 2, '镜头顺序（可留空，按连线顺序）', p.orderText)}</div>`;

        default: return '';
      }
    }

    /* ---------- chips 栏 ---------- */
    footHTML(n) {
      const p = n.props, o = n.state.output;
      const chip = (txt, hot) => `<span class="n-chip${hot ? ' hot' : ''}">${U.esc(txt)}</span>`;
      switch (n.type) {
        case 'text':
        case 'audio':
        case 'script':
        case 'subtitle':
          return '';   // 分栏式节点：摘要并入节点显示框，不渲染底部 chips
        case 'image': return '';   // 底部 chips 已并入节点内控件，不再重复显示
        case 'video': return '';
        case 'stage': return chip('人物站位') + (p.scene?.objs?.length ? chip(p.scene.objs.length + ' 个对象') : chip('素模库'));
        case 'check': return (o?.report ? chip(o.report.length ? o.report.length + ' 项风险' : '通过', !o.report.length) : chip((p.rules || []).length + ' 规则'));
        case 'export': return chip(p.resolution) + chip(p.fps + 'fps') + chip(p.transitions || '硬切');
        default: return '';
      }
    }

    /* ---------- 波形条 ---------- */
    waveBars(n) {
      let seed = hash(n.props.text || n.props.bgm || 'wave');
      let s = '';
      for (let i = 0; i < 28; i++) {
        seed = (seed * 9301 + 49297) % 233280;
        const h = 14 + (seed / 233280) * 30;
        s += `<i style="height:${h}px"></i>`;
      }
      return s;
    }

    /* ---------- 端口 ---------- */
    renderPorts(n, el) {
      const t = T[n.type];
      const put = (def, side) => {
        const d = document.createElement('div');
        d.className = `port ${side}`;
        d.dataset.node = n.id; d.dataset.port = def.id; d.dataset.side = side;
        d.title = side === 'in' ? '输入：拖到其他节点输出端口连线' : '输出：拖出连线到其他节点';
        d.style.top = '50%';
        el.appendChild(d);
        return d;
      };
      t.inputs.forEach((def) => put(def, 'in'));
      t.outputs.forEach((def) => put(def, 'out'));
      this.syncPorts(n);
    }

    syncPorts(n) {
      const el = this.els.get(n.id);
      if (!el) return;
      const out = new Set(), inn = new Set();
      for (let i = 0; i < this.graph.edges.length; i++) {
        const e = this.graph.edges[i];
        if (e.from.n === n.id) out.add(e.from.p);
        if (e.to.n === n.id) inn.add(e.to.p);
      }
      const ports = el.querySelectorAll('.port');
      for (let i = 0; i < ports.length; i++) {
        const p = ports[i];
        p.classList.toggle('connected', p.dataset.side === 'out' ? out.has(p.dataset.port) : inn.has(p.dataset.port));
      }
    }

    /* ---------- 元素事件 ---------- */
    bindEl(n, el) {
      // 点击节点任意位置 → 提到最上层（捕获阶段，先于拖动/选中处理器执行）
      // 效果：两个节点重叠时，点下面的节点，它立即浮到上面
      el.addEventListener('pointerdown', () => {
        n._z = ++this._zTop;
        el.style.zIndex = n._z;
      }, true);
      // 节点任意位置（左键按住）即可拖动，像组节点一样；排除按钮/输入框/端口/预览视频等交互区
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.n-ctrl,button,.port,select,textarea,input,.gcell')) return;
        e.preventDefault(); e.stopPropagation();
        LC.App.saveSoon();   // 重排 pending save，防止上次拖动的序列化在本次拖动中爆发
        if (!this.selected.has(n.id)) {
          if (!e.ctrlKey && !e.metaKey) { this.select([n.id]); }
          else this.selected.add(n.id);
        } else if (e.ctrlKey || e.metaKey) this.selected.delete(n.id);
        this.applySelection();
        // 过滤已删除节点（选中集合可能残留失效 id，否则 getNode(id).x 报 undefined）
        const ids = [...this.selected].filter((id) => this.graph.getNode(id));
        if (!ids.length) return;
        const start = ids.map((id) => ({ id, x: this.graph.getNode(id).x, y: this.graph.getNode(id).y }));
        const sx = e.clientX, sy = e.clientY;
        const move = (ev) => {
          const dx = (ev.clientX - sx) / LC.App.view.z;
          const dy = (ev.clientY - sy) / LC.App.view.z;
          // 只更新数据（廉价），transform 延迟到 rAF 内批量设置（避免 120Hz × N 次 style 修改导致卡顿）
          start.forEach(({ id, x, y }) => {
            const nn = this.graph.getNode(id);
            nn.x = Math.round(x + dx); nn.y = Math.round(y + dy);
          });
          // rAF 内批量设 transform + 刷新边 + 同步组框（每帧最多一次）
          if (this._dragRaf) return;
          this._dragRaf = requestAnimationFrame(() => {
            this._dragRaf = null;
            start.forEach(({ id }) => {
              const nn = this.graph.getNode(id);
              this.position(nn, true);     // 轻量：仅设 transform，节点立即跟随
            });
            LC.App.edges.refreshMoving(ids);   // 只更新连接被拖动节点的边
            // 组框实时跟随：被拖节点所属的组框立即同步到新边界，避免松手时才跳到目标位置
            const synced = new Set();
            ids.forEach((id) => {
              const grp = this.graph.groupOf(id);
              if (grp && !synced.has(grp.id)) { synced.add(grp.id); this._syncGroupBox(grp.id); }
            });
          });
          // 对齐检测独立节流（80ms 一次），不阻塞每帧的边刷新
          if (this._alignTimer) return;
          this._alignTimer = setTimeout(() => {
            this._alignTimer = null;
            this.checkAlign(ids, start);
          }, 80);
        };
        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          if (this._dragRaf) { cancelAnimationFrame(this._dragRaf); this._dragRaf = null; }
          // 立即同步最终位置（rAF 可能还没执行，确保松手时 DOM 与数据一致）
          start.forEach(({ id }) => { const nn = this.graph.getNode(id); this.position(nn, true); });
          if (LC.App.edges) LC.App.edges.refreshMoving(ids);
          if (this._alignTimer) { clearTimeout(this._alignTimer); this._alignTimer = null; }
          this.clearGuides();
          LC.App.view.renderMinimap();   // 拖动结束后才更新迷你地图
          if (LC.App.view.viewportCull) LC.App.view.viewportCull();   // 节点位置变化后刷新视口剔除
          this.renderGroups();           // 拖动结束后才更新组框
          this.graph.emit('change');
          LC.App.saveSoon();
        };
        el.setPointerCapture(e.pointerId);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });

      /* ---------- 节点内嵌控件（.n-ctrl / .n-bodyta）事件 ---------- */
      // 输入框按键不触发画布全局快捷键（Delete 删除节点等）
      el.addEventListener('keydown', (e) => {
        if (e.target.matches('textarea.n-field, input.n-field')) e.stopPropagation();
      });
      el.addEventListener('pointerdown', (e) => {
        if (e.target.matches('textarea.n-field, input.n-field')) e.stopPropagation();
      });
      el.addEventListener('dblclick', (e) => {
        if (e.target.matches('textarea.n-field, input.n-field')) e.stopPropagation();
      });
      // 双击节点标题 → 重命名节点
      el.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.n-title')) return;
        e.stopPropagation();
        const old = n.title;
        LC.Modal.prompt('重命名节点', old, { className: 'rename-node' }).then((nv) => {
          if (nv == null) return;            // 取消
          const v = nv.trim();
          if (!v || v === old) return;        // 空或未变
          n.title = v;
          this.renderNode(n);
          LC.History.push(true);
          LC.App.markDirty();
        });
      });

      // 内嵌视频：点击不冒泡到画布，但允许节点拖动处理器接管（拖动+选中+提示词面板）
      U.$('.n-video', el)?.addEventListener('pointerdown', (e) => {
        // 仅阻止画布级框选/菜单，不阻止冒泡到节点拖动处理器
        e.stopPropagation();
        // 手动触发节点选中（修复：点击视频时提示词面板不显示）
        if (!this.selected.has(n.id)) {
          if (!e.ctrlKey && !e.metaKey) this.select([n.id]);
          else this.selected.add(n.id);
          this.applySelection();
        }
        // 手动启动拖动
        if (e.button !== 0) return;
        LC.App.saveSoon();
        const ids = [...this.selected].filter((id) => this.graph.getNode(id));
        if (!ids.length) return;
        const start = ids.map((id) => ({ id, x: this.graph.getNode(id).x, y: this.graph.getNode(id).y }));
        const sx = e.clientX, sy = e.clientY;
        const move = (ev) => {
          const dx = (ev.clientX - sx) / LC.App.view.z;
          const dy = (ev.clientY - sy) / LC.App.view.z;
          // 只更新数据（廉价），transform 延迟到 rAF 内批量设置（避免 120Hz × N 次 style 修改导致卡顿）
          start.forEach(({ id, x, y }) => {
            const nn = this.graph.getNode(id);
            nn.x = Math.round(x + dx); nn.y = Math.round(y + dy);
          });
          if (this._dragRaf) return;
          this._dragRaf = requestAnimationFrame(() => {
            this._dragRaf = null;
            start.forEach(({ id }) => {
              const nn = this.graph.getNode(id);
              this.position(nn, true);
            });
            LC.App.edges.refreshMoving(ids);
            // 组框实时跟随：被拖节点所属的组框立即同步到新边界（与普通节点拖动一致）
            const synced = new Set();
            ids.forEach((id) => {
              const grp = this.graph.groupOf(id);
              if (grp && !synced.has(grp.id)) { synced.add(grp.id); this._syncGroupBox(grp.id); }
            });
          });
          if (this._alignTimer) return;
          this._alignTimer = setTimeout(() => {
            this._alignTimer = null;
            this.checkAlign(ids, start);
          }, 80);
        };
        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          if (this._dragRaf) { cancelAnimationFrame(this._dragRaf); this._dragRaf = null; }
          // 立即同步最终位置（rAF 可能还没执行，确保松手时 DOM 与数据一致）
          start.forEach(({ id }) => { const nn = this.graph.getNode(id); this.position(nn, true); });
          if (LC.App.edges) LC.App.edges.refreshMoving(ids);
          if (this._alignTimer) { clearTimeout(this._alignTimer); this._alignTimer = null; }
          this.clearGuides();
          LC.App.view.renderMinimap();
          if (LC.App.view.viewportCull) LC.App.view.viewportCull();
          this.renderGroups();
          this.graph.emit('change');
          LC.App.saveSoon();
        };
        el.setPointerCapture(e.pointerId);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      });
      // “尝试：”功能按钮
      U.$$('[data-try]', el).forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = btn.dataset.try;
        if (act === 'ref') { n.props.mode = 'ref'; this.updateNode(n.id); LC.App.saveSoon(); LC.App.toast('已切换为图生图模式', 'ok'); }
        else if (act === 'hd') { n.props.quality = 1; this.updateNode(n.id); LC.App.saveSoon(); LC.App.toast('已开启 4K 高清', 'ok'); }
      }));

      // 运行按钮
      U.$('.n-run', el).addEventListener('click', (e) => { e.stopPropagation(); LC.Executor.run(n.id); });

      // 折叠
      U.$('.n-fold', el).addEventListener('click', (e) => {
        e.stopPropagation();
        n.collapsed = !n.collapsed;
        el.classList.toggle('collapsed', n.collapsed);
        U.$('.n-fold', el).textContent = n.collapsed ? '▸' : '▾';
        this.graph.emit('change'); LC.App.saveSoon();
      });

      // 删除
      U.$('.n-del', el).addEventListener('click', (e) => {
        e.stopPropagation();
        this.graph.removeNode(n.id);
        LC.App.edges.refresh();
      });

      // 双击：更多操作（输入框/控件/端口/头部除外）
      el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.n-head,.port,.n-prompt,.n-ctrl,textarea.n-field,input.n-field')) return;
        e.stopPropagation();
        LC.App.openNodeDetail(n);
      });

      // 宫格提取
      U.$$('.gcell', el).forEach((gc) => {
        gc.addEventListener('click', (e) => {
          e.stopPropagation();
          LC.Executor.extractCell(n.id, Number(gc.dataset.cell));
        });
      });

      // 视频预览播放/重播
      const vimg = U.$('.n-preview img', el);
      if (vimg && n.type === 'video') {
        vimg.addEventListener('click', () => {
          const o = n.state.output;
          if (!o) return;
          vimg.classList.remove('kenburns');
          void vimg.offsetWidth;
          vimg.classList.add('kenburns');
        });
      }
    }

    /* ---------- ⛶ 灯箱：预览图/视频放大居中查看 ---------- */
    openLightbox(n) {
      const o = n.state.output;
      const p = n.props;
      const media = o?.kind === 'video' && o?.dataURL
        ? { type: 'video', src: o.dataURL }
        : (o?.dataURL || p.localURL || p.localFrame || (o?.frames && o.frames[0]))
          ? { type: 'image', src: o?.dataURL || p.localURL || p.localFrame || o.frames[0] }
          : null;
      if (!media) return;
      // 关掉旧的
      document.getElementById('lightbox')?.remove();
      const lb = document.createElement('div');
      lb.id = 'lightbox';
      lb.innerHTML = media.type === 'video'
        ? `<video src="${media.src}" controls autoplay playsinline></video>`
        : `<img src="${media.src}" alt="">`;
      lb.addEventListener('click', () => { lb.remove(); document.removeEventListener('keydown', esc); });
      lb.addEventListener('pointerdown', (e) => e.stopPropagation());
      const esc = (e) => { if (e.key === 'Escape') { lb.remove(); document.removeEventListener('keydown', esc); } };
      document.addEventListener('keydown', esc);
      document.body.appendChild(lb);
    }

    /* ---------- ⛶ 提示词放大编辑器：居中大窗编辑，关闭时写回节点 ---------- */
    openPromptEditor(n) {
      document.getElementById('prompt-editor')?.remove();
      const ed = document.createElement('div');
      ed.id = 'prompt-editor';
      const isVideo = n.type === 'video';
      ed.innerHTML = `
        <div class="pe-panel">
          <div class="pe-head"><span>${U.icon(isVideo ? 'video' : 'image', 15)} 编辑提示词 · ${U.esc(n.title)}</span><span class="pe-count"></span></div>
          <textarea class="pe-ta" placeholder="${isVideo ? '视频内容描述（动作/运镜/氛围）…' : '画面提示词…'} 输入 @ 可引用其他节点"></textarea>
          <div class="pe-foot"><span class="pe-tip">输入 @ 可引用其他节点 · Esc 或点空白处完成</span><button class="pe-done">✓ 完成</button></div>
        </div>`;
      const ta = ed.querySelector('.pe-ta');
      ta.value = n.props.prompt || '';
      const count = ed.querySelector('.pe-count');
      const upd = () => count.textContent = ta.value.length + ' 字';
      ta.addEventListener('input', upd); upd();
      const close = () => {
        n.props.prompt = ta.value;
        const el = this.els.get(n.id);
        const small = el?.querySelector('.n-prompt');
        if (small) small.value = ta.value;
        LC.App.saveSoon();
        ed.remove();
        document.removeEventListener('keydown', esc);
      };
      const esc = (e) => { if (e.key === 'Escape') close(); };
      ed.addEventListener('pointerdown', (e) => { if (e.target === ed) close(); });
      ed.querySelector('.pe-done').addEventListener('click', close);
      ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
      document.addEventListener('keydown', esc);
      document.body.appendChild(ed);
      setTimeout(() => ta.focus(), 60);
    }

    select(ids) {
      this.selected = new Set(ids);
      this.applySelection();
    }
    applySelection() {
      this.els.forEach((el, id) => el.classList.toggle('selected', this.selected.has(id)));
      LC.App.edges.refreshSelection();
      // 选中图片/视频节点时显示底部提示词面板，否则隐藏
      if (LC.PromptPanel) LC.PromptPanel.refresh();
    }

    position(n, light) {
      const el = this.els.get(n.id);
      if (!el) return;
      el.style.transform = `translate(${n.x}px, ${n.y}px)`;
      if (light) return;                   // 拖动中：仅更新 transform，边由 rAF refreshMoving 统一重绘
      const h = el.offsetHeight;
      el.dataset.h = h;
      LC.App.edges.refreshMoving([n.id]);  // 只更新连接到此节点的边，不再全量 refresh
    }

    /* ---------- 智能对齐参考线（拖动时检测与其他节点的边缘对齐） ---------- */
    checkAlign(dragIds, start) {
      const dragNode = this.graph.getNode(dragIds[0]);
      if (!dragNode) { this.clearGuides(); return; }
      const dragH = this.graph.nodeHeight(dragNode) || Number(this.els.get(dragIds[0])?.dataset.h) || 200;
      const THRESHOLD = 6; // 世界坐标阈值

      let snapDX = 0, snapDY = 0;
      const guides = [];

      this.graph.nodes.forEach((other, id) => {
        if (dragIds.includes(id)) return;
        const otherH = this.graph.nodeHeight(other) || 200;

        /* 竖线：左/右/居中 */
        if (snapDX === 0) {
          const pairs = [
            [dragNode.x, other.x],
            [dragNode.x + dragNode.w, other.x + other.w],
            [dragNode.x + dragNode.w / 2, other.x + other.w / 2],
          ];
          for (const [dv, ov] of pairs) {
            if (Math.abs(dv - ov) < THRESHOLD) {
              snapDX = Math.round(ov - dv);
              guides.push({ type: 'v', pos: ov });
              break;
            }
          }
        }

        /* 横线：顶/底/居中 */
        if (snapDY === 0) {
          const pairs = [
            [dragNode.y, other.y],
            [dragNode.y + dragH, other.y + otherH],
            [dragNode.y + dragH / 2, other.y + otherH / 2],
          ];
          for (const [dv, ov] of pairs) {
            if (Math.abs(dv - ov) < THRESHOLD) {
              snapDY = Math.round(ov - dv);
              guides.push({ type: 'h', pos: ov });
              break;
            }
          }
        }
      });

      /* 应用吸附偏移到所有选中节点 */
      if (snapDX || snapDY) {
        dragIds.forEach((id) => {
          const nn = this.graph.getNode(id);
          if (snapDX) nn.x += snapDX;
          if (snapDY) nn.y += snapDY;
          this.position(nn, true);   // 吸附仅微调位置，高度不变，走轻量更新；边由 move 的 rAF refreshMoving 统一重绘
        });
      }
      this.renderGuides(guides);
    }

    renderGuides(guides) {
      const container = U.$('#align-guides');
      if (!container) return;
      if (!guides.length) { container.textContent = ''; return; }
      const view = LC.App.view;
      const r = view.canvas.getBoundingClientRect();
      // DOM 复用：已有元素直接改 style，避免 innerHTML 重建
      while (container.children.length < guides.length) {
        const el = document.createElement('div');
        container.appendChild(el);
      }
      while (container.children.length > guides.length) {
        container.removeChild(container.lastChild);
      }
      guides.forEach((g, i) => {
        const el = container.children[i];
        if (g.type === 'v') {
          const sx = g.pos * view.z + view.x;
          el.className = 'ag-line ag-v';
          el.style.cssText = `left:${sx}px;top:0;height:${r.height}px`;
        } else {
          const sy = g.pos * view.z + view.y;
          el.className = 'ag-line ag-h';
          el.style.cssText = `top:${sy}px;left:0;width:${r.width}px`;
        }
      });
    }

    clearGuides() {
      const container = U.$('#align-guides');
      if (container) container.textContent = '';
    }

    refresh(n) {
      const el = this.els.get(n.id);
      if (!el) return;
      const keepSel = el.classList.contains('selected');
      this.layer.removeChild(el);
      this.els.delete(n.id);
      this.renderNode(n);
      if (keepSel) this.selected.add(n.id);
      this.applySelection();
    }

    removeEl(payload) {
      // 优先用 payload 精确移除单元素（O(1)），再兜底扫描清理脏数据
      if (payload && payload.id) {
        const el = this.els.get(payload.id);
        if (el) { el.remove(); this.els.delete(payload.id); this.selected.delete(payload.id); }
      }
      this.els.forEach((el, id) => {
        if (!this.graph.nodes.has(id)) { el.remove(); this.els.delete(id); this.selected.delete(id); }
      });
      this.applySelection();   // 节点删除后同步选中态 → 隐藏跟随节点显示的提示词面板
    }

    /* 按 id 更新：整卡幂等重渲染（主体 / 控件区 / 底部一并刷新，监听器不叠加） */
    updateNode(id) {
      const n = this.graph.getNode(id);
      if (!n) return;
      this.renderNode(n);
    }

    /* ---------- 图片节点 · 预设弹出菜单（生图/三视图/九宫格/参考图/逆向解析） ---------- */
    closePresetMenu() { U.$$('.nc-preset-pop').forEach((m) => m.remove()); }

    openPresetMenu(n, btn) {
      this.closePresetMenu();
      const modes = [['single', '生图'], ['tri', '三视图'], ['grid', '九宫格'], ['ref', '参考图'], ['reverse', '逆向解析']];
      const cur = n.props.mode || 'single';
      const pop = document.createElement('div');
      pop.className = 'nc-preset-pop';
      pop.innerHTML = modes.map(([v, lb]) =>
        `<div class="nc-pm-item${cur === v ? ' on' : ''}" data-pm="${v}">${lb}</div>`).join('')
        + (cur === 'grid' ? `<div class="nc-pm-sub">${['3x3', '5x5'].map((g) =>
          `<span class="nc-chip${(n.props.grid || '3x3') === g ? ' on' : ''}" data-pm-grid="${g}">${g}</span>`).join('')}</div>` : '');
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8) + 'px';

      const close = (ev) => {
        if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', close, true); }
      };
      setTimeout(() => document.addEventListener('pointerdown', close, true), 0);

      pop.addEventListener('click', (ev) => {
        const item = ev.target.closest('[data-pm]');
        if (item) {
          n.props.mode = item.dataset.pm;
          this.updateNode(n.id); LC.App.saveSoon();
          this.closePresetMenu();
          document.removeEventListener('pointerdown', close, true);
          return;
        }
        const g = ev.target.closest('[data-pm-grid]');
        if (g) {
          n.props.grid = g.dataset.pmGrid;
          this.updateNode(n.id); LC.App.saveSoon();
          this.closePresetMenu();
          document.removeEventListener('pointerdown', close, true);
        }
      });
    }

    applyState(n) {
      const el = this.els.get(n.id);
      if (!el) return;
      const st = U.$('.n-status', el);
      const run = U.$('.n-run', el);
      const pre = U.$('.n-preview', el);
      el.classList.remove('running', 'error');
      run.classList.remove('busy');
      const oldOv = pre && U.$('.n-progress', pre);
      if (oldOv) oldOv.remove();
      switch (n.state.status) {
        case 'running': {
          el.classList.add('running'); run.classList.add('busy');
          const pct = Math.round(n.state.progress || 0);
          st.textContent = pct + '%';
          if (pre) {
            const ov = document.createElement('div');
            ov.className = 'n-progress';
            ov.textContent = pct + '%';
            pre.appendChild(ov);
          }
          break;
        }
        case 'done':
          st.textContent = '✓';
          break;
        case 'error':
          el.classList.add('error'); st.textContent = '✗';
          break;
        default:
          st.textContent = '';
      }
    }

    /* ---------- 编组 ---------- */
    renderGroups() {
      const layer = U.$('#groups-layer');
      const keep = new Set();
      this.graph.groups.forEach((g) => {
        let el = U.$(`.node-group[data-gid="${g.id}"]`, layer);
        const box = this.graph.boundingBox(g.nodes);
        if (!box) return;
        keep.add(g.id);
        const pad = 48;
        if (!el) {
          el = document.createElement('div');
          el.className = 'node-group' + (g.collapsed ? ' collapsed' : '');
          el.dataset.gid = g.id;
          layer.appendChild(el);
          el.innerHTML = `<div class="g-title"><span class="g-title-text">${U.esc(g.title)}</span><button class="g-rename" title="重命名组">${U.icon('pen', 12)}</button></div><button class="g-fold">${g.collapsed ? '▸' : '▾'}</button>`;
          U.$('.g-fold', el).onclick = (e) => {
            e.stopPropagation();
            g.collapsed = !g.collapsed;
            el.classList.toggle('collapsed', g.collapsed);
            U.$('.g-fold', el).textContent = g.collapsed ? '▸' : '▾';
            g.nodes.forEach((id) => { this.graph.getNode(id).collapsed = g.collapsed; this.updateNode(id); });
            this.graph.emit('change');
          };
          // 阻止标题/按钮的 pointerdown 冒泡到组框，避免触发拖动
          U.$('.g-title', el).addEventListener('pointerdown', (e) => e.stopPropagation());
          U.$('.g-fold', el).addEventListener('pointerdown', (e) => e.stopPropagation());
          // 重命名：居中模态框
          const doRename = async () => {
            const nv = await LC.Modal.prompt('重命名组', g.title, { className: 'rename-group' });
            if (nv && nv.trim()) {
              g.title = nv.trim();
              U.$('.g-title-text', el).textContent = nv.trim();
              this.graph.emit('change');
              LC.App.toast('已重命名为「' + nv.trim() + '」', 'ok');
            }
          };
          // 标题双击 → 模态框
          U.$('.g-title', el).ondblclick = (e) => { e.stopPropagation(); doRename(); };
          // 重命名按钮
          U.$('.g-rename', el).onclick = (e) => { e.stopPropagation(); doRename(); };
          U.$('.g-rename', el).addEventListener('pointerdown', (e) => e.stopPropagation());
          // 右击组（含组内空白/边框）→ 复用画布右键菜单：顶部为删除组，下方为新建节点（新建后自动入组）
          el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const world = LC.App.view.worldAt(e.clientX, e.clientY);
            LC.App.showCanvasCtx({ x: e.clientX, y: e.clientY, world });
          });
          // 点击组框任意位置 → 拖动整组
          el.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            LC.App.saveSoon();
            const start = g.nodes.map((id) => { const nn = this.graph.getNode(id); return nn ? { id, x: nn.x, y: nn.y } : null; }).filter(Boolean);
            if (!start.length) return;
            const sx = e.clientX, sy = e.clientY;
            el.style.cursor = 'grabbing';
            const move = (ev) => {
              const dx = (ev.clientX - sx) / LC.App.view.z, dy = (ev.clientY - sy) / LC.App.view.z;
              start.forEach(({ id, x, y }) => {
                const nn = this.graph.getNode(id);
                nn.x = Math.round(x + dx); nn.y = Math.round(y + dy);
                this.position(nn, true);
              });
              // 拖动中让组框背景实时跟随子节点，避免松手时才跳到目标位置
              const box = this.graph.boundingBox(g.nodes);
              if (box) {
                el.style.left = (box.x - pad) + 'px';
                el.style.top = (box.y - pad) + 'px';
                el.style.width = (box.w + pad * 2) + 'px';
                el.style.height = (box.h + pad * 2) + 'px';
              }
              if (this._dragRaf) return;
              this._dragRaf = requestAnimationFrame(() => {
                this._dragRaf = null;
                LC.App.edges.refreshMoving(g.nodes);
              });
            };
            const finish = () => {
              el.style.cursor = 'grab';
              window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
              if (this._dragRaf) { cancelAnimationFrame(this._dragRaf); this._dragRaf = null; }
              this.renderGroups();
              LC.App.view.renderMinimap();
              if (LC.App.view.viewportCull) LC.App.view.viewportCull();
              this.graph.emit('change'); LC.App.saveSoon();
            };
            el.setPointerCapture(e.pointerId);
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish);
          });
        }
        el.classList.toggle('collapsed', !!g.collapsed);
        el.style.left = (box.x - pad) + 'px';
        el.style.top = (box.y - pad) + 'px';
        el.style.width = (box.w + pad * 2) + 'px';
        el.style.height = (box.h + pad * 2) + 'px';
        U.$('.g-fold', el).textContent = g.collapsed ? '▸' : '▾';
      });
      U.$$('.node-group', layer).forEach((el) => { if (!keep.has(el.dataset.gid)) el.remove(); });
    }

    /* 单组组框实时同步：拖动组内单个节点时，组框立即跟随子节点的边界框（无需等松手 renderGroups）
     * 用于 move 函数里，避免「拖动结束时组框才跳到目标位置」的视觉断层 */
    _syncGroupBox(grpId) {
      const layer = U.$('#groups-layer');
      if (!layer) return;
      const el = U.$(`.node-group[data-gid="${grpId}"]`, layer);
      if (!el) return;
      const grp = this.graph.groups.find((g) => g.id === grpId);
      if (!grp) return;
      // 直接用节点数据 + 缓存高度计算，不调 boundingBox（避免读 offsetHeight 触发强制同步布局）
      let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
      for (const id of grp.nodes) {
        const n = this.graph.getNode(id);
        if (!n) continue;
        const elN = this.els.get(id);
        // 优先用 position() 缓存的真实高度 dataset.h；其次视口剔除缓存 _cullH；最次默认 240。
        // 只读 _cullH 会在剔除未跑/过期时退回 240，导致组框包不住节点（点一下重新量才恢复）。
        const h = Number((elN && elN.dataset.h) || (elN && elN._cullH) || n._h || 240);
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + h);
      }
      if (minX > 1e17) return;
      const pad = 48;
      el.style.left = (minX - pad) + 'px';
      el.style.top = (minY - pad) + 'px';
      el.style.width = (maxX - minX + pad * 2) + 'px';
      el.style.height = (maxY - minY + pad * 2) + 'px';
    }
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  /* =====================================================
   * @ 引用（艾特节点）：提示词里输入 @ 弹出节点选择
   * ===================================================== */
  const Mention = {
    open: false, editable: null, node: null, items: [], active: 0, el: null, start: -1, end: -1, query: '',

    ensureEl() {
      if (this.el) return this.el;
      const el = document.createElement('div');
      el.className = 'mention-menu';
      el.hidden = true;
      el.innerHTML = `<div class="mention-hint">@ 引用节点 · ↑↓ 选择 · Enter 确认</div><div class="mention-list"></div>`;
      document.body.appendChild(el);
      this.el = el;
      return el;
    },

    /* 节点缩略图：图片节点取 output/localURL；视频节点取首帧 */
    thumb(x) {
      const o = x.state.output, p = x.props;
      if (x.type === 'image') return (o && o.dataURL) || p.localURL || '';
      if (x.type === 'video') return p.firstFrame || p.localFrame || (o && o.frames && o.frames[0]) || ((o && o.kind !== 'video') ? o.dataURL : '') || '';
      return '';
    },

    /* 纯文本 → 带缩略图块的 HTML（图片/视频节点且已有缩略图时生成内嵌 @块；
       canonical 文本仍为「@名称+空格」，保证 executor.collect 的 @ 解析照常工作；
       标题允许含空格（如「图片节点 3」），用最长匹配避免序号落到块外） */
    textToHTML(text) {
      const g = LC.App.graph;
      const raw = String(text || '');
      const matches = g.mentionNodes(raw);
      let out = '', i = 0;
      for (const m of matches) {
        out += U.esc(raw.slice(i, m.start));
        const nd = m.node, thumb = this.thumb(nd);
        if ((nd.type === 'image' || nd.type === 'video') && thumb) {
          out += `<span class="pp-mention" contenteditable="false" data-name="${U.esc(m.title)}"><img class="pp-mention-img" src="${U.esc(thumb)}" alt=""><span>${U.esc(m.title)}</span></span>`;
        } else {
          out += U.esc(raw.slice(m.start, m.end));
        }
        i = m.end;
      }
      out += U.esc(raw.slice(i));
      return out;
    },

    /* DOM（contenteditable）→ 纯文本：内嵌块还原为 @名称+空格 */
    toText(root) {
      let out = '';
      (root.childNodes || []).forEach((c) => {
        if (c.nodeType === 3) out += c.textContent;
        else if (c.classList && c.classList.contains('pp-mention')) out += '@' + (c.dataset.name || '') + ' ';
        else if (c.tagName === 'BR') out += '\n';
        else out += this.toText(c);
      });
      return out;
    },

    /* 某节点在纯文本中的占位长度（光标偏移换算用） */
    _len(c) {
      if (c.nodeType === 3) return c.textContent.length;
      if (c.classList && c.classList.contains('pp-mention')) return ('@' + (c.dataset.name || '') + ' ').length;
      if (c.tagName === 'BR') return 1;
      let n = 0;
      (c.childNodes || []).forEach((k) => (n += this._len(k)));
      return n;
    },

    /* 当前光标在纯文本中的偏移 */
    caretOffset(root) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return { text: this.toText(root), offset: 0 };
      const range = sel.getRangeAt(0);
      const node = range.startContainer, off = range.startOffset;
      let offset = 0;
      const walk = (n) => {
        if (n === node) { offset += off; return true; }
        for (const c of [...(n.childNodes || [])]) {
          if (c === node) { offset += off; return true; }
          if (c.nodeType !== 3 && c.contains && c.contains(node)) return walk(c);
          offset += this._len(c);
        }
        return false;
      };
      walk(root);
      return { text: this.toText(root), offset };
    },

    /* 把光标放到纯文本 offset 处（内嵌块不可编辑，落在其上时退到块前后） */
    setCaret(root, offset) {
      const sel = window.getSelection();
      const range = document.createRange();
      const at = this._at(root, Math.max(0, offset));
      range.setStart(at.node, at.off);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      root.focus();
    },
    _at(n, offset) {
      if (n.nodeType === 3) return { node: n, off: Math.min(offset, n.textContent.length) };
      const kids = [...(n.childNodes || [])];
      for (let i = 0; i < kids.length; i++) {
        const c = kids[i], len = this._len(c);
        if (c.classList && c.classList.contains('pp-mention')) {
          return offset <= 0 ? { node: n, off: i } : { node: n, off: i + 1 };
        }
        if (offset < len) return this._at(c, offset);
        if (offset === len) return { node: n, off: i + 1 };
        offset -= len;
      }
      return { node: n, off: kids.length };
    },

    /* 输入时检测：光标前是否有未闭合的 @xxx */
    check(editable, node) {
      this.editable = editable;
      const { text, offset } = this.caretOffset(editable);
      const before = text.slice(0, offset);
      const m = before.match(/@([^@\n]*)$/);
      if (!m) return this.close();
      this.query = m[1];
      if (this.query.includes(' ')) return this.close(); // @后带空格视为已结束
      // 仅列出与当前节点有连线关系的节点（上游输入 + 下游输出），未连线的节点不可 @
      const g = LC.App.graph;
      const conn = new Set([...(g.upstream(node.id) || []), ...(g.downstream(node.id) || [])]);
      const others = [...g.nodes.values()].filter((x) => x.id !== node.id && conn.has(x.id));
      const q = this.query.toLowerCase();
      this.items = q ? others.filter((x) => x.title.toLowerCase().includes(q)) : others;
      if (!this.items.length) return this.close();
      this.start = offset - this.query.length - 1;
      this.end = offset;
      this.show(editable, node, this.start);
    },

    show(editable, node, start) {
      this.ensureEl();
      this.editable = editable; this.node = node; this.start = start; this.active = 0; this.open = true;
      const list = U.$('.mention-list', this.el);
      list.innerHTML = this.items.map((x, i) => {
        const t = LC.NODE_TYPES[x.type];
        const done = x.state.status === 'done';
        const thumb = this.thumb(x);
        const iconHTML = thumb
          ? `<img class="mi-thumb" src="${U.esc(thumb)}" alt="">`
          : `<span class="mi-icon" style="background:${t.color}">${U.icon(t.icon, 12)}</span>`;
        return `<div class="mention-item${i === 0 ? ' active' : ''}" data-i="${i}">
          ${iconHTML}
          <span class="mi-title">${U.esc(x.title)}</span>
          <span class="mi-state">${done ? '✓ 有结果' : '未执行'}</span></div>`;
      }).join('');
      list.querySelectorAll('.mention-item').forEach((it) => {
        it.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          this.pick(parseInt(it.dataset.i, 10));
        });
      });
      this.el.hidden = false;
      const r = editable.getBoundingClientRect();
      this.el.style.left = Math.min(r.left, innerWidth - 280) + 'px';
      this.el.style.top = Math.min(r.bottom + 6, innerHeight - 240) + 'px';
    },

    pick(i) {
      const target = this.items[i]; if (!target || !this.editable) return this.close();
      const { text } = this.caretOffset(this.editable);
      const before = text.slice(0, this.start);
      const after = text.slice(this.end);
      const newText = before + '@' + target.title + ' ' + after;
      this.node.props.prompt = newText;
      this.editable.innerHTML = this.textToHTML(newText);
      this.setCaret(this.editable, before.length + target.title.length + 2);
      this.close();
      LC.App.saveSoon();
    },

    key(e) {
      if (!this.open) return false;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.move(1); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.move(-1); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.pick(this.active); return true; }
      if (e.key === 'Escape') { this.close(); return true; }
      return false;
    },

    move(d) {
      this.active = (this.active + d + this.items.length) % this.items.length;
      const list = U.$$('.mention-item', this.el);
      list.forEach((it, i) => it.classList.toggle('active', i === this.active));
      list[this.active]?.scrollIntoView({ block: 'nearest' });
    },

    close() { if (this.el) this.el.hidden = true; this.open = false; this.items = []; },
  };

  /* =====================================================
   * 本地上传：图片/视频节点直接上传并显示封面
   * ===================================================== */
  const NodeUpload = {
    /* 点击按钮选文件 */
    pick(n) {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = n.type === 'video' ? 'video/*' : 'image/*';
      inp.onchange = () => { if (inp.files[0]) this.load(n, inp.files[0]); };
      inp.click();
    },

    /* 视频节点素材槽位上传（MiniMax H3）：
       首帧/尾帧各 1 张；参考图 ≤9 / 参考视频 ≤3 / 参考音频 ≤3 */
    pickSlot(n, prop, accept, max) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept; inp.multiple = max > 1;
      inp.onchange = async () => {
        const files = [...inp.files].slice(0, max);
        if (!files.length) return;
        const prefix = 'data:' + accept.replace('/*', '/');
        LC.App.toast('上传素材中…', 'ok');
        for (const f of files) {
          try {
            const { url, name, dataURL } = await this.uploadToServer(f);
            if (!String(dataURL).startsWith(prefix)) {
              LC.App.toast('文件类型不符（需 ' + accept + '）', 'err');
              continue;
            }
            if (prop === 'firstFrame' || prop === 'lastFrame') {
              n.props[prop] = url;             // 持久化只存 URL
              n.props[prop + 'Data'] = dataURL; // 内存 dataURL 不序列化
              n.props.mode = 'shouweizhen';
            } else {
              if (!Array.isArray(n.props[prop])) n.props[prop] = [];
              if (n.props[prop].length < max) n.props[prop].push({ url, data: dataURL, name });
              n.props.mode = 'cankaosheng';
            }
          } catch (e) { LC.App.toast('上传失败：' + e.message, 'err'); }
        }
        LC.App.nodes.updateNode(n.id);
        LC.App.saveSoon();
        LC.App.toast('素材已上传', 'ok');
      };
      inp.click();
    },
    pickFrame(n) { this.pickSlot(n, 'firstFrame', 'image/*', 1); },
    pickLast(n) { this.pickSlot(n, 'lastFrame', 'image/*', 1); },
    pickRefImages(n) { this.pickSlot(n, 'refImages', 'image/*', videoRefCaps(n.props.model).img || 9); },
    pickRefVideos(n) {
      const max = videoRefCaps(n.props.model).vid;
      if (max <= 0) return LC.App.toast('当前模型不支持参考视频', 'warn');
      this.pickSlot(n, 'refVideos', 'video/*', max);
    },
    pickRefAudios(n) {
      const max = videoRefCaps(n.props.model).aud;
      if (max <= 0) return LC.App.toast('当前模型不支持参考音频', 'warn');
      this.pickSlot(n, 'refAudios', 'audio/*', max);
    },

    /* 音频节点：上传本地音频 */
    pickAudio(n) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'audio/*';
      inp.onchange = async () => {
        const f = inp.files[0]; if (!f) return;
        try {
          const { url, name, dataURL } = await this.uploadToServer(f);
          if (!/^data:audio\//.test(dataURL)) return LC.App.toast('请选择音频文件', 'err');
          n.props.localAudio = url;             // 持久化只存 URL
          n.props.localName = name;
          n.state.output = { kind: 'audio', dataURL, url, voice: name, duration: 0, meta: { type: '本地音频', model: name } };
          n.state.status = 'done'; n.state.progress = 100;
          LC.App.nodes.updateNode(n.id);
          LC.App.graph.emit('change');
          LC.App.registerAsset?.(n);
          LC.App.saveSoon();
          LC.App.toast(`已上传「${name.slice(0, 24)}」`, 'ok');
          LC.Executor.autoDownstream(n.id);
        } catch (e) { LC.App.toast('上传失败：' + e.message, 'err'); }
      };
      inp.click();
    },

    /* 上传文件到云端仓库，返回 {url, name, dataURL} — dataURL 仅内存使用不持久化 */
    async uploadToServer(f) {
      const j = await LC.Cloud.uploadAsset(f, f.name || 'file');
      if (!j || !j.url) throw new Error('上传失败');
      // 同时读 dataURL 供内存使用（AI 调用、预览）
      const dataURL = await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = () => rej(new Error('读取失败'));
        rd.readAsDataURL(f);
      });
      return { url: j.url, name: j.name || f.name, dataURL };
    },

    load(n, f) {
      LC.App.toast('上传中…', 'ok');
      this.uploadToServer(f).then(({ url, name, dataURL }) => {
        this.apply(n, url, dataURL, name);
      }).catch(e => LC.App.toast('上传失败：' + (e.message || e), 'err'));
    },

    /* 上传落位：url 存 props（持久化），dataURL 仅存内存 output（不序列化）。
       注意：不再强制改 mode='upload' —— 保留用户当前 mode（如已点"图生图"按钮的 mode='ref'），
       否则用户切了图生图模式又被上传动作覆盖回纯透传，导致参考图失效。 */
    async apply(n, url, dataURL, fname) {
      if (n.type === 'image') {
        if (!/^data:image\//.test(dataURL)) return LC.App.toast('请选择图片文件', 'err');
        n.props.localURL = url;             // 持久化只存 URL（几十字节）
        // 只在 mode 为空时才默认 'upload'；用户已选其他模式（ref/single 等）则保留
        if (!n.props.mode) n.props.mode = 'upload';
        n.state.output = { kind: 'image', dataURL, url, meta: { prompt: n.props.prompt || '', type: '本地图片', model: fname || '本地上传', time: U.formatTime() } };
      } else if (n.type === 'video') {
        if (!/^data:video\//.test(dataURL)) return LC.App.toast('请选择视频文件', 'err');
        const info = await this.videoInfo(dataURL);
        n.props.localVideo = url;           // 持久化只存 URL
        n.props.localCover = info.cover;    // 封面缩略图小，可存
        n.props.localDuration = info.duration;
        n.props.localName = fname || '本地视频';
        n.state.output = this.videoOutput(n, dataURL);
      } else return;
      n.state.status = 'done'; n.state.progress = 100;
      LC.App.nodes.updateNode(n.id);
      LC.App.graph.emit('change');
      LC.App.registerAsset?.(n);
      LC.App.saveSoon();
      LC.App.toast(`已上传「${(fname || '本地文件').slice(0, 24)}」`, 'ok');
      LC.Executor.autoDownstream(n.id);
    },

    /* 由 props 重建本地视频输出（重跑也稳定） */
    videoOutput(n, dataURL) {
      return {
        kind: 'video',
        frames: n.props.localCover ? [n.props.localCover] : [],
        duration: n.props.localDuration || 8,
        dataURL: dataURL || n.props.localVideo,   // 优先用内存 dataURL，回退到 URL
        url: n.props.localVideo || null,          // 磁盘 URL，toJSON 据此剔除 dataURL
        meta: { mode: '本地视频', model: n.props.localName || '本地视频' },
      };
    },

    /* 删除节点后清理不再被引用的磁盘素材（其他节点/资产仍引用则保留） */
    cleanupOrphanAssets(removedNodes) {
      try {
        const g = LC.App.graph;
        const stillUsed = new Set();
        const collectFrom = (props, output) => {
          if (!props) return;
          const isAsset = (v) => String(v).startsWith('/assets/') || String(v).indexOf('/lctv-canvas-data/main/assets/') >= 0;
          ['localURL', 'localVideo', 'localAudio', 'firstFrame', 'lastFrame'].forEach((k) => {
            if (typeof props[k] === 'string' && isAsset(props[k])) stillUsed.add(props[k]);
          });
          ['refImages', 'refVideos', 'refAudios'].forEach((k) => {
            (Array.isArray(props[k]) ? props[k] : []).forEach((x) => { if (x && x.url && isAsset(x.url)) stillUsed.add(x.url); });
          });
          if (output && output.url && isAsset(output.url)) stillUsed.add(output.url);
        };
        g.nodes.forEach((nn) => collectFrom(nn.props, nn.state && nn.state.output));
        const toDelete = new Set();
        (removedNodes || []).forEach((rn) => {
          const p = rn.props || {};
          const isAsset = (v) => String(v).startsWith('/assets/') || String(v).indexOf('/lctv-canvas-data/main/assets/') >= 0;
          ['localURL', 'localVideo', 'localAudio', 'firstFrame', 'lastFrame'].forEach((k) => {
            if (typeof p[k] === 'string' && isAsset(p[k]) && !stillUsed.has(p[k])) toDelete.add(p[k]);
          });
          ['refImages', 'refVideos', 'refAudios'].forEach((k) => {
            (Array.isArray(p[k]) ? p[k] : []).forEach((x) => { if (x && x.url && isAsset(x.url) && !stillUsed.has(x.url)) toDelete.add(x.url); });
          });
          // 注意：output.url（生成的图片/视频/音频）永久保留在资产库，节点删除时不清理
        });
        toDelete.forEach((url) => {
          LC.Cloud.deleteAsset(url).catch(() => {});
        });
      } catch (e) { /* 清理失败不影响主流程 */ }
    },

    /* 抓取视频首帧 + 时长 */
    videoInfo(dataURL) {
      return new Promise((resolve) => {
        let done = false;
        const fin = (cover, duration) => { if (!done) { done = true; resolve({ cover, duration }); } };
        const v = document.createElement('video');
        v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = dataURL;
        v.onloadedmetadata = () => {
          const dur = isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : 8;
          try {
            v.currentTime = Math.min(0.1, dur / 10);
            v.onseeked = () => {
              try {
                const c = document.createElement('canvas');
                c.width = 360; c.height = Math.round(360 * (v.videoHeight / (v.videoWidth || 640)) || 202);
                c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
                fin(c.toDataURL('image/jpeg', .82), dur);
              } catch { fin('', dur); }
            };
            setTimeout(() => fin('', dur), 1600);   // 截帧兜底
          } catch { fin('', dur); }
        };
        v.onerror = () => fin('', 8);
        setTimeout(() => fin('', 8), 4000);           // 整体兜底
      });
    },

    /* 拖拽文件：落点在图片/视频节点上 → 塞进节点；空白处 → 新建对应类型节点 */
    dropFiles(files, clientX, clientY) {
      const f = [...files].find((x) => /^(image|video)\//.test(x.type));
      if (!f) return LC.App.toast('仅支持拖入图片 / 视频文件', 'err');
      const isVideo = f.type.startsWith('video/');
      // 找落点下的节点
      const nodeEl = document.elementsFromPoint(clientX, clientY)
        .map((el) => el.closest?.('.node')).find(Boolean);
      let n = nodeEl && LC.App.graph.getNode(nodeEl.dataset.id);
      if (n && n.type !== (isVideo ? 'video' : 'image')) n = null;
      if (!n) {
        const w = LC.App.view.worldAt(clientX, clientY);
        n = LC.App.graph.createNode(isVideo ? 'video' : 'image', w.x - 120, w.y - 60);
      }
      this.load(n, f);
    },

    clear(n) {
      if (n.type === 'image') n.props.localURL = '';
      if (n.type === 'video') { n.props.localVideo = ''; n.props.localCover = ''; }
      n.state.output = null; n.state.status = 'idle'; n.state.progress = 0;
      LC.App.nodes.updateNode(n.id);
      LC.App.graph.emit('change');
      LC.App.saveSoon();
      LC.App.toast('已移除本地文件', 'ok');
    },
  };

  NodeView.videoRefCaps = videoRefCaps;
  NodeView.videoResolutions = videoResolutions;
  LC.NodeView = NodeView;
  LC.Mention = Mention;
  LC.NodeUpload = NodeUpload;
})();