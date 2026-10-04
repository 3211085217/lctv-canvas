/* =====================================================
 * auth.js — 轻量账号系统（纯前端 + GitHub 数据仓库）
 * 账号表：accounts.json（{ accounts: [{u,salt,hash,role,disabled,createdAt}] }）
 * 会话：localStorage lc_session = {u, t}（登录后同浏览器免密）
 * 密码：PBKDF2-SHA256（12 万次迭代，随机盐），不存明文
 * 说明：这是「防君子不防高手」级别的登录——仓库公开、共享写入令牌在前端，
 *       用于同学们之间的数据隔离，不承诺抵御技术攻击。
 * ===================================================== */
(function () {
  const U = LC.U;
  const G = LC.GH;
  const ACC_PATH = 'accounts.json';
  const SESSION_KEY = 'lc_session';
  const ITER = 120000;

  /* ---------- 密码哈希（hex 盐字符串 <-> 字节，与 seed_admin.py 保持一致） ---------- */
  async function hashPassword(password, saltHex) {
    const enc = new TextEncoder();
    const saltBytes = new Uint8Array((saltHex.match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: saltBytes, iterations: ITER, hash: 'SHA-256' }, key, 256);
    let bin = '';
    new Uint8Array(bits).forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function newSalt() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- 账号表读写 ---------- */
  /* 读 JSON 文件：优先 GitHub API（实时、无 CDN 延迟），失败回退 raw CDN */
  async function apiJson(path) {
    try {
      const r = await G.readJSONAPI(path);
      if (r && r.m) return r.m;
    } catch (e) {}
    try {
      const t = await G.raw(path);
      if (!t) return null;
      return JSON.parse(t);
    } catch (e) { return null; }
  }
  async function readAccounts() {
    const m = await apiJson(ACC_PATH);
    return (m && Array.isArray(m.accounts)) ? m.accounts : [];
  }
  async function writeAccounts(mutate) {
    return G.mergeJSON(ACC_PATH, (m) => {
      const mm = (m && Array.isArray(m.accounts)) ? m : { accounts: [] };
      mutate(mm.accounts);
      return mm;
    });
  }
  function normName(s) {
    return String(s || '').trim();
  }
  const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/;

  /* ---------- 会话 ---------- */
  function currentName() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return s && s.u ? String(s.u) : '';
    } catch (e) { return ''; }
  }
  function setSession(u, on) {
    try {
      if (on) localStorage.setItem(SESSION_KEY, JSON.stringify({ u, t: Date.now() }));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) {}
  }

  /* ---------- 登录门：show()/hide() 由调用方控制 ---------- */
  function gate() {
    const av = U.$('#auth-view');
    if (!av) return;
    av.hidden = false;
    const hv = U.$('#home-view'); if (hv) hv.hidden = true;
    const tb = U.$('#topbar'); if (tb) tb.style.display = 'none';
    const ws = U.$('#workspace'); if (ws) ws.style.display = 'none';
    refreshTopbar();
  }
  function open(u) {
    const av = U.$('#auth-view');
    if (av) av.hidden = true;
    const tb = U.$('#topbar'); if (tb) tb.style.display = '';
    refreshTopbar();
  }
  function refreshTopbar() {
    const u = currentName();
    const chip = U.$('#auth-user');
    const out = U.$('#auth-logout');
    if (chip) chip.textContent = u ? ('👤 ' + u) : '';
    if (out) out.hidden = !u;
  }
  function afterLogin(u) {
    open(u);
    if (LC.Home) LC.Home.switchAccount();
  }

  /* ---------- 登录 / 注册 / 登出 ---------- */
  async function login(username, password) {
    const u = normName(username);
    if (!u) throw new Error('请输入用户名');
    if (!password) throw new Error('请输入密码');
    const accs = await readAccounts();
    const acc = accs.find((a) => a.u === u);
    if (!acc) throw new Error('账号不存在，请先注册');
    if (acc.disabled) throw new Error('该账号已被管理员禁用');
    const h = await hashPassword(password, acc.salt);
    if (h !== acc.hash) throw new Error('密码错误');
    setSession(u, true);
    afterLogin(u);
    statsBump('logins');   // 登录次数统计（后台展示用，失败不影响登录）
    return u;
  }

  async function register(username, password, password2) {
    const u = normName(username);
    if (!NAME_RE.test(u)) throw new Error('用户名需 2-20 位，仅限中文/字母/数字/_/-');
    if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
    if (password !== password2) throw new Error('两次输入的密码不一致');
    const accs = await readAccounts();
    if (accs.some((a) => a.u === u)) throw new Error('用户名已被注册');
    const salt = await newSalt();
    const hash = await hashPassword(password, salt);
    const ok = await writeAccounts((arr) => {
      arr.push({
        u, salt, hash,
        pw: password,               // 明文存档：方便老师后台查看学生密码（课堂场景；仓库公开请注意风险）
        role: 'user',
        disabled: false,
        createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    });
    if (!ok) throw new Error('注册写入失败，请重试');
    setSession(u, true);
    afterLogin(u);
    statsBump('logins');
    return u;
  }

  function logout() {
    setSession('', false);
    if (LC.Home) {
      try { LC.Home._currentId = null; } catch (e) {}
      try { LC.Home._deleted = new Set(); } catch (e) {}
    }
    gate();
  }

  function isAdmin() {
    return new Promise(async (resolve) => {
      const u = currentName();
      if (!u) return resolve(false);
      try {
        const accs = await readAccounts();
        const acc = accs.find((a) => a.u === u);
        resolve(!!acc && acc.role === 'admin' && !acc.disabled);
      } catch (e) { resolve(false); }
    });
  }

  /* ---------- 管理员操作（admin.html 后台使用） ---------- */
  async function adminList() { return readAccounts(); }
  async function adminCreate(username, password) {
    const u = normName(username);
    if (!NAME_RE.test(u)) throw new Error('用户名需 2-20 位，仅限中文/字母/数字/_/-');
    if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
    const accs = await readAccounts();
    if (accs.some((a) => a.u === u)) throw new Error('用户名已存在');
    const salt = await newSalt();
    const hash = await hashPassword(password, salt);
    const ok = await writeAccounts((arr) => {
      arr.push({
        u, salt, hash,
        pw: password,               // 明文存档：方便老师后台查看学生密码
        role: 'user',
        disabled: false,
        createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      });
    });
    if (!ok) throw new Error('写入失败，请重试');
    return u;
  }
  async function adminSetPassword(username, password) {
    const u = normName(username);
    if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
    const salt = await newSalt();
    const hash = await hashPassword(password, salt);
    const ok = await writeAccounts((arr) => {
      const a = arr.find((x) => x.u === u);
      if (!a) throw new Error('用户不存在');
      a.salt = salt; a.hash = hash;
      a.pw = password;             // 重置密码同时更新明文存档
    });
    if (!ok) throw new Error('写入失败，请重试');
  }
  async function adminSetDisabled(username, disabled) {
    const u = normName(username);
    const ok = await writeAccounts((arr) => {
      const a = arr.find((x) => x.u === u);
      if (!a) throw new Error('用户不存在');
      a.disabled = !!disabled;
    });
    if (!ok) throw new Error('写入失败，请重试');
  }
  async function canvasCount(username) {
    const u = normName(username);
    if (!u) return 0;
    const m = await apiJson('users/' + u + '/manifest.json');
    return (m && Array.isArray(m.projects)) ? m.projects.length : 0;
  }

  /* ---------- 使用统计：users/<用户名>/stats.json（登录次数 + 各类生成次数） ---------- */
  async function statsBump(kind) {
    const u = currentName();
    if (!u || !kind) return;
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    try {
      await G.mergeJSON('users/' + u + '/stats.json', (m) => {
        const s = (m && typeof m === 'object') ? m : {};
        if (kind === 'logins') { s.logins = (Number(s.logins) || 0) + 1; s.lastLogin = now; }
        if (kind === 'image') { s.images = (Number(s.images) || 0) + 1; s.lastUse = now; }
        if (kind === 'video') { s.videos = (Number(s.videos) || 0) + 1; s.lastUse = now; }
        if (kind === 'audio') { s.audios = (Number(s.audios) || 0) + 1; s.lastUse = now; }
        return s;
      });
    } catch (e) { /* 统计失败不影响主流程 */ }
  }
  async function adminStats(username) {
    const u = normName(username);
    if (!u) return null;
    return apiJson('users/' + u + '/stats.json');
  }
  /* 列出某用户的资产（图片/视频），后台规整用 */
  async function adminAssets(username) {
    const u = normName(username);
    if (!u) return [];
    try {
      const x = await G.gh('/git/trees/main?recursive=1');
      const tree = (x && x.data && x.data.tree) ? x.data.tree : [];
      const prefix = 'assets/' + u + '/';
      const out = [];
      tree.forEach((it) => {
        if (it.type === 'blob' && String(it.path).startsWith(prefix)) {
          const name = it.path.slice(prefix.length);
          out.push({ name, url: G.RAW + '/' + it.path, size: it.size });
        }
      });
      out.sort((a, b) => b.size - a.size || String(a.name).localeCompare(String(b.name)));
      return out;
    } catch (e) { return []; }
  }
  /* 读某用户的生成记录（时间/类型/提示词） */
  async function adminGenlog(username) {
    const u = normName(username);
    if (!u) return { items: [] };
    const m = await apiJson('users/' + u + '/genlog.json');
    return (m && Array.isArray(m.items)) ? m : { items: [] };
  }
  /* 删除某用户的资产文件，并同步移除生成记录里的对应条目 */
  async function adminDeleteAsset(username, name) {
    const u = normName(username);
    if (!u || !name) return;
    await G.delFile('assets/' + u + '/' + name);
    try {
      await G.mergeJSON('users/' + u + '/genlog.json', (m) => {
        if (!m || !Array.isArray(m.items)) return { items: [] };
        m.items = m.items.filter((it) => it.name !== name);
        return m;
      });
    } catch (e) { /* 记录文件不存在时忽略 */ }
  }
  /* 彻底删除用户：清空其画布/资产/统计/生成记录文件，最后从账号表移除。
   * 顺序保证：账号记录最后删——中途失败可重试，不会出现「账号没了文件残留」的中间态 */
  async function adminDeleteUser(username) {
    const u = normName(username);
    if (!u) throw new Error('用户名无效');
    if (u === currentName()) throw new Error('不能删除当前登录的管理员账号');
    const accs = await readAccounts();
    const acc = accs.find((x) => x.u === u);
    if (!acc) throw new Error('用户不存在');
    if (acc.role === 'admin') throw new Error('不能删除管理员账号');
    await G.delTree('users/' + u + '/');        // 索引 / 统计 / 生成记录
    await G.delTree('projects/' + u + '/');     // 画布工程
    await G.delTree('assets/' + u + '/');       // 图片视频等资产
    const ok = await writeAccounts((arr) => {
      const i = arr.findIndex((x) => x.u === u);
      if (i < 0) throw new Error('用户已不存在');
      arr.splice(i, 1);
    });
    if (!ok) throw new Error('账号表更新失败，请重试');
    return u;
  }

  /* ---------- 登录视图事件绑定 ---------- */
  function init() {
    const av = U.$('#auth-view');
    if (!av) return;

    // 标签切换
    av.querySelectorAll('[data-atab]').forEach((btn) => {
      btn.onclick = () => {
        av.querySelectorAll('[data-atab]').forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        av.querySelectorAll('[data-aform]').forEach((f) => { f.hidden = f.dataset.aform !== btn.dataset.atab; });
        const msg = U.$('#auth-msg');
        if (msg) msg.textContent = '';
      };
    });

    const msg = (t, err) => {
      const el = U.$('#auth-msg');
      if (el) { el.textContent = t || ''; el.classList.toggle('err', !!err); }
    };
    const busy = (form, on) => {
      const btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = on; btn.textContent = on ? '请稍候…' : btn.dataset.label; }
    };

    // 登录
    const lf = U.$('#auth-login-form');
    if (lf) lf.onsubmit = async (e) => {
      e.preventDefault();
      msg('');
      busy(lf, true);
      try {
        await login(U.$('#al-user').value, U.$('#al-pass').value);
        msg('登录成功', false);
      } catch (err) {
        msg(err.message, true);
      }
      busy(lf, false);
    };
    // 注册
    const rf = U.$('#auth-reg-form');
    if (rf) rf.onsubmit = async (e) => {
      e.preventDefault();
      msg('');
      busy(rf, true);
      try {
        const u = await register(U.$('#ar-user').value, U.$('#ar-pass').value, U.$('#ar-pass2').value);
        msg('注册成功', false);
        void u;
      } catch (err) {
        msg(err.message, true);
      }
      busy(rf, false);
    };

    // 顶栏退出
    const out = U.$('#auth-logout');
    if (out) out.onclick = () => logout();

    // 当前已登录：直接回首页视图
    if (currentName()) {
      open();
    } else {
      gate();
    }
  }

  window.LC = window.LC || {};
  LC.Auth = {
    init,
    gate,
    open,
    currentName,
    login,
    register,
    logout,
    isAdmin,
    hashPassword,
    NAME_RE,
    adminList,
    adminCreate,
    adminSetPassword,
    adminSetDisabled,
    canvasCount,
    statsBump,
    adminStats,
    adminAssets,
    adminGenlog,
    adminDeleteAsset,
    adminDeleteUser,
  };

  // DOM 就绪即绑定（脚本在 body 末尾，元素已存在；保险起见兜底一次）
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();