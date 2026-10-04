/* =====================================================
 * admin.js — 后台管理页逻辑（admin.html 使用）
 * 管理能力：用户列表（含明文密码/使用次数）、预置账号、禁用/启用、
 * 重置密码、生成作品（图片/视频）查看与删除。
 * 说明：与主站同为「轻量账号」安全级别（共享令牌在前端），
 *       管理权限 = 管理员账号密码，防同学不防盗。
 * ===================================================== */
(function () {
  const A = LC.Auth;
  const G = LC.GH;
  const $ = (s) => document.querySelector(s);

  const loginPanel = $('#login-panel');
  const panel = $('#admin-panel');
  const modal = $('#det-modal');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
  const kindOf = (name) => /\.(mp4|webm|mov|m4v)$/i.test(name) ? 'v' : (/\.(jpe?g|png|webp|gif|bmp)$/i.test(name) ? 'i' : 'o');
  /* 从文件名猜生成时间（gen_<毫秒时间戳>.ext / pub_<毫秒>.ext） */
  const guessTime = (name) => {
    const m = String(name || '').match(/(\d{13})/);
    if (!m) return '—';
    const d = new Date(Number(m[1]));
    return isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false });
  };

  let _users = [];   // 最近一次用户列表快照

  /* ---------- 用户表格 + 统计 ---------- */
  async function refresh() {
    const me = A.currentName();
    $('#ad-who').textContent = '👤 ' + me;
    const users = await A.adminList();
    _users = users;
    let totalCanvas = 0, totalGen = 0, disabled = 0;
    const rows = [];
    for (const u of users) {
      const st = await A.adminStats(u.u).catch(() => null) || {};
      const n = await A.canvasCount(u.u).catch(() => 0);
      const imgs = Number(st.images) || 0;
      const vids = Number(st.videos) || 0;
      const logins = Number(st.logins) || 0;
      totalCanvas += n;
      totalGen += imgs + vids;
      if (u.disabled) disabled++;
      rows.push(`<tr>
        <td>${esc(u.u)}${u.role === 'admin' ? '<span class="tag">管理员</span>' : ''}</td>
        <td>${u.pw ? '<span class="pw" title="' + esc(u.pw) + '">' + esc(u.pw) + '</span>' : '<span style="color:var(--text3)">—</span>'}</td>
        <td class="${u.disabled ? 'off' : ''}">${u.disabled ? '已禁用' : '正常'}</td>
        <td class="num">${logins}</td>
        <td class="num">${imgs}</td>
        <td class="num">${vids}</td>
        <td class="num">${n}</td>
        <td class="ops">
          <button class="btn sm" data-op="works" data-u="${esc(u.u)}">生成记录</button>
          <button class="btn sm" data-op="toggle" data-u="${esc(u.u)}">${u.disabled ? '启用' : '禁用'}</button>
          <button class="btn sm" data-op="pwd" data-u="${esc(u.u)}">重置密码</button>
        </td></tr>`);
    }
    $('#user-tbody').innerHTML = rows.join('');
    $('#st-users').textContent = users.length;
    $('#st-canvases').textContent = totalCanvas;
    $('#st-gens').textContent = totalGen;
    $('#st-disabled').textContent = disabled;
    // 同步资产区下拉（保留当前选择）
    const sel = $('#as-user');
    const prev = sel.value;
    sel.innerHTML = _users.map((u) => `<option value="${esc(u.u)}">${esc(u.u)}</option>`).join('');
    if (_users.some((u) => u.u === prev)) sel.value = prev;
    if (sel.value) loadWorks(); else $('#as-list').innerHTML = '';
  }

  /* ---------- 表格操作：事件委托 ---------- */
  $('#user-tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    const u = b.dataset.u;
    const busy = (t) => { b.disabled = true; b.textContent = t; };
    try {
      if (b.dataset.op === 'works') {
        // 跳到该用户的生成记录
        const sel = $('#as-user');
        sel.value = u;
        await loadWorks();
        $('#works-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (b.dataset.op === 'toggle') {
        const acc = _users.find((x) => x.u === u);
        if (!acc) throw new Error('用户不存在');
        busy('处理中…');
        await A.adminSetDisabled(u, !acc.disabled);
      } else if (b.dataset.op === 'pwd') {
        const pw = prompt('为「' + u + '」设置新密码（至少 4 位）：');
        if (pw == null) return;
        if (String(pw).length < 4) { alert('密码至少 4 位'); return; }
        busy('处理中…');
        await A.adminSetPassword(u, pw);
        alert('已重置「' + u + '」的密码');
      }
      await refresh();
    } catch (err) {
      alert('操作失败：' + err.message);
      try { await refresh(); } catch (e) {}
    }
  });

  /* ---------- 生成作品规整 ---------- */
  async function loadWorks() {
    const grid = $('#as-list');
    const u = $('#as-user').value;
    grid.innerHTML = '<div class="as-empty">加载中…</div>';
    $('#as-chips').innerHTML = '';
    if (!u) {
      grid.innerHTML = '<div class="as-empty">还没有任何用户</div>';
      return;
    }
    const [gl, assets] = await Promise.all([A.adminGenlog(u), A.adminAssets(u)]);
    const items = gl.items || [];
    const imgs = items.filter((i) => i.kind !== 'video').length;
    const vids = items.filter((i) => i.kind === 'video').length;
    $('#as-chips').innerHTML =
      `<span>生成图片 <b>${imgs}</b></span><span>生成视频 <b>${vids}</b></span><span>云端文件 <b>${assets.length}</b></span>`;
    if (!items.length && !assets.length) {
      grid.innerHTML = '<div class="as-empty">「' + esc(u) + '」还没有生成/上传任何图片视频</div>';
      return;
    }
    const recorded = new Set(items.map((i) => i.name));
    const recHtml = items.map((it) => recCard(u, it));
    const legacy = assets.filter((a) => !recorded.has(a.name));
    const legHtml = legacy.map((a) => legacyCard(u, a));
    grid.innerHTML = [
      recHtml.length ? recHtml.join('') : '',
      legHtml.length ? '<div class="as-sec">历史文件（无提示词记录，仅可打开/删除）</div>' + legHtml.join('') : '',
    ].join('');
  }

  /* 生成记录卡片：缩略图可点击 → 详情弹窗 */
  function recCard(u, it) {
    const url = G.RAW + '/assets/' + u + '/' + it.name;
    const kind = kindOf(it.name);
    const kcls = { v: 'v', i: 'i', o: 'o' }[kind];
    const kindLabel = { v: '视频', i: '图片', o: '文件' }[kind];
    const detail = encodeURIComponent(JSON.stringify({
      name: it.name, kind: kindLabel, url, time: it.time || '—',
      prompt: it.prompt || '', size: fmtSize(it.size), duration: Number(it.duration) || 0,
    }));
    const media = kind === 'v'
      ? `<video class="mv" preload="metadata" src="${esc(url)}" data-open data-detail="${esc(detail)}"></video>`
      : kind === 'i'
        ? `<img class="im" loading="lazy" src="${esc(url)}" alt="" data-open data-detail="${esc(detail)}">`
        : `<div class="ph">非媒体文件</div>`;
    return `<div class="as-item">
      ${media}
      <div class="as-info">
        <span class="as-name" title="${esc(it.name)}">${esc(it.name)}</span>
        <span class="as-time">🕓 ${esc(it.time || guessTime(it.name))}</span>
        <span class="as-kind ${kcls}">${kindLabel}${Number(it.duration) ? ' · ' + it.duration + 's' : ''} · ${fmtSize(it.size)}</span>
        ${it.prompt ? `<span class="as-prompt" title="${esc(it.prompt)}">提示词：${esc(it.prompt)}</span>` : ''}
      </div>
      <div class="as-ops">
        <a href="${esc(url)}" target="_blank" rel="noopener">新窗口打开</a>
        <button class="btn sm danger" data-del="${esc(it.name)}">删除</button>
      </div>
    </div>`;
  }

  function legacyCard(u, a) {
    const url = a.url;
    const kind = kindOf(a.name);
    const detail = encodeURIComponent(JSON.stringify({
      name: a.name, kind: kind === 'v' ? '视频' : '图片', url, time: guessTime(a.name),
      prompt: '', size: fmtSize(a.size), duration: 0,
    }));
    const media = kind === 'v'
      ? `<video class="mv" preload="metadata" src="${esc(url)}" data-open data-detail="${esc(detail)}"></video>`
      : kind === 'i'
        ? `<img class="im" loading="lazy" src="${esc(url)}" alt="" data-open data-detail="${esc(detail)}">`
        : `<div class="ph">非媒体文件</div>`;
    return `<div class="as-item">
      ${media}
      <div class="as-info">
        <span class="as-name" title="${esc(a.name)}">${esc(a.name)}</span>
        <span class="as-time">🕓 ${esc(guessTime(a.name))}</span>
        <span class="as-kind o">历史文件 · ${fmtSize(a.size)}</span>
      </div>
      <div class="as-ops">
        <button class="btn sm" data-detail="${esc(detail)}">详情</button>
        <button class="btn sm danger" data-del="${esc(a.name)}">删除</button>
      </div>
    </div>`;
  }

  /* ---------- 详情弹窗：大图 / 可播放暂停的视频 + 时间/提示词 ---------- */
  function openDetail(d) {
    $('#det-media').innerHTML = d.kind === '视频'
      ? `<video controls autoplay src="${esc(d.url)}"></video>`
      : `<img src="${esc(d.url)}" alt="">`;
    $('#det-meta').innerHTML = `
      <div class="det-row"><span class="k">类型</span><span class="v">${esc(d.kind)}${d.duration ? '（时长 ' + d.duration + ' 秒）' : ''}</span></div>
      <div class="det-row"><span class="k">生成时间</span><span class="v">${esc(d.time || '—')}</span></div>
      <div class="det-row"><span class="k">提示词</span><span class="v${d.prompt ? ' prompt' : ''}">${d.prompt ? esc(d.prompt) : '（无记录）'}</span></div>
      <div class="det-row"><span class="k">大小</span><span class="v">${esc(d.size)}</span></div>
      <div class="det-row"><span class="k">文件名</span><span class="v">${esc(d.name)}</span></div>
      <div class="det-row"><span class="k">操作</span><span class="v">
        <a href="${esc(d.url)}" target="_blank" rel="noopener" style="color:var(--text2)">新窗口打开</a>
        <button class="btn sm" id="det-del" style="margin-left:12px">删除此文件</button>
      </span></div>`;
    $('#det-del').onclick = async () => {
      if (!confirm('确定删除「' + d.name + '」？删除后无法恢复。')) return;
      try {
        await delAsset($('#as-user').value, d.name);
        closeDetail();
        await loadWorks();
      } catch (err) { alert('删除失败：' + err.message); }
    };
    modal.hidden = false;
  }
  function closeDetail() {
    modal.hidden = true;
    $('#det-media').innerHTML = '';
    $('#det-meta').innerHTML = '';
  }
  $('#det-close').onclick = closeDetail;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeDetail(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeDetail(); });

  /* 删除资产：有生成记录的同步移除记录；否则只删文件 */
  async function delAsset(u, name) {
    const gl = await A.adminGenlog(u);
    const recorded = (gl.items || []).some((i) => i.name === name);
    if (recorded) await A.adminDeleteAsset(u, name);
    else await G.delFile('assets/' + u + '/' + name);
  }

  /* 列表点击：缩略图 → 详情弹窗；删除按钮 → 直接删 */
  $('#as-list').addEventListener('click', async (e) => {
    const d = e.target.closest('.as-item');
    if (!d) return;
    const media = e.target.closest('[data-open]');
    if (media) {
      let detail = null;
      try { detail = JSON.parse(decodeURIComponent(media.dataset.detail || '')); } catch (err) {}
      if (!detail) {
        const src = String(media.getAttribute('src') || '');
        detail = {
          name: decodeURIComponent(src.split('/').pop() || ''),
          kind: media.tagName === 'VIDEO' ? '视频' : '图片',
          url: src, time: guessTime(src.split('/').pop()),
          prompt: '', size: '—', duration: 0,
        };
      }
      openDetail(detail);
      return;
    }
    const del = e.target.closest('button[data-del]');
    if (del) {
      const u = $('#as-user').value;
      const name = del.dataset.del;
      if (!u || !name) return;
      if (!confirm('确定删除「' + u + '」的资产「' + name + '」？删除后无法恢复。')) return;
      del.disabled = true;
      try {
        await delAsset(u, name);
        await loadWorks();
      } catch (err) {
        alert('删除失败：' + err.message);
        del.disabled = false;
      }
      return;
    }
    const dt = e.target.closest('button[data-detail]');
    if (dt) { openDetail(JSON.parse(decodeURIComponent(dt.dataset.detail))); }
  });

  /* ---------- 管理员登录 ---------- */
  $('#ad-login-btn').addEventListener('click', async () => {
    const msg = $('#ad-msg');
    msg.textContent = '';
    const btn = $('#ad-login-btn');
    btn.disabled = true;
    try {
      await A.login($('#ad-user').value, $('#ad-pass').value);
      const admin = await A.isAdmin();
      if (!admin) {
        A.logout();
        throw new Error('该账号不是管理员，已退出');
      }
      loginPanel.hidden = true;
      panel.hidden = false;
      await refresh();
    } catch (err) {
      msg.textContent = err.message;
    }
    btn.disabled = false;
  });

  /* ---------- 预置账号 ---------- */
  $('#nu-btn').addEventListener('click', async () => {
    const u = $('#nu-user').value.trim();
    const p = $('#nu-pass').value;
    if (!u || !p) { alert('请填写用户名和初始密码'); return; }
    $('#nu-btn').disabled = true;
    try {
      await A.adminCreate(u, p);
      $('#nu-user').value = '';
      $('#nu-pass').value = '';
      await refresh();
    } catch (err) {
      alert('创建失败：' + err.message);
    }
    $('#nu-btn').disabled = false;
  });

  /* ---------- 退出 ---------- */
  $('#ad-logout').addEventListener('click', () => {
    A.logout();
    loginPanel.hidden = false;
    panel.hidden = true;
  });

  /* ---------- 资产区下拉切换 / 刷新 ---------- */
  $('#as-user').addEventListener('change', loadWorks);
  $('#as-refresh').addEventListener('click', loadWorks);

  /* ---------- 启动：已登录管理员直接进面板，否则显示登录 ---------- */
  (async () => {
    try {
      if (A.currentName() && await A.isAdmin()) {
        loginPanel.hidden = true;
        panel.hidden = false;
        await refresh();
        return;
      }
    } catch (e) {}
    loginPanel.hidden = false;
  })();
})();