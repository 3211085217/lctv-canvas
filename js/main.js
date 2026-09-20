/* =====================================================
 * 主入口：模块编排、存储、分享、上下文菜单、演示工程
 * ===================================================== */
(function () {
  const U = LC.U;

  const App = {
    graph: null, view: null, nodes: null, edges: null,
    projectName: '未命名项目',
    autoRerun: true,
    clipboard: [],
    dirty: false,

    /* ---------- 初始化 ---------- */
    init() {
      // 静态 HTML 里的 <i data-ic> 占位符 → 线条图标
      U.hydrateIcons();
      // 用户设置（模型 API / 自动重跑）
      LC.Settings.load();
      this.autoRerun = !!LC.Settings.data.autoRerun;
      const __ar = U.$('#auto-rerun');
      if (__ar) __ar.checked = this.autoRerun;

      this.graph = new LC.Graph();
      this.nodes = new LC.NodeView(U.$('#nodes-layer'), this.graph);
      this.edges = new LC.EdgesView(U.$('#edges-svg'), this.graph);
      this.view = new LC.CanvasView(U.$('#canvas-wrap'), U.$('#world'));
      this.graph.setHeightGetter((n) => Number(this.nodes.els.get(n.id)?.offsetHeight || 240));

      LC.Menubar.init();
      LC.Slash.init();
      LC.Library.buildNodeLib();
      LC.AssetLibrary.init();
      LC.Templates.init();
      LC.Home.init();
      LC.PromptPanel.init();

      // logo 点击返回首页（确保绑定在所有初始化之后）
      const __logo = U.$('#logo-home');
      if (__logo) {
        __logo.style.cursor = 'pointer';
        __logo.addEventListener('click', (e) => {
          e.stopPropagation();
          if (LC.Home) LC.Home.back();
        });
      }

      // 画布事件
      this.view.on('empty', (p) => LC.Slash.open(p, p));
      this.view.on('boxselect', (r) => this.onBoxSelect(r));
      this.view.on('ctx', (p) => {
        if (p.ctrl) return this.showGroupCtx({ x: p.x, y: p.y, world: p.world, node: null });
        this.showCanvasCtx(p);
      });
      this.view.on('nodectx', (p) => {
        if (p.ctrl) return this.showGroupCtx({ x: p.x, y: p.y, world: null, node: p.node });
        this.showNodeCtx(p.node, p.x, p.y);
      });
      this.view.on('view', () => U.$('#zoom-label').textContent = Math.round(this.view.z * 100) + '%');

      // 端口连线启动
      U.$('#nodes-layer').addEventListener('pointerdown', (e) => {
        const port = e.target.closest('.port');
        if (port && !port.dataset.side) return;
        if (port) {
          e.preventDefault(); e.stopPropagation();
          this.edges.startLink(port, port.dataset.side, e);
        }
      });

      // 魔法指令按钮
      U.$('#btn-slash').onclick = () => {
        const r = this.view.canvas.getBoundingClientRect();
        const w = this.view.worldAt(r.width / 2, r.height / 2 - 120);
        LC.Slash.open(w, w);
      };
      U.$('#btn-stage').onclick = () => this.openStage(null);

      // 图上变更 -> 历史
      this.graph.on((evt) => {
        if (['node:add', 'node:remove', 'edge:add', 'edge:remove'].includes(evt)) {
          LC.History.push(true);
        }
        this.markDirty();
      });

      // 磁盘素材丢失的全局兜底提示（img/video/audio 加载 /assets/ 失败时）
      window.addEventListener('error', (e) => {
        const t = e.target;
        if (!t || !['IMG', 'VIDEO', 'AUDIO'].includes(t.tagName)) return;
        const src = t.currentSrc || t.src || '';
        if (!src.includes('/assets/')) return;
        t.classList.add('media-missing');
        const now = Date.now();
        if (!this._missAt || now - this._missAt > 30000) {
          this._missAt = now;
          this.toast('有素材文件缺失（assets 目录中的文件被删除或移动），相关节点需重新上传', 'err');
        }
      }, true);

      // 自动保存
      this.saveSoon();
      this.loadInitial();

      // 用户交互时间戳：saveCurrent 检测到交互中时延后执行，避免序列化阻塞拖动/平移
      this._lastInteract = 0;
      const markInteract = () => { this._lastInteract = Date.now(); };
      window.addEventListener('pointermove', markInteract, { passive: true, capture: true });
      window.addEventListener('pointerdown', markInteract, { passive: true, capture: true });
      window.addEventListener('wheel', markInteract, { passive: true, capture: true });
      window.addEventListener('keydown', markInteract, { passive: true, capture: true });

      // 定期存档（历史项目 + 当前画布）
      setInterval(() => { this.saveCurrent(true); }, 3 * 60 * 1000);

      // 关页/切后台时立即持久化（取消 debounce 并尽力落库，避免 900ms 防抖窗口内的改动丢失）
      const flushOnExit = () => {
        clearTimeout(this._st);
        const save = LC.Home?.saveCurrent(undefined, { keepalive: true });
         if (save && typeof save.catch === 'function') save.catch(() => {});
      };
      window.addEventListener('beforeunload', flushOnExit);
      window.addEventListener('pagehide', flushOnExit);
    },

    /* ---------- 初始载入：分享链接 > 首页 ---------- */
    async loadInitial() {
      try {
        if (LC.Store?.ready) await LC.Store.ready;
        const q = new URLSearchParams(location.search);
        if (q.get('p')) {
          const data = JSON.parse(await U.gunzip(q.get('p')));
          this.applyLoaded(data, '已载入分享工程');
          return;
        }
        // 默认进入首页，由用户选择 / 新建画布
        LC.Home.show();
      } catch (e) {
        console.error(e);
        LC.Home.show();
      }
    },

    applyLoaded(data, msg) {
      try {
        this.graph.fromJSON(data);
        this.projectName = data.name || '未命名项目';
        U.$('#project-name').value = this.projectName;
        this.nodes.rebuild();
        this.edges.refresh();
        this.fitView();
        LC.History.push(true);
        this.toast(msg, 'ok');
        this.renderAllOutlines();
        // 刷新恢复：扫描 running 节点，查后端任务状态恢复或重跑
        if (LC.Executor && LC.Executor.resumeAll) {
          setTimeout(() => LC.Executor.resumeAll().catch(() => {}), 300);
        }
      } catch (e) {
        console.error('[App.applyLoaded] 应用数据失败:', e);
        throw e;
      }
    },

    renderAllOutlines() {
      this.graph.nodes.forEach((n) => {
        if (n.type === 'script' && n.state.output?.shots) LC.Library.renderOutline(n, n.state.output);
      });
    },

    /* ---------- 保存（磁盘文件存储，toJSON 已剔除 dataURL 只保留 URL） ---------- */
    sanitizeJSON() {
      const json = this.graph.toJSON();
      json.name = this.projectName;
      return json;
    },
    async saveCurrent(archive = true) {
      if (!this.graph) return;
      // 用户交互中延后执行：sanitizeJSON 同步深拷贝会阻塞主线程几百 ms，
      // 拖动/平移/缩放时延后，避免间歇性卡顿（用户停顿 >debounce 后才序列化）
      if (Date.now() - (this._lastInteract || 0) < 800) { this.saveSoon(); return; }
      try {
        // 统一走 Home 磁盘保存（当前画布 id；无画布时跳过磁盘写）
        if (LC.Home && LC.Home.currentId) await LC.Home.saveCurrent();
        if (archive) LC.History.archiveProject();
      } catch (e) {
        // 失败提示节流：30 秒内最多报一次，避免连续操作刷屏
        const now = Date.now();
        if (!this._saveErrAt || now - this._saveErrAt > 30000) {
          this._saveErrAt = now;
          this.toast('画布已保存到浏览器缓存；服务器暂不可用', 'warn');
        }
      }
    },
    saveNow() {
      this.saveCurrent(true);
      LC.History.saveVersion('保存点');
      this.markDirty(false);
      this.toast('项目已保存 ✓', 'ok');
    },
    saveSoon() { clearTimeout(this._st); this._st = setTimeout(() => this.saveCurrent(false), 1500); },
    /* 强制立即保存（不弹 toast、不存历史版本），用于生成开始时持久化 running 状态 */
    async forceSave() {
      clearTimeout(this._st);
      try {
        if (LC.Home && LC.Home.currentId) await LC.Home.saveCurrent();
      } catch (e) {}
    },
    markDirty(d = true) {
      this.dirty = d;
      const el = U.$('#save-status');
      if (el) { el.textContent = d ? '未保存' : '已保存'; el.classList.toggle('dirty', d); }
    },

    /* ---------- 新项目：回到首页新建 ---------- */
    async newProject() {
      // 保存当前画布后回到首页
      if (LC.Home && LC.Home.currentId) await LC.Home.saveCurrent();
      if (LC.Home) { LC.Home.currentId = null; LC.Home.show(); }
      else { LC.App.toast('请从首页新建画布', 'warn'); }
    },

    /* ---------- 工程文件导入导出 / 分享 ---------- */
    exports: {
      exportFile() {
        const data = JSON.stringify(LC.App.sanitizeJSON(), null, 2);
        U.download(`${LC.App.projectName}.lctv`, data, 'application/json');
        LC.App.toast('工程文件已导出（含全部节点/提示词/流程，可分享给他人导入）', 'ok');
      },
      importFile() {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.lctv,.json';
        inp.onchange = async () => {
          const f = inp.files[0];
          if (!f) return;
          try {
            const data = JSON.parse(await f.text());
            this.applyLoaded(data, '工程导入成功');
          } catch (e) { LC.App.toast('文件解析失败', 'err'); }
        };
        inp.click();
      },
      async share() {
        const json = JSON.stringify(LC.App.sanitizeJSON());
        const packed = await U.gzip(json);
        const url = location.origin + location.pathname + '?p=' + packed;
        const ok = await U.copyText(url);
        if (ok) {
          LC.App.toast('分享链接已复制到剪贴板！打开链接即可看到完整提示词与全部节点流程', 'ok');
          LC.Modal.open(`<div style="font-size:12px;color:var(--text3);line-height:1.8;word-break:break-all">${U.esc(url)}</div>`,
            { title: `${U.icon('link', 15)} 工程分享链接（已复制）`, width: '560px' });
        } else LC.App.toast('复制失败', 'err');
      },
    },

    /* ---------- Toast ---------- */
    toast(msg, type = 'ok') {
      const root = U.$('#toast-root');
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.textContent = msg;
      root.appendChild(t);
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3200);
    },

    /* ---------- 节点创建 ---------- */
    createNodeAt(type, props, world, groupId) {
      const n = this.graph.createNode(type, Math.round(world.x), Math.round(world.y));
      if (props) Object.assign(n.props, props);
      if (n.props.mode === 'tri' && !n.props.prompt) n.props.prompt = '角色定妆三视图';
      if (groupId) this.graph.addToGroup(groupId, [n.id]);
      LC.History.push(true);
      this.nodes.select([n.id]);
      this.toast(`已创建「${n.title}」${groupId ? ' · 已加入组' : ''}`, 'ok');
      this.saveSoon();
      return n;
    },
    createNodeNearCenter(type) {
      const r = this.view.canvas.getBoundingClientRect();
      const w = this.view.worldAt(r.width / 2 + (Math.random() * 120 - 60), r.height / 2 + (Math.random() * 120 - 60));
      return this.createNodeAt(type, null, { x: w.x - 120, y: w.y - 60 });
    },

    fitView() {
      setTimeout(() => {
        this.view.fit(this.graph);
        this.view.renderMinimap();
        if (this.view.viewportCull) this.view.viewportCull();   // 适应视图后刷新视口剔除
      }, 60);
    },

    /* ---------- 节点详情 ---------- */
    openNodeDetail(n) {
      if (n.type === 'stage') return this.openStage(n);
      if (n.type === 'image' && n.state.output?.dataURL) {
        const m = LC.Modal.open(`<img src="${n.state.output.dataURL}" style="max-width:78vw;max-height:70vh;display:block">`,
          { title: `${U.icon('image', 15)} ${U.esc(n.title)}`, width: 'auto', maskClose: true,
            footer: `<button class="btn" data-dl>下载图片</button><button class="btn primary" data-rerun>重新生成</button>` });
        setTimeout(() => {
          U.$('[data-dl]', m.foot).onclick = () => U.download(n.title + '.png', n.state.output.dataURL, 'url');
          U.$('[data-rerun]', m.foot).onclick = () => { m.close(); LC.Executor.run(n.id); };
        }, 50);
        return;
      }
      if (n.type === 'video' && n.state.output?.dataURL) {
        const m = LC.Modal.open(`<video src="${n.state.output.dataURL}" controls autoplay playsinline style="width:640px;max-width:70vw;display:block;background:#000"></video>`,
          { title: `${U.icon('video', 15)} ${U.esc(n.title)} · ${n.state.output.duration}s`, width: 'auto', maskClose: true });
        return;
      }
      if (n.type === 'script' && n.state.output?.shots) {
        const html = `<div style="max-height:60vh;overflow-y:auto">${n.state.output.shots.map((s) => `
          <div style="background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin-bottom:8px">
            <div style="color:var(--accent2);font-size:12px;margin-bottom:4px"><b>镜头 ${s.no}</b> · ${s.size} · ${s.move} · ${s.lens} · ${s.duration}s</div>
            <div style="font-size:12.5px;color:var(--text2)">${U.esc(s.desc)}</div>
            ${s.dialogue ? `<div style="font-size:12px;color:var(--warn);margin-top:4px">台词：${U.esc(s.dialogue)}</div>` : ''}
          </div>`).join('')}</div>`;
        LC.Modal.open(html, { title: `${U.icon('script', 15)} ${U.esc(n.title)} · 完整分镜脚本`, width: '560px' });
        return;
      }
    },

    /* ---------- 导演台 ---------- */
    openStage(node) {
      if (!node) {
        // 无节点：创建临时节点绑定
        const r = this.view.canvas.getBoundingClientRect();
        const w = this.view.worldAt(r.width / 2, r.height / 2);
        node = this.createNodeAt('stage', null, { x: w.x - 120, y: w.y - 60 });
      }
      LC.Director3D.open(node);
    },

    /* ---------- 分镜批量生图 ---------- */
    async applyShotsToImages(scriptNode) {
      const out = scriptNode.state.output;
      if (!out?.shots) return;
      const shots = out.shots;
      LC.App.toast(`正在为 ${shots.length} 个镜头批量创建首帧图节点…`, 'ok');
      const g = this.graph;
      const baseX = scriptNode.x + scriptNode.w + 80;
      const nodes = [];
      shots.forEach((s, i) => {
        const n = g.createNode('image', baseX, scriptNode.y + i * 60 - 30);
        n.title = `分镜 #${s.no} 首帧`;
        n.props.prompt = `镜头${s.no}：${s.size}，${s.move}，${s.lens}。${s.desc}`;
        n.props.light = '电影·低饱和';
        g.addEdge({ n: scriptNode.id, p: 'out' }, { n: n.id, p: 'in' });
        nodes.push(n);
        this.nodes.renderNode(n);
      });
      this.edges.refresh();
      this.fitView();
      this.saveSoon();
      // 串行批量执行
      for (const n of nodes) {
        await LC.Executor.run(n.id);
        await U.sleep(250);
      }
      LC.App.toast(`批量生成完成：${nodes.length} 张分镜首帧图已进入资产库`, 'ok');
    },

    registerAsset(node) { LC.AssetLibrary.register(node); },
    renderOutline(node, out) { LC.Library.renderOutline(node, out); },

    /* ---------- 框选 ---------- */
    onBoxSelect(r) {
      const rect = U.$('#selection-rect');
      if (!r.active) {
        if (r.origin === 'up') {
          rect.hidden = true;
          // 计算世界矩形命中
          const a = r.start, b = r.cur;
          const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
          const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
          const ids = [];
          this.graph.nodes.forEach((n) => {
            const h = this.graph.nodeHeight(n);
            if (n.x < maxX && n.x + n.w > minX && n.y < maxY && n.y + h > minY) ids.push(n.id);
          });
          if (ids.length) this.nodes.select(ids);
          else this.nodes.select([]);
          // Ctrl+左键框选 → 选完后直接弹选组菜单（在鼠标释放位置）
          if (r.ctrl) {
            let cx = r.clientX, cy = r.clientY;
            if (cx == null || cy == null) {
              // fallback: 用世界坐标转换到屏幕坐标
              const sc = this.view.clientAt(r.cur.x, r.cur.y);
              cx = sc.x; cy = sc.y;
            }
            this.showGroupCtx({ x: cx, y: cy, world: r.cur, node: null });
          }
        }
        return;
      }
      // 世界坐标 → canvas 内坐标（不含屏幕偏移，#selection-rect 是 .canvas 子元素）
      const z = this.view.z, vx = this.view.x, vy = this.view.y;
      const a = { x: r.start.x * z + vx, y: r.start.y * z + vy };
      const b = { x: r.cur.x * z + vx, y: r.cur.y * z + vy };
      rect.hidden = false;
      rect.style.left = Math.min(a.x, b.x) + 'px';
      rect.style.top = Math.min(a.y, b.y) + 'px';
      rect.style.width = Math.abs(b.x - a.x) + 'px';
      rect.style.height = Math.abs(b.y - a.y) + 'px';
    },

    /* ---------- 右键菜单 ---------- */
    showCanvasCtx(p) {
      // 检测右键位置是否在某个组内
      let hitGroup = null;
      const pad = 26;
      for (const g of this.graph.groups) {
        const box = this.graph.boundingBox(g.nodes);
        if (box && p.world.x >= box.x - pad && p.world.x <= box.x + box.w + pad &&
            p.world.y >= box.y - pad && p.world.y <= box.y + box.h + pad) {
          hitGroup = g; break;
        }
      }
      const base = [
        [`${U.icon('clipboard', 14)} 粘贴 (Ctrl+V)`, 'paste'], [`${U.icon('text', 14)} 文本节点`, 'n-text'], [`${U.icon('image', 14)} 图片节点`, 'n-image'], [`${U.icon('video', 14)} 视频节点`, 'n-video'],
        [`${U.icon('audio', 14)} 音频节点`, 'n-audio'], [`${U.icon('script', 14)} 脚本节点`, 'n-script'], [`${U.icon('stage', 14)} 3D 导演台`, 'n-stage'],
        [`${U.icon('subtitle', 14)} 字幕节点`, 'n-subtitle'], [`${U.icon('export', 14)} 导出节点`, 'n-export'], [`${U.icon('check', 14)} 合规校验`, 'n-check'],
        [`${U.icon('expand', 14)} 适应全部节点`, 'fit'], [`${U.icon('book', 14)} 模板库`, 'tpl'],
      ];
      // 组内空白右键：菜单顶部补「删除组」，下方仍是各新建节点（新建后会自动入组）
      const items = hitGroup
        ? [
            [`${U.icon('xcircle', 14)} 删除组框（保留节点）`, 'grp-del-keep'],
            [`${U.icon('trash', 14)} 删除组及全部节点`, 'grp-del-all'],
            [`${U.icon('grid', 14)} 一键排版（${hitGroup.nodes.length} 个节点）`, 'grp-layout'],
            ...base,
          ]
        : base;
      this.openCtx(p.x, p.y, items, p.world, null, hitGroup?.id);
    },
    showNodeCtx(n, cx, cy) {
      const g2 = this.graph.groupOf(n.id);
      const items = [
        [`${U.icon('play', 14)} 执行节点`, 'run'],
        [`${U.icon('pen', 14)} 重命名`, 'rename'],
        [`${U.icon('copy', 14)} 复制节点`, 'dup'],
        [`${U.icon('copy', 14)} 复制`, 'copy'],
        [`${U.icon('cube', 14)} 编组选中`, 'group'],
        [`${U.icon('bookmark', 14)} 存为模板`, 'tpl-save'],
        [`${U.icon('trash', 14)} 删除节点`, 'del'],
        [`${U.icon('eye', 14)} 查看详情`, 'detail'],
      ];
      // 节点在组内：右键菜单补上该组的操作（移出 / 删除组框）
      if (g2) {
        items.splice(4, 0,
          [`${U.icon('upload', 14)} 移出组「${U.esc(g2.title)}」`, 'grp-node-rem'],
          [`${U.icon('xcircle', 14)} 删除组框（保留节点）`, 'grp-del-keep'],
          [`${U.icon('trash', 14)} 删除组及全部节点`, 'grp-del-all'],
        );
      }
      this.openCtx(cx, cy, items, null, n, g2 ? g2.id : null);
    },
    openCtx(cx, cy, items, world, node, groupId) {
      const menu = U.$('#ctx-menu');
      menu.innerHTML = items.map(([label, act]) => `<button data-ca="${act}">${label}</button>`).join('');
      menu.hidden = false;
      // 位置限制在视口内
      menu.style.left = Math.min(cx, innerWidth - 190) + 'px';
      menu.style.top = Math.min(cy, innerHeight - items.length * 30 - 20) + 'px';

      const hide = () => {
        menu.hidden = true;
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('contextmenu', onCtxAway, true);
        document.removeEventListener('keydown', onKey);
      };
      // 点击菜单外部才关闭；点菜单项本身不关（等 click 执行动作）
      // 用 capture 阶段：即使目标元素 stopPropagation 阻止 bubble，document 仍能先收到事件
      const onDown = (ev) => { if (menu.contains(ev.target)) return; hide(); };
      const onClick = (ev) => { if (menu.contains(ev.target)) return; hide(); };
      const onCtxAway = (ev) => { if (!menu.contains(ev.target)) hide(); };
      const onKey = (ev) => { if (ev.key === 'Escape') hide(); };

      U.$$('button', menu).forEach((b) => {
        b.onclick = () => { hide(); this.runCtx(b.dataset.ca, world, node, groupId); };
      });
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('contextmenu', onCtxAway, true);
      document.addEventListener('keydown', onKey);
    },
    runCtx(act, world, node, groupId) {
      const sel = [...this.nodes.selected];
      switch (act) {
        case 'paste': LC.Menubar.run('paste'); break;
        case 'n-text': case 'n-image': case 'n-video': case 'n-audio': case 'n-script':
        case 'n-stage': case 'n-subtitle': case 'n-export': case 'n-check':
          this.createNodeAt(act.slice(2), null, world, groupId); break;
        case 'fit': this.fitView(); break;
        case 'tpl': LC.Templates.openPanel(world); break;
        case 'run': if (node) LC.Executor.run(node.id); break;
        case 'rename': {
          if (!node) break;
          const old = node.title;
          LC.Modal.prompt('重命名节点', old, { className: 'rename-node' }).then((nv) => {
            if (nv == null) return;            // 取消
            const v = String(nv).trim();
            if (!v || v === old) return;        // 空或未变
            node.title = v;
            this.nodes.updateNode(node.id);
            LC.History.push(true);
            this.markDirty();
            this.toast(`已重命名为「${v}」`, 'ok');
          });
          break;
        }
        case 'dup': if (node) this.graph.cloneNodes([node.id], 42, 42); break;
        case 'copy': if (node) { this.clipboard = [JSON.parse(JSON.stringify(node))]; this.toast('已复制节点', 'ok'); } break;
        case 'group': if (node) { this.nodes.select([node.id, ...sel]); LC.Menubar.run('group'); } break;
        case 'tpl-save': LC.Templates.save(node ? [...new Set([...sel, node.id])] : sel); break;
        case 'del': this.graph.removeNodes(node ? [node.id] : sel); this.edges.refresh(); break;
        case 'detail': if (node) this.openNodeDetail(node); break;
        case 'grp-node-rem': { if (node) { const tg = this.graph.groupOf(node.id); if (tg) { this.graph.removeFromGroup(tg.id, [node.id]); this.nodes.renderGroups(); this.saveSoon(); this.toast(`已将「${node.title}」移出组「${tg.title}」`, 'ok'); } } break; }
        case 'grp-del-keep': { const tg = this.graph.getGroup(groupId); if (tg) { this.graph.disbandGroup(groupId); this.nodes.renderGroups(); this.saveSoon(); this.toast(`已删除组「${tg.title}」（节点保留）`, 'ok'); } break; }
        case 'grp-del-all': { const tg = this.graph.getGroup(groupId); if (tg) { const cnt = tg.nodes.length; tg.nodes.slice().forEach((id) => this.graph.removeNode(id)); this.graph.disbandGroup(groupId); this.nodes.renderGroups(); this.edges.refresh(); this.saveSoon(); this.toast(`已删除组「${tg.title}」及 ${cnt} 个节点`, 'ok'); } break; }
        case 'grp-layout': { const tg = this.graph.getGroup(groupId); if (tg) this.layoutGroup(tg); break; }
      }
    },

    /* ---------- 组内一键排版：图片在左网格排列，视频在右单独一列 ---------- */
    layoutGroup(grp) {
      const nodes = grp.nodes.map((id) => this.graph.getNode(id)).filter(Boolean);
      if (nodes.length === 0) { this.toast('组内无节点', 'warn'); return; }
      // 按类型分组：视频节点单独一列放右侧，其他节点网格排列
      const videoNodes = nodes.filter((n) => n.type === 'video');
      const otherNodes = nodes.filter((n) => n.type !== 'video');
      // 其他节点按当前位置排序（从上到下、从左到右），保持大致顺序
      otherNodes.sort((a, b) => a.y - b.y || a.x - b.x);
      // 网格列数 = ceil(sqrt(N))，列间距 = 节点最大宽度 + 60，行间距 = 400
      const cols = Math.ceil(Math.sqrt(otherNodes.length || 1));
      const maxW = Math.max(...nodes.map((n) => n.w || 400));
      const colGap = maxW + 60;
      const rowGap = 400;
      // 起点用组当前左上角，保持组在原位
      const box = this.graph.boundingBox(grp.nodes);
      const startX = box ? box.x : 0;
      const startY = box ? box.y : 0;
      // 排列其他节点（网格）
      otherNodes.forEach((n, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;
        n.x = Math.round(startX + col * colGap);
        n.y = Math.round(startY + row * rowGap);
        this.nodes.position(n, true);
      });
      // 视频节点单独一列（网格右侧），垂直排列
      if (videoNodes.length > 0) {
        videoNodes.sort((a, b) => a.y - b.y || a.x - b.x);
        const videoColX = otherNodes.length > 0 ? startX + cols * colGap : startX;
        videoNodes.forEach((n, i) => {
          n.x = Math.round(videoColX);
          n.y = Math.round(startY + i * rowGap);
          this.nodes.position(n, true);
        });
      }
      this.nodes.renderGroups();
      if (LC.App.edges) LC.App.edges.refresh();
      this.graph.emit('change');
      this.saveSoon();
      const msg = videoNodes.length > 0
        ? `已排版 ${nodes.length} 个节点（${cols} 列 + 视频列 ${videoNodes.length} 个）`
        : `已排版 ${nodes.length} 个节点（${cols} 列网格）`;
      this.toast(msg, 'ok');
    },

    /* ---------- Ctrl + 右键 → 自定义选组菜单 ---------- */
    /* 根据上下文（右击节点 / 当前框选）确定目标操作节点集合 */
    _groupTargets(ctx) {
      const sel = [...this.nodes.selected];
      if (ctx && ctx.node) {
        // 若右击的节点恰在当前框选里 → 对整批操作；否则仅对此节点
        if (sel.includes(ctx.node.id)) return [...new Set(sel)];
        return [ctx.node.id];
      }
      return [...new Set(sel)];
    },
    /* 列出现有组，若空则返回 false（供二级菜单判断） */
    _hasGroups() { return this.graph.groups.length > 0; },
    /* 自定义选组主菜单 */
    showGroupCtx(ctx) {
      const g = this.graph;
      const targets = this._groupTargets(ctx);
      const targetsLabel = targets.length ? `（${targets.length} 个节点）` : '（请先框选节点）';
      // 目标节点已归属的组（用于「移出组」项的提示）
      const hitGroups = targets.map((id) => g.groupOf(id)).filter(Boolean);
      const hitGroupsLabel = hitGroups.length ? ` · 已在 ${[...new Set(hitGroups.map(x => x.id))].length} 组` : '';

      const disabled = (html) => `<button disabled style="opacity:.45;cursor:not-allowed">${html}</button>`;
      const btn = (label, act, dis) => dis ? disabled(label) : `<button data-ca="${act}">${label}</button>`;

      const items = [
        `<div style="padding:6px 14px 4px;font-size:12px;color:#9a9890;border-bottom:1px solid var(--line);">${U.icon('knob', 13)} 自定义选组 ${targetsLabel}${hitGroupsLabel}</div>`,
        btn(`${U.icon('plus', 13)} 新建组 ${targets.length ? '' : '— 请先选节点'}`, 'grp-new', !targets.length),
        btn(`${U.icon('folder', 13)} 加入现有组… ${targets.length ? '' : '— 请先选节点'}`, 'grp-add', !targets.length),
        btn(`${U.icon('minus', 13)} 从组中移出… ${hitGroups.length ? '' : '— 目标不在任何组'}`, 'grp-rem', !hitGroups.length),
        btn(`${U.icon('xcircle', 13)} 解散组… ${this._hasGroups() ? '' : '— 无已存在组'}`, 'grp-disband', !this._hasGroups()),
        btn(`${U.icon('mapPin', 13)} 定位 / 聚焦到组… ${this._hasGroups() ? '' : '— 无已存在组'}`, 'grp-fit', !this._hasGroups()),
        btn(`${U.icon('pen', 13)} 重命名组… ${this._hasGroups() ? '' : '— 无已存在组'}`, 'grp-rename', !this._hasGroups()),
      ];

      const menu = U.$('#ctx-menu');
      menu.innerHTML = items.join('');
      menu.hidden = false;
      // 菜单出现在鼠标位置，并确保不超出视口边界
      const mw = 230, mh = items.length * 30 + 10;
      menu.style.left = Math.max(4, Math.min(ctx.x, innerWidth - mw - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(ctx.y, innerHeight - mh - 4)) + 'px';
      const hide = () => {
        menu.hidden = true;
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('contextmenu', onCtxAway, true);
        document.removeEventListener('keydown', onKey);
      };
      const onDown = (ev) => { if (menu.contains(ev.target)) return; hide(); };
      const onClick = (ev) => { if (menu.contains(ev.target)) return; hide(); };
      const onCtxAway = (ev) => { if (!menu.contains(ev.target)) hide(); };
      const onKey = (ev) => { if (ev.key === 'Escape') hide(); };
      U.$$('button[data-ca]', menu).forEach((b) => {
        b.onclick = () => { const a = b.dataset.ca; hide(); this.runGroupCtx(a, ctx); };
      });
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('contextmenu', onCtxAway, true);
      document.addEventListener('keydown', onKey);
    },
    /* 组选择二级菜单：{title, items: [[label, payload, disabled?]]} */
    _openGroupPicker(cx, cy, title, items, onPick) {
      const menu = U.$('#ctx-menu');
      const header = `<div style="padding:6px 14px 4px;font-size:12px;color:#9a9890;border-bottom:1px solid var(--line);">${title}</div>`;
      const rows = items.map((it, idx) => {
        const [label, payload, dis] = it;
        if (dis) return `<button disabled style="opacity:.4;cursor:not-allowed" data-pi="${idx}">${label}</button>`;
        return `<button data-pi="${idx}">${label}</button>`;
      }).join('');
      menu.innerHTML = header + rows;
      menu.hidden = false;
      const mw = 250, mh = (items.length + 1) * 30 + 10;
      menu.style.left = Math.max(4, Math.min(cx, innerWidth - mw - 4)) + 'px';
      menu.style.top = Math.max(4, Math.min(cy, innerHeight - mh - 4)) + 'px';
      const hide = () => {
        menu.hidden = true;
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('contextmenu', onCtxAway, true);
        document.removeEventListener('keydown', onKey);
      };
      const onDown = (ev) => { if (menu.contains(ev.target)) return; hide(); };
      const onClick = (ev) => { if (menu.contains(ev.target)) return; hide(); };
      const onCtxAway = (ev) => { if (!menu.contains(ev.target)) hide(); };
      const onKey = (ev) => { if (ev.key === 'Escape') hide(); };
      U.$$('button[data-pi]', menu).forEach((b) => {
        b.onclick = () => { const idx = Number(b.dataset.pi); hide(); onPick(items[idx][1]); };
      });
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('contextmenu', onCtxAway, true);
      document.addEventListener('keydown', onKey);
    },
    runGroupCtx(act, ctx) {
      const g = this.graph;
      const targets = this._groupTargets(ctx);
      const x = ctx.x, y = ctx.y + 2;
      switch (act) {
        case 'grp-new': {
          if (!targets.length) return this.toast('请先框选节点再新建组', 'warn');
          const ng = g.createGroup(targets);
          this.nodes.renderGroups();
          this.nodes.select([]);   // 新建组后清空选中，避免点击组内单节点时误拖整组
          this.saveSoon();
          this.toast(`已新建组「${ng.title}」（${targets.length} 个节点）`, 'ok');
          break;
        }
        case 'grp-add': {
          if (!targets.length) return this.toast('请先框选节点再加入组', 'warn');
          const items = g.groups.map((gg) => [`${U.icon('cube', 13)} ${U.esc(gg.title)} (${gg.nodes.length})`, gg.id]);
          items.push([`${U.icon('plus', 13)} 新建组并加入`, '__new__']);
          this._openGroupPicker(x, y, `选择要把 ${targets.length} 个节点加入到：`, items, (gid) => {
            if (gid === '__new__') {
              const ng = g.createGroup(targets);
              this.nodes.renderGroups(); this.nodes.select([]); this.saveSoon();
              this.toast(`已新建组「${ng.title}」并加入全部节点`, 'ok');
            } else {
              g.addToGroup(gid, targets);
              this.nodes.renderGroups(); this.saveSoon();
              const tg = g.getGroup(gid);
              this.toast(`已加入组「${tg ? tg.title : gid}」`, 'ok');
            }
          });
          break;
        }
        case 'grp-rem': {
          // 只列出目标节点归属的组
          const inGroupMap = new Map();
          targets.forEach((id) => {
            const gg = g.groupOf(id); if (gg) inGroupMap.set(gg.id, gg);
          });
          if (!inGroupMap.size) return this.toast('目标节点不在任何组里', 'warn');
          const items = [
            [`${U.icon('target', 13)} 一键从所有组（${inGroupMap.size}）移出`, '__all__'],
            ['— 或逐个选择：', null, true],
            ...[...inGroupMap.values()].map((gg) => [`${U.icon('upload', 13)} ${U.esc(gg.title)}`, gg.id]),
          ];
          this._openGroupPicker(x, y, `移出的目标：${targets.length} 个节点`, items, (gid) => {
            if (gid === '__all__') {
              let cnt = 0;
              inGroupMap.forEach((gg) => { g.removeFromGroup(gg.id, targets); cnt++; });
              this.nodes.renderGroups(); this.saveSoon();
              this.toast(`已从 ${cnt} 个组中移出 ${targets.length} 个节点`, 'ok');
            } else {
              g.removeFromGroup(gid, targets);
              this.nodes.renderGroups(); this.saveSoon();
              this.toast('已从该组移出', 'ok');
            }
          });
          break;
        }
        case 'grp-disband': {
          if (!this._hasGroups()) return this.toast('当前没有可解散的组', 'warn');
          const items = [
            [`${U.icon('xcircle', 13)} 解散全部 ${g.groups.length} 个组`, '__all__'],
            ['— 或选择某个组解散：', null, true],
            ...g.groups.map((gg) => [`${U.icon('cube', 13)} ${U.esc(gg.title)} (${gg.nodes.length})`, gg.id]),
          ];
          this._openGroupPicker(x, y, '解散组（节点本身会保留）：', items, (gid) => {
            if (gid === '__all__') {
              const n = g.groups.length; g.groups = []; g.emit('change');
              this.nodes.renderGroups(); this.saveSoon();
              this.toast(`已解散全部 ${n} 个组`, 'ok');
            } else {
              const tg = g.getGroup(gid);
              g.disbandGroup(gid);
              this.nodes.renderGroups(); this.saveSoon();
              this.toast(`已解散组「${tg ? tg.title : gid}」`, 'ok');
            }
          });
          break;
        }
        case 'grp-fit': {
          if (!this._hasGroups()) return;
          const items = g.groups.map((gg) => [`${U.icon('search', 13)} ${U.esc(gg.title)} (${gg.nodes.length})`, gg.id]);
          this._openGroupPicker(x, y, '定位 / 聚焦到：', items, (gid) => {
            const gg = g.getGroup(gid); if (!gg) return;
            const box = g.boundingBox(gg.nodes); if (!box) return;
            this.view.fitBox(box.x - 40, box.y - 40, box.w + 80, box.h + 80);
            // 轻微高亮：滚动时已在视口内；加一条 toast 便于确认
            this.toast(`已聚焦到「${gg.title}」`, 'ok');
          });
          break;
        }
        case 'grp-rename': {
          if (!this._hasGroups()) return;
          const items = g.groups.map((gg) => [`${U.icon('pen', 13)} ${U.esc(gg.title)}`, gg.id]);
          this._openGroupPicker(x, y, '选择要重命名的组：', items, (gid) => {
            const gg = g.getGroup(gid); if (!gg) return;
            const input = prompt('重命名组：', gg.title);
            if (input == null) return;
            const newName = String(input).trim();
            if (!newName) return this.toast('组名不能为空', 'warn');
            g.renameGroup(gid, newName);
            this.nodes.renderGroups(); this.saveSoon();
            this.toast(`已重命名为「${newName}」`, 'ok');
          });
          break;
        }
      }
    },
  };

  LC.App = App;

  // 启动（防重复初始化：DOMContentLoaded 与直呼只会执行一次）
  // 任何初始化错误都以醒目横幅显示，绝不无声失败
  let started = false;
  const start = () => {
    if (started) return; started = true;
    try { App.init(); }
    catch (err) {
      console.error('初始化失败：', err);
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b3261e;color:#fff;'
        + 'padding:10px 16px;font:13px/1.6 sans-serif;white-space:pre-wrap;';
      bar.textContent = '⚠ 应用初始化失败：' + (err && err.message) + ' —— 请按 F12 查看控制台并截图反馈';
      document.body.appendChild(bar);
    }
  };
  // 全局错误兜底：运行时报错也可见（toast 而非无声失败）
  window.addEventListener('error', (e) => {
    console.error('全局错误：', e.error || e.message, e);
    if (window.LC && LC.App && LC.App.toast && e.message) {
      // 带上堆栈关键行，便于定位（如 Cannot read properties of undefined (reading 'x') → 具体文件:行号）
      const stackLine = (e.error && e.error.stack) ? (e.error.stack.split('\n')[1] || '').trim() : '';
      LC.App.toast('脚本错误：' + String(e.message).slice(0, 60) + (stackLine ? ' ⚠ ' + stackLine.slice(-60) : ''), 'err');
    }
  });
  document.addEventListener('DOMContentLoaded', start);
  if (document.readyState !== 'loading') start();
})();