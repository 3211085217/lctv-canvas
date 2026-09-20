/* 工具函数集 */
(function () {
  const U = {};
  window.LC = window.LC || {};
  window.LC.U = U;

  let _seq = 0;
  U.uid = (prefix = 'n') =>
    `${prefix}_${Date.now().toString(36)}${(_seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  U.$ = (sel, root = document) => root.querySelector(sel);
  U.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  U.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  U.lerp = (a, b, t) => a + (b - a) * t;

  U.debounce = (fn, ms = 300) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  U.formatTime = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  U.shortTime = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* 下载文件 */
  U.download = (filename, content, mime = 'application/octet-stream') => {
    const a = document.createElement('a');
    // 仅当本函数自己创建了 blob URL 时才负责 revoke；data:/url 直接复用，不回收（避免误 revoke 外部仍使用的 blob URL）
    const isRaw = mime.startsWith('data:') || mime === 'url';
    const url = isRaw
      ? content
      : URL.createObjectURL(new Blob([content], { type: mime }));
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    if (!isRaw) setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  U.dataURLtoBlob = (dataURL) => {
    const [head, body] = dataURL.split(',');
    const mime = (head.match(/data:(.*?);/) || [])[1] || 'image/png';
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  };

  /* UTF-8 安全的 base64url */
  const te = new TextEncoder(), td = new TextDecoder();
  U.b64encode = (str) => {
    const bytes = te.encode(str);
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  U.b64decode = (b64) => {
    const s = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s.padEnd(s.length + ((4 - (s.length % 4)) % 4), '='));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return td.decode(bytes);
  };

  /* gzip 压缩（用于分享链接） */
  U.gzip = async (str) => {
    try {
      const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      let bin = '';
      new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch (e) { return U.b64encode(str); }
  };
  U.gunzip = async (b64) => {
    try {
      const s = b64.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(s.padEnd(s.length + ((4 - (s.length % 4)) % 4), '='));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch (e) { return U.b64decode(b64); }
  };

  /* 复制到剪贴板 */
  U.copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  };

  /* 磁盘 URL → dataURL（AI 调用需要 base64）；已是 dataURL 则原样返回 */
  U.urlToDataURL = async (url) => {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const blob = await r.blob();
      return await new Promise((res, rej) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.onerror = () => rej(new Error('URL→dataURL 失败'));
        rd.readAsDataURL(blob);
      });
    } catch (e) { return null; }
  };

  /* 颜色 hash */
  U.colorHash = (str) => {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    const hue = h % 360;
    return { hue, base: `hsl(${hue},55%,58%)`, dark: `hsl(${hue},45%,30%)` };
  };

  /* 生成头像级占位符（canvas 绘制，色彩随 seed） */
  U.seedAvatar = (seed, size = 96) => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const { hue } = U.colorHash(seed);
    const g = x.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, `hsl(${hue},60%,26%)`);
    g.addColorStop(1, `hsl(${(hue + 70) % 360},55%,12%)`);
    x.fillStyle = g; x.fillRect(0, 0, size, size);
    // 简单抽象构图：圆 + 光斑
    x.fillStyle = `hsla(${hue},70%,70%,.85)`;
    x.beginPath(); x.arc(size * .5, size * .4, size * .16, 0, 7); x.fill();
    x.fillStyle = `hsla(${hue},35%,55%,.9)`;
    x.beginPath(); x.ellipse(size * .5, size * .85, size * .30, size * .22, 0, 0, 7); x.fill();
    x.fillStyle = `hsla(${hue},80%,80%,.25)`;
    x.beginPath(); x.arc(size * .78, size * .2, size * .3, 0, 7); x.fill();
    return c.toDataURL('image/png');
  };

  /* png dataURL -> 缩略图 canvas */
  U.thumbOf = (dataURL, w = 220) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const r = w / img.width;
      c.width = w; c.height = Math.round(img.height * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });

  /* 简易 HTML 转义 */
  U.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 单色线条图标库（替代彩色 emoji，专业工具质感） ---------- */
  U.ICONS = {
    dot: '<circle cx="12" cy="12" r="4"/>',
    text: '<rect x="5" y="3" width="14" height="18" rx="2"/><line x1="8.5" y1="8" x2="15.5" y2="8"/><line x1="8.5" y1="12" x2="15.5" y2="12"/><line x1="8.5" y1="16" x2="13" y2="16"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 15.5l-5-5-8.5 8.5"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10.2 9.4l4.8 2.6-4.8 2.6z"/>',
    audio: '<path d="M9 18V6.5L19 4.5V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    script: '<path d="M6 3h8.5L19 7.5V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14.5 3v4.5H19"/><line x1="9" y1="12.5" x2="15" y2="12.5"/><line x1="9" y1="16" x2="15" y2="16"/>',
    stage: '<rect x="2.5" y="7" width="12.5" height="10" rx="2"/><path d="M15 10.8l6-3.1v8.6l-6-3.1"/>',
    subtitle: '<path d="M4 5.5h16a1 1 0 011 1V16a1 1 0 01-1 1H9.5L4.5 21V17h-.5a1 1 0 01-1-1V6.5a1 1 0 011-1z"/><line x1="8" y1="9.5" x2="16" y2="9.5"/><line x1="8" y1="13" x2="13" y2="13"/>',
    check: '<path d="M12 3l7 2.8v5.4c0 4.4-2.9 7.9-7 9.8-4.1-1.9-7-5.4-7-9.8V5.8z"/><path d="M9 12l2.2 2.2L15.5 9.7"/>',
    export: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7.5" y1="4" x2="7.5" y2="20"/><line x1="16.5" y1="4" x2="16.5" y2="20"/><line x1="3" y1="9.5" x2="7.5" y2="9.5"/><line x1="3" y1="14.5" x2="7.5" y2="14.5"/><line x1="16.5" y1="9.5" x2="21" y2="9.5"/><line x1="16.5" y1="14.5" x2="21" y2="14.5"/>',
    grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><line x1="9.2" y1="3.5" x2="9.2" y2="20.5"/><line x1="14.8" y1="3.5" x2="14.8" y2="20.5"/><line x1="3.5" y1="9.2" x2="20.5" y2="9.2"/><line x1="3.5" y1="14.8" x2="20.5" y2="14.8"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0013 0"/><line x1="12" y1="18" x2="12" y2="21"/>',
    tri: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6"/><path d="M12 2.5v1.5"/>',
    person: '<circle cx="12" cy="7.5" r="3.4"/><path d="M5 20.5c0-4 3.1-6.3 7-6.3s7 2.3 7 6.3"/>',
    crowd: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.4 2.7-5.3 6-5.3s6 1.9 6 5.3"/><circle cx="17.2" cy="9" r="2.4"/><path d="M16 14.9c2.7.3 4.8 2.2 4.8 5.1"/>',
    cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12L4 7.5M12 12v9"/>',
    cylinder: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/>',
    sphere: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3.2"/>',
    table: '<line x1="3" y1="8" x2="21" y2="8"/><line x1="5.5" y1="8" x2="5.5" y2="19"/><line x1="18.5" y1="8" x2="18.5" y2="19"/>',
    chair: '<path d="M7 3v18"/><path d="M7 12h9.5"/><path d="M16.5 12v9"/><path d="M7 7.5h7"/>',
    bed: '<line x1="3" y1="19" x2="3" y2="7"/><path d="M3 13.5h18V19"/><circle cx="7.2" cy="10.6" r="1.9"/><path d="M11 13.5v-2a2 2 0 012-2h5a3 3 0 013 3v1"/>',
    door: '<rect x="6" y="3" width="12" height="18" rx="1"/><circle cx="15" cy="12" r="0.6"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/>',
    expand: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 12H2M22 12h-2.2M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7"/>',
    camera: '<path d="M4 8h3l2-2.5h6L17 8h3a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/><circle cx="12" cy="13.5" r="3.4"/>',
    link: '<path d="M10.5 13.5a3.8 3.8 0 005.4 0l2.8-2.8a3.8 3.8 0 00-5.4-5.4l-1.5 1.5"/><path d="M13.5 10.5a3.8 3.8 0 00-5.4 0l-2.8 2.8a3.8 3.8 0 005.4 5.4l1.5-1.5"/>',
    save: '<path d="M4 5a1 1 0 011-1h10.5L20 8.5V19a1 1 0 01-1 1H5a1 1 0 01-1-1z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="7"/>',
    folder: '<path d="M3 6.5a1 1 0 011-1h4.8L11 8h9a1 1 0 011 1v8.5a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
    undo: '<path d="M8 5L3.5 9.5 8 14"/><path d="M3.5 9.5H15a5.5 5.5 0 110 11H9.5"/>',
    redo: '<path d="M16 5l4.5 4.5L16 14"/><path d="M20.5 9.5H9a5.5 5.5 0 100 11h5.5"/>',
    copy: '<rect x="9" y="9" width="11" height="12" rx="2"/><path d="M6 15H5a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"/>',
    clipboard: '<rect x="5" y="4.5" width="14" height="16.5" rx="2"/><rect x="9" y="2.5" width="6" height="4" rx="1"/>',
    trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13.5h9l1-13.5"/><line x1="10.2" y1="11" x2="10.2" y2="17"/><line x1="13.8" y1="11" x2="13.8" y2="17"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
    file: '<path d="M6 3h8.5L19 7.5V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z"/><path d="M14.5 3v4.5H19"/>',
    pin: '<path d="M12 21.5V15"/><path d="M7.5 3.5h9L15 10l3 4.5H6l3-4.5z"/>',
    bookmark: '<path d="M6.5 3.5h11V21l-5.5-3.8L6.5 21z"/>',
    zap: '<path d="M13 2.5L5.5 13.5H11L9.8 21.5 18.5 10h-6z"/>',
    book: '<path d="M4.5 5a2 2 0 012-2h13v16h-13a2 2 0 00-2 2z"/><path d="M4.5 19a2 2 0 012-2h13"/>',
    info: '<circle cx="12" cy="12" r="8.8"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.5" x2="12" y2="7.6"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><line x1="15.8" y1="15.8" x2="20.5" y2="20.5"/>',
    target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5"/>',
    move: '<path d="M12 3.5v17M3.5 12h17"/><path d="M9.5 6L12 3.5 14.5 6M9.5 18l2.5 2.5L14.5 18M6 9.5L3.5 12 6 14.5M18 9.5l2.5 2.5L18 14.5"/>',
    rotate: '<path d="M20 12a8 8 0 11-2.4-5.7"/><path d="M20 3.5V8h-4.5"/>',
    eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    mouse: '<rect x="8" y="3.5" width="8" height="17" rx="4"/><line x1="12" y1="7" x2="12" y2="10"/>',
    keyboard: '<rect x="2.5" y="7" width="19" height="10" rx="2"/><path d="M6 10.5h.01M9.5 10.5h.01M13 10.5h.01M16.5 10.5h.01M7 14h10"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
    xcircle: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
    mapPin: '<path d="M12 21s-6.5-5.3-6.5-10a6.5 6.5 0 0113 0c0 4.7-6.5 10-6.5 10z"/><circle cx="12" cy="11" r="2.2"/>',
    pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z"/>',
    upload: '<path d="M12 16V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4 20h16"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    bulb: '<path d="M9.5 18h5"/><path d="M10.2 21h3.6"/><path d="M12 3a6 6 0 00-3.5 10.9c.7.6 1 1.3 1 2.1h5c0-.8.3-1.5 1-2.1A6 6 0 0012 3z"/>',
    knob: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/><line x1="12" y1="8.8" x2="12" y2="5"/>',
    'arrow-up': '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
    maximize: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.3 9.3 0 0 0-6.5 2.6"/><polyline points="3 4 3 10 9 10"/>',
  };
  /* 返回内联 SVG 图标字符串；color 继承 currentColor */
  U.icon = (name, size = 16, cls = '') => {
    const body = U.ICONS[name] || U.ICONS.dot;
    return `<svg class="lc-ic${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };
  /* 把 <i data-ic="name"> 占位符水合成真实 SVG（用于静态 HTML） */
  U.hydrateIcons = (root = document) => {
    U.$$('[data-ic]', root).forEach((el) => {
      el.outerHTML = U.icon(el.dataset.ic, Number(el.dataset.sz) || 15, el.dataset.cls || '');
    });
  };
})();