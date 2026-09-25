/* =====================================================
 * 提示词面板：选中图片/视频节点时显示在节点正下方（留 10px 空隙）
 * 包含：提示词输入区 + 模型/画幅/画质等控件 + 提交按钮
 * 面板跟随节点位置，随画布平移/缩放/拖动实时对齐
 * ===================================================== */
(function () {
  const U = LC.U;
  const GAP = 10;        // 节点底边与面板顶边的空隙（屏幕 px，固定不随缩放）
  const PANEL_W = 560;   // 面板固定屏幕宽度（不随画布缩放变化，保证控件永远横排可读）

  /* 分栏式节点（文本/音频/脚本/字幕）：面板配置
   * promptProp：提示词绑定的 props 字段；modelKind：模型列表类别；modelProp：模型保存字段 */
  const PANE_TYPES = {
    text:     { promptProp: 'text',     modelKind: 'text', modelProp: 'model', placeholder: '文本内容 / 提示词 / 备注…' },
    audio:    { promptProp: 'text',     modelKind: 'tts',  modelProp: 'voice', placeholder: '台词 / 音频描述…' },
    script:   { promptProp: 'content',  modelKind: 'text', modelProp: 'model', placeholder: '粘贴故事梗概或完整剧本…' },
    subtitle: { promptProp: 'text',     modelKind: 'text', modelProp: 'model', placeholder: '字幕文本…' },
  };

  const Panel = {
    el: null,
    node: null,   // 当前绑定的节点

    init() {
      this.el = U.$('#prompt-panel');
      this.bindPanel();
      // 选中变化时刷新面板
      LC.App.graph.on((evt) => {
        if (evt === 'select') this.refresh();
      });
      // 节点状态变化时刷新提交按钮
      LC.App.graph.on((evt) => {
        if (evt === 'node:state') this.updateRunBtn();
      });
      // 点击任何非节点、非面板区域 → 取消选中隐藏面板
      // （画布空白、左面板、菜单栏、工具栏等点击都生效）
      document.addEventListener('pointerdown', (e) => {
        if (!this.el || this.el.hidden) return;
        if (this.el.contains(e.target)) return;                 // 点面板内：保留
        if (e.target.closest && e.target.closest('.node')) return;  // 点节点：交给节点逻辑
        if (LC.Mention && LC.Mention.el && LC.Mention.el.contains(e.target)) return;  // 点@菜单：保留
        if (this._stylePop && this._stylePop.contains(e.target)) return;              // 点风格菜单：保留
        if (this._aspectPop && this._aspectPop.contains(e.target)) return;            // 点画幅菜单：保留
        if (this._dropPop && this._dropPop.contains(e.target)) return;                // 点下拉菜单：保留
        LC.App.nodes.select([]);                                // 其他任何地方 → 隐藏
      }, true);
      // Alt+V 切换语音输入（网页版无本地语音服务，仅提示）
      document.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        if (e.key !== 'v' && e.key !== 'V' && e.code !== 'KeyV') return;
        if (!this.el || this.el.hidden) return;
        if (!this.node) return;
        e.preventDefault();
        if (LC.App && LC.App.toast) LC.App.toast('网页版暂不支持语音输入', 'warn');
      });
    },

    /* 获取当前应绑定的节点（单选 图片/视频/文本/音频/脚本/字幕 节点） */
    currentNode() {
      const ids = [...LC.App.nodes.selected];
      if (ids.length !== 1) return null;
      const n = LC.App.graph.getNode(ids[0]);
      if (!n) return null;
      if (n.type !== 'image' && n.type !== 'video' && !PANE_TYPES[n.type]) return null;
      return n;
    },

    refresh() {
      this._stopVoice && this._stopVoice();
      const n = this.currentNode();
      if (!n) { this.hide(); return; }
      this.node = n;
      this.render(n);
      this.show();
      this.position();
    },

    show() {
      if (this.el) this.el.hidden = false;
      this.position();        // 立即定位到节点正下方
      this._startRAF();       // rAF 跟随节点拖动（画布平移时面板定在原地）
    },
    hide() {
      this._stopRAF();
      if (this._stopVoice) this._stopVoice();
      this.node = null;
      this.closeStylePicker();
      this.closeDropPicker();
      if (LC.Mention) LC.Mention.close();
      if (this.el) this.el.hidden = true;
    },

    /* rAF：视口未变化（节点被拖动）时每帧重定位跟随；
       视口变化（画布平移/缩放）时面板定在原地不动 */
    _startRAF() {
      if (this._raf) return;
      let last = null;
      const loop = () => {
        if (!this.el || this.el.hidden) { this._raf = null; return; }
        const v = LC.App.view;
        const cur = v.x + ',' + v.y + ',' + v.z;
        if (last !== null && cur === last) this.position();   // 视口未变 → 节点拖动中 → 跟随
        last = cur;
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    },
    _stopRAF() {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    },

    /* ---------- 定位：面板水平居中节点中心，垂直贴节点下方 GAP（10px） ---------- */
    position() {
      const n = this.node;
      if (!n || !this.el || this.el.hidden) return;
      const nodeEl = LC.App.nodes.els.get(n.id);
      if (!nodeEl) return;
      const cR = LC.App.view.canvas.getBoundingClientRect();
      const nR = nodeEl.getBoundingClientRect();   // 节点真实屏幕包围盒（已含缩放）
      const left = (nR.left + nR.width / 2) - PANEL_W / 2 - cR.left;
      const top = nR.bottom + GAP - cR.top;
      this.el.style.width = PANEL_W + 'px';
      this.el.style.transform = `translate(${left}px, ${top}px)`;
    },

    /* ---------- 渲染面板内容 ---------- */
    render(n) {
      this.closeStylePicker();
      this.closeDropPicker();
      const pane = PANE_TYPES[n.type];
      if (pane) return this.renderPane(n, pane);
      const p = n.props;
      const isImg = n.type === 'image';

      // ---------- 图片模型「档位」下拉：按模型能力动态（不写死） ----------
      // tt-image-2 → 画质 高/中/低；tt-image-2.5 / 官转、纳米香蕉 Pro → 分辨率 1K/2K/4K；其他 → null（走画质+分辨率组合）
      const ttTierCfg = (modelId) => {
        const id = String(modelId || '');
        if (/tt-image-2\.5/i.test(id)) return { prop: 'imgRes', def: '2K',
          options: [['auto', '自适应'], ['1K', '1K'], ['2K', '2K'], ['4K', '4K']] };
        if (/banana-pro/i.test(id)) return { prop: 'imgRes', def: '2K',
          options: [['1K', '1K'], ['2K', '2K'], ['4K', '4K']] };
        if (/^tt-image-2($|-)/i.test(id)) return { prop: 'imgQuality', def: 'high',
          options: [['high', '画质·高'], ['medium', '画质·中'], ['low', '画质·低']] };
        return null;
      };
      const ttCfg = isImg && LC.Settings ? ttTierCfg((LC.Settings.findModel(p.model, 'image') || {}).modelId) : null;
      // 当前值：在档位内取之，否则用默认档（绝不让 auto 兜底）
      const ttCur = ttCfg && ttCfg.options.some(([v]) => v === p[ttCfg.prop]) ? p[ttCfg.prop] : (ttCfg ? ttCfg.def : '');
      const ttLabel = ttCfg ? ((ttCfg.options.find(([v]) => v === ttCur) || ttCfg.options[0])[1]) : '';

      // 模型下拉（自定义按钮，显示完整名称）
      const modelKind = isImg ? (p.mode === 'reverse' ? 'text' : 'image') : 'video';
      const modelProp = isImg ? (p.mode === 'reverse' ? 'textModel' : 'model') : 'model';
      const modelOpts = () => {
        const names = LC.Settings.modelNames(modelKind);
        if (!names.length) return `<button class="pp-nomodel" data-open-settings>去设置添加模型</button>`;
        const cur = p[modelProp];
        const icon = `<span class="pp-model-ic">${U.icon('image', 14)}</span>`;
        return `<span class="pp-model">${icon}<button class="pp-drop" data-ppdrop="${modelProp}">${U.esc(cur)}<span class="pp-caret">▾</span></button></span>`;
      };

      // 画幅：自定义下拉按钮（视频含"自适应"）
      const aspLabel = (!isImg && (!p.aspect || p.aspect === 'adaptive')) ? '自适应' : (p.aspect || '1:1');
      const aspectSel = `<button class="pp-drop pp-drop-sm" data-ppdrop="aspect" title="选择画幅比例">${aspLabel}<span class="pp-caret">▾</span></button>`;

      // 画质：tt 模型按动态档位手动选；其他图片模型用「画质+分辨率」组合；视频用滑块选秒
      const qualityLabel = isImg
        ? (ttCfg
          ? (ttLabel || '自适应')
          : (Number(p.quality) ? '高清' : '标准') + '画质 ' + (p.resolution || '2K'))
        : (p.duration || 5) + 's';
      // 视频时长：迷你 range 滑块（替代下拉）；图片仍用下拉
      const vModel = p.model || '';
      const durMax = /seedance.*2\.5|seedance-2-5/i.test(vModel) ? 30 : 15;
      const durCur = Number(p.duration) || 5;
      const qualitySel = isImg
        ? `<button class="pp-drop pp-drop-sm" data-ppdrop="${ttCfg ? 'ttTier' : 'qualityRes'}">${qualityLabel}<span class="pp-caret">▾</span></button>`
        : `<span class="pp-dur-slider" title="拖动选时长"><input type="range" class="pp-dur-range" min="4" max="${durMax}" step="1" value="${durCur}"><span class="pp-dur-val">${durCur}s</span></span>`;

      // 模式 chips（图片）
      const modeChips = isImg ? (() => {
        const modes = [['single', '生图'], ['tri', '三视图'], ['grid', '九宫格'], ['ref', '参考图'], ['reverse', '逆向']];
        return modes.map(([v, lb]) =>
          `<span class="pp-chip${p.mode === v ? ' on' : ''}" data-ppchip="mode=${v}">${lb}</span>`).join('');
      })() : (() => {
        // H3 三模式（旧 i2v 归一为首尾帧）
        const cur = (p.mode === 'shouweizhen' || p.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';
        const modes = [['shouweizhen', '首尾帧'], ['cankaosheng', '参考生']];
        return modes.map(([v, lb]) =>
          `<span class="pp-chip${cur === v ? ' on' : ''}" data-ppchip="mode=${v}">${lb}</span>`).join('');
      })();

      // 参考素材按钮：视频按模式切换（首尾帧 / 参考生 / 文生=本地视频导入）
      const vMode = (p.mode === 'shouweizhen' || p.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';
      const caps = !isImg && LC.NodeView?.videoRefCaps ? LC.NodeView.videoRefCaps(p.model) : { img: 9, vid: 3, aud: 3 };
      const refBtns = isImg
        ? `<button class="pp-tag" data-ppact="ref" title="上传参考图"><span class="pp-plus">+</span>参考</button>`
        : (vMode === 'shouweizhen'
          ? `<button class="pp-tag" data-ppact="ref" title="上传首帧图"><span class="pp-plus">+</span>首帧</button>
            <button class="pp-tag" data-ppact="lastframe" title="上传尾帧图（可选）"><span class="pp-plus">+</span>尾帧</button>`
          : vMode === 'cankaosheng'
            ? `<button class="pp-tag" data-ppact="ref" title="上传参考图（最多${caps.img}张）"><span class="pp-plus">+</span>参考图</button>
            ${caps.vid > 0 ? `<button class="pp-tag" data-ppact="refvid" title="上传参考视频（最多${caps.vid}个）"><span class="pp-plus">+</span>视频</button>` : ''}
            ${caps.aud > 0 ? `<button class="pp-tag" data-ppact="refaud" title="上传参考音频（最多${caps.aud}段）"><span class="pp-plus">+</span>音频</button>` : ''}`
            : `<button class="pp-tag" data-ppact="ref" title="导入本地视频文件（作为成片透传）"><span class="pp-plus">+</span>本地视频</button>`);

      // 风格按钮固定显示"风格"，选中后右侧显示风格名
      this.el.innerHTML = `
        <div class="pp-inner">
          <div class="pp-node-title" title="当前面板绑定的节点（下方 ▶ 只生成这个节点）">${U.icon('target', 12)} ${U.esc(n.title)}</div>
          <div class="pp-top">
            <div class="pp-tags">
              ${refBtns}
              <button class="pp-tag" data-ppact="tag" title="标记">${U.icon('pin', 13)} 标记</button>
              <button class="pp-tag pp-tag-style${p.style ? ' on' : ''}" data-ppact="style" title="选择画面风格（隐藏提示词）">${U.icon('knob', 13)} 风格</button>${p.style ? `<span class="pp-style-now">${U.esc(p.style)}</span>` : ''}
            </div>
            <button class="pp-zoom" data-ppact="zoom" title="放大编辑">${U.icon('maximize', 14)}</button>
          </div>
          <div class="pp-modes">${modeChips}</div>
          <div class="pp-input-wrap">
            <div class="pp-input" contenteditable="true" spellcheck="false" data-ppprop="prompt"
              data-placeholder="${isImg ? '可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜' : '视频内容描述（动作/运镜/氛围）… 输入 @ 可引用其他节点'}">${LC.Mention.textToHTML(p.prompt || '')}</div>
          </div>
          <div class="pp-bar">
            <div class="pp-bar-left">
              ${modelOpts()}
              <span class="pp-sep"></span>
              ${aspectSel}
              <span class="pp-mid">·</span>
              ${qualitySel}
              <span class="pp-mid">·</span>
              ${isImg ? `<button class="pp-drop pp-drop-sm" data-ppdrop="count">${p.count || 1}张<span class="pp-caret">▾</span></button>`
                : `<button class="pp-drop pp-drop-sm" data-ppdrop="resolution" title="输出分辨率">${p.resolution || '720P'}<span class="pp-caret">▾</span></button>`}
            </div>
            <div class="pp-bar-right">
              <button class="pp-run" data-ppact="run" title="生成">${U.icon('arrow-up', 15)}</button>
            </div>
          </div>
        </div>`;

      this.bindEvents(n);
      this.updateRunBtn();
    },

    /* ---------- 分栏式节点（文本/音频/脚本/字幕）：简版面板 — 提示词输入 + 模型选择 + 生成 ---------- */
    renderPane(n, cfg) {
      this.closeStylePicker();
      this.closeDropPicker();
      const p = n.props;
      // 模型选择：自定义下拉按钮（显示完整名称）；空列表则引导去设置添加
      const modelOpts = () => {
        const names = LC.Settings.modelNames(cfg.modelKind);
        if (!names.length) return `<button class="pp-nomodel" data-open-settings>暂无${cfg.modelKind === 'tts' ? '音色' : '语言模型'} · 去设置添加</button>`;
        const cur = p[cfg.modelProp];
        const icon = U.icon(cfg.modelKind === 'tts' ? 'audio' : 'text', 14);
        return `<span class="pp-model">${icon}<button class="pp-drop" data-ppdrop="${cfg.modelProp}">${U.esc(cur || names[0])}<span class="pp-caret">▾</span></button></span>`;
      };
      this.el.innerHTML = `
        <div class="pp-inner">
          <div class="pp-node-title" title="当前面板绑定的节点（下方 ▶ 只生成这个节点）">${U.icon('target', 12)} ${U.esc(n.title)}</div>
          <div class="pp-input-wrap">
            <div class="pp-input" contenteditable="true" spellcheck="false" data-ppprop="${cfg.promptProp}"
              data-placeholder="${cfg.placeholder}">${LC.Mention.textToHTML(p[cfg.promptProp] || '')}</div>
          </div>
          <div class="pp-bar">
            <div class="pp-bar-left">${modelOpts()}</div>
            <div class="pp-bar-right">
              <button class="pp-run" data-ppact="run" title="生成">${U.icon('arrow-up', 15)}</button>
            </div>
          </div>
        </div>`;
      this.bindEvents(n);
      this.updateRunBtn();
    },

    /* ---------- 风格选择弹层（24 种风格，隐藏提示词） ---------- */
    openStylePicker(n, anchor) {
      this.closeStylePicker();
      const styles = (LC.AI && LC.AI.STYLES) || [];
      const pop = document.createElement('div');
      pop.className = 'pp-style-pop';
      pop.innerHTML =
        `<div class="pp-style-head">画面风格（自动注入隐藏提示词）</div>`
        + `<div class="pp-style-grid">`
        + `<span class="pp-style-item${!n.props.style ? ' on' : ''}" data-style="">不指定</span>`
        + styles.map((s) =>
          `<span class="pp-style-item${n.props.style === s ? ' on' : ''}" data-style="${U.esc(s)}">${U.esc(s)}</span>`).join('')
        + `</div>`;
      document.body.appendChild(pop);
      // 定位在风格按钮上方
      const r = anchor.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.left = Math.min(r.left, window.innerWidth - 340) + 'px';
      const top = r.top - pop.offsetHeight - 8;
      pop.style.top = (top > 8 ? top : r.bottom + 8) + 'px';
      pop.addEventListener('click', (e) => {
        const item = e.target.closest('.pp-style-item');
        if (!item) return;
        n.props.style = item.dataset.style || '';
        LC.App.saveSoon();
        this.closeStylePicker();
        this.render(n);
        this.position();
        if (n.props.style) LC.App.toast('风格：' + n.props.style + '（生成时自动注入）', 'ok');
      });
      // 点击外部关闭
      setTimeout(() => {
        const off = (ev) => {
          if (pop.contains(ev.target) || (anchor && anchor.contains(ev.target))) return;
          this.closeStylePicker();
          document.removeEventListener('pointerdown', off, true);
        };
        document.addEventListener('pointerdown', off, true);
      }, 0);
      this._stylePop = pop;
    },
    closeStylePicker() {
      if (this._stylePop) { this._stylePop.remove(); this._stylePop = null; }
    },

    /* ---------- 通用自定义下拉弹层（统一符号/颜色/hover；body 挂载避免被画布 transform/overflow 裁剪） ---------- */
    openDropPicker(n, prop, anchor) {
      this.closeDropPicker();
      const isImg = n.type === 'image';
      let items = [];
      if (prop === 'aspect') {
        const aspects = isImg ? [
          ['1:1', '1:1'], ['1:2', '1:2'], ['2:1', '2:1'], ['9:16', '9:16'], ['16:9', '16:9'],
          ['3:4', '3:4'], ['4:3', '4:3'], ['3:2', '3:2'], ['2:3', '2:3'], ['5:4', '5:4'],
          ['4:5', '4:5'], ['21:9', '21:9'], ['9:21', '9:21'],
        ] : [
          ['adaptive', '自适应'], ['16:9', '16:9'], ['9:16', '9:16'], ['1:1', '1:1'],
          ['4:3', '4:3'], ['3:4', '3:4'], ['21:9', '21:9'],
        ];
        items = aspects.map(([v, lb]) => ({ v, label: lb, on: n.props.aspect === v }));
      } else if (prop === 'model' || prop === 'textModel' || prop === 'voice') {
        // 图片/视频：按模式解析 kind；分栏式节点：按面板配置解析 kind 与字段
        const pane = PANE_TYPES[n.type];
        let kind, modelProp;
        if (prop === 'voice') { kind = 'tts'; modelProp = 'voice'; }
        else if (pane) { kind = pane.modelKind; modelProp = pane.modelProp; }
        else {
          kind = isImg ? (n.props.mode === 'reverse' ? 'text' : 'image') : 'video';
          modelProp = isImg ? (n.props.mode === 'reverse' ? 'textModel' : 'model') : 'model';
        }
        const cur = n.props[modelProp];
        items = LC.Settings.modelNames(kind).map((m) => ({ v: m, label: m, on: m === cur }));
      } else if (prop === 'qualityRes') {
        items = [
          { v: '0|2K', label: '标准画质 2K', on: !Number(n.props.quality) && (n.props.resolution || '2K') === '2K' },
          { v: '1|2K', label: '高清画质 2K', on: Number(n.props.quality) && (n.props.resolution || '2K') === '2K' },
          { v: '0|4K', label: '标准画质 4K', on: !Number(n.props.quality) && n.props.resolution === '4K' },
          { v: '1|4K', label: '高清画质 4K', on: Number(n.props.quality) && n.props.resolution === '4K' },
        ];
      } else if (prop === 'ttTier') {
        // tt/香蕉动态档位：tt-image-2 → 画质(高/中/低)；tt-image-2.5 → 分辨率(自适应/1K/2K/4K)；banana-pro → 分辨率(1K/2K/4K)
        const id = String((LC.Settings.findModel(n.props.model, 'image') || {}).modelId || '');
        let opts, cfgProp, def;
        if (/tt-image-2\.5/i.test(id)) { opts = [['auto', '自适应'], ['1K', '1K'], ['2K', '2K'], ['4K', '4K']]; cfgProp = 'imgRes'; def = '2K'; }
        else if (/banana-pro/i.test(id)) { opts = [['1K', '1K'], ['2K', '2K'], ['4K', '4K']]; cfgProp = 'imgRes'; def = '2K'; }
        else { opts = [['high', '画质·高'], ['medium', '画质·中'], ['low', '画质·低']]; cfgProp = 'imgQuality'; def = 'high'; }
        const cur = opts.some(([v]) => v === n.props[cfgProp]) ? n.props[cfgProp] : def;
        items = opts.map(([v, lb]) => ({ v, label: lb, on: cur === v, cfgProp }));
      } else if (prop === 'duration') {
        // 按模型查时长范围：Seedance 2.5 → 4~30 秒；其余 → 4~15 秒
        const mn = n.props.model || '';
        const max = /seedance.*2\.5|seedance-2-5/i.test(mn) ? 30 : 15;
        items = Array.from({ length: max - 3 }, (_, i) => i + 4)
          .map((v) => ({ v, label: v + 's', on: Number(n.props.duration) === v }));
      } else if (prop === 'count') {
        items = [1, 2, 4].map((v) => ({ v, label: v + '张', on: Number(n.props.count || 1) === v }));
      } else if (prop === 'resolution') {
        // 视频节点：按当前选的模型动态显示支持的分辨率档位（与节点本体下拉保持一致）
        const mn = n.props.model || '';
        let opts;
        if (/viduq3/i.test(mn)) opts = ['540P', '720P', '1080P'];
        else if (/minimax.*h3|^h3|H3$/i.test(mn)) opts = ['720P', '2K'];
        else if (/seedance.*2\.5|seedance-2-5/i.test(mn)) opts = ['480P', '720P', '1080P'];
        else if (/seedance/i.test(mn)) opts = ['480P', '720P', '1080P', '4K'];
        else opts = ['720P', '1080P', '2K'];
        items = opts.map((v) => ({ v, label: v, on: (n.props.resolution || opts[0]) === v }));
      }
      if (!items.length) return;

      const grid = prop === 'aspect';
      const pop = document.createElement('div');
      pop.className = grid ? 'pp-drop-pop pp-drop-grid' : 'pp-drop-pop';
      pop.style.display = grid ? 'grid' : 'block';
      // ttTier：把目标字段（imgQuality/imgRes）带到 pop，供点击时写对节点 props
      pop._cfgProp = (prop === 'ttTier') ? (items[0] && items[0].cfgProp) : null;
      pop.innerHTML = items.map((it) =>
        `<span class="pp-drop-item${it.on ? ' on' : ''}" data-val="${U.esc(String(it.v))}">${U.esc(it.label)}</span>`).join('');
      document.body.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      // 优先显示在按钮下方；空间不足则显示在上方
      const spaceBelow = window.innerHeight - r.bottom;
      if (spaceBelow >= pop.offsetHeight + 8) pop.style.top = (r.bottom + 6) + 'px';
      else pop.style.top = Math.max(8, r.top - pop.offsetHeight - 6) + 'px';
      pop.addEventListener('click', (e) => {
        const item = e.target.closest('.pp-drop-item');
        if (!item) return;
        const val = item.dataset.val;
        if (prop === 'qualityRes') {
          const [q, res] = val.split('|');
          this.setProp(n, 'quality', Number(q));
          this.setProp(n, 'resolution', res);
        } else if (prop === 'ttTier') {
          // tt 动态档位写入对应字段（tt-2 → imgQuality；tt-2.5 → imgRes），绝无 auto 兜底
          const cfgProp = (this._dropPop && this._dropPop._cfgProp) || 'imgQuality';
          this.setProp(n, cfgProp, val);
        } else if (prop === 'duration' || prop === 'count') {
          this.setProp(n, prop, Number(val));
        } else {
            this.setProp(n, prop, val);
          // 视频模型切换：分辨率强制重置为新模型的最低档（第一档）
          if (prop === 'model' && n.type === 'video' && LC.NodeView?.videoResolutions) {
            const vRes = LC.NodeView.videoResolutions(val);
            if (vRes.length) n.props.resolution = vRes[0][0];
            if (LC.App.nodes) LC.App.nodes.updateNode(n.id);
          }
        }
        this.closeDropPicker();
        if (prop === 'aspect' || prop === 'resolution') LC.App.nodes.updateNode(n.id);   // 画幅改变 → 更新节点预览框比例；分辨率改变 → 同步节点本体下拉显示
        this.render(n);
        this.position();
      });
      setTimeout(() => {
        const off = (ev) => {
          if (pop.contains(ev.target) || (anchor && anchor.contains(ev.target))) return;
          this.closeDropPicker();
          document.removeEventListener('pointerdown', off, true);
        };
        document.addEventListener('pointerdown', off, true);
      }, 0);
      pop._anchor = anchor;
      this._dropPop = pop;
    },
    closeDropPicker() {
      if (this._dropPop) { this._dropPop.remove(); this._dropPop = null; }
    },

    /* ---------- 面板级事件委托（只绑定一次，节点动态读取 this.node） ---------- */
    bindPanel() {
      const el = this.el;
      // 点击：模式 chips / 功能按钮（委托，避免重复绑定导致旧闭包互相覆盖）
      el.addEventListener('click', (e) => {
        const n = this.node;
        if (!n) return;
        if (e.target.closest('.pp-nomodel')) { LC.Settings.open(); return; }
        const chip = e.target.closest('[data-ppchip]');
        if (chip && el.contains(chip)) {
          const [prop, val] = chip.dataset.ppchip.split('=');
          this.setProp(n, prop, val);
          this.render(n);
          this.position();
          return;
        }
        // 自定义下拉按钮：展开选择弹层（body 挂载，置顶显示）
        const drop = e.target.closest('.pp-drop');
        if (drop && el.contains(drop)) {
          if (this._dropPop && this._dropPop._anchor === drop) { this.closeDropPicker(); return; }
          this.openDropPicker(n, drop.dataset.ppdrop, drop);
          return;
        }
        const act = e.target.closest('[data-ppact]');
        if (!act || !el.contains(act)) return;
        const a = act.dataset.ppact;
        if (a === 'run') { LC.Executor.run(n.id); }
        else if (a === 'zoom') { LC.App.nodes.openPromptEditor(n); }
        else if (a === 'ref') {
          if (n.type === 'video' && LC.NodeUpload) {
            // 视频按模式分流：首尾帧→首帧、参考生→参考图
            const m = (n.props.mode === 'shouweizhen' || n.props.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';
            if (m === 'shouweizhen') LC.NodeUpload.pickFrame(n);
            else if (m === 'cankaosheng') LC.NodeUpload.pickRefImages(n);
            else LC.NodeUpload.pick(n);
          } else if (LC.NodeUpload) LC.NodeUpload.pick(n);
          else this.triggerUpload(n);
        }
        else if (a === 'lastframe') { LC.NodeUpload?.pickLast(n); }
        else if (a === 'refvid') { LC.NodeUpload?.pickRefVideos(n); }
        else if (a === 'refaud') { LC.NodeUpload?.pickRefAudios(n); }
        else if (a === 'tag') {
          LC.Modal.prompt('添加标记', n.props.tag || '').then((v) => {
            if (v != null) { n.props.tag = v; LC.App.saveSoon(); }
          });
        }
        else if (a === 'style') {
          this.openStylePicker(n, act);
        }
        else if (a === 'voice') {
          this.toggleVoice(n);
        }
      });

      // input 事件：duration range 滑块实时拖动
      el.addEventListener('input', (e) => {
        const n = this.node;
        if (!n) return;
        const rng = e.target.closest('.pp-dur-range');
        if (!rng || !el.contains(rng)) return;
        const val = Number(rng.value);
        n.props.duration = val;
        const lab = rng.parentElement.querySelector('.pp-dur-val');
        if (lab) lab.textContent = val + 's';
        LC.App.saveSoon();
        // 同步节点本体显示
        if (LC.App.nodes) LC.App.nodes.updateNode(n.id);
      });
    },

    /* ---------- 语音输入（本地 vosk-server WebSocket 流式，边说边出字） ---------- */
    // 后端 vosk_ws.py 监听 ws://127.0.0.1:2700,接收 16kHz mono 16-bit PCM,返回 partial/text
    toggleVoice(n) {
      if (this._voiceOn) this._stopVoice();
      else this._startVoice(n);
    },

    async _startVoice(n) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        LC.App.toast('当前浏览器不支持录音（建议 Chrome/Edge）', 'err');
        return;
      }
      // 先尝试连本地 vosk WebSocket 服务
      let ws;
      try {
        ws = new WebSocket('ws://127.0.0.1:2700');
        ws.binaryType = 'arraybuffer';
      } catch (e) {
        LC.App.toast('无法连接语音识别服务，请确认 vosk_ws.py 已启动', 'err');
        return;
      }
      this._voiceOn = true;
      this._voiceNode = n;
      this._voiceFinal = n.props[this.promptPropOf(n)] || '';  // 已有文本作为基础,新内容追加
      this._voicePartial = '';
      this._voiceConnecting = true;

      const onOpen = async () => {
        this._voiceConnecting = false;
        // 打开麦克风,16kHz mono
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        } catch (e) {
          const msg = String(e.name || e.message || '');
          if (/notallowed|denied|permission/i.test(msg)) {
            LC.App.toast('麦克风权限被拒绝,请在浏览器地址栏允许', 'err');
          } else {
            LC.App.toast('麦克风启动失败:' + (e.message || e.name || '未知'), 'err');
          }
          this._stopVoice();
          return;
        }
        if (!this._voiceOn) { stream.getTracks().forEach((t) => t.stop()); return; }
        this._voiceStream = stream;
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        this._voiceCtx = ctx;
        const src = ctx.createMediaStreamSource(stream);
        // ScriptProcessor 4096 帧(单声道),约 0.25s/帧
        const node = ctx.createScriptProcessor(4096, 1, 1);
        const mute = ctx.createGain(); mute.gain.value = 0;
        src.connect(node); node.connect(mute); mute.connect(ctx.destination);
        this._voiceSPNode = node;
        node.onaudioprocess = (e) => {
          if (!this._voiceOn || !ws || ws.readyState !== 1) return;
          const f32 = e.inputBuffer.getChannelData(0);
          // Float32 → Int16 LE
          const buf = new ArrayBuffer(f32.length * 2);
          const v = new DataView(buf);
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          }
          // 检测静音跳过(避免网络/算力浪费):若最大幅度<0.01 视为静音不发送
          let mx = 0;
          for (let i = 0; i < f32.length; i += 16) { const a = Math.abs(f32[i]); if (a > mx) mx = a; }
          if (mx > 0.01) ws.send(buf);
        };
        const btn = U.$('.pp-voice', this.el);
        if (btn) btn.classList.add('recording');
        LC.App.toast('开始录音…边说边出字,再按 Alt+V 或点麦克风结束', 'ok');
      };
      const onMsg = (ev) => {
        let j;
        try { j = JSON.parse(ev.data); } catch (e) { return; }
        if (j.partial != null) {
          this._voicePartial = j.partial || '';
          this._renderVoiceText(n);
        }
        if (j.text != null && j.text) {
          // 一句话说完的最终结果,追加到 _voiceFinal
          const base = this._voiceFinal;
          const sep = base && !base.endsWith(' ') && !base.endsWith('\n') ? ' ' : '';
          this._voiceFinal = base + sep + j.text;
          this._voicePartial = '';
          this._renderVoiceText(n);
        }
        if (j.final != null) {
          // 连接结束前的总最终结果
          if (j.final) {
            const base = this._voiceFinal;
            const sep = base && !base.endsWith(' ') && !base.endsWith('\n') ? ' ' : '';
            this._voiceFinal = base + sep + j.final;
          }
          this._voicePartial = '';
          this._renderVoiceText(n);
        }
      };
      const onErr = () => {
        // 错误:onclose 会接着触发
      };
      const onClose = () => {
        if (this._voiceConnecting) {
          LC.App.toast('无法连接语音识别服务,请确认 vosk_ws.py 已启动 (端口 2700)', 'err');
          this._voiceOn = false;
          this._voiceConnecting = false;
        } else if (this._voiceOn) {
          // 异常断开,自动重连一次
          LC.App.toast('语音识别服务意外断开,请重新按 Alt+V', 'err');
          this._voiceOn = false;
          this._cleanupVoiceRes();
        }
        const btn = U.$('.pp-voice', this.el);
        if (btn) btn.classList.remove('recording');
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMsg);
      ws.addEventListener('error', onErr);
      ws.addEventListener('close', onClose);
      this._voiceWS = ws;
      this._voiceWSHandlers = { onOpen, onMsg, onErr, onClose };
    },

    _renderVoiceText(n) {
      const ed = U.$('.pp-input', this.el);
      if (!ed) return;
      const final = this._voiceFinal || '';
      const partial = this._voicePartial || '';
      const sep = final && partial && !final.endsWith(' ') && !final.endsWith('\n') ? ' ' : '';
      const text = (final + sep + partial).trim();
      n.props[this.promptPropOf(n)] = text;
      ed.innerHTML = LC.Mention.textToHTML(text);
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    },

    _cleanupVoiceRes() {
      // 清理本地资源(不关 ws)
      if (this._voiceSPNode) { try { this._voiceSPNode.disconnect(); } catch (e) {} this._voiceSPNode = null; }
      if (this._voiceCtx) { try { this._voiceCtx.close(); } catch (e) {} this._voiceCtx = null; }
      if (this._voiceStream) {
        this._voiceStream.getTracks().forEach((t) => t.stop());
        this._voiceStream = null;
      }
    },

    _stopVoice() {
      this._voiceOn = false;
      // 先让后端出 final 结果
      if (this._voiceWS && this._voiceWS.readyState === 1) {
        try { this._voiceWS.send(JSON.stringify({ eof: 1 })); } catch (e) {}
      }
      // 250ms 后强制清理(等 final 回来)
      setTimeout(() => {
        if (this._voiceWS) {
          if (this._voiceWSHandlers) {
            try {
              this._voiceWS.removeEventListener('open', this._voiceWSHandlers.onOpen);
              this._voiceWS.removeEventListener('message', this._voiceWSHandlers.onMsg);
              this._voiceWS.removeEventListener('error', this._voiceWSHandlers.onErr);
              this._voiceWS.removeEventListener('close', this._voiceWSHandlers.onClose);
            } catch (e) {}
          }
          try { this._voiceWS.close(); } catch (e) {}
          this._voiceWS = null;
          this._voiceWSHandlers = null;
        }
        this._cleanupVoiceRes();
        const btn = U.$('.pp-voice', this.el);
        if (btn) btn.classList.remove('recording');
        if (this._voiceFinal) LC.App.saveSoon();
        this._voicePartial = '';
      }, 250);
    },

    _appendVoiceText(n, text) {
      if (!text) return;
      const ed = U.$('.pp-input', this.el);
      if (!ed) return;
      const cur = n.props[this.promptPropOf(n)] || '';
      const sep = cur && !cur.endsWith(' ') && !cur.endsWith('\n') ? ' ' : '';
      n.props[this.promptPropOf(n)] = cur + sep + text;
      ed.innerHTML = LC.Mention.textToHTML(n.props[this.promptPropOf(n)]);
      // 光标移到末尾，方便继续输入或追加
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(ed); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
      LC.App.saveSoon();
    },

    /* ---------- 每次渲染后绑定：提示词输入框（元素随 innerHTML 重建） ---------- */
    /* 提示词在 props 中的字段名：图片/视频 → prompt；分栏式节点 → 面板配置 */
    promptPropOf(n) {
      const pane = PANE_TYPES[n.type];
      return pane ? pane.promptProp : 'prompt';
    },

    bindEvents(n) {
      const el = this.el;
      const ed = U.$('.pp-input', el);
      ed.addEventListener('input', () => {
        n.props[this.promptPropOf(n)] = LC.Mention.toText(ed);
        LC.App.saveSoon();
        // 分栏式节点：显示框直接展示内容，输入时实时刷新节点预览
        if (PANE_TYPES[n.type] && LC.App.nodes) LC.App.nodes.updateNode(n.id);
        if (LC.Mention) LC.Mention.check(ed, n);   // @提及检测：输入 @ 弹出节点选择菜单
      });
      // @提及：菜单打开后由 Mention.key 处理方向键/Enter/Esc 导航
      // （菜单弹出由上方 input 事件的 Mention.check 负责）
      ed.addEventListener('keydown', (e) => {
        if (LC.Mention && LC.Mention.key(e)) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); LC.Executor.run(n.id); }
      });
    },

    setProp(n, path, val) {
      const parts = path.split('.');
      let o = n.props;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
      o[parts[parts.length - 1]] = val;
      LC.App.saveSoon();
    },

    triggerUpload(n) {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = n.type === 'video' ? 'video/*' : 'image/*';
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) return;
        try {
          const { url, dataURL, name } = await LC.NodeUpload.uploadToServer(f);
          if (n.type === 'video') {
            n.props.localVideo = url;
            n.state.output = { dataURL, url, kind: 'video', duration: n.props.duration || 5, meta: { mode: '本地视频', model: name || f.name } };
          } else {
            n.props.localURL = url;
            n.state.output = { dataURL, url, kind: 'image', meta: { type: '本地图片', model: name || f.name } };
          }
          n.state.status = 'done';
          n.state.progress = 100;
          LC.App.nodes.updateNode(n.id);
          LC.App.graph.emit('change');
          LC.App.saveSoon();
          LC.App.toast('参考图已上传', 'ok');
        } catch (e) {
          LC.App.toast('上传失败：' + (e.message || e), 'err');
        }
      };
      inp.click();
    },

    updateRunBtn() {
      if (!this.node || !this.el) return;
      const btn = U.$('.pp-run', this.el);
      if (!btn) return;
      const running = this.node.state.status === 'running';
      btn.classList.toggle('busy', running);
      btn.disabled = running;
    },
  };

  LC.PromptPanel = Panel;
})();
