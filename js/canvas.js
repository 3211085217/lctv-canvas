/* =====================================================
 * 无限画布视口：平移 / 缩放 / 网格 / 框选 / 迷你地图
 * ===================================================== */
(function () {
  const U = LC.U;

  class CanvasView {
    constructor(wrap, world) {
      this.wrap = wrap;            // #canvas-wrap
      this.canvas = U.$('#canvas', wrap);
      this.world = world;          // #world
      this.gridEl = document.createElement('div');
      this.gridEl.className = 'grid-bg';
      this.canvas.appendChild(this.gridEl);

      this.x = 0; this.y = 0; this.z = 1;   // 视口平移(屏幕px) + 缩放
      this.MINZ = 0.06; this.MAXZ = 2.6;

      this.rect = null;            // 框选矩形元素
      this._rect = { on: false, x0: 0, y0: 0 };

      this.listeners = { empty: new Set(), view: new Set(), boxselect: new Set(), boxmove: new Set(), ctx: new Set(), nodectx: new Set() };

      bind(this, wrap);
      this.apply();
      // 初始视野
      this.x = wrap.clientWidth / 2;
      this.y = wrap.clientHeight / 2;
      this.apply();
    }

    on(evt, fn) { this.listeners[evt].add(fn); return () => this.listeners[evt].delete(fn); }
    fire(evt, payload) { this.listeners[evt].forEach((fn) => fn(payload)); }

    /* 坐标转换 */
    worldAt(sx, sy) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (sx - r.left - this.x) / this.z, y: (sy - r.top - this.y) / this.z };
    }
    clientAt(wx, wy) {
      const r = this.canvas.getBoundingClientRect();
      return { x: wx * this.z + this.x + r.left, y: wy * this.z + this.y + r.top };
    }

    apply() {
      this.world.style.transform = `translate(${this.x}px,${this.y}px) scale(${this.z})`;
      // 端口/控件反向缩放：任何缩放下保持屏幕像素大小，保证可点击
      this.world.style.setProperty('--iz', String(1 / this.z));
      this.world.classList.toggle('low-zoom', this.z < 0.5);
      // 点状网格（屏幕空间背景，随视口滚动/缩放；间距沿用原格线 28px / 280px，用浅灰圆点替代线条）
      const gs = 28 * this.z, gg = 280 * this.z;
      // 点半径随缩放等比放大，避免放大后圆点过小近乎消失，保证任何缩放下始终可见
      const r1 = Math.max(1, 1.1 * this.z), r2 = Math.max(1.4, 1.6 * this.z);
      this.gridEl.style.backgroundImage = `
        radial-gradient(circle, rgba(160,160,160,.22) ${r1}px, transparent ${r1 + 0.4}px),
        radial-gradient(circle, rgba(160,160,160,.34) ${r2}px, transparent ${r2 + 0.5}px)`;
      this.gridEl.style.backgroundSize = `${gs}px ${gs}px, ${gg}px ${gg}px`;
      this.gridEl.style.backgroundPosition = `${this.x}px ${this.y}px`;
      this.fire('view');
    }

    zoomAt(sx, sy, factor, animate) {
      const target = U.clamp(this.z * factor, this.MINZ, this.MAXZ);
      if (target === this.z) return;
      const r = this.canvas.getBoundingClientRect();
      const px = sx - r.left, py = sy - r.top;
      // 保持鼠标下的世界坐标不动
      const wx = (px - this.x) / this.z, wy = (py - this.y) / this.z;
      this.z = target;
      this.x = px - wx * this.z;
      this.y = py - wy * this.z;
      this.apply();
    }

    panBy(dx, dy) { this.x += dx; this.y += dy; this.apply(); }

    setZoom(z, cx, cy) {
      z = U.clamp(z, this.MINZ, this.MAXZ);
      const r = this.canvas.getBoundingClientRect();
      const px = cx ?? r.width / 2, py = cy ?? r.height / 2;
      const wx = (px - this.x) / this.z, wy = (py - this.y) / this.z;
      this.z = z;
      this.x = px - wx * this.z; this.y = py - wy * this.z;
      this.apply();
    }
    reset() { this.setZoom(1); }

    /* 适应全部节点 */
    fit(graph) {
      const box = graph.boundingBox([...graph.nodes.keys()]);
      if (!box) { this.reset(); return; }
      this.fitBox(box.x, box.y, box.w, box.h, 90);
    }
    /* 适应指定的世界坐标矩形（Ctrl+右键定位组时使用） */
    fitBox(wx, wy, ww, wh, pad = 40) {
      const r = this.canvas.getBoundingClientRect();
      const availW = Math.max(r.width - pad * 2, 120);
      const availH = Math.max(r.height - pad * 2, 120);
      const z = U.clamp(Math.min(availW / Math.max(ww, 20), availH / Math.max(wh, 20)), this.MINZ, this.MAXZ);
      this.z = z;
      this.x = r.width / 2 - (wx + ww / 2) * z;
      this.y = r.height / 2 - (wy + wh / 2) * z;
      this.apply();
    }

    centerOn(wx, wy, z) {
      const r = this.canvas.getBoundingClientRect();
      if (z) this.z = U.clamp(z, this.MINZ, this.MAXZ);
      this.x = r.width / 2 - wx * this.z;
      this.y = r.height / 2 - wy * this.z;
      this.apply();
    }
  }

  /* ---------- 事件绑定 ---------- */
  function bind(v, wrap) {
    const c = v.canvas;
    let dragging = false, panned = false, btn = 0, lastX = 0, lastY = 0;
    let ctrlDragged = false;   // Ctrl+左键是否产生了拖动
    let _panRaf = null, _panDx = 0, _panDy = 0;   // rAF 节流：平移位移累积，每帧最多一次 panBy
    const cancelDrag = () => {
      dragging = false;
      panned = false;
      ctrlDragged = false;
      if (_panRaf) { cancelAnimationFrame(_panRaf); _panRaf = null; _panDx = 0; _panDy = 0; }
      c.classList.remove('panning');
      v._ctrlNode = null;
      v._ctrlRect = false;
      if (v._rect.on) {
        v._rect.on = false;
        v.fire('boxselect', { active: false, origin: 'cancel' });
      }
    };
    c.addEventListener('pointercancel', cancelDrag);
    c.addEventListener('lostpointercapture', cancelDrag);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('dragend', cancelDrag);
    window.addEventListener('drop', cancelDrag, true);

    c.addEventListener('pointerdown', (e) => {
      // Ctrl/⌘ + 左键 → 框选模式（空白处）或选组菜单（节点上）
      if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
        dragging = true; panned = false; btn = e.button;
        ctrlDragged = false;
        lastX = e.clientX; lastY = e.clientY;
        c.setPointerCapture(e.pointerId);
        const nodeEl = e.target.closest('.node');
        if (nodeEl) {
          // 点在节点上 → pointerup 时弹选组菜单
          v._ctrlNode = LC.App.graph.getNode(nodeEl.dataset.id);
        } else if (!e.target.closest('.node-group,.slash-box')) {
          // 空白处 → 框选模式
          v._rect.on = true; v._ctrlRect = true;
          const w = v.worldAt(e.clientX, e.clientY);
          v._rect.x0 = w.x; v._rect.y0 = w.y;
          v.fire('boxselect', { start: w, active: true, origin: 'start' });
        }
        return;
      }
      if (e.target.closest('.node,.node-group,.slash-box,.prompt-panel,.edge-g')) return;
      if (e.button === 2) return; // 右键菜单另有处理
      dragging = true; panned = false; btn = e.button;
      lastX = e.clientX; lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
      if (e.shiftKey && e.button === 0) {
        v._rect.on = true;
        const w = v.worldAt(e.clientX, e.clientY);
        v._rect.x0 = w.x; v._rect.y0 = w.y;
        v.fire('boxselect', { start: w, active: true, origin: 'start' });
      }
      if (e.button === 0) c.classList.add('panning');
    });

    c.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (v._rect.on) {
        const w = v.worldAt(e.clientX, e.clientY);
        v.fire('boxselect', { start: { x: v._rect.x0, y: v._rect.y0 }, cur: w, active: true, origin: 'move' });
        if (Math.abs(dx) + Math.abs(dy) > 3) ctrlDragged = true;
      } else if (!v._ctrlNode) {
        // rAF 节流：累积位移，每帧最多一次 panBy + transform 更新（避免 120Hz 事件每秒 120 次重绘导致卡顿）
        _panDx += dx; _panDy += dy;
        if (Math.abs(dx) + Math.abs(dy) > 3) panned = true;
        if (!_panRaf) {
          _panRaf = requestAnimationFrame(() => {
            _panRaf = null;
            const px = _panDx, py = _panDy;
            _panDx = 0; _panDy = 0;
            v.panBy(px, py);
            v.fire('boxmove', null);
          });
        }
      }
    });

    c.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      c.classList.remove('panning');
      // 应用未消费的平移位移（rAF 可能还没执行，松手时立即同步最终位置）
      if (_panRaf) { cancelAnimationFrame(_panRaf); _panRaf = null; }
      if (_panDx || _panDy) { v.panBy(_panDx, _panDy); _panDx = 0; _panDy = 0; }
      if (v._rect.on) {
        // 框选完成 → fire boxselect（main.js 检测 ctrl 弹选组菜单）
        v._rect.on = false;
        const w = v.worldAt(e.clientX, e.clientY);
        v.fire('boxselect', {
          start: { x: v._rect.x0, y: v._rect.y0 }, cur: w, active: false, origin: 'up',
          ctrl: !!v._ctrlRect, clientX: e.clientX, clientY: e.clientY,
        });
        v._ctrlRect = false;
      } else if (v._ctrlNode && !ctrlDragged) {
        // Ctrl+左键单击节点 → 弹选组菜单
        v.fire('nodectx', { node: v._ctrlNode, x: e.clientX, y: e.clientY, ctrl: true });
      } else if (!panned && !ctrlDragged) {
        // 纯点击空白处（未拖动）→ 取消选中节点与连线，隐藏提示词面板
        LC.App.nodes.select([]);
        if (LC.App.edges) LC.App.edges.selectEdge(null);
      }
      v._ctrlNode = null;
      // 平移结束后刷新视口剔除（视口外节点隐藏，减少重绘）
      if (panned) v.viewportCull();
    });

    // 双击空白 -> 斜杠输入
    c.addEventListener('dblclick', (e) => {
      if (e.target.closest('.node,.node-group,.prompt-panel')) return;
      const w = v.worldAt(e.clientX, e.clientY);
      v.fire('empty', { x: w.x, y: w.y, clientX: e.clientX, clientY: e.clientY, event: e });
    });

    // 滚轮缩放
    c.addEventListener('wheel', (e) => {
      if (dragging) return;
      // 提示词面板上的滚轮用于滚动输入框内容，不触发画布缩放
      if (e.target.closest('.prompt-panel')) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0014);
      v.zoomAt(e.clientX, e.clientY, factor);
      // 缩放结束后刷新视口剔除（节流 80ms 内合并）
      v.viewportCull();
      if (!v._mmT) { v._mmT = setTimeout(() => { v._mmT = null; v.renderMinimap(); }, 150); }
    }, { passive: false });

    // 右键：节点上弹节点菜单，空白处弹画布菜单（组框内也弹画布菜单，以便添加节点到组）
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const nodeEl = e.target.closest('.node');
      if (nodeEl) {
        const n = LC.App.graph.getNode(nodeEl.dataset.id);
        if (n) { v.fire('nodectx', { node: n, x: e.clientX, y: e.clientY }); return; }
      }
      v.fire('ctx', { x: e.clientX, y: e.clientY, world: v.worldAt(e.clientX, e.clientY) });
    });

    // 迷你地图（节流 100ms：拖动时最多 100ms 更新一次，避免频繁重绘）
    const mm = U.$('#minimap', wrap), mmc = U.$('#minimap-canvas', wrap);

    /* 视口剔除：视口外节点 display:none，避免 N 大时浏览器重绘整个 world 子树
     * - 节点隐藏后边仍可绘制：edges.portPos 用缓存的端口偏移 + 节点世界坐标算位置，不返回 null
     * - 节点高度缓存：可见时读 offsetHeight，隐藏时用缓存，避免误判视口内节点为视口外
     * - buffer 300px：节点部分在视口外但仍有边连进视口时保留，避免边缘抖动
     * - 用 rAF 而非 setTimeout：rAF 在浏览器布局完成后执行，offsetHeight 读取是廉价缓存查询，
     *   不触发强制同步布局（setTimeout 可能在布局 dirty 时执行，N 次 offsetHeight 触发 N 次强制布局导致卡顿） */
    let _cullT = null;
    v.viewportCull = () => {
      if (_cullT) return;
      _cullT = requestAnimationFrame(() => {
        _cullT = null;
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const nodes = LC.App.nodes;
        const graph = LC.App.graph;
        if (!nodes || !graph) return;
        const tl = v.worldAt(0, 0);
        const br = v.worldAt(r.width, r.height);
        const buf = 300;
        const minX = tl.x - buf, maxX = br.x + buf;
        const minY = tl.y - buf, maxY = br.y + buf;
        let changed = false;
        nodes.els.forEach((el, id) => {
          const n = graph.getNode(id);
          if (!n) return;
          // 缓存高度：可见时读 offsetHeight，隐藏时用上次缓存（rAF 内布局已完成，读取是廉价缓存查询）
          if (el.style.display !== 'none') {
            const h = el.offsetHeight;
            if (h) el._cullH = h;
          }
          const nh = el._cullH || 240;
          const visible = (n.x + n.w) >= minX && n.x <= maxX && (n.y + nh) >= minY && n.y <= maxY;
          const want = visible ? '' : 'none';
          if (el.style.display !== want) { el.style.display = want; changed = true; }
        });
        // 节点显隐变化后刷新边（视口外的边仍会绘制，端口位置由缓存偏移+世界坐标算出）
        if (changed && LC.App.edges) LC.App.edges.refresh();
      });
    };

    v.renderMinimap = () => {
      if (v._mmTimer) return;
      v._mmTimer = setTimeout(() => {
        v._mmTimer = null;
        const graph = LC.App.graph;
        mmc.width = mm.clientWidth; mmc.height = mm.clientHeight;
        const g = mmc.getContext('2d');
        g.clearRect(0, 0, mmc.width, mmc.height);
        g.fillStyle = 'rgba(18,20,29,.4)'; g.fillRect(0, 0, mmc.width, mmc.height);
        const box = graph.boundingBox([...graph.nodes.keys()]);
        if (!box) return;
        const pad = 26, sc = Math.min((mmc.width - pad) / box.w, (mmc.height - pad) / box.h);
        const ox = (mmc.width - box.w * sc) / 2 - box.x * sc;
        const oy = (mmc.height - box.h * sc) / 2 - box.y * sc;
        g.fillStyle = '#3a3a40';
        graph.nodes.forEach((n) => {
          g.fillRect(ox + n.x * sc, oy + n.y * sc, Math.max(3, n.w * sc), Math.max(3, (n.h || 60) * sc * .35));
        });
        const r = c.getBoundingClientRect();
        g.strokeStyle = '#d4a853'; g.lineWidth = 1;
        g.strokeRect(ox + (-v.x / v.z) * sc, oy + (-v.y / v.z) * sc, (r.width / v.z) * sc, (r.height / v.z) * sc);
      }, 100);
    };
    mm.addEventListener('click', (e) => {
      const graph = LC.App.graph;
      const box = graph.boundingBox([...graph.nodes.keys()]);
      if (!box) return;
      const r = mm.getBoundingClientRect();
      const pad = 26, sc = Math.min((mmc.width - pad) / box.w, (mmc.height - pad) / box.h);
      const wxc = (e.clientX - r.left - (mmc.width - box.w * sc) / 2) / sc + box.x;
      const wyc = (e.clientY - r.top - (mmc.height - box.h * sc) / 2) / sc + box.y;
      v.centerOn(wxc, wyc);
      v.viewportCull();   // minimap 跳转后视口变化，刷新剔除
    });

    // 缩放按钮
    U.$('#zoom-in', wrap).onclick = () => v.zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1.3);
    U.$('#zoom-out', wrap).onclick = () => v.zoomAt(c.clientWidth / 2, c.clientHeight / 2, 1 / 1.3);
    U.$('#zoom-fit', wrap).onclick = () => LC.App.fitView();
  }

  LC.CanvasView = CanvasView;
})();