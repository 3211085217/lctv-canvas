/* =====================================================
 * 3D 导演台：素模人物站位 / 道具摆放 / 摄像机 / 截图输出
 * 依赖：Three.js（CDN 全局 THREE，离线时降级提示）
 * ===================================================== */
(function () {
  const U = LC.U;

  const CATALOG = [
    { type: 'man', name: '男主 · 素模', icon: 'person', color: 0x4a7bd6 },
    { type: 'woman', name: '女主 · 素模', icon: 'person', color: 0xd66b8f },
    { type: 'kid', name: '孩童 · 素模', icon: 'person', color: 0x7ed66b },
    { type: 'elder', name: '长者 · 素模', icon: 'person', color: 0x9aa0b8 },
    { type: 'box', name: '几何体 · 方块', icon: 'cube', color: 0x8a90b8 },
    { type: 'cylinder', name: '几何体 · 圆柱', icon: 'cylinder', color: 0x8a90b8 },
    { type: 'sphere', name: '几何体 · 球体', icon: 'sphere', color: 0x8a90b8 },
    { type: 'table', name: '道具 · 桌子', icon: 'table', color: 0x9c7a54 },
    { type: 'chair', name: '道具 · 椅子', icon: 'chair', color: 0x8c6b45 },
    { type: 'bed', name: '道具 · 床榻', icon: 'bed', color: 0x8a5f8f },
    { type: 'door', name: '道具 · 门框', icon: 'door', color: 0x7a5f3f },
    { type: 'crowd', name: '群众阵列', icon: 'crowd', color: 0x777f9e, special: true },
  ];

  const Scene = {
    renderer: null, scene: null, camera: null, container: null,
    objects: [], selected: null, mode: 'move', camPreset: '平视',
    node: null, modal: null, listeners: [],

    open(node) {
      if (!window.THREE) { LC.App.toast('3D 引擎加载失败（需要联网加载 Three.js），请检查网络后刷新', 'err'); return; }
      this.node = node;
      const html = `
        <div class="stage-layout">
          <div class="stage-view" id="stage-view"></div>
          <div class="stage-panel">
            <div class="stage-tools">
              <button data-mode="move" class="active">${U.icon('move', 14)} 移动</button>
              <button data-mode="rotate">${U.icon('rotate', 14)} 旋转</button>
              <button data-mode="look">${U.icon('eye', 14)} 朝向</button>
              <button id="sp-snap" style="background:#d4a853;color:#111;border:none;font-weight:600">${U.icon('camera', 14)} 截图输出</button>
            </div>
            <div class="sp-body">
              <div class="p-section">机位预设</div>
              <div class="p-chip-row" id="sp-campres"></div>
              <div class="p-section">角色 / 道具库</div>
              <div id="sp-catalog"></div>
              <div class="p-section">场景光照</div>
              <div class="p-chip-row" id="sp-lights"></div>
              <div class="p-section">场景对象 (<span id="sp-count">0</span>)</div>
              <div id="sp-objs"></div>
              <div class="stage-hint">
                ${U.icon('mouse', 12)} <b>左键拖拽</b>选中对象并移动（shift+拖 = 升高）<br>
                ${U.icon('mouse', 12)} <b>右键拖拽</b>旋转机位 · <b>滚轮</b>推拉<br>
                ${U.icon('keyboard', 12)} <b>R</b> 旋转对象 · <b>Delete</b> 删除选中<br>
                摆放完成后点击 <b>截图输出</b> 回传节点
              </div>
            </div>
          </div>
        </div>`;
      const modal = LC.Modal.open(html, { className: 'stage-modal', width: '96vw', title: `${U.icon('stage', 15)} 3D 导演台 — 人物站位控制`, onClose: () => this.dispose() });
      this.modal = modal;
      const body = modal.body;
      this.initRenderer(U.$('#stage-view', body));
      this.buildUI(body);
      // 载入已保存场景
      this.loadSceneData(node.props.scene);
      this.refreshList();
    },

    /* ---------- Three 初始化 ---------- */
    initRenderer(container) {
      this.container = container;
      const W = container.clientWidth, H = container.clientHeight;
      this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setSize(W, H);
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(this.renderer.domElement);

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x171a26);
      this.scene.fog = new THREE.Fog(0x171a26, 14, 46);

      // 地面与网格
      const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(60, 60),
        new THREE.MeshStandardMaterial({ color: 0x2a2e42, roughness: .92 })
      );
      ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
      this.scene.add(ground);
      const grid = new THREE.GridHelper(60, 60, 0x4a5480, 0x2c3250);
      grid.position.y = .008;
      this.scene.add(grid);

      // 灯光
      this.sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
      this.sun.position.set(8, 10, 6); this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.scene.add(this.sun);
      this.hemi = new THREE.HemisphereLight(0x8899dd, 0x333a55, .9);
      this.scene.add(this.hemi);
      this.amb = new THREE.AmbientLight(0xffffff, .25);
      this.scene.add(this.amb);

      this.camera = new THREE.PerspectiveCamera(50, W / H, .1, 200);
      this.camera.position.set(5.5, 4.2, 7.2);
      this.camera.lookAt(0, 1, 0);

      this.orbit = { theta: Math.atan2(this.camera.position.x, this.camera.position.z), phi: 1.05, radius: 9.4, target: new THREE.Vector3(0, 1, 0) };
      this.applyOrbit();

      // 交互
      this.raycaster = new THREE.Raycaster();
      this.planeY0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      this.drag = null;
      const dom = this.renderer.domElement;
      dom.addEventListener('pointerdown', (e) => this.onDown(e));
      dom.addEventListener('pointermove', (e) => this.onMove(e));
      dom.addEventListener('pointerup', () => { this.drag = null; });
      dom.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.orbit.radius = U.clamp(this.orbit.radius * (1 + e.deltaY * .0012), 1.8, 40);
        this.applyOrbit();
      }, { passive: false });
      window.addEventListener('keydown', this.onKey = (e) => {
        if (!this.modal) return;
        if (e.key === 'r' || e.key === 'R') this.setMode('rotate');
        if (e.key === 'Delete' || e.key === 'Backspace') this.removeSelected();
        if (e.key === 'Escape') { this.setMode('move'); }
      });
      window.addEventListener('resize', this.onResize = () => {
        if (!this.container) return;
        const w = this.container.clientWidth, h = this.container.clientHeight;
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
      });
      this.animId = requestAnimationFrame(() => this.animate());
    },

    applyOrbit() {
      const { theta, phi, radius, target } = this.orbit;
      this.camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta)
      );
      this.camera.lookAt(target);
    },

    setCamPreset(name) {
      this.camPreset = name;
      const t = this.orbit.target;
      const P = {
        平视: { phi: 1.14, radius: 9.4 },
        俯拍: { phi: 1.75, radius: 13 },
        顶视: { phi: 0.06, radius: 14 },
        侧拍: { phi: 1.18, radius: 8.4 },
        低角度仰拍: { phi: 2.05, radius: 9 },
      };
      const pr = P[name] || P['平视'];
      this.orbit.phi = pr.phi; this.orbit.radius = pr.radius;
      this.camera.fov = name === '顶视' ? 45 : 50;
      this.camera.updateProjectionMatrix();
      this.applyOrbit();
      this.orbit = this.orbit;
    },

    /* ---------- 物体构建 ---------- */
    makeObject(type, color) {
      const g = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color, roughness: .6 });
      const skin = new THREE.MeshStandardMaterial({ color: 0xe8c9a8, roughness: .7 });
      switch (type) {
        case 'man': case 'woman': case 'kid': case 'elder': {
          const k = type === 'kid' ? .62 : type === 'elder' ? .92 : 1;
          const head = new THREE.Mesh(new THREE.SphereGeometry(.16 * k, 20, 16), skin);
          head.position.y = 1.62 * k; head.castShadow = true;
          const body = new THREE.Mesh(new THREE.CapsuleGeometry(.19 * k * (type === 'woman' ? .92 : 1), .72 * k, 8, 14), mat);
          body.position.y = .98 * k; body.castShadow = true;
          const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.055 * k, .5 * k, 6, 10), mat);
          arm.position.set(.3 * k, 1.08 * k, 0); arm.rotation.z = .25; arm.castShadow = true;
          const arm2 = arm.clone(); arm2.position.x = -.3 * k; arm2.rotation.z = -.25;
          const leg = new THREE.Mesh(new THREE.CapsuleGeometry(.075 * k, .62 * k, 6, 10), mat);
          leg.position.set(.11 * k, .36 * k, 0); leg.castShadow = true;
          const leg2 = leg.clone(); leg2.position.x = -.11 * k;
          g.add(head, body, arm, arm2, leg, leg2);
          break;
        }
        case 'box': {
          const m = new THREE.Mesh(new THREE.BoxGeometry(.9, .9, .9), mat);
          m.position.y = .45; m.castShadow = true; g.add(m);
          break;
        }
        case 'cylinder': {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, 1.1, 20), mat);
          m.position.y = .55; m.castShadow = true; g.add(m);
          break;
        }
        case 'sphere': {
          const m = new THREE.Mesh(new THREE.SphereGeometry(.5, 22, 18), mat);
          m.position.y = .55; m.castShadow = true; g.add(m);
          break;
        }
        case 'table': {
          const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, .09, .9), new THREE.MeshStandardMaterial({ color: 0x9c7a54 }));
          top.position.y = .78; top.castShadow = true;
          const legs = [];
          [[-.62, 0, -.36], [.62, 0, -.36], [-.62, 0, .36], [.62, 0, .36]].forEach(([x, y, z]) => {
            const l = new THREE.Mesh(new THREE.CylinderGeometry(.045, .045, .78, 8), mat);
            l.position.set(x, .39, z); legs.push(l);
          });
          g.add(top, ...legs); break;
        }
        case 'chair': {
          const seat = new THREE.Mesh(new THREE.BoxGeometry(.55, .07, .55), mat);
          seat.position.y = .5; seat.castShadow = true;
          const back = new THREE.Mesh(new THREE.BoxGeometry(.55, .62, .07), mat);
          back.position.set(0, .85, -.24);
          const legs = [];
          [[-.22, .22], [.22, .22], [-.22, -.22], [.22, -.22]].forEach(([x, z]) => {
            const l = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, .5, 8), mat);
            l.position.set(x, .25, z); legs.push(l);
          });
          g.add(seat, back, ...legs); break;
        }
        case 'bed': {
          const base = new THREE.Mesh(new THREE.BoxGeometry(2.1, .3, 1.2), new THREE.MeshStandardMaterial({ color: 0x7a5f8f }));
          base.position.y = .25; base.castShadow = true;
          const mat2 = new THREE.Mesh(new THREE.BoxGeometry(1.9, .22, 1), new THREE.MeshStandardMaterial({ color: 0xd8cfe8 }));
          mat2.position.y = .5;
          const pillow = new THREE.Mesh(new THREE.BoxGeometry(.6, .1, .36), new THREE.MeshStandardMaterial({ color: 0xffffff }));
          pillow.position.set(-.6, .66, 0);
          g.add(base, mat2, pillow); break;
        }
        case 'door': {
          const frame = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.4, .08), new THREE.MeshStandardMaterial({ color: 0x5f4a33 }));
          frame.position.y = 1.2; frame.castShadow = true;
          const doorp = new THREE.Mesh(new THREE.BoxGeometry(1.12, 2.2, .05), new THREE.MeshStandardMaterial({ color: 0x8a6b45 }));
          doorp.position.set(.05, 1.12, .02);
          g.add(frame, doorp); break;
        }
      }
      return g;
    },

    spawn(type) {
      const item = CATALOG.find((c) => c.type === type);
      const color = type === 'kid' ? 0xf0d9a8 : (typeof item.color === 'number' ? item.color : 0x8a90b8);
      const target = this.orbit.target;
      const pos = new THREE.Vector3(target.x, 0, target.z - 2.5);
      return this.addObject(type, pos, color);
    },

    addObject(type, pos, color, data = {}) {
      const g = this.makeObject(type, color);
      g.position.copy(pos);
      if (data.rotY) g.rotation.y = data.rotY;
      if (data.s) g.scale.setScalar(data.s);
      g.userData = { type, oid: U.uid('o'), name: data.name || (CATALOG.find((c) => c.type === type)?.name || type), baseScale: data.s || 1 };
      this.scene.add(g);
      this.objects.push(g);
      this.selected = g;
      this.refreshList();
      return g;
    },

    loadSceneData(sc) {
      if (sc && sc.objs && sc.objs.length) {
        sc.objs.forEach((o) => this.addObject(o.type, new THREE.Vector3(o.x, o.y, o.z), o.color || 0x4a7bd6, o));
        if (sc.camera && sc.camera.orbit) {
          const o = sc.camera.orbit, t = o.target || { x: 0, y: 1, z: 0 };
          this.orbit = { theta: o.theta, phi: o.phi, radius: o.radius, target: new THREE.Vector3(t.x, t.y, t.z) };
        }
      }
      this.refreshList();
    },

    removeSelected() {
      if (!this.selected) return;
      this.scene.remove(this.selected);
      this.objects = this.objects.filter((o) => o !== this.selected);
      this.selected = null;
      this.refreshList();
    },

    snapshot() {
      // 稍等一帧保证渲染
      requestAnimationFrame(() => {
        this.renderer.render(this.scene, this.camera);
        const out = LC.AI.stageSnapshot(this.renderer.domElement);
        const n = this.node;
        n.props.snapshot = out.dataURL;
        n.props.scene = {
          objs: this.objects.map((o) => ({ type: o.userData.type, name: o.userData.name, x: +o.position.x.toFixed(2), y: +o.position.y.toFixed(2), z: +o.position.z.toFixed(2), rotY: +o.rotation.y.toFixed(2), color: (o.children[0]?.material?.color?.getHex?.() || o.children.find(c=>c.material)?.material.color.getHex() || 0x4a7bd6) })),
          camera: { orbit: { ...this.orbit, target: { x: this.orbit.target.x, y: this.orbit.target.y, z: this.orbit.target.z } } },
        };
        if (n.state.output) { /* 保留 */ }
        n.state.output = out;
        n.state.status = 'done';
        LC.App.toast('导演台截图已输出到节点，可连线生图/生视频', 'ok');
        LC.App.nodes.updateNode(n.id);
        LC.App.graph.emit('change');
        LC.App.saveSoon();
        this.modal.close();
      });
    },

    serializeColor(obj) {
      // 取第一个 mesh 的颜色
      let c = 0x4a7bd6;
      obj.traverse((o) => { if (o.material && o.material.color) { c = o.material.color.getHex(); return; } });
      return c;
    },

    /* ---------- 交互 ---------- */
    pick(e) {
      const r = this.renderer.domElement.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const my = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.raycaster.setFromCamera({ x: mx, y: my }, this.camera);
      const hits = this.raycaster.intersectObjects(this.objects, true);
      return hits.length ? this.upToGroup(hits[0].object) : null;
    },
    upToGroup(o) { while (o.parent && this.objects.indexOf(o) < 0) o = o.parent; return this.objects.indexOf(o) >= 0 ? o : null; },

    onDown(e) {
      const dom = this.renderer.domElement;
      if (e.button === 2) { this.drag = { orbit: true, x: e.clientX, y: e.clientY, theta: this.orbit.theta, phi: this.orbit.phi }; return; }
      if (e.button !== 0) return;
      const hit = this.pick(e);
      if (hit) {
        this.selected = hit;
        this.refreshList();
        const r = this.raycaster.ray.intersectPlane(this.planeY0, new THREE.Vector3());
        this.drag = { obj: hit, mode: this.mode, lastX: e.clientX, lastY: e.clientY, startY: e.clientY, planePoint: r, baseY: hit.position.y };
      } else {
        this.drag = { pan: true, x: e.clientX, y: e.clientY };
        this.selected = null;
        this.refreshList();
      }
    },

    onMove(e) {
      if (!this.drag) return;
      if (this.drag.orbit) {
        this.orbit.theta = this.drag.theta - (e.clientX - this.drag.x) * .006;
        this.orbit.phi = U.clamp(this.drag.phi - (e.clientY - this.drag.y) * .006, .15, Math.PI - .15);
        this.applyOrbit();
        return;
      }
      if (this.drag.pan) {
        const dx = (e.clientX - this.drag.x), dy = (e.clientY - this.drag.y);
        const d = this.orbit.radius * .0018;
        this.orbit.target.x -= Math.cos(this.orbit.theta) * dx * d;
        this.orbit.target.z += Math.sin(this.orbit.theta) * dx * d;
        this.orbit.target.y += dy * d * .7;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
        this.applyOrbit();
        return;
      }
      const obj = this.drag.obj;
      if (!obj) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * 2 - 1;
      const my = -((e.clientY - r.top) / r.height) * 2 + 1;
      this.raycaster.setFromCamera({ x: mx, y: my }, this.camera);
      const pt = this.raycaster.ray.intersectPlane(this.planeY0, new THREE.Vector3());
      if (this.mode === 'move') {
        if (pt) {
          obj.position.x = pt.x; obj.position.z = pt.z;
          if (e.shiftKey) obj.position.y = U.clamp(this.drag.baseY - (e.clientY - this.drag.startY) * .012, 0, 6);
        }
      } else if (this.mode === 'rotate') {
        obj.rotation.y -= (e.clientX - this.drag.lastX) * .012;
      } else if (this.mode === 'look') {
        if (pt) obj.lookAt(pt.x, obj.position.y, pt.z);
      }
      this.drag.lastX = e.clientX; this.drag.lastY = e.clientY;
    },

    animate() {
      if (!this.modal) return;
      this.renderer.render(this.scene, this.camera);
      this.animId = requestAnimationFrame(() => this.animate());
    },

    /* ---------- UI ---------- */
    buildUI(body) {
      const campres = U.$('#sp-campres', body);
      ['平视', '俯拍', '顶视', '侧拍', '低角度仰拍'].forEach((name) => {
        const b = document.createElement('div');
        b.className = 'p-chip' + (name === '平视' ? ' active' : '');
        b.textContent = name;
        b.onclick = () => {
          U.$$('.p-chip', campres).forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          this.setCamPreset(name);
        };
        campres.appendChild(b);
      });

      const lights = U.$('#sp-lights', body);
      const lightPresets = { 日光: { bg: 0x171a26, sun: 1.6, hemi: .9 }, 夜景: { bg: 0x0d0f1c, sun: .5, hemi: .4 }, 暖调: { bg: 0x1c1612, sun: 1.3, hemi: .7 }, 阴天: { bg: 0x20242e, sun: .8, hemi: 1.1 } };
      Object.keys(lightPresets).forEach((name, i) => {
        const b = document.createElement('div');
        b.className = 'p-chip' + (i === 0 ? ' active' : '');
        b.textContent = name;
        b.onclick = () => {
          U.$$('.p-chip', lights).forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          const pr = lightPresets[name];
          this.scene.background = new THREE.Color(pr.bg);
          this.scene.fog.color = new THREE.Color(pr.bg);
          this.sun.intensity = pr.sun; this.hemi.intensity = pr.hemi;
        };
        lights.appendChild(b);
      });

      const cat = U.$('#sp-catalog', body);
      CATALOG.forEach((c) => {
        const b = document.createElement('button');
        b.className = 'p-btn';
        b.style.marginBottom = '6px';
        b.innerHTML = `${U.icon(c.icon, 14)} ${c.name}`;
        b.onclick = () => {
          if (c.special) {
            // 群众阵列：5 x 2
            for (let i = 0; i < 10; i++) {
              const g = this.makeObject(i % 3 === 0 ? 'woman' : 'man', 0x555d80 + (i * 23456) % 0x220000);
              g.position.set((i % 5) * .9 - 1.8, 0, -Math.floor(i / 5) * 1.1 - 4);
              g.userData = { type: i % 3 === 0 ? 'woman' : 'man', oid: U.uid('o'), name: '群众' + (i + 1) };
              this.scene.add(g); this.objects.push(g);
              g.rotation.y = Math.random() * 1.2 - .6;
            }
            this.refreshList();
          } else this.spawn(c.type);
        };
        cat.appendChild(b);
      });

      U.$('#sp-snap', body).onclick = () => this.snapshot();
      U.$('#sp-campres', body).addEventListener('click', () => {});
      // 模式切换
      U.$$('.stage-tools button[data-mode]', body).forEach((b) => {
        b.onclick = () => {
          U.$$('.stage-tools button[data-mode]', body).forEach((x) => x.classList.remove('active'));
          b.classList.add('active');
          this.setMode(b.dataset.mode);
        };
      });
      window.dispatchEvent(new Event('resize'));
    },

    setMode(m) {
      this.mode = m;
      const modal = this.modal && this.modal.body;
      if (modal) U.$$('.stage-tools button[data-mode]', modal).forEach((b) =>
        b.classList.toggle('active', b.dataset.mode === m));
    },

    refreshList() {
      if (!this.modal) return;
      const body = this.modal.body;
      const list = U.$('#sp-objs', body);
      U.$('#sp-count', body).textContent = this.objects.length;
      list.innerHTML = '';
      this.objects.forEach((o, i) => {
        const d = document.createElement('div');
        d.className = 'sp-obj' + (o === this.selected ? ' active' : '');
        d.innerHTML = `<span class="so-ic">${U.icon(CATALOG.find((c) => c.type === o.userData.type)?.icon || 'cube', 14)}</span>
          <span class="so-nm">${U.esc(o.userData.name || '对象')} <small style="color:var(--text3)">(${o.position.x.toFixed(1)},${o.position.y.toFixed(1)},${o.position.z.toFixed(1)})</small></span>
          <button class="so-del">✕</button>`;
        d.onclick = () => { this.selected = o; this.refreshList(); };
        U.$('.so-del', d).onclick = (e) => {
          e.stopPropagation();
          this.scene.remove(o); this.objects.splice(i, 1);
          if (this.selected === o) this.selected = null;
          this.refreshList();
        };
        list.appendChild(d);
      });
    },

    dispose() {
      this.modal = null;
      window.removeEventListener('keydown', this.onKey);
      window.removeEventListener('resize', this.onResize);
      cancelAnimationFrame(this.animId);
      if (this.scene) {
        this.scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            const materials = Array.isArray(o.material) ? o.material : [o.material];
            materials.forEach((m) => {
              Object.values(m).forEach((v) => { if (v && v.isTexture) v.dispose(); });
              m.dispose();
            });
          }
        });
        this.scene.clear();
      }
      if (this.renderer) { this.renderer.dispose(); this.container.innerHTML = ''; }
      this.scene = null; this.camera = null; this.objects = []; this.selected = null; this.container = null;
    },
  };

  LC.Director3D = Scene;
})();