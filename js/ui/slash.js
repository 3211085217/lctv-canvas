/* =====================================================
 * 斜杠快捷指令：双击画布 / 「/ 快捷指令」按钮唤起
 * 支持 / 预设快捷工作流 与 自然语言智能建节点
 * ===================================================== */
(function () {
  const U = LC.U;
  const Menu = [
    { key: 'tri', icon: 'tri', name: '角色三视图', desc: '正面/侧面/背面定妆', act: () => LC.App.createNodeAt('image', { mode: 'tri', prompt: '主角定妆照，正面/侧面/背面三视图' }, d) },
    { key: 'grid', icon: 'grid', name: '九宫格分镜', desc: '同场景多机位构图', act: () => LC.App.createNodeAt('imageGrid', { prompt: '场景多机位试镜' }, d) },
    { key: 'shots', icon: 'script', name: '故事脚本拆分镜', desc: '剧本一键拆镜头列表', act: () => LC.App.createNodeAt('script', { content: '' }, d) },
    { key: 'stage', icon: 'stage', name: '3D 导演台', desc: '人物站位控制', act: () => LC.App.createNodeAt('stage', {}, d) },
    { key: 'video', icon: 'video', name: '首尾帧生视频', desc: '首帧图生成 4-15s', act: () => LC.App.createNodeAt('video', { mode: 'shouweizhen', duration: 5 }, d) },
    { key: 'voice', icon: 'mic', name: 'AI 配音', desc: '多音色角色配音', act: () => LC.App.createNodeAt('audio', { kind: 'voice' }, d) },
    { key: 'sub', icon: 'subtitle', name: 'AI 字幕', desc: '台词自动转字幕', act: () => LC.App.createNodeAt('subtitle', {}, d) },
    { key: 'export', icon: 'export', name: '成片拼接导出', desc: '串联镜头导成片', act: () => LC.App.createNodeAt('export', {}, d) },
    { key: 'check', icon: 'check', name: '合规校验', desc: '版权/敏感风险检测', act: () => LC.App.createNodeAt('check', {}, d) },
  ];

  let d = { x: 0, y: 0 }; // 当前锚点（世界坐标）

  const box = () => U.$('#slash-box');
  const input = () => U.$('#slash-input');
  const menuEl = () => U.$('#slash-menu');

  function open(world, client) {
    d = world;
    const b = box();
    b.hidden = false;
    b.style.left = U.clamp(world.x * LC.App.view.z + LC.App.view.x, 60, innerWidth - 380) + 'px';
    b.style.top = U.clamp(world.y * LC.App.view.z + LC.App.view.y, 60, innerHeight - 400) + 'px';
    menuEl().hidden = true;
    menuEl().innerHTML = '';
    input().value = '';
    setTimeout(() => input().focus(), 30);
  }

  function close() {
    if (box().hidden) return;
    box().hidden = true;
  }

  function renderMenu(filter) {
    const m = menuEl();
    const items = Menu.filter((x) => !filter || x.name.includes(filter) || x.key.includes(filter) || x.desc.includes(filter));
    m.innerHTML = items.map((x, i) =>
      `<div class="slash-item" data-i="${i}"><span class="si-ic">${U.icon(x.icon, 15)}</span><span class="si-nm">${x.name}${x.hot ? ' <b style="color:var(--warn)">推荐</b>' : ''}</span><span class="si-ds">${x.desc}</span></div>`
    ).join('') || `<div class="slash-item" style="color:var(--text3)">无匹配指令，回车将按文本智能创建</div>`;
    m.hidden = false;
    active = 0;
    highlight();
    U.$$('.slash-item', m).forEach((el) => {
      el.onclick = () => { pick(Number(el.dataset.i), filter); };
    });
  }

  let active = 0;
  function highlight() {
    U.$$('.slash-item', menuEl()).forEach((el, i) =>
      el.classList.toggle('active', (menuEl().dataset.mode === 'filter' || input().value.startsWith('/')) && i === active));
  }

  function pick(i, filter) {
    const items = Menu.filter((x) => !filter || x.name.includes(filter) || x.key.includes(filter) || x.desc.includes(filter));
    const item = items[i];
    if (!item) return;
    close();
    item.act();
  }

  function smartCreate(text) {
    const t = text.toLowerCase();
    if (/三视图|定妆|角色图/.test(t)) return LC.App.createNodeAt('image', { mode: 'tri', prompt: text }, d);
    if (/九宫格|多机位|宫格/.test(t)) return LC.App.createNodeAt('imageGrid', { prompt: text }, d);
    if (/生图|图片|画一张|生成图|场景图|参考图/.test(t)) return LC.App.createNodeAt('image', { mode: 'single', prompt: text }, d);
    if (/视频|推演|动画/.test(t)) return LC.App.createNodeAt('video', { mode: 'cankaosheng', prompt: text }, d);
    if (/配音|音频|bgm|音效|背景音乐/.test(t)) return LC.App.createNodeAt('audio', { kind: /bgm|背景音乐/.test(t) ? 'bgm' : 'voice', text: text }, d);
    if (/剧本|分镜|故事|脚本/.test(t)) return LC.App.createNodeAt('script', { content: text }, d);
    if (/字幕/.test(t)) return LC.App.createNodeAt('subtitle', {}, d);
    if (/导演台|站位|3d/.test(t)) return LC.App.createNodeAt('stage', {}, d);
    if (/导出|成片|拼接/.test(t)) return LC.App.createNodeAt('export', {}, d);
    if (/校验|合规|版权/.test(t)) return LC.App.createNodeAt('check', {}, d);
    return LC.App.createNodeAt('text', { text }, d);
  }

  function init() {
    input().addEventListener('input', (e) => {
      const v = e.target.value;
      if (v.startsWith('/')) {
        renderMenu(v.slice(1).toLowerCase());
        menuEl().dataset.mode = 'filter';
      } else {
        menuEl().hidden = true;
      }
    });
    input().addEventListener('keydown', (e) => {
      const v = input().value;
      if (e.key === 'Escape') return close();
      if (e.key === 'Enter') {
        if (v.startsWith('/') && !menuEl().hidden) {
          pick(active, v.slice(1));
        } else if (v.trim()) {
          close();
          smartCreate(v.trim());
        }
        return;
      }
      if (menuEl().hidden) return;
      if (e.key === 'ArrowDown') { active = U.clamp(active + 1, 0, U.$$('.slash-item', menuEl()).length - 1); highlight(); }
      if (e.key === 'ArrowUp') { active = U.clamp(active - 1, 0, U.$$('.slash-item', menuEl()).length - 1); highlight(); }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#slash-box') && !box().hidden) close();
    });
  }

  LC.Slash = { open, close, init, smartCreate };
})();