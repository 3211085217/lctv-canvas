/* =====================================================
 * 顶栏菜单 / 动作分发 / 全局快捷键
 * ===================================================== */
(function () {
  const U = LC.U;

  const Menubar = {
    init() {
      // 菜单开合
      U.$$('.menu-item').forEach((mi) => {
        mi.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          // 按下的是下拉内部按钮：保持菜单打开，让随后的 click 正常落在按钮上执行动作。
          // 否则这里先把菜单关掉，按钮瞬间 display:none，click 就永远打不到了。
          if (e.target.closest('.dropdown')) return;
          const was = mi.classList.contains('open');
          U.$$('.menu-item').forEach((x) => x.classList.remove('open'));
          if (!was) mi.classList.add('open');
        });
      });
      document.addEventListener('pointerdown', () => U.$$('.menu-item').forEach((x) => x.classList.remove('open')));

      // 动作分发
      U.$('#topbar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        U.$$('.menu-item').forEach((x) => x.classList.remove('open'));
        this.run(btn.dataset.act);
      });

      // 自动重跑开关
      U.$('#auto-rerun').addEventListener('change', (e) => { LC.App.autoRerun = e.target.checked; });

      // 全局快捷键
      window.addEventListener('keydown', (e) => {
        const ae = document.activeElement;
        const inField = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName || '') || !!(ae && ae.isContentEditable);
        if (inField || LC.Director3D.modal || document.querySelector('.modal-mask')) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); LC.History.undo(); return; }
        if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); LC.History.redo(); return; }
        if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); this.run('copy'); return; }
        if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); this.run('paste'); return; }
        if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.run('duplicate'); return; }
        if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); LC.App.nodes.select([...LC.App.graph.nodes.keys()]); return; }
        if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); this.run('group'); return; }
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); this.run('save'); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.run('delete'); return; }
        if (e.key.toLowerCase() === 'f') { e.preventDefault(); LC.App.fitView(); return; }
      });

      // 项目名称
      U.$('#project-name').addEventListener('change', (e) => {
        LC.App.projectName = e.target.value.trim() || '未命名项目';
        U.$('#project-name').value = LC.App.projectName;
        LC.App.saveSoon();
      });
    },

    run(act) {
      const A = LC.App, g = A.graph, sel = [...A.nodes.selected];
      switch (act) {
        case 'save': A.saveNow(); break;
        case 'export-json': A.exports.exportFile(); break;
        case 'import-json': A.exports.importFile(); break;
        case 'share': A.exports.share(); break;
        case 'open-history': LC.History.openProjects(); break;
        case 'new': A.newProject(); break;
        case 'undo': LC.History.undo(); break;
        case 'redo': LC.History.redo(); break;
        case 'copy':
          A.clipboard = sel.map((id) => {
            const node = g.getNode(id);
            return node ? JSON.parse(JSON.stringify(node)) : null;
          }).filter(Boolean);
          LC.App.toast(`已复制 ${A.clipboard.length} 个节点`, 'ok');
          break;
        case 'paste':
          if (!A.clipboard?.length) return;
          {
            const ids = A.clipboard.map((snapshot) => {
              const copy = JSON.parse(JSON.stringify(snapshot));
              const n = g.createNode(copy.type, (copy.x || 0) + 52, (copy.y || 0) + 52, copy.props || null);
              n.title = g.uniqueTitle(copy.title || n.title);
              n.collapsed = !!copy.collapsed;
              return n.id;
            });
            LC.App.toast(`已粘贴 ${ids.length} 个节点`, 'ok');
          }
          break;
        case 'duplicate':
          if (sel.length) g.cloneNodes(sel, 42, 42);
          break;
        case 'select-all': A.nodes.select([...g.nodes.keys()]); break;
        case 'group': {
          if (sel.length < 1) { LC.App.toast('请先框选节点再编组', 'warn'); return; }
          const ng = g.createGroup([...sel]);
          A.nodes.renderGroups();
          A.nodes.select([]);   // 新建组后清空选中：组由组框整体拖动，节点点击应为单选，避免误拖整组
          g.emit('change'); A.saveSoon();
          if (ng) LC.App.toast(`已新建组「${ng.title}」（${sel.length} 个节点）`, 'ok');
          break;
        }
        case 'delete':
          if (A.edges.selectedEdge) { g.removeEdge(A.edges.selectedEdge); A.saveSoon(); break; }
          if (sel.length) { g.removeNodes(sel); A.edges.refresh(); A.saveSoon(); }
          break;
        case 'n-text': case 'n-image': case 'n-video': case 'n-audio': case 'n-script':
        case 'n-stage': case 'n-subtitle': case 'n-export': case 'n-check':
          A.createNodeNearCenter(act.slice(2)); break;
        case 'fit': A.fitView(); break;
        case 'reset-view': A.view.reset(); break;
        case 'save-template': LC.Templates.save(sel); break;
        case 'open-templates': LC.Templates.openPanel(); break;
        case 'settings':
          try { LC.Settings.open(); }
          catch (err) { console.error(err); LC.App.toast('设置打开失败：' + err.message, 'err'); }
          break;
        case 'help-about': this.help(); break;
      }
    },

    help() {
      const html = `
        <div style="font-size:13px;color:var(--text2);line-height:2">
          <h3 style="color:var(--text);margin-bottom:6px">◈ 无限画布 · 短剧全流程工作台</h3>
          <b style="color:var(--accent2)">鼠标</b><br>
          · 滚轮缩放画布 · 拖拽空白平移 · <b>Shift+拖拽</b>框选多节点<br>
          · 双击空白输入「/」唤起魔法指令 · 右键空白更多菜单<br>
          <b style="color:var(--accent2)">节点</b><br>
          · 拖动标题移动 · 端口拖出连线（上游输出自动流转）<br>
          · ▶ 执行节点 · 双击节点查看详情（图片大图 / 导演台）<br>
          <b style="color:var(--accent2)">快捷键</b><br>
          · Ctrl+S 保存 · Ctrl+Z/Y 撤销重做 · Ctrl+C/V 复制粘贴<br>
          · Ctrl+D 快速复制 · Ctrl+A 全选 · Ctrl+G 编组 · Del 删除 · F 适应视图<br>
          <b style="color:var(--accent2)">AI 引擎</b><br>
          · 模型 API 在<b>「设置 → API 接口 / 模型管理」</b>中自行添加，应用不预设任何模型<br>
          · 全部功能走真实 API（火山方舟协议），未配置模型或 API Key 时执行会直接报错<br>
          · 提示词里输入 <b>@</b> 可引用其他节点（等同连线）<br>
          <b style="color:var(--accent2)">存储</b><br>
          · 工程 / 版本 / 资产 / 模板存于浏览器 IndexedDB（大容量），不受 5MB 限制
        </div>`;
      LC.Modal.open(html, { title: `${U.icon('info', 15)} 关于 · 使用说明`, width: '520px' });
    },
  };

  LC.Menubar = Menubar;
})();