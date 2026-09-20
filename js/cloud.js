/* =====================================================
 * cloud.js — 云端协同层（网页版）
 * 数据仓库：3211085217/lctv-canvas-data（公开仓库，共享数据池）
 *   projects/<id>.json   画布工程文件
 *   manifest.json        画布索引（权威列表，保存时更新）
 *   assets/<file>        媒体资产（图片/视频/音频）
 * 读取走 raw.githubusercontent（国内可直连，带缓存戳）
 * 写入走 GitHub Contents API（内置令牌）
 * ===================================================== */
(function () {
  const CFG = {
    owner: '3211085217',
    repo: 'lctv-canvas-data',
    branch: 'main',
    token: 'gho_P2AjV3TixOIBbjQc4X0TzMYOko0GoLM3Y', // 同学们共享写入用（学期结束可吊销换新）
  };
  const RAW = 'https://raw.githubusercontent.com/' + CFG.owner + '/' + CFG.repo + '/' + CFG.branch;
  const API = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo;

  /* ---------- 基础工具 ---------- */
  const utf8b64 = (str) => btoa(unescape(encodeURIComponent(str)));
  const b64utf8 = (b64) => {
    try { return decodeURIComponent(escape(atob(b64))); } catch (e) {
      try { return atob(b64); } catch (e2) { return ''; }
    }
  };

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
    const r = await fetch(API + path, opts);
    let data = null;
    try { data = await r.json(); } catch (e) {}
    return { code: r.status, data };
  }

  async function getSHA(path) {
    const x = await gh('/contents/' + path);
    return (x && x.data && x.data.sha) ? x.data.sha : null;
  }

  /* 写文件：带 sha 更新，并发冲突(422)时拿新 sha 重试一次 */
  async function putFile(path, content, msg) {
    const body0 = { message: msg || 'update ' + path, content: utf8b64(content) };
    let sha = await getSHA(path);
    for (let i = 0; i < 2; i++) {
      const body = { ...body0 };
      if (sha) body.sha = sha;
      const r = await fetch(API + '/contents/' + path, {
        method: 'PUT',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + CFG.token, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify(body),
      });
      if (r.ok) return true;
      if (r.status === 422) { sha = await getSHA(path); continue; }
      if (r.status === 403) throw new Error('云端写入频率过高，请稍后再试');
      return false;
    }
    return false;
  }

  function delFile(path) {
    return gh('/contents/' + path, 'DELETE', { message: 'remove ' + path });
  }

  /* raw 读取（缓存戳防 CDN 陈旧） */
  async function raw(path, t) {
    const r = await fetch(RAW + '/' + path + '?t=' + (t || Date.now()));
    if (!r.ok) return null;
    return r.text();
  }

  /* ---------- 画布 ---------- */
  async function readManifest() {
    const t = await raw('manifest.json');
    if (!t) return { projects: [] };
    try {
      const m = JSON.parse(t);
      return (m && Array.isArray(m.projects)) ? m : { projects: [] };
    } catch (e) { return { projects: [] }; }
  }

  async function writeManifest(m) {
    await putFile('manifest.json', JSON.stringify(m), 'update manifest');
  }

  /* 列表：manifest 权威 + 容错回退 */
  async function list() {
    try {
      const m = await readManifest();
      return m.projects || [];
    } catch (e) { return []; }
  }

  /* 保存画布：工程文件 + 更新索引（失败抛错由调用方兜底缓存） */
  async function save(id, obj) {
    const ok = await putFile('projects/' + id + '.json', JSON.stringify(obj, null, 0), 'save ' + (obj.name || id));
    if (!ok) throw new Error('云端保存失败');
    try {
      const m = await readManifest();
      const now = new Date().toLocaleString('zh-CN', { hour12: false });
      const old = (m.projects || []).filter((p) => p.id !== id);
      m.projects = [{ id, name: obj.name || '未命名画布', createdAt: obj.createdAt || now, updatedAt: now }, ...old].slice(0, 200);
      await writeManifest(m);
    } catch (e) { /* 索引失败不阻塞工程保存 */ }
  }

  /* 载入画布：云端优先，404 返回 null */
  async function load(id) {
    const t = await raw('projects/' + id + '.json');
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  async function del(id) {
    await delFile('projects/' + id + '.json');
    try {
      const m = await readManifest();
      m.projects = (m.projects || []).filter((p) => p.id !== id);
      await writeManifest(m);
    } catch (e) {}
  }

  /* ---------- 资产 ---------- */
  async function assets() {
    const x = await gh('/git/trees/' + CFG.branch + '?recursive=1');
    const tree = (x && x.data && x.data.tree) ? x.data.tree : [];
    const out = [];
    tree.forEach((it) => {
      if (it.type !== 'blob' || !String(it.path).startsWith('assets/')) return;
      const name = it.path.slice('assets/'.length);
      out.push({ name, url: RAW + '/' + it.path, size: it.size });
    });
    out.sort((a, b) => b.size - a.size || String(a.name).localeCompare(String(b.name)));
    return out;
  }

  /* 上传文件/Blob 到云端资产，返回 {url, name, size}（url 为 raw 直读地址） */
  async function uploadAsset(blob, name) {
    const safeName = String(name || ('file_' + Date.now())).replace(/[\/\\?#%]/g, '_'); // 仓库路径安全
    const buf = await blobToAB(blob);
    const b64 = abToB64(buf);
    const path = 'assets/' + safeName;
    const body0 = { message: 'upload ' + safeName, content: b64 };
    let sha = await getSHA(path);
    for (let i = 0; i < 2; i++) {
      const body = { ...body0 };
      if (sha) body.sha = sha;
      const r = await fetch(API + '/contents/' + path, {
        method: 'PUT',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + CFG.token, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify(body),
      });
      if (r.ok) return { url: RAW + '/' + path, name: safeName, size: buf.byteLength };
      if (r.status === 422) { sha = await getSHA(path); continue; }
      if (r.status === 403) throw new Error('云端上传频率过高，请稍后再试');
      throw new Error('上传失败 HTTP ' + r.status);
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

  /* 删除资产（参数为 raw URL 或仓库路径） */
  async function deleteAsset(ref) {
    const s = String(ref || '');
    const m = s.match(/lctv-canvas-data\/[^\/]+\/assets\/(.+)$/) || s.match(/^assets\/(.+)$/);
    const name = m ? m[1] : null;
    if (!name) return;
    await delFile('assets/' + name);
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
    b64utf8,
  };
})();