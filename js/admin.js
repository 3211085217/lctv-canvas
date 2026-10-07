/* =====================================================
 * admin.js — 后台管理页逻辑（admin.html 使用）
 * 管理能力：用户列表（含明文密码/使用次数）、预置账号、禁用/启用、重置密码。
 * 单用户详情（生成记录/提示词/作品规整）在新标签页 user.html 中查看。
 * 说明：与主站同为「轻量账号」安全级别（共享令牌在前端），
 *       管理权限 = 管理员账号密码，防同学不防盗。
 * ===================================================== */
(function () {
  const A = LC.Auth;
  const $ = (s) => document.querySelector(s);

  /* 版本自检：老标签页检测到远端更新后自动刷新（避免旧代码页面残留）。
   常量必须与 version.json 的 v 保持一致（20）；sessionStorage 护栏保证一个会话最多自动刷新一次，
   杜绝「旧版本号常数 + 新远端版本」造成的死循环刷新。 */
  (function verCheck() {
    try {
      if (sessionStorage.getItem('lc_ver_reloaded')) return;
      fetch('version.json?t=' + Date.now())
        .then((r) => r.json())
        .then((j) => {
          if (j && typeof j.v === 'number' && j.v > 22) {
            sessionStorage.setItem('lc_ver_reloaded', '1');
            setTimeout(() => { try { location.reload(); } catch (e) {} }, 800);
          }
        })
        .catch(() => {});
    } catch (e) {}
  })();

  const loginPanel = $('#login-panel');
  const panel = $('#admin-panel');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let _users = [];   // 最近一次用户列表快照
let _credits = null;   // {账号:积分} 快照（来自后端 /api/credit/admin/list；null=未取到）

/* 积分管理密码：优先取输入框，其次读 sessionStorage 缓存 */
function creditPwd() {
  const el = $('#credit-pwd');
  if (el && el.value.trim()) {
    const p = el.value.trim();
    try { sessionStorage.setItem('lc_credit_pwd', p); } catch (e) {}
    return p;
  }
  try { return sessionStorage.getItem('lc_credit_pwd') || ''; } catch (e) { return ''; }
}

/* 从后端拉取所有账号积分（需积分管理密码） */
async function fetchCredits() {
  const pwd = creditPwd();
  if (!pwd) { _credits = null; return; }
  try {
    const r = await fetch('/api/credit/admin/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    const j = await r.json().catch(() => null);
    if (j && Array.isArray(j.accounts)) {
      const map = {};
      j.accounts.forEach((a) => { map[a.account] = a.credits; });
      _credits = map;
    } else {
      _credits = null;
    }
  } catch (e) { _credits = null; }
}

async function adjustCredit(u, delta) {
  const pwd = creditPwd();
  if (!pwd) throw new Error('请先在「积分管理」里填写积分管理密码');
  const r = await fetch('/api/credit/admin/adjust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd, account: u, delta: delta }),
  });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error('服务器无响应（积分接口需与后端同域部署）');
  if (j.error) throw new Error(j.error);
  return j;
}

  /* ---------- 用户表格 + 统计 ---------- */
  async function refresh() {
    const me = A.currentName();
    $('#ad-who').textContent = '👤 ' + me;
    const users = await A.adminList();
    _users = users;
    await fetchCredits();
    // 并行拉取每个用户的统计与画布数（用户多时避免串行慢）
    const rowsData = await Promise.all(users.map(async (u) => ({
      u,
      st: await A.adminStats(u.u).catch(() => null) || {},
      n: await A.canvasCount(u.u).catch(() => 0),
    })));
    let totalCanvas = 0, totalGen = 0, disabled = 0;
    const rows = rowsData.map(({ u, st, n }) => {
      const imgs = Number(st.images) || 0;
      const vids = Number(st.videos) || 0;
      const logins = Number(st.logins) || 0;
      totalCanvas += n;
      totalGen += imgs + vids;
      if (u.disabled) disabled++;
      const cred = _credits ? (_credits[u.u] != null ? _credits[u.u] : 0) : null;
      return `<tr>
        <td>
          <a class="ulink" href="user.html?u=${encodeURIComponent(u.u)}" target="_blank" rel="noopener" title="在新标签页查看该用户详情">${esc(u.u)}</a>
          ${u.role === 'admin' ? '<span class="tag">管理员</span>' : ''}
        </td>
        <td>${u.pw ? '<span class="pw" title="' + esc(u.pw) + '">' + esc(u.pw) + '</span>' : '<span style="color:var(--text3)">—</span>'}</td>
        <td class="${u.disabled ? 'off' : ''}">${u.disabled ? '已禁用' : '正常'}</td>
        <td class="num">${logins}</td>
        <td class="num">${imgs}</td>
        <td class="num">${vids}</td>
        <td class="num">${n}</td>
        <td class="num">${cred == null ? '<span style="color:var(--text3)">—</span>' : cred}</td>
        <td class="ops">
          <button class="btn sm" data-op="toggle" data-u="${esc(u.u)}">${u.disabled ? '启用' : '禁用'}</button>
          <button class="btn sm" data-op="pwd" data-u="${esc(u.u)}">重置密码</button>
          <button class="btn sm" data-op="credit" data-u="${esc(u.u)}">加积分</button>
          ${u.role !== 'admin' ? `<button class="btn sm danger" data-op="deluser" data-u="${esc(u.u)}">删除用户</button>` : ''}
        </td></tr>`;
    });
    $('#user-tbody').innerHTML = rows.join('');
    $('#st-users').textContent = users.length;
    $('#st-canvases').textContent = totalCanvas;
    $('#st-gens').textContent = totalGen;
    $('#st-disabled').textContent = disabled;
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
      } else if (b.dataset.op === 'credit') {
        const amt = prompt('为「' + u + '」调整多少积分？（填正数=加，负数=减）');
        if (amt == null) return;
        const num = Number(String(amt).trim());
        if (!isFinite(num) || num === 0) { alert('请输入有效的非零数字'); return; }
        busy('调整中…');
        const j = await adjustCredit(u, num);
        alert(`已调整「${u}」积分：本次 ${j.delta >= 0 ? '+' : ''}${j.delta}，当前余额 ${j.credits}`);
      } else if (b.dataset.op === 'deluser') {
        if (!confirm('确定永久删除用户「' + u + '」？\n将同时删除 TA 的全部画布、图片、视频、使用统计和生成记录，且无法恢复。')) return;
        const typed = prompt('此操作不可恢复。请再次输入「' + u + '」确认删除：');
        if (typed !== u) { alert('输入不一致，已取消删除'); return; }
        busy('删除中…');
        await A.adminDeleteUser(u);
        alert('已彻底删除用户「' + u + '」（画布/资产/记录零残留）');
      }
      await refresh();
    } catch (err) {
      alert('操作失败：' + err.message);
      try { await refresh(); } catch (e) {}
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

  /* ---------- 积分管理：加载余额 ---------- */
  $('#credit-refresh').addEventListener('click', async () => {
    $('#credit-refresh').disabled = true;
    try {
      await refresh();
    } catch (err) {
      alert('加载失败：' + err.message);
    }
    $('#credit-refresh').disabled = false;
  });

  /* ---------- 退出 ---------- */
  $('#ad-logout').addEventListener('click', () => {
    A.logout();
    loginPanel.hidden = false;
    panel.hidden = true;
  });

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