/* =====================================================
 * 设置中心：模型 API 接口管理（用户自添加，应用不预设任何模型）
 * 每条模型：显示名称 / 协议 / 模型 ID / API 地址 / API Key
 * 存储于 localStorage: lc_settings（小体量，不入 IndexedDB）
 * ===================================================== */
(function () {
  const U = LC.U;

  const DEFAULTS = {
    imageModels: [],   // [{name, provider:'ark'|'custom', modelId, url, key}]
    videoModels: [],
    textModels: [],
    ttsModels: [],
    autoRerun: true,
  };

  /* 预置模型（含内置 Key，直接开箱即用；name 为前端显示名，modelId 为实际请求模型） */
  const PRESET_MODELS = {
    image: [
      { name: 'gpt-image-2', provider: 'openai', modelId: 'tt-image-2', url: 'https://api.lk888.ai/v1', key: 'sk-a43af86bf67a74528de08a6dced865b8bc10da45e4504bea' },
      { name: 'gpt-image-2.5', provider: 'openai', modelId: 'tt-image-2.5', url: 'https://api.lk888.ai/v1', key: 'sk-cbcaa71d27f6f2dcb0fc39f51e86b0b5b6baf0d3db5aeaa8' },
      { name: 'gpt-image-2.5 官转', provider: 'openai', modelId: 'tt-image-2.5-token', url: 'https://api.lk888.ai/v1', key: 'sk-3b747bf8a4eb827c5938113c790b269bdd1a46ecb7e1bc3c' },
      { name: '纳米香蕉 Pro', provider: 'openai', modelId: 'banana-pro', url: 'https://api.lk888.ai/v1', key: 'sk-522024479adf6612b14fcb1f859b9ce751835e8619d4291c', resolutions: ['1K', '2K', '4K'] },
    ],
    video: [
      { name: 'viduq3-turbo 全能参考', provider: 'openai', modelId: 'viduq3-turbo-cankaosheng', url: 'https://api.lk888.ai/v1', key: 'sk-54dc77a3432e80f23940bd47ff8ff5495fb46a27d11c5ab6', resolutions: ['540P', '720P', '1080P'] },
      { name: 'MiniMax H3', provider: 'openai', modelId: 'minimax-h3', url: 'https://api.lk888.ai/v1', key: 'sk-f8ea02bf9b4e5ce2eae978b4e3bcf1dc584ff042c1557841', resolutions: ['720P', '2K'] },
      { name: 'seedance 2.0', provider: 'ark', modelId: 'doubao-seedance-2-0-260128', url: 'https://api.lk888.ai/api/v3/anmiao', key: 'sk-23ab50ed44c0fe89c44d63728dd3b857a5158fe906f50396', resolutions: ['480P', '720P', '1080P', '4K'] },
      { name: 'seedance 2.0 fast', provider: 'ark', modelId: 'doubao-seedance-2-0-fast-260128', url: 'https://api.lk888.ai/api/v3/anmiao', key: 'sk-15eb8f58fccbbe00c464c2487e712b7a6a263cf48fa7aa02', resolutions: ['480P', '720P'] },
      { name: 'seedance 2.0 mini', provider: 'ark', modelId: 'doubao-seedance-2-0-mini-260615', url: 'https://api.lk888.ai/api/v3/anmiao', key: 'sk-90885a6da70a05728c0f733b416aa8394c2040064f32520b', resolutions: ['480P', '720P'] },
      { name: 'seedance-2.5', provider: 'ark', modelId: 'seedance-2.5-guanfang', url: 'https://api.lk888.ai/v1', key: 'sk-be09115bdbcf6251e3baa8d2c9128c9317b3eb7e0f9cf654', resolutions: ['480P', '720P', '1080P'] },
    ],
  };

  /* 字节火山各能力端点（url 只填 base/完整地址，路径由 AI 层拼接） */
  const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
  const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/create';
  /* 旧版数据兼容：ttsVoices → ttsModels */
  const TABS = [
    ['image', 'imageModels', '生图模型', 'image'],
    ['video', 'videoModels', '视频模型', 'video'],
    ['text', 'textModels', '文本模型', 'text'],
    ['tts', 'ttsModels', '配音音色', 'mic'],
    ['general', '', '通用', 'gear'],
  ];

  const Settings = {
    data: JSON.parse(JSON.stringify(DEFAULTS)),

    load() {
      try {
        const raw = localStorage.getItem('lc_settings');
        if (raw) {
          this.data = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(raw));
        }
      } catch (e) { /* 损坏则用默认 */ }
      // 数据净化：损坏/旧版数据强制归位为数组，防止渲染层崩溃
      ['imageModels', 'videoModels', 'textModels', 'ttsModels'].forEach((k) => {
        if (!Array.isArray(this.data[k])) this.data[k] = [];
      });
      // 旧数据迁移：ttsVoices → ttsModels；补 provider / modelId 字段
      if (Array.isArray(this.data.ttsVoices) && this.data.ttsVoices.length) {
        this.data.ttsModels = this.data.ttsModels.concat(this.data.ttsVoices);
      }
      delete this.data.ttsVoices;
      ['imageModels', 'videoModels', 'textModels', 'ttsModels'].forEach((k) => {
        this.data[k].forEach((m) => {
          if (!m || typeof m !== 'object') return;
          if (!m.provider) m.provider = 'custom';
          if (m.modelId === undefined) m.modelId = '';
        });
      });
      // 一次性清理旧预置模型（用户重置）；之后由用户重新提供，不再自动回填
      if (!localStorage.getItem('__models_reset__')) {
        const LEGACY = ['Doubao-Seedream-5.0-pro', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-c', 'gpt-image-2.5-pro'];
        this.data.imageModels = this.data.imageModels.filter((m) => !m || !LEGACY.includes(m.name));
        localStorage.setItem('__models_reset__', '1');
        this.save();
      }
      // 迁移：清理历史 seedance 显示名，统一为「seedance 2.0 / fast / mini」三档
      if (!localStorage.getItem('__seedance_anmiao_v3__')) {
        const OLD_SEEDANCE = ['seedance-2.0', 'SD 2.0 标准版', 'SD 2.0 快速版', 'SD 2.0 Mini 版'];
        this.data.videoModels = this.data.videoModels.filter((m) => !(m && OLD_SEEDANCE.includes(m.name)));
        localStorage.setItem('__seedance_anmiao_v3__', '1');
        this.save();
      }
      // 迁移：移除已下线的「seedance-2-0 (性价比)」模型（含本地缓存残留）
      if (!localStorage.getItem('__seedance_value_removed__')) {
        this.data.videoModels = this.data.videoModels.filter((m) => !(m && m.name === 'seedance-2-0 (性价比)'));
        localStorage.setItem('__seedance_value_removed__', '1');
        this.save();
      }
      // 预置模型回填：缺则补、已存在则同步地址/Key（开箱即用）
      const PRESET_KEYS = { image: 'imageModels', video: 'videoModels' };
      Object.keys(PRESET_KEYS).forEach((kind) => {
        const presets = PRESET_MODELS[kind];
        const listKey = PRESET_KEYS[kind];
        if (!Array.isArray(presets)) return;
        presets.forEach((p) => {
          const m = this.data[listKey].find((x) => x && x.name === p.name);
          if (!m) this.data[listKey].push({ ...p });
          else {
            // 预置为准：同步 provider/modelId/url（防止旧缓存指向错误地址）
            if (!m.provider) m.provider = p.provider;
            if (p.modelId && m.modelId !== p.modelId) m.modelId = p.modelId;
            if (p.url && m.url !== p.url) m.url = p.url;
            if (!m.key && p.key) m.key = p.key;
            if (!Array.isArray(m.resolutions) && Array.isArray(p.resolutions)) m.resolutions = p.resolutions.slice();
          }
        });
      });
      return this.data;
    },

    save() {
      try { localStorage.setItem('lc_settings', JSON.stringify(this.data)); }
      catch (e) { LC.App.toast('设置保存失败（存储空间不足）', 'err'); }
    },

    /* 按名称查模型配置 */
    findModel(name, kind) {
      const list = this.listOf(kind);
      return (list || []).find((m) => m.name === name) || null;
    },

    modelNames(kind) {
      return (this.listOf(kind) || []).map((m) => m.name);
    },

    listOf(kind) {
      const t = TABS.find((x) => x[0] === kind);
      return t ? this.data[t[1]] : [];
    },

    /* ---------- 设置弹窗 ---------- */
    open() {
      const html = `
        <div class="set-wrap">
          <div class="set-tabs">
            ${TABS.map(([k, , label, ic]) => `<button class="set-tab${k === 'image' ? ' active' : ''}" data-tab="${k}">${U.icon(ic, 14)} ${label}</button>`).join('')}
          </div>
          <div class="set-body" id="set-body"></div>
          <div class="set-foot">
            <div class="set-hint">全部 AI 能力均走真实 API：<b>生图/视频</b>选「OpenAI 兼容」（22Ai/lk888，模型 ID 如 tt-image-2 / minimax-h3）填 API Key 即可；<b>文本</b>选「字节火山 Ark」填 doubao-seed-1-6-250615；<b>配音</b>选「字节火山语音」填 seed-audio-1.0 + API Key。「自定义」则 POST {task, params} JSON。未配置的模型类型对应节点无法执行。</div>
            <div style="display:flex;gap:8px">
              <button class="p-btn" id="set-cancel">取消</button>
              <button class="p-btn primary" id="set-save">保存设置</button>
            </div>
          </div>
        </div>`;
      const modal = LC.Modal.open(html, { title: `${U.icon('gear', 15)} 设置 — API 接口与模型管理`, width: '640px', className: 'set-modal' });
      const body = modal.body;
      this._draft = JSON.parse(JSON.stringify(this.data));
      // 草稿同步净化：任何损坏数据强制归位数组，保证弹窗始终可渲染
      ['imageModels', 'videoModels', 'textModels', 'ttsModels'].forEach((k) => {
        if (!Array.isArray(this._draft[k])) this._draft[k] = [];
      });
      let tab = 'image';

      const render = () => {
        const box = U.$('#set-body', body);
        if (tab === 'general') {
          box.innerHTML = `
            <div class="p-row" style="display:flex;align-items:center;gap:10px">
              <label style="flex:1">上游更新后自动重跑下游节点</label>
              <input type="checkbox" id="set-autorerun" ${this._draft.autoRerun ? 'checked' : ''}>
            </div>
            <div class="p-hint">关闭后仅在手动点击 ▶ 时执行节点。</div>`;
          U.$('#set-autorerun', body).addEventListener('change', (e) => {
            this._draft.autoRerun = e.target.checked;
          });
          return;
        }
        const key = TABS.find((t) => t[0] === tab)[1];
        const label = TABS.find((t) => t[0] === tab)[2];
        const list = this._draft[key] || [];
        const isTTS = tab === 'tts';
        const idPh = tab === 'image' ? 'doubao-seedream-4-0-250828'
          : tab === 'video' ? 'minimax-h3'
          : tab === 'text' ? 'doubao-seed-1-6-250615'
          : 'seed-audio-1.0';
        const defUrl = isTTS ? TTS_URL : (tab === 'video' ? 'https://api.lk888.ai/v1' : ARK_BASE);
        box.innerHTML = (list.length ? `
          <div class="set-list">${list.map((m, i) => `
            <div class="set-card" data-i="${i}">
              <div class="sc-r1">
                <input type="text" class="s-name" value="${U.esc(m.name)}" placeholder="名称（节点下拉里显示）">
                <select class="s-provider">
                  <option value="ark"${m.provider === 'ark' ? ' selected' : ''}>${isTTS ? '字节火山语音' : '字节火山 Ark'}</option>
                  ${!isTTS ? `<option value="openai"${m.provider === 'openai' ? ' selected' : ''}>OpenAI 兼容</option>` : ''}
                  <option value="custom"${m.provider !== 'ark' && m.provider !== 'openai' ? ' selected' : ''}>自定义接口</option>
                </select>
                <button class="s-del" data-i="${i}" title="删除">✕</button>
              </div>
              <div class="sc-r2">
                ${m.provider === 'ark' || m.provider === 'openai' ? `
                <input type="text" class="s-modelid" value="${U.esc(m.modelId || '')}" placeholder="${m.provider === 'openai' ? '模型 ID：如 tt-image-2' : `模型 ID：${idPh}`}">
                <input type="text" class="s-url" value="${U.esc(m.url || (m.provider === 'openai' ? 'https://api.lk888.ai/v1' : defUrl))}" placeholder="${m.provider === 'openai' ? 'https://api.lk888.ai/v1' : defUrl}">`
                  : `<input type="text" class="s-url" value="${U.esc(m.url || '')}" placeholder="完整接口地址 https://…（POST {task, params}）">`}
              </div>
              <div class="sc-r3">
                <input type="password" class="s-key" value="${U.esc(m.key || '')}" placeholder="API Key（${isTTS ? '语音服务 API Key' : 'API 访问密钥'}）">
              </div>
            </div>`).join('')}</div>`
          : `<div class="set-empty">尚未添加${label}。<br>点击下方按钮添加你自己的 API 接口。</div>`)
          + `<button class="p-btn" id="set-add">＋ 添加${label}</button>`;

        const syncRow = () => {
          U.$$('.set-card', box).forEach((row) => {
            const i = +row.dataset.i;
            const m = list[i];
            row.querySelector('.s-name').addEventListener('input', (e) => { m.name = e.target.value; });
            row.querySelector('.s-provider').addEventListener('change', (e) => {
              m.provider = e.target.value;
              if (m.provider === 'ark' && !m.url) m.url = defUrl;
              if (m.provider === 'openai' && !m.url) m.url = 'https://api.lk888.ai/v1';
              render();   // 重渲染切换 Ark/OpenAI/自定义 字段显隐
            });
            row.querySelector('.s-modelid')?.addEventListener('input', (e) => { m.modelId = e.target.value; });
            row.querySelector('.s-url')?.addEventListener('input', (e) => { m.url = e.target.value; });
            row.querySelector('.s-key').addEventListener('input', (e) => { m.key = e.target.value; });
            row.querySelector('.s-del').addEventListener('click', () => { list.splice(i, 1); render(); });
          });
        };
        syncRow();
        U.$('#set-add', box).addEventListener('click', () => {
          // 默认字节协议；TTS 默认自定义
          list.push(isTTS
            ? { name: '', provider: 'ark', modelId: '', url: TTS_URL, key: '' }
            : tab === 'video'
              ? { name: '', provider: 'openai', modelId: '', url: 'https://api.lk888.ai/v1', key: '' }
              : { name: '', provider: 'ark', modelId: '', url: ARK_BASE, key: '' });
          render();
          const rows = U.$$('.set-card', box); const last = rows[rows.length - 1];
          if (last) last.querySelector('.s-name').focus();
        });
      };

      U.$$('.set-tab', body).forEach((t) => t.addEventListener('click', () => {
        U.$$('.set-tab', body).forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        tab = t.dataset.tab;
        render();
      }));

      U.$('#set-cancel', body).addEventListener('click', () => modal.close());
      U.$('#set-save', body).addEventListener('click', () => {
        // 清理空名称行 + 名称去重
        ['imageModels', 'videoModels', 'textModels', 'ttsModels'].forEach((k) => {
          this._draft[k] = (this._draft[k] || []).filter((m) => m && m.name && m.name.trim());
          const seen = new Set();
          this._draft[k].forEach((m) => {
            let nm = m.name.trim();
            while (seen.has(nm)) nm += ' 2';
            seen.add(nm); m.name = nm;
          });
        });
        this.data = this._draft;
        this.save();
        // 应用自动重跑开关
        if (LC.App) LC.App.autoRerun = !!this.data.autoRerun;
        // 刷新所有节点卡片（模型下拉即时更新为新列表）
        LC.App?.graph?.nodes.forEach((nn) => LC.App.nodes.updateNode(nn.id));
        LC.App.toast('设置已保存 ✓', 'ok');
        modal.close();
      });

      render();
    },
  };

  LC.Settings = Settings;
})();
