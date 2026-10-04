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

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
  const kindOf = (name) => /\.(mp4|webm|mov|m4v)$/i.test(name) ? 'v' : (/\.(jpe?g|png|webp|gif|bmp)$/i.test(name) ? 'i' : 'o');

  let _users = [];   // 最近一次用户列表快照（资产区下拉用）

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
    if (sel.value && !$('#as-grid').dataset.loaded) loadAssets();
    if (!sel.value) loadAssets();
  }

  /* ---------- 表格操作：事件委托 ---------- */
  $('#user-tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    const u = b.dataset.u;
    const busy = (t) => { b.disabled = true; b.textContent = t; };
    try {
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
  async function loadAssets() {
    const grid = $('#as-grid');
    grid.dataset.loaded = '1';
    const u = $('#as-user').value;
    grid.innerHTML = '<div class="as-empty">加载中…</div>';
    if (!u) { grid.innerHTML = '<div class="as-empty">还没有任何用户</div>'; return; }
    const items = await A.adminAssets(u);
    if (!items.length) {
      grid.innerHTML = '<div class="as-empty">「' + esc(u) + '」还没有上传/生成任何图片视频</div>';
      return;
    }
    grid.innerHTML = items.map((it) => {
      const kind = kindOf(it.name);
      const kindLabel = { v: '视频', i: '图片', o: '文件' }[kind];
      const kcls = { v: 'v', i: 'i', o: 'o' }[kind];
      const media = kind === 'v'
        ? `<video controls preload="metadata" src="${esc(it.url)}"></video>`
        : kind === 'i'
          ? `<img loading="lazy" src="${esc(it.url)}" alt="">`
          : `<div class="ph">非媒体文件</div>`;
      return `<div class="as-item">
        ${media}
        <div class="as-info">
          <span class="as-name" title="${esc(it.name)}">${esc(it.name)}</span>
          <span class="as-kind ${kcls}">${kindLabel} · ${fmtSize(it.size)}</span>
        </div>
        <div class="as-ops">
          <a href="${esc(it.url)}" target="_blank" rel="noopener">新窗口打开</a>
          <button class="btn sm danger" data-del="${esc(it.name)}">删除</button>
        </div>
      </div>`;
    }).join('');
  }

  /* 资产删除：事件委托 */
  $('#as-grid').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-del]');
    if (!b) return;
    const u = $('#as-user').value;
    const name = b.dataset.del;
    if (!u || !name) return;
    if (!confirm('确定删除「' + u + '」的资产「' + name + '」？删除后无法恢复。')) return;
    b.disabled = true;
    try {
      const ok = await G.delFile('assets/' + u + '/' + name);
      if (!ok) throw new Error('云端删除失败');
      await loadAssets();
    } catch (err) {
      alert('删除失败：' + err.message);
      b.disabled = false;
    }
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
  $('#as-user').addEventListener('change', loadAssets);
  $('#as-refresh').addEventListener('click', loadAssets);

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