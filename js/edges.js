/* =====================================================
 * 连线视图：贝塞尔曲线渲染、拖拽连线
 * ===================================================== */
(function () {
  const U = LC.U;

  class EdgesView {
    constructor(svg, graph) {
      this.svg = svg;
      this.graph = graph;
      this.paths = new Map();       // edgeId -> pathEl
      this.selectedEdge = null;
      // 世界坐标平移组：SVG 铺在 (-100000,-100000) 起 200000×200000，
      // 组内平移 +100000，路径直接用世界坐标，全部落在 SVG 视口内（保证绘制）
      this.g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      this.g.setAttribute('transform', 'translate(100000,100000)');
      svg.appendChild(this.g);
      this.svg.addEventListener('click', () => this.selectEdge(null));

      graph.on((evt, payload) => {
        if (evt === 'node:remove') this.refresh();
        if (evt === 'edge:add') { this.refresh(); this.syncPortStates(payload); }
        if (evt === 'edge:remove') { this.refresh(); this.syncPortStates(payload); }
        if (evt === 'load') this.refresh();
      });
    }

    /* 端口世界坐标
     * 节点被视口剔除（display:none）时，用缓存的端口偏移 + 节点世界坐标计算位置，
     * 这样连接到视口外节点的边仍能绘制——用户放大/平移时不会看到边突然消失。
     * 缓存在节点可见时更新（offsetLeft/offsetWidth 在 display:none 时为 0，不可读）。 */
    portPos(nodeId, portId, side) {
      const el = LC.App.nodes.els.get(nodeId);
      if (!el) return null;
      const n = this.graph.getNode(nodeId);
      if (!n) return null;
      const port = U.$(`.port.${side}[data-port="${portId}"]`, el);
      if (!port) return null;
      // 节点可见时实时读取并缓存端口相对偏移；不可见时复用缓存
      if (el.style.display !== 'none') {
        port._lp = {
          x: port.offsetLeft + port.offsetWidth / 2,
          y: port.offsetTop + port.offsetHeight / 2,
        };
      }
      const lp = port._lp;
      if (!lp) return null;   // 节点尚未布局过（首次渲染前）
      return { x: n.x + lp.x, y: n.y + lp.y, el: port };
    }

    pathD(from, to) {
      const dx = Math.max(40, Math.abs(to.x - from.x) * 0.5);
      return `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
    }

    refresh() {
      const SVGNS = 'http://www.w3.org/2000/svg';
      // 箭头 marker 只创建一次
      if (!this.svg.querySelector('defs')) {
        const defs = document.createElementNS(SVGNS, 'defs');
        defs.innerHTML = `<marker id="edge-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M0,1 L9,5 L0,9 z" fill="#d4a853"/></marker>`;
        this.svg.appendChild(defs);
      }
      const alive = new Set();
      this.graph.edges.forEach((e) => {
        let g = this.paths.get(e.id);
        if (!g) {
          g = document.createElementNS(SVGNS, 'g');
          g.classList.add('edge-g');
          g.dataset.edge = e.id;
          const base = document.createElementNS(SVGNS, 'path');
          base.classList.add('edge-base');
          const flow = document.createElementNS(SVGNS, 'path');
          flow.classList.add('edge-flow');
          // 隐形宽 hit path：扩大双击/点击命中区到 16px，避免细线难以点中
          const hit = document.createElementNS(SVGNS, 'path');
          hit.classList.add('edge-hit');
          hit.setAttribute('stroke', 'transparent');
          hit.setAttribute('stroke-width', '16');
          hit.setAttribute('fill', 'none');
          hit.style.pointerEvents = 'all';
          g.append(base, flow, hit);
          this.g.appendChild(g);
          this.paths.set(e.id, g);
          g._base = base; g._flow = flow; g._hit = hit;   // 缓存子元素引用，避免 hot path 里 querySelector
          // 左键双击删除连线：用 click + 计时器模拟双击，不依赖浏览器 dblclick 事件（更可靠）
          // 两次 click 间隔 < 400ms 即视为双击 → 删除；否则仅选中
          let lastClickAt = 0;
          g.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const now = Date.now();
            if (now - lastClickAt < 400) {
              // 双击 → 删除连线
              this.graph.removeEdge(e.id);
              LC.App.saveSoon();
              LC.App.toast('连线已删除（双击）', 'ok');
              lastClickAt = 0;
            } else {
              this.selectEdge(e.id);
              lastClickAt = now;
            }
          });
          // 右键不再弹出删除菜单：删除统一用左键双击；右键仅选中连线并提示
          g.addEventListener('contextmenu', (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            this.selectEdge(e.id);
            LC.App.toast('左键双击连线可删除', 'ok');
          });
          // 新建闪烁确认，950ms 后恢复常态
          g.classList.add('edge-new');
          setTimeout(() => g.classList.remove('edge-new'), 950);
        }
        alive.add(e.id);
        const from = this.portPos(e.from.n, e.from.p, 'out');
        const to = this.portPos(e.to.n, e.to.p, 'in');
        if (from && to) {
          const d = this.pathD(from, to);
          g._base.setAttribute('d', d);
          g._flow.setAttribute('d', d);
          g._hit.setAttribute('d', d);
          g.style.display = '';
        } else g.style.display = 'none';
        g.classList.toggle('selected', this.selectedEdge === e.id);
      });
      this.paths.forEach((p, id) => { if (!alive.has(id)) { p.remove(); this.paths.delete(id); } });
      this.syncPortStates();
    }

    /* 拖动时轻量刷新：只更新连接到 movingNodeIds 的边，其余边不动（O(受影响边) 而非 O(全部边)） */
    refreshMoving(movingNodeIds) {
      const moving = new Set(movingNodeIds);
      this.graph.edges.forEach((e) => {
        if (!moving.has(e.from.n) && !moving.has(e.to.n)) return;   // 边两端都不在被拖动节点 → 跳过
        const g = this.paths.get(e.id);
        if (!g) return;
        const from = this.portPos(e.from.n, e.from.p, 'out');
        const to = this.portPos(e.to.n, e.to.p, 'in');
        if (from && to) {
          const d = this.pathD(from, to);
          g._base.setAttribute('d', d);
          g._flow.setAttribute('d', d);
          g._hit.setAttribute('d', d);
          g.style.display = '';
        } else g.style.display = 'none';
      });
    }

    refreshSelection() {
      this.paths.forEach((p, eid) => p.classList.toggle('selected', eid === this.selectedEdge));
    }

    selectEdge(id) {
      this.selectedEdge = id;
      this.paths.forEach((p, eid) => p.classList.toggle('selected', eid === id));
    }

    showEdgeMenu(x, y, edgeId) {
      this._edgeMenu?.remove();
      const m = document.createElement('div');
      m.className = 'edge-menu';
      m.innerHTML = `<button data-del>${LC.U.icon('trash', 13)} 删除连接</button>`;
      document.body.appendChild(m);
      m.style.left = x + 'px';
      m.style.top = y + 'px';
      m.querySelector('[data-del]').onclick = (ev) => {
        ev.stopPropagation();
        this.graph.removeEdge(edgeId);
        LC.App.saveSoon();
        LC.App.toast('连接已删除', 'ok');
        m.remove();
      };
      this._edgeMenu = m;
      const close = (e) => {
        if (e.target === m || m.contains(e.target)) return;
        m.remove();
        window.removeEventListener('pointerdown', close);
        this._edgeMenu = null;
      };
      setTimeout(() => window.addEventListener('pointerdown', close), 0);
    }

    syncPortStates() {
      const connected = new Set();
      this.graph.edges.forEach((e) => {
        connected.add(e.from.n + '\0' + e.from.p + '\0out');
        connected.add(e.to.n + '\0' + e.to.p + '\0in');
      });
      this.graph.nodes.forEach((n) => {
        const el = LC.App.nodes.els.get(n.id);
        if (!el) return;
        const ports = el.querySelectorAll('.port');
        for (let i = 0; i < ports.length; i++) {
          const p = ports[i];
          p.classList.toggle('connected', connected.has(n.id + '\0' + p.dataset.port + '\0' + p.dataset.side));
        }
      });
    }

    /* ---------- 拖拽连线 ----------
     * 可靠性设计（真实手势）：
     * 1. pointerdown 时 setPointerCapture —— 所有后续 move/up 必达，不受原生行为打断
     * 2. 拖动中实时高亮可连端口；松手时若未精确命中端口，在 24px 半径内吸附最近端口
     * 3. pointercancel / dragstart 全兜底清理
     * 性能：findTarget / clearHover 用 rAF 节流 + 只清上次命中的单元素，
     * 避免每帧 O(N×P) 全端口扫描 + getBoundingClientRect 强制布局导致卡顿 */
    startLink(portEl, side, ev) {
      if (this._linking) return;
      this._linking = true;
      const nid = portEl.dataset.node, pid = portEl.dataset.port;
      document.body.classList.add('linking');
      // 批量 ghost：Ctrl+左键多选节点时，为每个选中节点创建一条 ghost path，
      // 拖动过程中所有选中节点的连线预览都显示
      const selected = LC.App.nodes.selected;
      const isBatch = selected && selected.size > 1 && selected.has(nid);
      const sourceIds = isBatch ? [...selected] : [nid];
      const ghosts = [];
      const froms = [];
      sourceIds.forEach((srcId) => {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        g.classList.add('edge-ghost');
        this.g.appendChild(g);
        ghosts.push(g);
        froms.push(this.portPos(srcId, pid, side));
      });

      let lastHover = null;   // 上次高亮的端口元素，clearHover 只清这一个，避免每帧全端口扫描
      let rafId = null;       // findTarget 的 rAF 节流 id
      let lastMoveEv = null;  // 最新一次 pointermove 事件，供 rAF 回调读取坐标

      /* 找指针下的端口：先精确命中，再半径吸附；排除所有选中源节点（避免吸附到自身） */
      const srcSet = new Set(sourceIds);
      const findTarget = (cx, cy) => {
        const stack = document.elementsFromPoint(cx, cy) || [];
        for (const el of stack) {
          const p = el.closest?.('.port');
          if (p && !srcSet.has(p.dataset.node)) return p;
        }
        // 吸附：屏幕距离最近的可连端口（≤24px）
        let best = null, bestD = 24 * 24;
        LC.App.nodes.els.forEach((el) => {
          U.$$('.port', el).forEach((p) => {
            if (p.dataset.side === side || srcSet.has(p.dataset.node)) return;
            const r = p.getBoundingClientRect();
            const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = p; }
          });
        });
        return best;
      };
      const clearHover = () => {
        if (lastHover) { lastHover.classList.remove('drag-over'); lastHover = null; }
      };

      const move = (e) => {
        lastMoveEv = e;
        // 更新所有 ghosts 的 d：每条 ghost 从各自选中节点的端口到鼠标位置
        const w = LC.App.view.worldAt(e.clientX, e.clientY);
        ghosts.forEach((g, i) => {
          const f = froms[i];
          if (f) g.setAttribute('d', side === 'out' ? this.pathD(f, w) : this.pathD(w, f));
        });
        // findTarget / clearHover 用 rAF 节流：pointermove 高频（60-120Hz），但吸附检测每帧最多一次
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          if (!lastMoveEv) return;
          const t = findTarget(lastMoveEv.clientX, lastMoveEv.clientY);
          if (t !== lastHover) {
            if (lastHover) lastHover.classList.remove('drag-over');
            if (t) t.classList.add('drag-over');
            lastHover = t;
          }
        });
      };
      const finish = () => {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        ghosts.forEach((g) => g.remove());
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        document.removeEventListener('dragstart', noDrag, true);
        clearHover();
        document.body.classList.remove('linking');
        this._linking = false;
      };
      const up = (e) => {
        const target = findTarget(e.clientX, e.clientY);
        finish();
        if (target && target.dataset.side !== side && target.dataset.node !== nid) {
          const toRef = { n: target.dataset.node, p: target.dataset.port };
          // 批量连线：Ctrl+左键多选节点后，从任一选中节点的端口拖到目标，
          // 所有选中节点的同侧端口都连到目标（pid 是 'in'/'out'，所有节点端口 id 统一）
          const selected = LC.App.nodes.selected;
          const sourceIds = (selected && selected.size > 1 && selected.has(nid)) ? [...selected] : [nid];
          let count = 0;
          sourceIds.forEach((srcId) => {
            if (srcId === target.dataset.node) return;  // 跳过自连
            const fromRef = { n: srcId, p: pid };
            const edge = side === 'out'
              ? this.graph.addEdge(fromRef, toRef)
              : this.graph.addEdge(toRef, fromRef);
            if (edge) {
              LC.Executor.onEdgeAdded(edge);
              count++;
            }
          });
          if (count > 0) {
            LC.App.toast(count > 1 ? `已批量连接 ${count} 条连线` : '已连接：数据将沿链路自动流转', 'ok');
            LC.App.saveSoon();
          } else {
            LC.App.toast('连线无效：同节点 / 重复连接', 'warn');
          }
        } else if (!target) {
          // 拖到空白处松手：弹出节点选择菜单（右键菜单样式），选中后创建节点并自动连线
          const w = LC.App.view.worldAt(e.clientX, e.clientY);
          const selected = LC.App.nodes.selected;
          const sourceIds = (selected && selected.size > 1 && selected.has(nid)) ? [...selected] : [nid];
          const menu = U.$('#ctx-menu');
          if (!menu) return;
          const nodeTypes = [
            ['text', '文本节点'], ['image', '图片节点'], ['video', '视频节点'],
            ['audio', '音频节点'], ['script', '脚本/分镜节点'], ['stage', '3D 导演台'],
            ['subtitle', '字幕节点'], ['export', '成片拼接导出'], ['check', '合规校验'],
          ];
          menu.innerHTML = nodeTypes.map(([t, label]) =>
            `<button data-nt="${t}">${U.icon(t, 14)} ${label}</button>`).join('');
          menu.hidden = false;
          menu.style.left = Math.min(e.clientX, innerWidth - 200) + 'px';
          menu.style.top = Math.min(e.clientY, innerHeight - nodeTypes.length * 30 - 20) + 'px';
          const hide = () => {
            menu.hidden = true;
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('contextmenu', onCtxAway, true);
            document.removeEventListener('keydown', onKey);
          };
          const onDown = (ev) => { if (menu.contains(ev.target)) return; hide(); };
          const onCtxAway = (ev) => { if (!menu.contains(ev.target)) hide(); };
          const onKey = (ev) => { if (ev.key === 'Escape') hide(); };
          U.$$('button', menu).forEach((b) => {
            b.onclick = () => {
              hide();
              const type = b.dataset.nt;
              const newNode = LC.App.createNodeAt(type, null, w);
              if (!newNode) return;
              const newId = newNode.id;
              let count = 0;
              sourceIds.forEach((srcId) => {
                if (srcId === newId) return;
                const edge = side === 'out'
                  ? this.graph.addEdge({ n: srcId, p: 'out' }, { n: newId, p: 'in' })
                  : this.graph.addEdge({ n: newId, p: 'out' }, { n: srcId, p: 'in' });
                if (edge) { LC.Executor.onEdgeAdded(edge); count++; }
              });
              if (count > 0) {
                LC.App.toast(count > 1 ? `已批量连接 ${count} 条连线到新节点` : '已自动连接到新节点', 'ok');
                LC.App.saveSoon();
              }
            };
          });
          document.addEventListener('pointerdown', onDown, true);
          document.addEventListener('contextmenu', onCtxAway, true);
          document.addEventListener('keydown', onKey);
        }
      };
      const cancel = () => finish();
      const noDrag = (e) => e.preventDefault();

      // pointer capture：事件锁定到端口元素，冒泡到 window
      try { portEl.setPointerCapture(ev.pointerId); } catch (err) { /* 老浏览器忽略 */ }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      document.addEventListener('dragstart', noDrag, true);
      if (ev.pointerType === 'mouse') move(ev); // 立即画一次起点线
    }
  }

  LC.EdgesView = EdgesView;
})();