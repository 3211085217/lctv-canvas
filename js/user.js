/* =====================================================
 * user.js — 单用户详情页逻辑（user.html?u=用户名 使用）
 * 内容：使用情况（登录/生成次数）、生成记录（图片/视频标签切换查看、
 *       每条含生成时间与提示词）、点开弹窗（大图/可播放暂停视频）、删除。
 * 权限：仅管理员会话可打开，否则跳回后台登录页。
 * ===================================================== */
(function () {
  const A = LC.Auth;
  const G = LC.GH;
  const $ = (s) => document.querySelector(s);

  /* 版本自检：老标签页检测到远端更新后自动刷新。
   常量必须与 version.json 的 v 保持一致（20）；sessionStorage 护栏保证一个会话最多自动刷新一次，
   杜绝「旧版本号常数 + 新远端版本」造成的死循环刷新。 */
  (function verCheck() {
    try {
      if (sessionStorage.getItem('lc_ver_reloaded')) return;
      fetch('version.json?t=' + Date.now())
        .then((r) => r.json())
        .then((j) => {
          if (j && typeof j.v === 'number' && j.v > 20) {
            sessionStorage.setItem('lc_ver_reloaded', '1');
            setTimeout(() => { try { location.reload(); } catch (e) {} }, 800);
          }
        })
        .catch(() => {});
    } catch (e) {}
  })();

  const q = new URLSearchParams(location.search);
  const UNAME = (q.get('u') || '').trim();
  const modal = $('#u-modal');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
  const kindOf = (name) => /\.(mp4|webm|mov|m4v)$/i.test(name) ? 'v' : (/\.(jpe?g|png|webp|gif|bmp)$/i.test(name) ? 'i' : 'o');
  const guessTime = (name) => {
    const m = String(name || '').match(/(\d{13})/);
    if (!m) return '—';
    const d = new Date(Number(m[1]));
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
  };

  let _items = [];      // 合并后的展示条目（含历史文件）
  let _tab = 'all';

  /* ---------- 详情弹窗 ---------- */
  function openDetail(d) {
    $('#m-media').innerHTML = d.kind === 'video'
      ? `<video controls autoplay src="${esc(d.url)}"></video>`
      : `<img src="${esc(d.url)}" alt="">`;
    $('#m-meta').innerHTML = `
      <div class="mrow"><span class="k">类型</span><span class="v">${esc(d.kind === 'video' ? '视频' : '图片')}${d.duration ? '（时长 ' + d.duration + ' 秒）' : ''}</span></div>
      <div class="mrow"><span class="k">生成时间</span><span class="v">${esc(d.time || '—')}${d.rec === false ? '（历史文件，无记录）' : ''}</span></div>
      <div class="mrow"><span class="k">提示词</span><span class="v${d.prompt ? ' prompt' : ''}">${d.prompt ? esc(d.prompt) : '（无记录）'}</span></div>
      <div class="mrow"><span class="k">大小</span><span class="v">${esc(d.size)}</span></div>
      <div class="mrow"><span class="k">文件名</span><span class="v">${esc(d.name)}</span></div>
      <div class="mrow"><span class="k">操作</span><span class="v">
        <a href="${esc(d.url)}" target="_blank" rel="noopener">新窗口打开</a>
        <button class="btn danger" id="m-del" style="margin-left:14px">删除此文件</button>
      </span></div>`;
    $('#m-del').onclick = async () => {
      if (!confirm('确定删除「' + d.name + '」？删除后无法恢复。')) return;
      try {
        await delAsset(d.name, d.rec !== false);
        closeDetail();
        await reload();
      } catch (err) { alert('删除失败：' + err.message); }
    };
    modal.hidden = false;
  }
  function closeDetail() {
    modal.hidden = true;
    $('#m-media').innerHTML = '';
    $('#m-meta').innerHTML = '';
  }
  $('#m-close').onclick = closeDetail;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDetail(); });

  /* ---------- 删除（带记录的同步移除记录） ---------- */
  async function delAsset(name, recorded) {
    if (recorded) await A.adminDeleteAsset(UNAME, name);
    else await G.delFile('assets/' + UNAME + '/' + name);
  }

  /* ---------- 数据加载 ---------- */
  async function reload() {
    const users = await A.adminList();
    const acc = users.find((x) => x.u === UNAME);
    if (!acc) {
      $('#u-name').textContent = '用户不存在';
      $('#u-list').innerHTML = '<div class="empty">没有找到「' + esc(UNAME) + '」，可能已被删除</div>';
      return;
    }
    $('#u-name').textContent = acc.u;
    $('#u-tag-container').innerHTML =
      (acc.role === 'admin' ? '<span class="tag">管理员</span>' : '') +
      (acc.disabled ? '<span class="st-disabled">已禁用</span>' : '');
    $('#u-created').textContent = acc.createdAt ? '注册于 ' + acc.createdAt : '';

    const [st, canvases, gl, assets] = await Promise.all([
      A.adminStats(acc.u).catch(() => null),
      A.canvasCount(acc.u).catch(() => 0),
      A.adminGenlog(acc.u).catch(() => ({ items: [] })),
      A.adminAssets(acc.u).catch(() => []),
    ]);
    const S = st || {};
    $('#u-use').innerHTML = `
      <div class="use"><b>${Number(S.logins) || 0}</b><span>登录次数</span></div>
      <div class="use"><b>${Number(S.images) || 0}</b><span>生成图片</span></div>
      <div class="use"><b>${Number(S.videos) || 0}</b><span>生成视频</span></div>
      <div class="use"><b>${Number(S.audios) || 0}</b><span>生成音频</span></div>
      <div class="use"><b>${canvases}</b><span>画布数</span></div>
      <div class="use wide"><b style="font-size:14px">${esc(S.lastLogin || '—')}</b><span>最后登录</span></div>
      <div class="use wide"><b style="font-size:14px">${esc(S.lastUse || '—')}</b><span>最后生成</span></div>`;

    const recorded = new Set((gl.items || []).map((i) => i.name));
    const rec = (gl.items || []).map((it) => ({
      name: it.name,
      kind: it.kind === 'video' ? 'video' : 'image',
      time: it.time || guessTime(it.name),
      prompt: it.prompt || '',
      size: Number(it.size) || 0,
      duration: Number(it.duration) || 0,
      url: G.RAW + '/assets/' + UNAME + '/' + it.name,
      rec: true,
      ts: String(it.name || '').match(/(\d{13})/) ? Number(String(it.name).match(/(\d{13})/)[1]) : 0,
    }));
    const legacy = assets
      .filter((a) => !recorded.has(a.name))
      .map((a) => {
        const k = kindOf(a.name);
        return {
          name: a.name,
          kind: k === 'v' ? 'video' : 'image',
          time: guessTime(a.name),
          prompt: '',
          size: a.size,
          duration: 0,
          url: a.url,
          rec: false,
          ts: String(a.name).match(/(\d{13})/) ? Number(String(a.name).match(/(\d{13})/)[1]) : 0,
        };
      });
    _items = [...rec.sort((a, b) => String(b.time).localeCompare(String(a.time))),
              ...legacy.sort((a, b) => b.ts - a.ts)];

    const cImg = _items.filter((i) => i.kind === 'image').length;
    const cVid = _items.filter((i) => i.kind === 'video').length;
    $('#c-all').textContent = _items.length;
    $('#c-img').textContent = cImg;
    $('#c-vid').textContent = cVid;
    renderList();
  }

  /* ---------- 渲染列表（按当前标签过滤） ---------- */
  function renderList() {
    const list = $('#u-list');
    const items = _items.filter((i) => _tab === 'all' || i.kind === _tab);
    if (!items.length) {
      list.innerHTML = '<div class="empty">' + (_tab === 'video' ? '没有视频' : _tab === 'image' ? '没有图片' : '还没有任何生成记录') + '</div>';
      return;
    }
    list.innerHTML = items.map((it) => {
      const kcls = it.kind === 'video' ? 'v' : 'i';
      const kindLabel = it.kind === 'video' ? '视频' : '图片';
      const detail = encodeURIComponent(JSON.stringify({
        name: it.name, kind: it.kind, url: it.url, time: it.time,
        prompt: it.prompt, size: fmtSize(it.size), duration: it.duration, rec: it.rec,
      }));
      const media = it.kind === 'video'
        ? `<video class="mv" preload="metadata" src="${esc(it.url)}" data-detail="${esc(detail)}"></video>`
        : `<img class="im" loading="lazy" src="${esc(it.url)}" alt="" data-detail="${esc(detail)}">`;
      return `<div class="item">
        ${media}
        <div class="info">
          <span class="name" title="${esc(it.name)}">${esc(it.name)}${it.rec === false ? '<span class="hist">历史文件</span>' : ''}</span>
          <span class="time">🕓 ${esc(it.time)}</span>
          <span class="kind ${kcls}">${kindLabel}${it.duration ? ' · ' + it.duration + 's' : ''} · ${fmtSize(it.size)}</span>
          ${it.prompt ? `<span class="prompt" title="${esc(it.prompt)}">提示词：${esc(it.prompt)}</span>` : ''}
        </div>
        <div class="ops">
          <a href="${esc(it.url)}" target="_blank" rel="noopener">新窗口打开</a>
          <button class="btn danger" data-del="${esc(it.name)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  /* ---------- 事件 ---------- */
  $('#u-tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    if (t.dataset.tab === _tab) return;
    _tab = t.dataset.tab;
    document.querySelectorAll('#u-tabs .tab').forEach((b) => b.classList.toggle('on', b === t));
    renderList();
  });

  $('#u-list').addEventListener('click', async (e) => {
    const media = e.target.closest('[data-detail]');
    if (media) {
      try { openDetail(JSON.parse(decodeURIComponent(media.dataset.detail || ''))); } catch (err) {}
      return;
    }
    const del = e.target.closest('button[data-del]');
    if (del) {
      const name = del.dataset.del;
      if (!confirm('确定删除「' + name + '」？删除后无法恢复。')) return;
      del.disabled = true;
      try {
        const it = _items.find((x) => x.name === name);
        await delAsset(name, it ? it.rec !== false : true);
        await reload();
      } catch (err) {
        alert('删除失败：' + err.message);
        del.disabled = false;
      }
    }
  });

  /* ---------- 启动：管理员会话校验 + 加载 ---------- */
  (async () => {
    if (!UNAME) { location.replace('admin.html'); return; }
    if (!A.currentName() || !(await A.isAdmin())) { location.replace('admin.html'); return; }
    await reload();
  })();
})();