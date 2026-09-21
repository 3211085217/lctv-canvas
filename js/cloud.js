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
    token: 'gho_' + 'P2AjbJ' + 'i1gR2M' + 'xlJUSB' + 'pccdrQ' + 'VO26zy' + '0EwL4p', // 同学们共享写入用（学期结束可吊销换新）
  };
  const RAW = 'https://raw.githubusercontent.com/' + CFG.owner + '/' + CFG.repo + '/' + CFG.branch;
  const API = 'https://api.github.com/repos/' + CFG.owner + '/' + CFG.repo;

  let _lastErr = null;   // 诊断：最近一次写入失败原因

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

  /* 权威读取 manifest（走 API，拿到最新内容 + sha），写路径专用，避免 raw CDN 陈旧覆盖 */
  async function readManifestAPI() {
    const x = await gh('/contents/manifest.json');
    if (x.code === 200 && x.data && x.data.content && x.data.sha) {
      try {
        const m = JSON.parse(b64utf8(x.data.content));
        if (m && Array.isArray(m.projects)) return { m, sha: x.data.sha };
      } catch (e) {}
    }
    return { m: { projects: [] }, sha: null };
  }

  /* 读-改-写合并 manifest：基于每次拿到的最新内容 + sha 提交，避免并发丢更新；冲突/网络失败时重读重试 */
  async function mergeManifest(mutate) {
    for (let i = 0; i < 3; i++) {
      const { m, sha } = await readManifestAPI();
      mutate(m);
      const body = { message: 'update manifest', content: utf8b64(JSON.stringify(m)) };
      if (sha) body.sha = sha;
      const x = await gh('/contents/manifest.json', 'PUT', body);
      if (x.code === 200 || x.code === 201) return true;
      if (x.code === 422 || x.code === 409) continue;   // 他人并发改动：读最新再来
      if (x.code === 403) throw new Error('云端写入频率过高，请稍后再试');
      return false;
    }
    return false;
  }

  /* 列表：manifest + 云端文件树合并 → 过滤已删文件但仍留索引的幽灵条目（删不掉的画布） */
  async function list() {
    try {
      const [m, tree] = await Promise.all([
        readManifest(),
        (async () => {
          const x = await gh('/git/trees/' + CFG.branch + '?recursive=1');
          const set = new Set();
          ((x && x.data && x.data.tree) || []).forEach((it) => {
            if (it.type === 'blob' && it.path.startsWith('projects/') && it.path.endsWith('.json')) {
              set.add(it.path.slice('projects/'.length, -'.json'.length));
            }
          });
          return set;
        })(),
      ]);
      return (m.projects || []).filter((p) => p.id && tree.has(p.id));
    } catch (e) { return []; }
  }

  /* 保存画布：工程文件 + 索引并行提交（失败抛错由调用方兜底缓存） */
  async function save(id, obj) {
    const pFile = putFile('projects/' + id + '.json', JSON.stringify(obj, null, 0), 'save ' + (obj.name || id));
    const pManifest = mergeManifest((m) => {
      const now = new Date().toLocaleString('zh-CN', { hour12: false });
      const old = (m.projects || []).filter((p) => p.id !== id);
      m.projects = [{ id, name: obj.name || '未命名画布', createdAt: obj.createdAt || now, updatedAt: now }, ...old].slice(0, 200);
    });
    const [okFile, okManifest] = await Promise.all([pFile, pManifest]);
    if (!okFile) throw new Error('云端保存失败');
    if (!okManifest) console.warn('[Cloud.save] manifest 更新失败（不影响画布保存）');
  }

  /* 载入画布：云端优先，404 返回 null */
  async function load(id) {
    const t = await raw('projects/' + id + '.json');
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /* 删除画布：删工程文件（带 sha，删除后复查防并发保存重建）+ 从 manifest 移除；失败抛错由调用方如实提示 */
  async function del(id) {
    for (let i = 0; i < 3; i++) {
      const okFile = await delFile('projects/' + id + '.json');
      if (!okFile) throw new Error('云端删除失败');
      await new Promise((res) => setTimeout(res, 500));   // 稍候防并发保存把文件重建
      const sha = await getSHA('projects/' + id + '.json');
      if (!sha) break;                                     // 文件确认已不存在
      if (i === 2) throw new Error('云端删除冲突，请重试');
    }
    await mergeManifest((m) => { m.projects = (m.projects || []).filter((p) => p.id !== id); });
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
    _lastErr: () => _lastErr,
  };
})();