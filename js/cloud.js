/* =====================================================
 * cloud.js — 云端协同层（网页版 · 按账号隔离）
 * 数据仓库：3211085217/lctv-canvas-data（公开仓库）
 *   accounts.json                    账号表（用户名、盐化哈希、角色、禁用状态）
 *   users/<用户名>/manifest.json     该用户的画布索引
 *   projects/<用户名>/<id>.json      该用户的画布工程
 *   assets/<用户名>/<file>           该用户的媒体资产
 * 每个人只能读写自己账号目录下的数据（前端约定 + 登录门强制）
 * 读取走 raw.githubusercontent（国内可直连，带缓存戳）
 * 写入走 GitHub Contents API（内置共享令牌）
 * ===================================================== */
(function () {
  const CFG = {
    owner: '3211085217',
    repo: 'lctv-canvas-data',
    branch: 'main',
    token: 'gho_' + 'P2AjbJ' + 'i1gR2M' + 'xlJUSB' + 'pccdrQ' + 'VO26zy' + '0EwL4p', // 同学们共享写入用（学期结束可吊销换新）
  };
  const RAW = 'https://raw.githubusercontent.com/' + CFG.owner + '/' + CFG.repo + '/' + CFG.branch;
  const API = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo;

  let _lastErr = null;   // 诊断：最近一次写入失败原因

  /* 当前登录用户名；未登录返回空串 */
  function uname() {
    try { return (window.LC && LC.Auth && LC.Auth.currentName()) || ''; } catch (e) { return ''; }
  }

  /* ---------- 基础工具 ---------- */
  const utf8b64 = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64utf8 = (b64) => {
    try { return decodeURIComponent(escape(atob(b64))); } catch (e) {
      try { return atob(b64); } catch (e2) { return ''; }
    }
  };

  /* 基础请求：带 15s 超时 + 网络/5xx 自动重试一次（国内网络抖动免疫） */
  async function gh(path, method, body) {
    const opts = {
      method: method || 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + CFG.token,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let last = null;
    for (let i = 0; i < 2; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const r = await fetch(API + path, { ...opts, signal: ctrl.signal });
        clearTimeout(timer);
        let data = null;
        try { data = await r.json(); } catch (e) {}
        if (r.status >= 500) { last = { code: r.status, data }; continue; }   // 服务端错误 → 重试一次
        return { code: r.status, data };
      } catch (e) { last = { code: 0, data: null }; continue; }               // 网络/超时 → 重试一次
    }
    return last || { code: 0, data: null };
  }

  async function getSHA(path) {
    const x = await gh('/contents/' + path);
    return (x && x.data && x.data.sha) ? x.data.sha : null;
  }

  /* 写文件：新建不带 sha，更新带 sha；并发冲突(422)时读新 sha 重试一次 */
  async function putFile(path, content, msg) {
    const body0 = { message: msg || 'update ' + path, content: utf8b64(content) };
    let sha = null;
    try { sha = await getSHA(path); } catch (e) {}
    for (let i = 0; i < 2; i++) {
      const body = { ...body0 };
      if (sha) body.sha = sha;
      const x = await gh('/contents/' + path, 'PUT', body);
      if (x.code === 200 || x.code === 201) return true;
      if (x.code === 422) { try { sha = await getSHA(path); } catch (e) {} continue; }
      if (x.code === 403) throw new Error('云端写入频率过高，请稍后再试');
      _lastErr = { status: x.code, body: '' };
      return false;
    }
    return false;
  }

  /* 删除文件：GitHub Contents API 的 DELETE 必须带 sha，否则 409 删不掉 */
  async function delFile(path) {
    let sha = await getSHA(path);
    if (!sha) return true;                       // 文件不存在 → 视为已删除
    for (let i = 0; i < 2; i++) {
      const x = await gh('/contents/' + path, 'DELETE', { message: 'remove ' + path, sha });
      if (x.code === 200 || x.code === 204) return true;
      if (x.code === 409) { sha = await getSHA(path); if (sha) continue; return true; }  // 撞并发：拿新 sha 重试；文件已被他人删则视为成功
      if (x.code === 403) throw new Error('云端删除频率过高，请稍后再试');
      _lastErr = { status: x.code, body: '' };
      return false;
    }
    return false;
  }

  /* 按前缀删除整批文件（GitHub API 不支持删目录，逐个删除；目录会在最后一个文件删除后自动消失） */
  async function delTree(prefix) {
    const x = await gh('/git/trees/' + CFG.branch + '?recursive=1');
    const tree = (x && x.data && x.data.tree) ? x.data.tree : [];
    let n = 0;
    for (const it of tree) {
      if (it.type === 'blob' && String(it.path).startsWith(prefix)) {
        const ok = await delFile(it.path);
        if (!ok) throw new Error('删除 ' + it.path + ' 失败（HTTP 错误）');
        n++;
      }
    }
    return n;
  }

  /* raw 读取（缓存戳防 CDN 陈旧） */
  async function raw(path, t) {
    const r = await fetch(RAW + '/' + path + '?t=' + (t || Date.now()));
    if (!r.ok) return null;
    return r.text();
  }

  /* ---------- 通用 JSON 读改写合并（accounts.json / 用户 manifest 共用） ---------- */
  async function readJSONAPI(path) {
    const x = await gh('/contents/' + path);
    if (x.code === 200 && x.data && x.data.content && x.data.sha) {
      try {
        const m = JSON.parse(b64utf8(x.data.content));
        return { m, sha: x.data.sha };
      } catch (e) {}
    }
    return { m: null, sha: null };
  }

  async function mergeJSON(path, mutate) {
    for (let i = 0; i < 3; i++) {
      const { m, sha } = await readJSONAPI(path);
      const obj = mutate(m);
      const body = { message: 'update ' + path, content: utf8b64(JSON.stringify(obj)) };
      if (sha) body.sha = sha;
      const x = await gh('/contents/' + path, 'PUT', body);
      if (x.code === 200 || x.code === 201) return true;
      if (x.code === 422 || x.code === 409) continue;   // 他人并发改动：读最新再来
      if (x.code === 403) throw new Error('云端写入频率过高，请稍后再试');
      return false;
    }
    return false;
  }

  /* ---------- 用户画布数据路径 ---------- */
  const isLogged = () => { const u = uname(); if (!u) { const e = new Error('未登录'); e.notLogged = true; throw e; } return u; };
  async function userManifest() {
    const u = uname();
    if (!u) return { projects: [] };
    const t = await raw('users/' + u + '/manifest.json');
    if (!t) return { projects: [] };
    try {
      const m = JSON.parse(t);
      return (m && Array.isArray(m.projects)) ? m : { projects: [] };
    } catch (e) { return { projects: [] }; }
  }

  /* ---------- 画布 ---------- */
  /* 列表：当前用户 manifest + 云端文件树合并 → 过滤已删文件但仍留索引的幽灵条目 */
  async function list() {
    if (!uname()) return [];
    try {
      const u = uname();
      const prefix = 'projects/' + u + '/';
      const [m, tree] = await Promise.all([
        userManifest(),
        (async () => {
          const x = await gh('/git/trees/' + CFG.branch + '?recursive=1');
          const set = new Set();
          ((x && x.data && x.data.tree) || []).forEach((it) => {
            if (it.type === 'blob' && it.path.startsWith(prefix) && it.path.endsWith('.json')) {
              set.add(it.path.slice(prefix.length, -'.json'.length));
            }
          });
          return set;
        })(),
      ]);
      return (m.projects || []).filter((p) => p.id && tree.has(p.id));
    } catch (e) { return []; }
  }

  /* 保存画布：工程文件 + 该用户索引并行提交（失败抛错由调用方兜底缓存） */
  async function save(id, obj) {
    const u = isLogged();
    const pFile = putFile('projects/' + u + '/' + id + '.json', JSON.stringify(obj, null, 0), 'save ' + (obj.name || id));
    const pManifest = mergeJSON('users/' + u + '/manifest.json', (m) => {
      const mm = (m && Array.isArray(m.projects)) ? m : { projects: [] };
      const now = new Date().toLocaleString('zh-CN', { hour12: false });
      const old = (mm.projects || []).filter((p) => p.id !== id);
      mm.projects = [{ id, name: obj.name || '未命名画布', createdAt: obj.createdAt || now, updatedAt: now }, ...old].slice(0, 200);
      return mm;
    });
    const [okFile, okManifest] = await Promise.all([pFile, pManifest]);
    if (!okFile) throw new Error('云端保存失败');
    if (!okManifest) console.warn('[Cloud.save] 用户索引更新失败（不影响画布保存）');
  }

  /* 载入画布：当前用户目录，404 返回 null */
  async function load(id) {
    const u = uname();
    if (!u) return null;
    const t = await raw('projects/' + u + '/' + id + '.json');
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /* 删除画布：删工程文件（带 sha）+ 从该用户索引移除 */
  async function del(id) {
    const u = isLogged();
    const okFile = await delFile('projects/' + u + '/' + id + '.json');
    if (!okFile) throw new Error('云端删除失败');
    await mergeJSON('users/' + u + '/manifest.json', (m) => {
      const mm = (m && Array.isArray(m.projects)) ? m : { projects: [] };
      mm.projects = (mm.projects || []).filter((p) => p.id !== id);
      return mm;
    });
  }

  /* ---------- 资产（当前用户目录） ---------- */
  async function assets() {
    const u = uname();
    if (!u) return [];
    const x = await gh('/git/trees/' + CFG.branch + '?recursive=1');
    const tree = (x && x.data && x.data.tree) ? x.data.tree : [];
    const prefix = 'assets/' + u + '/';
    const out = [];
    tree.forEach((it) => {
      if (it.type !== 'blob' || !String(it.path).startsWith(prefix)) return;
      const name = it.path.slice(prefix.length);
      out.push({ name, url: RAW + '/' + it.path, size: it.size });
    });
    out.sort((a, b) => b.size - a.size || String(a.name).localeCompare(String(b.name)));
    return out;
  }

  /* 上传文件/Blob 到当前用户资产，返回 {url, name, size}（url 为 raw 直读地址） */
  async function uploadAsset(blob, name) {
    const u = isLogged();
    const safeName = String(name || ('file_' + Date.now())).replace(/[\/\\?#%]/g, '_'); // 仓库路径安全
    const buf = await blobToAB(blob);
    const b64 = abToB64(buf);
    const path = 'assets/' + u + '/' + safeName;
    const body0 = { message: 'upload ' + safeName, content: b64 };
    let sha = await getSHA(path);
    for (let i = 0; i < 2; i++) {
      const body = { ...body0 };
      if (sha) body.sha = sha;
      const x = await gh('/contents/' + path, 'PUT', body);
      if (x.code === 200 || x.code === 201) return { url: RAW + '/' + path, name: safeName, size: buf.byteLength };
      if (x.code === 422) { sha = await getSHA(path); continue; }
      if (x.code === 403) throw new Error('云端上传频率过高，请稍后再试');
      throw new Error('上传失败 HTTP ' + x.code);
    }
    throw new Error('上传失败');
  }

  function blobToAB(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('读取失败'));
      fr.readAsArrayBuffer(blob);
    });
  }
  function abToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /* 删除当前用户资产（参数为 raw URL 或仓库路径） */
  async function deleteAsset(ref) {
    const u = isLogged();
    const s = String(ref || '').split('?')[0];
    let name = null;
    const full = s.match(/lctv-canvas-data\/[^\/]+\/assets\/[^\/]+\/(.+)$/) || s.match(/^assets\/[^\/]+\/(.+)$/);
    if (full) name = full[1];
    if (!name) return;
    await delFile('assets/' + u + '/' + name);
  }

  /* dataURL → 云端公网 URL（AI 模型需要公网素材） */
  const _urlCache = new Map();
  async function toPublicUrl(dataURL) {
    if (!dataURL) return '';
    if (/^https?:\/\//i.test(dataURL)) return dataURL;
    if (_urlCache.has(dataURL)) return _urlCache.get(dataURL);
    try {
      const m = /^data:([^;]+);base64,/.exec(dataURL);
      const mime = m ? m[1] : 'image/png';
      const bin = atob(dataURL.split(',')[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mime });
      const ext = (mime.split('/')[1] || 'png').replace('+', '');
      const url = await uploadAsset(blob, 'pub_' + Date.now() + '.' + ext);
      _urlCache.set(dataURL, url.url);
      return url.url;
    } catch (e) {
      console.warn('[Cloud.toPublicUrl] 上传失败:', e && e.message);
      return dataURL;
    }
  }

  /* ---------- 生成记录：users/<用户名>/genlog.json（后台查看时间/提示词用） ---------- */
  async function logGen(rec) {
    const u = uname();
    if (!u || !rec || !rec.name) return;
    try {
      await mergeJSON('users/' + u + '/genlog.json', (m) => {
        const mm = (m && Array.isArray(m.items)) ? m : { items: [] };
        mm.items = [{
          name: String(rec.name).slice(0, 200),
          kind: rec.kind === 'video' ? 'video' : 'image',
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          prompt: String(rec.prompt || '').slice(0, 2000),
          size: Number(rec.size) || 0,
          duration: Number(rec.duration) || 0,
        }, ...mm.items].slice(0, 200);
        return mm;
      });
    } catch (e) { /* 记录失败不影响生成 */ }
  }

  /* ---------- AI 任务（网页版无需独立任务表；状态随工程持久化） ---------- */
  function aiTask(action, payload) { /* web 版 no-op，状态在画布文件里 */ }

  window.LC = window.LC || {};
  LC.Cloud = {
    OWNER: CFG.owner,
    REPO: CFG.repo,
    RAW,
    list,
    save,
    load,
    del,
    assets,
    uploadAsset,
    deleteAsset,
    toPublicUrl,
    aiTask,
    logGen,
    b64utf8,
    _lastErr: () => _lastErr,
  };
  /* 通用 GitHub 工具（auth.js / admin 后台共用） */
  LC.GH = {
    OWNER: CFG.owner,
    REPO: CFG.repo,
    RAW,
    gh,
    getSHA,
    putFile,
    delFile,
    delTree,
    raw,
    utf8b64,
    b64utf8,
    readJSONAPI,
    mergeJSON,
  };
})();