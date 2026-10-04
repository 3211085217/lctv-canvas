/* =====================================================
 * admin.js — 后台管理页逻辑（admin.html 使用）
 * 管理员登录（管理员账号）后可：查看用户列表/统计、预置账号、
 * 禁用/启用账号、重置密码。
 * 说明：与主站同为「轻量账号」安全级别（共享令牌在前端），
 *       管理权限 = 管理员账号密码，防同学不防盗。
 * ===================================================== */
(function () {
  const A = LC.Auth;
  const $ = (s) => document.querySelector(s);

  const loginPanel = $('#login-panel');
  const panel = $('#admin-panel');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function refresh() {
    const me = A.currentName();
    $('#ad-who').textContent = '👤 ' + me;
    const users = await A.adminList();
    let total = 0, disabled = 0;
    const rows = [];
    for (const u of users) {
      const n = await A.canvasCount(u.u);
      total += n;
      if (u.disabled) disabled++;
      rows.push(`<tr>
        <td>${esc(u.u)}${u.role === 'admin' ? '<span class="tag">管理员</span>' : ''}</td>
        <td class="${u.disabled ? 'off' : ''}">${u.disabled ? '已禁用' : '正常'}</td>
        <td>${esc(u.createdAt || '')}</td>
        <td>${n}</td>
        <td class="ops">
          <button class="btn sm" data-op="toggle" data-u="${esc(u.u)}">${u.disabled ? '启用' : '禁用'}</button>
          <button class="btn sm" data-op="pwd" data-u="${esc(u.u)}">重置密码</button>
        </td></tr>`);
    }
    $('#user-tbody').innerHTML = rows.join('');
    $('#st-users').textContent = users.length;
    $('#st-canvases').textContent = total;
    $('#st-disabled').textContent = disabled;
  }

  /* 表格操作：事件委托 */
  $('#user-tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-op]');
    if (!b) return;
    const u = b.dataset.u;
    const busy = (t) => { b.disabled = true; b.textContent = t; };
    try {
      if (b.dataset.op === 'toggle') {
        const users = await A.adminList();
        const acc = users.find((x) => x.u === u);
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

  /* 管理员登录 */
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

  /* 预置账号 */
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

  /* 退出 */
  $('#ad-logout').addEventListener('click', () => {
    A.logout();
    loginPanel.hidden = false;
    panel.hidden = true;
  });

  /* 启动：已登录管理员直接进面板，否则显示登录 */
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