/* =====================================================
 * 执行引擎：输入收集、按节点类型调度 AI、下游级联重跑
 * ===================================================== */
(function () {
  const U = LC.U;
  const T = LC.NODE_TYPES;
  const AI = LC.AI;

  const Executor = {
    running: new Set(),
    queue: [],
    _downCache: new Map(),      // upId -> Set<downId>（仅覆盖连线下游）
    _downCacheRev: -1,          // 上次重建缓存时的 graph.revision
    _downQueued: new Set(),     // 待批量触发的下游节点 id（去重）
    _downTimer: null,           // 批量触发定时器

    /* ---------- 输出 -> 文本 ---------- */
    toText(o) {
      if (!o) return '';
      if (o.kind === 'text') return o.text;
      if (o.kind === 'shots') return o.shots.map((s) => `镜头${s.no}【${s.size}·${s.move}】${s.desc}${s.dialogue ? ' 台词：' + s.dialogue : ''}`).join('\n');
      if (o.kind === 'report') return o.text;
      if (o.kind === 'image') return '[图片] ' + (o.meta?.prompt || '');
      if (o.kind === 'video') return '[视频] ' + (o.meta?.prompt || '') + ` ${o.duration}s`;
      if (o.kind === 'audio') return '[音频] ' + (o.text || '');
      return JSON.stringify(o).slice(0, 400);
    },

    /* ---------- 收集节点输入（连线 + @引用，按输出类型自动归类） ---------- */
    async collect(n) {
      const g = LC.App.graph;
      const map = g.inputsOf(n.id);
      const res = { text: [], images: [], audio: [], videos: [], any: [], refs: [] };
      const seen = new Set();
      const push = async (o) => {
        if (!o) return;
        if (o.kind === 'image') {
          const d = await U.urlToDataURL(o.dataURL);
          if (d) res.images.push(d);            // 转换失败（文件丢失）跳过，不混 null 进 API
        }
        // 视频/音频：浅拷贝携带转换结果，绝不回写原 output（防 _dataURL 被序列化）
        if (o.kind === 'video') res.videos.push({ ...o, _dataURL: await U.urlToDataURL(o.dataURL) });
        if (o.kind === 'audio') res.audio.push({ ...o, _dataURL: await U.urlToDataURL(o.dataURL) });
        if (o.kind === 'text' || o.kind === 'shots' || o.kind === 'report') res.text.push(this.toText(o));
        res.any.push(o);
      };
      // 1) 连线输入
      for (const ref of Object.values(map).flat()) {
        if (seen.has(ref.n)) continue;
        seen.add(ref.n);
        res.refs.push(ref.n);
        await push(g.getNode(ref.n)?.state.output);
      }
      // 2) @引用输入
      const src = [n.props.prompt, n.props.text, n.props.content].filter(Boolean).join('\n');
      for (const mm of g.mentionNodes(src)) {
        const nn = mm.node;
        if (nn.id === n.id || seen.has(nn.id)) continue;
        seen.add(nn.id);
        res.refs.push(nn.id);
        await push(nn.state.output);
      }
      return res;
    },

    /* 生成结果落盘：dataURL 转磁盘文件，output 只留 url（序列化零负担） */
    async persistOutput(output) {
      try {
        const o = output;
        if (!o || !o.dataURL || typeof o.dataURL !== 'string') return;
        if (o.dataURL.startsWith('blob:')) {
          const blobRes = await fetch(o.dataURL);
          if (!blobRes.ok) return;
          const blob = await blobRes.blob();
          const ext = (blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg');
          const j = await LC.Cloud.uploadAsset(blob, 'gen_' + Date.now() + '.' + ext);
          if (j && j.url) { o.url = j.url; o.dataURL = j.url; }
          return;
        }
        if (!o.dataURL.startsWith('data:')) return;
        // base64 → blob：用 fetch(data: URL) 让浏览器原生解码，避免 atob + charCodeAt 循环阻塞主线程（几 MB 图像性能差异显著）
        const dataRes = await fetch(o.dataURL);
        const blob = await dataRes.blob();
        const mime = blob.type || 'application/octet-stream';
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3', 'audio/wav': '.wav' }[mime] || '';
        const j = await LC.Cloud.uploadAsset(blob, 'gen_' + Date.now() + ext);
        if (j && j.url) { o.url = j.url; o.dataURL = j.url; }   // 落盘成功：dataURL 一并替换为 URL（与 blob 分支一致），toJSON 见 url 即剔除 dataURL
      } catch (e) { /* 落盘失败则保留 dataURL，下次保存仍走旧逻辑 */ }
    },

    /* ---------- 执行节点 ---------- */
    async run(id, opts = {}) {
      const g = LC.App.graph;
      const n = g.getNode(id);
      if (!n || this.running.has(id)) return;
      this.running.add(id);   // 先标记：防止 @/连线 循环引用导致无限递归
      let progTimer = null;
      try {
        // 上游未执行 -> 先跑上游（连线 + @引用）
        await this.runUpstream(id);
        // 运行开始即生成任务 ID 并持久化：中途刷新也能查到后端任务（刷新后续轮询，不重新生成）
        n.state.taskId = U.uid('ai');
        n.state.status = 'running'; n.state.progress = 0; n.state.output = null; n.state.error = null;
        LC.App.nodes.updateNode(id);
        if (LC.App.forceSave) LC.App.forceSave();   // 立即持久化 running 状态 + taskId，刷新后可恢复
        // 第三方上游任务钩子：任务创建时把 ext 写入节点状态并保存 → 刷新后据此续轮询原任务，绝不重复生成
        LC.__onExtTask = (ext) => { if (ext && ext.extTaskId) { n.state.extTask = ext; if (LC.App && LC.App.saveSoon) LC.App.saveSoon(); } };
        // 平滑进度动画：1% → 99% 逐帧递增，API 真实进度更高时同步跳变
        let displayProg = 0;
        let lastBackendSync = 0;   // 动画进度同步后端的节流时间戳
        const setProg = (val) => {
          displayProg = val;
          n.state.progress = val;
          const el = LC.App.nodes.els.get(id);
          if (el) {
            const st = U.$('.n-status', el); if (st) st.textContent = Math.round(val) + '%';
            const ov = U.$('.n-progress', el); if (ov) ov.textContent = Math.round(val) + '%';
          }
          // 将“界面显示的动画进度”节流同步到后端（所见即所得）：
          // 后端 AI.run 同步的是 API 真实进度（通常偏低），刷新后恢复用低值会“从最开始开始”；
          // 这里把用户实际看到的百分比覆盖上去，保证刷新后续接的是刷新前看到的数字。
          const now = Date.now();
          if (now - lastBackendSync > 1500) {
            lastBackendSync = now;
            try {
              if (window.LC && LC.Cloud) LC.Cloud.aiTask('progress', { task_id: n.state.taskId, progress: Math.round(val) });
            } catch (e) {}
          }
        };
        progTimer = setInterval(() => {
          if (displayProg < 99) {
            const inc = displayProg < 30 ? 2 : displayProg < 60 ? 1 : displayProg < 85 ? 0.5 : 0.2;
            setProg(Math.min(99, displayProg + inc));
          }
        }, 500);
        const progress = (p) => { if (p > displayProg) setProg(p); };
        // AI.run 会直接复用运行开始已持久化的 n.state.taskId（presetTaskId），保证中途刷新可查
        n.state.output = await this.dispatch(n, progress, n.state.taskId);
        await this.persistOutput(n.state.output);   // 生成媒体落盘 → 保存时零 base64
        n.state.status = 'done'; n.state.progress = 100;
        LC.App.registerAsset(n);
      } catch (err) {
        n.state.status = 'error';
        n.state.error = err.message;
        LC.App.toast(`「${n.title}」执行失败：${err.message}`, 'err');
      } finally {
        if (progTimer) clearInterval(progTimer);
        LC.__onExtTask = null;
        this.running.delete(id);
      }
      LC.App.nodes.updateNode(id);
      g.emit('change');
      LC.App.saveSoon();
      LC.App.view.renderMinimap();
      this.autoDownstream(id);
    },

    /* ---------- 刷新后恢复：扫描 running 节点，查后端任务状态 ---------- */
    async resumeAll() {
      const g = LC.App.graph;
      const running = [...g.nodes.values()].filter((n) => n.state && n.state.status === 'running');
      if (!running.length) return;
      for (const n of running) {
        this._resumeOne(n).catch(() => {});
      }
    },

    async _resumeOne(n) {
      const id = n.id;
      const taskId = n.state.taskId;
      // 网页版：第三方上游任务信息随工程持久化在节点状态里，直接续轮询原任务（绝不重新生成）
      if (n.state.extTask && n.state.extTask.extTaskId) {
        await this.resumeExt(n, { status: 'running', progress: n.state.progress || 0, ext: n.state.extTask });
        return;
      }
      // 查后端任务状态（网页版无后端：等效查询不到，自然走重跑兜底）
      if (taskId) {
        try {
          const r = (window.LC && LC.Cloud) ? { ok: false } : await fetch('/api/ai/task?task_id=' + encodeURIComponent(taskId));
          if (r.ok) {
            const t = await r.json();
            if (t.status === 'done' && t.result) {
              // 任务已完成：恢复结果
              n.state.output = t.result;
              n.state.status = 'done';
              n.state.progress = 100;
              n.state.error = null;
              // 回填 dataURL（后端存的是 url，没有 base64）
              if (n.state.output && n.state.output.url && !n.state.output.dataURL) {
                n.state.output.dataURL = n.state.output.url;
              }
              LC.App.nodes.updateNode(id);
              LC.App.graph.emit('change');
              LC.App.saveSoon();
              return;
            }
            if (t.status === 'error') {
              n.state.status = 'error';
              n.state.error = t.error || '生成失败';
              LC.App.nodes.updateNode(id);
              LC.App.graph.emit('change');
              return;
            }
            // status === 'running'：若有第三方任务信息 → 续轮询原任务（上游仍在跑，绝不重新提交）
            if (t.status === 'running' && t.ext && t.ext.extTaskId) {
              await this.resumeExt(n, t);
              return;
            }
            // status === 'running' 但无第三方任务信息：老任务无法续接，只能重新提交（上游已跑完的旧任务除外）
          }
        } catch (e) { /* 查询失败，走重跑 */ }
      }
      // 没有 taskId 或任务不存在/仍在跑 → 重新执行
      n.state.status = 'idle';
      n.state.progress = 0;
      LC.App.nodes.updateNode(id);
      this.run(id).catch(() => {});
    },

    /* ---------- 刷新后恢复：续轮询上游原第三方任务（不重新生成，进度从后端继续） ---------- */
    async resumeExt(n, t) {
      const id = n.id;
      const g = LC.App.graph;
      n.state.status = 'running';
      n.state.error = null;
      // 进度从后端已同步值继续（不归零、不重新从 1% 起步）
      let displayProg = Math.min(99, Math.max(0, Number(t.progress) || 0));
      let lastBackendSync = 0;
      const setProg = (val) => {
        displayProg = val;
        n.state.progress = val;
        const el = LC.App.nodes.els.get(id);
        if (el) {
          const st = U.$('.n-status', el); if (st) st.textContent = Math.round(val) + '%';
          const ov = U.$('.n-progress', el); if (ov) ov.textContent = Math.round(val) + '%';
        }
        // 恢复期间的动画进度同样同步后端：恢复中再刷新也接续当前值，不退回
        const now = Date.now();
        if (now - lastBackendSync > 1500) {
          lastBackendSync = now;
          try {
            if (window.LC && LC.Cloud) LC.Cloud.aiTask('progress', { task_id: n.state.taskId, progress: Math.round(val) });
          } catch (e) {}
        }
      };
      setProg(displayProg);
      LC.App.nodes.updateNode(id);
      // 平滑动画从后端进度起步，API 真实进度更高时跳变
      const progTimer = setInterval(() => {
        if (displayProg < 99) {
          const inc = displayProg < 30 ? 2 : displayProg < 60 ? 1 : displayProg < 85 ? 0.5 : 0.2;
          setProg(Math.min(99, displayProg + inc));
        }
      }, 500);
      const progress = (p) => { if (p > displayProg) setProg(p); };
      try {
        const cfg = LC.Settings ? LC.Settings.findModel(t.ext.modelName, t.ext.kind === 'image' ? 'image' : 'video') : null;
        n.state.output = await LC.AI.resumeExtTask(t.ext, progress, cfg);
        // 保存 AI 任务 ID
        n.state.taskId = n.state.taskId || (n.state.output && n.state.output._taskId);
        await this.persistOutput(n.state.output);   // 生成媒体落盘 → 保存时零 base64
        n.state.status = 'done'; n.state.progress = 100;
        LC.App.registerAsset(n);
        LC.App.nodes.updateNode(id);
        g.emit('change');
        LC.App.saveSoon();
        LC.App.view.renderMinimap();
        this.autoDownstream(id);
      } catch (err) {
        n.state.status = 'error';
        n.state.error = err.message;
        LC.App.toast(`「${n.title}」任务恢复失败：${err.message}`, 'err');
        LC.App.nodes.updateNode(id);
        g.emit('change');
      } finally {
        clearInterval(progTimer);
        LC.App.saveSoon();
      }
    },

    /* 递归保证上游完成（连线 + @引用） */
    async runUpstream(id) {
      const n = LC.App.graph.getNode(id);
      if (!n) return;
      const ids = (await this.collect(n)).refs;
      for (const uid of ids) {
        const un = LC.App.graph.getNode(uid);
        if (!un || !un.state.output) await this.run(uid);
      }
    },

    /* ---------- 各类型调度 ---------- */
    async dispatch(n, progress, taskId) {
      const p = n.props;
      const inp = await this.collect(n);
      // 槽位素材：优先内存 data，否则 url 转 dataURL（磁盘），兼容纯字符串
      const slotData = async (arr) => {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const x of arr) {
          if (x && x.data) out.push(x.data);
          else if (x && x.url) out.push(await U.urlToDataURL(x.url));
          else if (typeof x === 'string') out.push(x);
        }
        return out;
      };
      switch (n.type) {
        case 'text': {
          const upText = inp.text.join('\n');
          const text = p.text || upText;
          return { kind: 'text', text, meta: { length: text.length, time: U.formatTime() } };
        }
        case 'image': {
          const prompt = [p.prompt, ...inp.text].filter(Boolean).join('\n');
          const promptLike = prompt || '（无提示词 · 来自参考图）';
          const opts = { model: p.model, aspect: p.aspect, size: p.size, light: p.light, camera: p.camera, quality: p.quality, resolution: p.resolution, negPrompt: p.negPrompt, style: p.style, background: p.background, version: p.version, imgQuality: p.imgQuality, imgRes: p.imgRes };
          // 多图参考：本地上传参考图槽位 + 单图本地上传 + @引用/连线上游图片 全部收集，随 images 数组传给模型（杜绝“只传第一张”）
          const refImages = [
            ...(await slotData(p.refImages)),
            ...(p.localURL ? [await U.urlToDataURL(p.localURL)] : []),
            ...inp.images,
          ].filter(Boolean);
          if (p.mode === 'grid') return AI.run('genGrid', { prompt: promptLike, ...opts, grid: p.grid, images: refImages }, progress, taskId);
          if (p.mode === 'tri') return AI.run('genTriView', { prompt: promptLike, ...opts, images: refImages }, progress, taskId);
          if (p.mode === 'hand') return AI.run('genHandRef', { prompt: promptLike, ...opts, images: refImages }, progress, taskId);
          if (p.mode === 'reverse') {
          if (!inp.images[0]) throw new Error('逆向提示词需要参考图片输入');
          return AI.run('reverseImage', { prompt: inp.images[0], model: p.textModel }, progress, taskId);
        }
          if (p.mode === 'expand') {
            const img = await U.urlToDataURL(p.localURL) || inp.images[0];
            if (!img) throw new Error('扩图需要参考图输入（上游图片或本地上传）');
            return AI.run('genExpand', { prompt: promptLike, image: img, direction: p.expandDir || 'right', ratio: .5, ...opts }, progress, taskId);
          }
          if (p.mode === 'inpaint') {
            const img = await U.urlToDataURL(p.localURL) || inp.images[0];
            if (!img) throw new Error('局部重绘需要参考图输入（上游图片或本地上传）');
            return AI.run('genInpaint', { prompt: promptLike, image: img, ...opts }, progress, taskId);
          }
          // 图生图：有参考图（本地上传 / 上游图片）时，无论是否填编辑指令都调 AI。
          //   有 prompt：按编辑指令改图；无 prompt：用默认提示词让模型基于参考图主导生成（高分辨率重绘 / 风格延续）。
          //   这样“图生图”模式真正等价于“调 AI 基于参考图生成”，而不是“透传本地图”。
          console.log('[图生图诊断] p.mode=%s p.localURL=%s inp.images.length=%d refImages.length=%d',
            p.mode, p.localURL ? (p.localURL.slice(0, 60) + '...') : '(空)', inp.images.length, refImages.length);
          if (refImages.length) {
            const pp = prompt || '（请基于参考图生成分辨率更高的版本，保持画面主体、构图、光影、风格与参考图完全一致）';
            return AI.run('genImage', { prompt: pp, images: refImages, ...opts }, progress, taskId);
          }
          // 纯本地图透传（mode='upload'）：不调 AI，直接把本地图作为节点输出供下游引用/展示
          if (p.mode === 'upload' && p.localURL) {
            return { kind: 'image', dataURL: p.localURL, meta: { prompt: promptLike, type: '本地图片', time: U.formatTime() } };
          }
          if (!prompt) throw new Error('请先输入提示词（若有参考图也请填写编辑指令）再生成');
          return AI.run('genImage', { prompt: promptLike, ...opts }, progress, taskId);
        }
        case 'video': {
          // 本地上传视频：重跑直接透传，不走生成
          if (p.localVideo) {
            await U.sleep(120);
            return LC.NodeUpload.videoOutput(n);
          }
          const prompt = [p.prompt, ...inp.text].filter(Boolean).join('\n');
          if (!prompt) throw new Error('请先输入视频提示词（描述动作/运镜）再生成');
          // 视频两模式：首尾帧 / 参考生（默认参考生=图生；连线连上资产自动带参考）
          const mode = (p.mode === 'shouweizhen' || p.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';
          const upVids = (inp.videos || []).map((v) => v && (v._dataURL || v.dataURL)).filter(Boolean);
          const upAuds = (inp.audio || []).map((a) => a && (a._dataURL || a.dataURL || a.data)).filter(Boolean);
          // 首尾帧：本地槽位优先（内存 data 优先，磁盘 url 转 dataURL 回退），其次上游图片
          const ffRaw = p.firstFrameData || p.firstFrame || p.localFrame || '';
          const lfRaw = p.lastFrameData || p.lastFrame || '';
          const ff = ffRaw ? await U.urlToDataURL(ffRaw) : null;   // /assets/ URL → base64
          const lf = lfRaw ? await U.urlToDataURL(lfRaw) : null;
          const swImgs = [ff, lf, ...(inp.images || [])].filter(Boolean).slice(0, 2);
          // 参考生：本地槽位 + 上游图/视频/音频合并（slotData 与 collect 已过滤 null）
          const isVidu = /viduq3/i.test(p.model || '');
          const isSeed = /seedance/i.test(p.model || '');
          const capImg = isVidu ? 7 : (isSeed ? 30 : 9);
          const capVid = isSeed ? 10 : (isVidu ? 0 : 3);
          const capAud = isSeed ? 10 : (isVidu ? 0 : 3);
          const refImgs = [...(await slotData(p.refImages)), ...(inp.images || [])].filter(Boolean).slice(0, capImg);
          const _fp = (s) => (typeof s === 'string' ? (s.slice(0, 14) + '…' + s.slice(-8) + '[' + s.length + ']') : '?');
          console.log('[视频参考图诊断] mode=%s 本地槽=%d 上游连线=%d 合计=%d → %s',
            mode, p.refImages ? p.refImages.length : 0, inp.images.length, refImgs.length,
            refImgs.map(_fp).join(' | '));
          const refVids = [...(await slotData(p.refVideos)), ...upVids].filter(Boolean).slice(0, capVid);
          const refAuds = [...(await slotData(p.refAudios)), ...upAuds].filter(Boolean).slice(0, capAud);
          const opts = {
            model: p.model, duration: p.duration, aspect: p.aspect, resolution: p.resolution,
            mode, style: p.style, light: p.light,
            images: mode === 'shouweizhen' ? swImgs : [],
            refImages: mode === 'cankaosheng' ? refImgs : [],
            refVideos: mode === 'cankaosheng' ? refVids : [],
            refAudios: mode === 'cankaosheng' ? refAuds : [],
          };
          return AI.run('genVideo', { prompt, ...opts }, progress, taskId);
        }
        case 'audio': {
          // 本地上传音频：重跑直接透传
          if (p.localAudio) {
            return { kind: 'audio', dataURL: p.localAudio, voice: p.localName || '本地音频', duration: 0, meta: { type: '本地音频', model: p.localName || '本地音频' } };
          }
          if (p.kind === 'voice') {
            const text = p.text || inp.text.join('\n');
            if (!text) throw new Error('缺少台词文本（从脚本节点连线或直接输入）');
            return AI.run('tts', { prompt: text, voice: p.voice, mode: 'voice' }, progress, taskId);
          }
          // BGM / 音效：同样走语音 API（seed-audio 等模型支持音频内容生成）
          if (!p.bgm || p.bgm === '无') throw new Error(p.kind === 'bgm' ? '请先选择背景音乐类型' : '请先选择音效类型');
          const desc = p.kind === 'bgm'
            ? `生成背景音乐：${p.bgm}，纯音乐，无人声`
            : `生成环境音效：${p.bgm}，无台词`;
          return AI.run('tts', { prompt: desc, voice: p.voice, mode: p.kind }, progress, taskId);
        }
        case 'script': {
          const content = p.content || inp.text.join('\n');
          if (!content) throw new Error('请先粘贴剧本内容');
          const out = await AI.run('scriptToShots', { prompt: content, shotCount: p.shotCount, shotDuration: p.shotDuration, style: p.style, model: p.model }, progress, taskId);
          LC.App.renderOutline(n, out);
          return out;
        }
        case 'stage': {
          if (p.snapshot) return { kind: 'image', dataURL: p.snapshot, meta: { type: '导演台构图', time: U.formatTime() } };
          LC.App.toast('请先在 3D 导演台中摆好人物并截图输出', 'warn');
          LC.App.openStage(n);
          throw new Error('等待导演台截图');
        }
        case 'subtitle': {
          const audioText = inp.audio
            .map((a) => a.text || a.meta?.text || a.meta?.transcript || '')
            .filter(Boolean)
            .join('\n');
          const text = inp.text.join('\n') || audioText || '（无台词输入）';
          return { kind: 'subtitle', text, style: p.style, fontSize: p.fontSize, pos: p.pos, meta: { time: U.formatTime() } };
        }
        case 'check': {
          const text = [p.extra, ...inp.text].filter(Boolean).join(' ') ||
            inp.any.map((o) => (o.meta?.prompt || '')).filter(Boolean).join(' ') || '';
          if (!text) throw new Error('没有可校验的内容输入');
          return AI.run('compliance', { prompt: text, rules: p.rules, model: p.model }, progress, taskId);
        }
        case 'export': {
          // 优先用真实视频源（Ark 生成/本地上传），无源退化为首帧图动效
          const clips = inp.videos.map((v) => ({ src: v._dataURL || v.dataURL || null, frame: v.frames?.[0] || null, duration: v.duration || 6 }));
          if (clips.length === 0) throw new Error('未接入任何视频节点');
          const out = await AI.run('composeVideo', { prompt: '', clips, fps: p.fps, aspect: p.aspect }, progress);
          // 触发下载
          U.download(`${LC.App.projectName || '成片'}_${p.resolution}.webm`, out.dataURL, 'url');
          LC.App.toast(`成片已导出：${out.duration}s · webm（${clips.length} 个镜头）`, 'ok');
          return out;
        }
        default: throw new Error('未实现执行: ' + n.type);
      }
    },

    /* ---------- 连线建立后联动 ----------
     * 连线本身不自动触发生成（避免一连线就跑、误触发计费）；
     * 仅当用户手动执行上游节点成功后，才通过 autoDownstream 联动下游。
     * autoRerun 开关仍控制手动执行后的下游联动行为。 */
    onEdgeAdded(edge) {
      // 连线成功仅提示，不自动 run；下游生成由用户手动触发或上游执行后联动
    },

    /* ---------- 上游变更 -> 下游自动更新（连线 + @引用） ----------
     * 优化：
     *  - 连线下游用反向边缓存（_downCache）按 revision 懒重建，O(1) 命中
     *  - @引用下游用纯字符串扫描（mentionNodes），不再对每个候选节点 await collect
     *  - 多个上游同时完成时用 _downQueued + _downTimer 去重，300ms 内合并成一次批量触发
     */
    async autoDownstream(id) {
      if (!LC.App.autoRerun) return;
      const g = LC.App.graph;
      if (this._downCacheRev !== g.revision) {
        // 反向边缓存与图版本不一致，重建（edge:add/remove/load/node:remove 都会 bump revision）
        this._downCache = new Map();
        for (const e of g.edges) {
          if (!this._downCache.has(e.from.n)) this._downCache.set(e.from.n, new Set());
          this._downCache.get(e.from.n).add(e.to.n);
        }
        this._downCacheRev = g.revision;
      }
      const downstreamSet = new Set(this._downCache.get(id) || []);
      // @ 引用下游：遍历所有节点的 props 文本，仅字符串扫描，不做 fetch
      for (const dn of g.nodes.values()) {
        if (dn.id === id || downstreamSet.has(dn.id)) continue;
        const src = [dn.props.prompt, dn.props.text, dn.props.content].filter(Boolean).join('\n');
        if (!src || !src.includes('@')) continue;
        if (g.mentionNodes(src).some((m) => m.node.id === id)) downstreamSet.add(dn.id);
      }
      // 去重 + 批量延迟触发
      for (const dnId of downstreamSet) {
        const dn = g.getNode(dnId);
        if (!dn || dn.state.status === 'running') continue;
        // 视频节点未写提示词时不自动生成
        if (dn.type === 'video' && !dn.props.prompt) continue;
        // 图片节点未写提示词时不自动生成（ref/upload 本地透传除外）
        if (dn.type === 'image' && !dn.props.prompt && !['ref', 'upload'].includes(dn.props.mode)) continue;
        this._downQueued.add(dnId);
      }
      if (this._downQueued.size && !this._downTimer) {
        this._downTimer = setTimeout(() => {
          const ids = [...this._downQueued];
          this._downQueued.clear();
          this._downTimer = null;
          for (const dnId of ids) this.run(dnId);
        }, 300);
      }
    },

    /* ---------- 宫格提取为独立图片节点 ---------- */
    async extractCell(nodeId, cellIndex) {
      const g = LC.App.graph;
      const src = g.getNode(nodeId);
      const out = src.state.output;
      if (!out || !out.meta?.cells) { LC.App.toast('请先生成九宫格', 'warn'); return; }
      LC.App.toast('正在提取宫格…', 'ok');
      const img = await AI.run('extractGridCell', { prompt: '', gridOutput: out, index: cellIndex });
      const cell = out.meta.cells[cellIndex];
      const nn = g.createNode('image', src.x + src.w + 90, src.y + (cellIndex % 3) * 40 - 40);
      nn.title = '分镜 · ' + cell.shot;
      nn.props.prompt = out.meta.prompt;
      nn.props.mode = 'ref';
      nn.props.localURL = '';
      nn.state.output = img;
      nn.state.status = 'done';
      g.addEdge({ n: nodeId, p: 'out' }, { n: nn.id, p: 'in' });
      LC.App.toast(`已提取「${cell.shot}」为独立图片节点`, 'ok');
      LC.App.saveSoon();
    },
  };

  LC.Executor = Executor;
})();