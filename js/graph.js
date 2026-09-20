/* 图数据模型：节点类型注册、Graph 数据结构、序列化 */
(function () {
  const U = LC.U;

  /* ---- 节点类型注册表 ---- */
  const T = {};
  const reg = (key, def) => { T[key] = Object.assign({ key, icon: 'dot', color: '#9a9890', w: 400, h: null }, def); };
  const P = (id, label, dt) => ({ id, label, dataType: dt });

  /* 统一端口：每个节点只有一个输入 / 一个输出，内容按数据类型自动识别 */
  const IN = () => [P('in', '输入', 'any')];
  const OUT = () => [P('out', '输出', 'any')];

  /* 五大基础节点 */
  reg('text', {
    icon: 'text', color: 'var(--text-node)', name: '文本节点', category: 'basic', w: 400,
    inputs: IN(), outputs: OUT(),
    props: () => ({ text: '', tag: '', model: '' }),
  });
  reg('image', {
    icon: 'image', color: 'var(--image-node)', name: '图片节点', category: 'basic', w: 560,
    inputs: IN(), outputs: OUT(),
    props: () => ({
      prompt: '', mode: 'single', model: 'gpt-image-2', textModel: '', aspect: '16:9', style: '',
      camera: { focal: '50mm', fstop: 'f/2.8', lens: '标准' },
      light: '电影·低饱和', grid: '3x3', quality: 'standard', resolution: '2K', negPrompt: '',
      background: 'opaque', version: '', imgQuality: '', imgRes: '2K',
    }),
  });
  reg('video', {
    icon: 'video', color: 'var(--video-node)', name: '视频节点', category: 'basic', w: 560,
    inputs: IN(), outputs: OUT(),
    props: () => ({
      prompt: '', model: 'MiniMax H3', duration: 5, mode: 'cankaosheng',
      aspect: 'adaptive', style: '', resolution: '768P',
      firstFrame: '', lastFrame: '', refImages: [], refVideos: [], refAudios: [],
    }),
  });
  reg('audio', {
    icon: 'audio', color: 'var(--audio-node)', name: '音频节点', category: 'basic', w: 440,
    inputs: IN(), outputs: OUT(),
    props: () => ({ kind: 'voice', voice: '', text: '', emotion: '自然', bgm: '无', volume: 80 }),
  });
  reg('script', {
    icon: 'script', color: 'var(--script-node)', name: '脚本节点', category: 'basic', w: 440,
    inputs: IN(), outputs: OUT(),
    props: () => ({ content: '', shotCount: 8, shotDuration: 8, style: '网文漫剧', hasShots: false, model: '' }),
  });

  /* AI 能力节点 */
  reg('stage', {
    icon: 'stage', color: 'var(--stage-node)', name: '3D 导演台', category: 'ai', w: 400,
    inputs: IN(), outputs: OUT(),
    props: () => ({ scene: { objs: [], camera: {} }, snapshot: '' }),
  });
  reg('subtitle', {
    icon: 'subtitle', color: 'var(--check-node)', name: '字幕节点', category: 'ai', w: 400,
    inputs: IN(), outputs: OUT(),
    props: () => ({ style: '默认白字', fontSize: 24, pos: 'bottom', text: '', model: '' }),
  });
  reg('check', {
    icon: 'check', color: 'var(--check-node)', name: '合规校验', category: 'ai', w: 400,
    inputs: IN(), outputs: OUT(),
    props: () => ({ rules: ['版权', '敏感词', '暴力', '肖像'], result: null, model: '' }),
  });
  reg('export', {
    icon: 'export', color: 'var(--export-node)', name: '成片拼接导出', category: 'ai', w: 420,
    inputs: IN(), outputs: OUT(),
    props: () => ({ resolution: '1080p', fps: 25, aspect: '9:16', transitions: '硬切', order: [] }),
  });

  /* 九宫格在 image 节点上以 mode 呈现；补充一个专用快捷节点定义（创建时即 grid 模式） */
  reg('imageGrid', {
    icon: 'grid', color: 'var(--image-node)', name: '九宫格分镜', category: 'ai', w: 560,
    inputs: IN(), outputs: OUT(),
    props: () => ({ prompt: '', mode: 'grid', model: '', aspect: '1:1', grid: '3x3', light: '电影·低饱和' }),
  });

  /* 节点库面板分类 */
  const LIB = {
    basic: [['script', '脚本 / 分镜'], ['text', '文本'], ['image', '图片 / 生图'], ['video', '视频'], ['audio', '音频']],
    ai: [['imageGrid', '九宫格分镜'], ['stage', '3D 导演台'], ['subtitle', 'AI 字幕'], ['export', '拼接导出']],
    tool: [['check', '合规校验']],
  };

  LC.NODE_TYPES = T;
  LC.NODE_LIB = LIB;

  /* ---- Graph 数据结构 ---- */
  class Graph {
    constructor() {
      this.nodes = new Map();      // id -> node
      this.edges = [];             // {id, from:{n,p}, to:{n,p}}
      this.groups = [];            // {id, title, nodes:[], collapsed}
      this.listeners = new Set();
      this.revision = 0;
    }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    emit(evt = 'change', payload) {
      this.revision++;
      this.listeners.forEach((fn) => fn(evt, payload));
    }

    addNode(node) { this.nodes.set(node.id, node); this.emit('node:add', node); return node; }

    createNode(type, x, y, props = null) {
      const t = T[type]; if (!t) throw new Error('未知节点类型: ' + type);
      const n = {
        id: U.uid('n'), type, title: this.uniqueTitle(t.name), x, y, w: t.w,
        props: props || t.props(), state: { status: 'idle', progress: 0, output: null, meta: {} },
        collapsed: false,
      };
      return this.addNode(n);
    }

    /* 标题去重：同名节点自动加序号，保证 @ 引用可唯一定位 */
    uniqueTitle(base) {
      const names = new Set([...this.nodes.values()].map((n) => n.title));
      if (!names.has(base)) return base;
      let i = 2;
      while (names.has(`${base} ${i}`)) i++;
      return `${base} ${i}`;
    }

    /* 解析文本里的 @节点引用：对每个 @ 做节点标题最长匹配（标题允许含空格，
       如「图片节点 3」），返回按出现顺序的 [{ title, node, start, end }] */
    mentionNodes(text) {
      const raw = String(text || '');
      const arr = [...this.nodes.values()];
      const out = [];
      for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== '@') continue;
        let best = null;
        for (const nd of arr) {
          const t = nd.title;
          if (t && raw.startsWith('@' + t, i) && (!best || t.length > best.title.length)) best = nd;
        }
        if (!best) continue;
        out.push({ title: best.title, node: best, start: i, end: i + 1 + best.title.length });
        i += best.title.length;
      }
      return out;
    }

    removeNode(id) {
      const n = this.nodes.get(id); if (!n) return;
      this.edges = this.edges.filter((e) => e.from.n !== id && e.to.n !== id);
      this.nodes.delete(id);
      this.groups.forEach((g) => (g.nodes = g.nodes.filter((x) => x !== id)));
      this.groups = this.groups.filter((g) => g.nodes.length > 0);
      this.emit('node:remove', n);
      // 清理不再被引用的磁盘素材（复制出的节点共享同一 URL，仍被引用则保留）
      if (LC.NodeUpload && LC.NodeUpload.cleanupOrphanAssets) LC.NodeUpload.cleanupOrphanAssets([n]);
    }

    removeNodes(ids) { ids.forEach((id) => this.removeNode(id)); if (ids.length) this.emit('change'); }

    getNode(id) { return this.nodes.get(id); }

    /* 端口引用解析 */
    portRef(ref) { return { node: this.nodes.get(ref.n), portId: ref.p }; }

    addEdge(from, to) {
      if (from.n === to.n) return null;
      if (this.edges.some((e) => e.from.n === from.n && e.from.p === from.p && e.to.n === to.n && e.to.p === to.p)) return null;
      const e = { id: U.uid('e'), from: { ...from }, to: { ...to } };
      this.edges.push(e);
      this.emit('edge:add', e);
      return e;
    }

    removeEdge(id) {
      const i = this.edges.findIndex((e) => e.id === id);
      if (i < 0) return;
      const [e] = this.edges.splice(i, 1);
      this.emit('edge:remove', e);
    }

    edgesOf(id) { return this.edges.filter((e) => e.from.n === id || e.to.n === id); }

    /* 直接上游 / 下游 */
    upstream(id) {
      const set = new Set();
      this.edges.forEach((e) => { if (e.to.n === id) set.add(e.from.n); });
      return [...set];
    }
    downstream(id) {
      const set = new Set();
      this.edges.forEach((e) => { if (e.from.n === id) set.add(e.to.n); });
      return [...set];
    }

    /* 某节点的全部输入：按端口收集 */
    inputsOf(id) {
      const map = {};
      const t = T[this.nodes.get(id).type];
      t.inputs.forEach((p) => (map[p.id] = []));
      this.edges.forEach((e) => {
        if (e.to.n === id && map[e.to.p]) map[e.to.p].push(e.from);
      });
      return map;
    }

    boundingBox(ids) {
      let minX = 1e18, minY = 1e18, maxX = -1e18, maxY = -1e18;
      ids.forEach((id) => {
        const n = this.nodes.get(id); if (!n) return;
        minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + this.nodeHeight(n));
      });
      return minX > 1e17 ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /* 复制子图（返回 id 映射） */
    cloneNodes(ids, dx = 48, dy = 48) {
      const idMap = {};
      const newIds = [];
      ids.forEach((id) => {
        const n = this.nodes.get(id); if (!n) return;
        const copy = JSON.parse(JSON.stringify(n));
        copy.id = U.uid('n'); copy.x += dx; copy.y += dy;
        copy.state.status = 'idle';
        copy.state.progress = 0;
        copy.state.output = null;   // 复制出的节点为干净未执行态，不带旧结果（否则显示「未执行」却残留旧 output / blob URL）
        idMap[id] = copy.id;
        this.addNode(copy);
        newIds.push(copy.id);
      });
      this.edges.forEach((e) => {
        if (idMap[e.from.n] && idMap[e.to.n]) {
          this.addEdge({ n: idMap[e.from.n], p: e.from.p }, { n: idMap[e.to.n], p: e.to.p });
        }
      });
      this.emit('change');
      return newIds;
    }

    /* 序列化 —— 精简：剔除渲染层数据；blob: 链接刷新即失效，
       有签名 videoURL 则替换保存，否则清空回退首帧预览 */
    toJSON() {
      return {
        v: 1, name: LC.App ? LC.App.projectName : '未命名项目',
        savedAt: Date.now(),
        nodes: [...this.nodes.values()].map((n) => {
          // 深拷贝 state，有 url 时剔除 dataURL 节省空间；无 url 时保留 dataURL（旧数据兼容）
          let state = n.state;
          const o = state && state.output;
          if (o) {
            state = { ...state, output: { ...o } };
            delete state.output._dataURL;   // 执行期缓存，绝不序列化
            if (state.output.dataURL && String(state.output.dataURL).startsWith('blob:')) {
              state.output.dataURL = (o.meta && o.meta.videoURL) || '';
            } else if (state.output.dataURL && String(state.output.dataURL).startsWith('data:') && state.output.url) {
              state.output.dataURL = state.output.url;  // 有磁盘 URL 才剔除 dataURL
            }
          }
          // 浅拷贝 props
          const props = { ...n.props };
          // 槽位素材：有 url 才剔除 data；无 url 保留 data（旧数据兼容）
          ['refImages', 'refVideos', 'refAudios'].forEach((p) => {
            if (Array.isArray(props[p])) props[p] = props[p].map((x) => {
              if (x && x.url) return { url: x.url, name: x.name };
              return x;  // 无 url，原样保留（含 data）
            });
          });
          if (props.firstFrameData) delete props.firstFrameData;
          if (props.lastFrameData) delete props.lastFrameData;
          ['localURL', 'localVideo', 'localAudio'].forEach((key) => {
            if (typeof props[key] === 'string' && (props[key].startsWith('data:') || props[key].startsWith('blob:'))) props[key] = '';
          });
          return {
            id: n.id, type: n.type, title: n.title, x: n.x, y: n.y, w: n.w,
            props, state, collapsed: n.collapsed,
          };
        }),
        edges: this.edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
        groups: this.groups,
      };
    }

    fromJSON(data) {
      this.nodes.clear(); this.edges = []; this.groups = data.groups || [];
      (data.nodes || []).forEach((n) => {
        // 保留 running 状态：刷新后由 Executor 恢复（查后端任务状态，done 则恢复结果，否则重跑）
        const nn = JSON.parse(JSON.stringify(n));
        // 恢复 output.dataURL：toJSON 剔除了 dataURL 只留 url，加载时用 url 回填 dataURL 供显示
        if (nn.state?.output?.url && !nn.state.output.dataURL) {
          nn.state.output.dataURL = nn.state.output.url;
        }
        this.nodes.set(n.id, nn);
      });
      // 旧版多端口（prompt/ref/audio/in2…）迁移到统一单端口
      this.edges = (data.edges || []).map((e) => ({
        id: e.id, from: { n: e.from.n, p: 'out' }, to: { n: e.to.n, p: 'in' },
      }));
      this.emit('load');
    }

    /* 节点实际高度（因内容动态，由渲染层注册估算函数） */
    setHeightGetter(fn) { this._heightFn = fn; }
    nodeHeight(n) { return this._heightFn ? this._heightFn(n) : 260; }

    /* =====================================================
     * 组管理工具方法（Ctrl + 右键「自定义选组」菜单使用）
     * ===================================================== */
    /* 查节点所在组（一个节点同一时刻仅属于一个组） */
    groupOf(nodeId) { return this.groups.find((g) => g.nodes.includes(nodeId)) || null; }
    /* 通过 id 查组 */
    getGroup(gid) { return this.groups.find((g) => g.id === gid) || null; }
    /* 组标题去重 */
    uniqueGroupTitle(base) {
      const names = new Set(this.groups.map((g) => g.title));
      if (!names.has(base)) return base;
      let i = 2; while (names.has(`${base} ${i}`)) i++; return `${base} ${i}`;
    }
    /* 新建组（把传入节点自动从旧组中移出，保证不重复） */
    createGroup(nodeIds, title) {
      const ids = [...new Set((nodeIds || []).filter((id) => this.nodes.has(id)))];
      if (!ids.length) return null;
      // 先从已有组中移除（保证一个节点仅属一组）
      this.groups.forEach((g) => { g.nodes = g.nodes.filter((id) => !ids.includes(id)); });
      this.groups = this.groups.filter((g) => g.nodes.length > 0);
      const g = {
        id: U.uid('g'),
        title: this.uniqueGroupTitle(title || ('镜头组 ' + (this.groups.length + 1))),
        nodes: ids,
        collapsed: false,
      };
      this.groups.push(g);
      this.emit('change');
      return g;
    }
    /* 加入组（节点自动去重 + 从原组迁移） */
    addToGroup(gid, nodeIds) {
      const g = this.getGroup(gid); if (!g) return false;
      const ids = [...new Set((nodeIds || []).filter((id) => this.nodes.has(id)))];
      if (!ids.length) return false;
      // 从其他组中移除（保证唯一归属）
      this.groups.forEach((gg) => { if (gg.id !== gid) gg.nodes = gg.nodes.filter((id) => !ids.includes(id)); });
      ids.forEach((id) => { if (!g.nodes.includes(id)) g.nodes.push(id); });
      this.groups = this.groups.filter((gg) => gg.nodes.length > 0);
      this.emit('change');
      return true;
    }
    /* 从组中移出节点；若组空则自动删除 */
    removeFromGroup(gid, nodeIds) {
      const g = this.getGroup(gid); if (!g) return false;
      g.nodes = g.nodes.filter((id) => !nodeIds.includes(id));
      this.groups = this.groups.filter((gg) => gg.nodes.length > 0);
      this.emit('change');
      return true;
    }
    /* 解散组（保留节点，删除组容器本身） */
    disbandGroup(gid) {
      const before = this.groups.length;
      this.groups = this.groups.filter((g) => g.id !== gid);
      if (this.groups.length !== before) { this.emit('change'); return true; }
      return false;
    }
    /* 重命名组 */
    renameGroup(gid, newTitle) {
      const g = this.getGroup(gid); if (!g || !newTitle) return false;
      g.title = String(newTitle).trim() || g.title;
      this.emit('change');
      return true;
    }
  }

  LC.Graph = Graph;
})();