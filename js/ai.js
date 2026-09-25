/* =====================================================
 * AI 引擎层：全程真实 API，无本地 Mock
 * 架构：LC.AI.run(task, params, onProgress) 统一调度
 *  - 字节火山 Ark：图片 images/generations（含图生图编辑）、
 *    视频 contents/generations/tasks 异步轮询、文本 chat/completions
 *  - 字节火山语音：openspeech /api/v3/tts/create
 *  - 自定义接口：POST {task, params} JSON
 *  - 未配置模型时直接抛错（节点红色报错 + toast），绝不本地兜底
 * ===================================================== */
(function () {
  const U = LC.U;
  const AI = {};

  const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
  const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/create';

  /* 22Ai/lk888 媒体平台：图片+视频统一走 POST /v1/media/generate（base 固定 /api），
     轮询走 GET /v1/skills/task-status?task_id=xxx（裸对象，无 code/msg/data 信封）。 */
  const LK_MEDIA_BASE = 'https://api.lk888.ai/api';
  /* 旧版/别名模型名 → 平台当前规范模型名（调用 /v1/media/generate 的 model 字段必须用规范名）。
     Seedance 官方 model 名（doubao-seedance-x）只能走火山方舟 /api/v3 格式；
     走本站媒体协议 /v1/media/generate 时必须用 -guanfang 规范名（全形态一体，支持参考图/视频/音频）。 */
  const LK_MODEL_ALIAS = {
    'doubao-seedance-2-0-260128': 'seedance-2.0-guanfang',
    'doubao-seedance-2-0-pro-260128': 'seedance-2.0-guanfang',
    'doubao-seedance-2-5-260628': 'seedance-2.5-guanfang',
    'doubao-seedance-2-5-pro-260628': 'seedance-2.5-guanfang',
  };
  function lkModelName(id) {
    const s = String(id || '');
    return LK_MODEL_ALIAS[s.toLowerCase()] || s;
  }

  /* ---------- 任务状态同步（网页版随工程持久化，无需独立任务表） ---------- */
  function aiTaskSync(action, payload) {
    try {
      return (window.LC && LC.Cloud) ? LC.Cloud.aiTask(action, payload) : Promise.resolve(null);
    } catch (e) { return Promise.resolve(null); }
  }

  /* ---------- 第三方任务注册（刷新后用于“续轮询原任务”，避免重新生成） ----------
   * 各协议函数创建上游任务成功后调用 noteExtTask({proto, base, modelId, extTaskId, kind, ...})
   * 信息随刷新同步到后端任务表；executor._resumeOne 刷新后据此继续轮询而非重新提交。 */
  let _curAiTaskId = null;   // AI.run 当前前端任务 ID（供协议函数挂接第三方信息）
  function noteExtTask(ext) {
    if (!_curAiTaskId) return;
    // 网页版：同步挂到运行中节点 → 随画布持久化，刷新后续轮询原任务
    if (window.LC && LC.__onExtTask) LC.__onExtTask(ext);
    aiTaskSync('meta', { task_id: _curAiTaskId, ext });
  }

  async function loadImg(src) {
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => {});
    return img;
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('文件读取失败'));
      fr.readAsDataURL(blob);
    });
  }
  /* 从模型输出中稳健提取 JSON（容错代码块围栏 / 前后缀文字） */
  function extractJSON(text) {
    const t = String(text).replace(/```(json)?/gi, '').trim();
    try { return JSON.parse(t); } catch (e) { /* 继续 */ }
    const a = t.match(/\[[\s\S]*\]/);
    if (a) { try { return JSON.parse(a[0]); } catch (e) { /* 继续 */ } }
    const o = t.match(/\{[\s\S]*\}/);
    if (o) { try { return JSON.parse(o[0]); } catch (e) { /* 继续 */ } }
    return null;
  }

  /* =====================================================
   * 隐藏提示词系统：画幅/三视图等要求转为提示词片段，
   * 随请求发给 AI，由 AI 直接按要求生成对应画幅内容（非本地裁切）。
   * ===================================================== */
  const ASPECT_PROMPTS = {
    '1:1': '1:1方形画幅构图，适合封面与人物卡',
    '1:2': '1:2竖长画幅构图，极窄竖版海报规格，画面竖向满幅铺满，无黑边无留白',
    '2:1': '2:1 Univisium平衡宽画幅构图，网飞剧集质感',
    '3:2': '3:2横版画幅构图，经典35mm相机胶片比例，横向满幅摄影构图',
    '2:3': '2:3竖版画幅构图，A4印刷漫画页原始画布',
    '5:4': '5:4画幅构图，接近正方形，压抑封闭氛围',
    '4:5': '4:5社交竖版画幅构图，小红书规格',
    '9:16': '9:16竖屏画幅，手机满屏竖版构图，抖音红果短剧规格',
    '9:21': '9:21超窄竖屏画幅构图，手机全屏竖版电影，画面竖向满幅铺满无黑边',
    '16:9': '16:9标准横屏宽幅构图，B站正片规格',
    '3:4': '3:4竖版画幅构图，源素材规格',
    '4:3': '4:3复古电视画幅构图，回忆闪回质感',
    '21:9': '21:9超宽银幕画幅构图，仙侠大战电影氛围，画面横向满幅铺满无黑边',
    'webtoon': '条漫竖向无限长条画幅，滚动Webtoon分镜画面，非视频画幅',
  };
  function aspectPrompt(aspect) { return ASPECT_PROMPTS[aspect] || ''; }

  /* 摄影参数 → 隐藏提示词：仅保留风格与负面词，灯光/镜头/光圈等摄影术语不再注入 */
  function stylePrompts(p) {
    const parts = [];
    if (p.style) {
      const sp = STYLE_PROMPTS[p.style];
      if (sp) parts.push(sp);
    }
    if (p.negPrompt) parts.push('避免出现：' + p.negPrompt);
    return parts;
  }

  /* 24 种视觉风格 → 隐藏提示词（图片/视频通用，随请求注入，用户输入框不可见） */
  const STYLE_PROMPTS = {
    '写实电影风': '写实电影质感，photorealistic cinematic style，真实光影与材质纹理',
    '写实纪录片风': '写实纪录片风格，documentary realism，手持摄影真实感，自然光源，无摆拍的真实生活质感，纪实质感色彩',
    '广告大片风': '商业广告大片质感，commercial advertising visual，精致棚拍布光，高端时尚构图，干净画面，品牌大片级调色',
    '赛博朋克风': '赛博朋克风格，cyberpunk style，霓虹灯光与雨夜街道，全息投影与广告牌，高饱和蓝紫品红撞色，未来高科技低层生活都市',
    '未来科技风': '未来科技风格，futuristic tech style，极简白色空间，全息UI界面，冷色蓝光，光滑高科技材质，clean sci-fi interior',
    '科幻大片风': '科幻大片风格，sci-fi blockbuster，宏大宇宙与未来场景，史诗级特效场面，IMAX巨幕质感，冷色金属与体积光',
    '暗黑奇幻风': '暗黑奇幻风格，dark fantasy style，中世纪魔法世界，低暗调光影，哥特神秘氛围，厚重史诗质感，暗色调高对比',
    '国风仙侠风': '国风仙侠风格，Chinese xianxia fantasy，古风山水仙境，流云飞瀑与亭台楼阁，汉服衣袂飘逸，东方玄幻唯美光影',
    '日式动画风': '日式动画风格，Japanese anime style，赛璐璐上色 cel shading，干净精致线条，明快平涂色块，新海诚式通透光影',
    '欧美卡通风': '欧美卡通风格，western cartoon style，夸张造型与表情，明快饱和色块，弹性动画质感，美式TV动画画面',
    '3D动画风': '3D动画风格，3D animation render，三维建模质感，柔和全局光照，Octane/Redshift渲染器质感，材质细腻',
    '皮克斯迪士尼风': '皮克斯迪士尼感动画风，Pixar Disney style，温暖3D卡通渲染，可爱大眼睛角色，柔和光影，治愈温暖色彩',
    '黏土定格动画风': '黏土定格动画风格，claymation stop-motion style，黏土材质与手工指纹质感，微缩实景模型，定格动画帧质感',
    '水彩插画风': '水彩插画风格，watercolor illustration style，水彩晕染笔触，纸张纹理，透明柔和色彩，手绘插画质感',
    '油画质感风': '油画质感风格，oil painting style，古典油画笔触，厚重颜料肌理，伦勃朗式布光，文艺复兴写实油画质感',
    '水墨风': '中国水墨风格，Chinese ink wash painting，宣纸墨韵与飞白，大面积留白意境，写意山水，黑白灰墨色层次',
    '蒸汽朋克风': '蒸汽朋克风格，steampunk style，维多利亚时代机械美学，黄铜齿轮与蒸汽管道，复古工业质感，暖铜色调',
    '复古港风': '复古港风，80-90年代香港电影质感，霓虹招牌与雨夜街头，暖黄钨丝灯光，王家卫式浓郁色调',
    '80/90年代复古录像风': '80/90年代复古录像带风格，retro VHS style，录像带噪点与磁迹，CRT扫描线，低饱和怀旧色调，家用磁带摄影机质感',
    'MV视觉风': 'MV音乐录影带视觉风格，music video visual，舞台灯光与酷炫运镜，时尚造型，节奏化画面设计，高质感商业影像',
    '游戏CG风': '游戏CG过场风格，game cinematic CG，虚幻引擎5实时渲染，PBR物理材质，高精度建模，次世代游戏画面质感',
    '悬疑电影风': '悬疑电影风格，mystery thriller style，低调照明，浓重阴影压迫感，冷青色调，大卫·芬奇式暗黑克制影像',
    '恐怖惊悚风': '恐怖惊悚风格，horror thriller style，黑暗环境与诡异光源，不安倾斜构图，高对比度阴影，毛骨悚然的恐怖氛围',
    '治愈系慢镜头风': '治愈系慢镜头风格，healing slow cinema，温暖柔和自然光，慢门动态模糊，清新日系色调，安静唯美',
  };

  /* 各任务专属隐藏提示词 */
  const TRI_PROMPT = '角色设定三视图（character design sheet）：横版长图，画面左侧为人物正面大头照特写（锁骨以上，极致面部细节，清晰皮肤纹理），右侧为同一人物全身三视图——正面视图 front view、正侧面视图 side view profile、背面视图 back view 从左到右等距横向排列；三个视图人物等高等比例、自然站立双手垂于身体两侧，面部五官、发型发色、服装鞋帽、配饰在所有视图中100%一致；纯白摄影棚背景 pure white studio background，平光柔和无硬阴影，full body，高质量角色设定参考图，无多余场景与道具';
  const GRID_PROMPT = '场景镜头九宫格分镜图（3x3 cinematic storyboard grid）：一张图内3列3行紧密排列9个独立画格，同一场景同一主体在9格中保持服装、发型、光线、环境、色彩风格完全一致；镜头按专业电影分镜景别排布——第一行：大远景ELS交代完整环境、全景LS主体完整入画、中全景MLS膝上/四分之三视角；第二行：中景MS腰部以上展现动作、中特写MCU胸上表情清晰、近景CU面部/主体正面特写；第三行：大特写ECU眼睛/手部/材质细节、低角度仰拍营造气势、高角度俯拍俯瞰空间关系；每格独立完整构图，景深随景别真实变化、特写背景自然虚化，照片级质感与统一电影调色';
  const HAND_PROMPT = '手势参考图四宫格：摊开手掌、握拳、兰花指、双指指向四种手型，四格并排横图，简洁纯色背景，手部结构与比例清晰准确，绘画参考图';
  const INPAINT_PROMPT = '局部重绘：仅按描述重绘画面主体区域，其余部分与原画面保持一致';
  function expandPrompt(p) {
    const dirs = { left: '向左', right: '向右', top: '向上', bottom: '向下' };
    const dir = dirs[p.direction || 'right'] || '向右';
    const pct = Math.round((Number(p.ratio) || .5) * 100);
    return `扩图：将画面${dir}扩展约${pct}%画幅，自然延伸场景内容，保持原画面主体、光影与风格一致`;
  }

  /* ---------- 画幅比例 → 实际像素（导出合成画布用，返回 [w,h]） ---------- */
  function composeSize(aspect, size) {
    if (aspect && String(aspect).includes(':')) {
      const [a, b] = String(aspect).split(':').map(Number);
      if (a > 0 && b > 0) {
        const ratio = a / b;
        let h = Math.sqrt(1280 * 720 / ratio);
        let w = h * ratio;
        w = Math.max(64, Math.round(w / 64) * 64);
        h = Math.max(64, Math.round(h / 64) * 64);
        return [w, h];
      }
    }
    const [w, h] = (size || '1280x720').split('x').map(Number);
    return [w || 1280, h || 720];
  }

  /* 时长 → 隐藏提示词（自然语言描述，不使用 --duration 命令行标志） */
  function durationPrompt(duration) {
    const d = Number(duration);
    if (!d || d <= 0) return '';
    return `视频总时长严格控制为 ${d} 秒，叙事节奏与动作完整覆盖 ${d} 秒，不要提前结束，也不要超出时长`;
  }

  /* 组装真实 API 请求参数：把隐藏提示词（画幅/时长/四视图/灯光/镜头等）拼进 prompt 一起发送 */
  function buildRemoteParams(task, params) {
    const p = { ...params };
    const parts = [p.prompt || ''];
    const style = () => parts.push(...stylePrompts(p));
    switch (task) {
      case 'genVideo': {
        const hp = aspectPrompt(p.aspect);
        if (hp) parts.push(hp + '，按此画幅生成视频');
        const dp = durationPrompt(p.duration);
        if (dp) parts.push(dp);
        parts.push(...stylePrompts(p));   // 风格/灯光等隐藏提示词同样作用于视频
        break;
      }
      case 'genTriView': parts.push(TRI_PROMPT); style(); break;
      case 'genGrid': { const hp = aspectPrompt(p.aspect); if (hp) parts.push(hp); parts.push(GRID_PROMPT); style(); break; }
      case 'genHandRef': parts.push(HAND_PROMPT); style(); break;
      case 'genExpand': parts.push(expandPrompt(p)); style(); break;
      case 'genInpaint': parts.push(INPAINT_PROMPT); style(); break;
      default: { const hp = aspectPrompt(p.aspect); if (hp) parts.push(hp); style(); }
    }
    p.prompt = parts.filter(Boolean).join('，');
    p.hiddenPrompt = p.prompt;   // 保留完整提示词字段，便于 API 端识别
    return p;
  }

  /* =====================================================
   * 字节火山 Ark 协议
   * ===================================================== */

  /* 视频文件 → 首帧截图 dataURL（供节点预览与下游拼接） */
  function videoFirstFrame(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.src = url; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
      const fail = () => reject(new Error('视频加载失败'));
      v.onloadeddata = () => { v.currentTime = 0.1; };
      v.onseeked = () => {
        try {
          const c = document.createElement('canvas');
          c.width = v.videoWidth || 720; c.height = v.videoHeight || 1280;
          c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', .82));
        } catch (e) { reject(e); }
      };
      v.onerror = fail;
    });
  }

  /* 官方宽高映射（2K 档）：Seedream 5.0 pro「方式 2」支持指定宽高像素值，
     总像素须落在 [921600, 4624220]、宽高比 [1/16, 16]；下表取自官方参考值 + 等比推导，
     用于让「比例」真正通过 size 落盘出图（而非仅靠提示词文字，否则模型常默认 1:1） */
  const ASPECT_2K = {
    '1:1':   [2048, 2048],
    '4:3':   [2368, 1776],
    '3:4':   [1776, 2368],
    '16:9':  [2816, 1584],
    '9:16':  [1584, 2816],
    '3:2':   [2496, 1664],
    '2:3':   [1664, 2496],
    '21:9':  [3136, 1344],
    '9:21':  [1344, 3136],
    '4:5':   [1792, 2240],
    '5:4':   [2240, 1792],
    '2:1':   [2816, 1408],
    '1:2':   [1408, 2816],
  };

  function aspectSize(aspect, fourK) {
    const a = String(aspect || '1:1');
    let [w, h] = ASPECT_2K[a] || ASPECT_2K['1:1'];
    if (fourK) { w *= 2; h *= 2; }
    return `${w}x${h}`;
  }

  /* OpenAI 兼容生图（agicto 等中转站）：gpt-image 系列只接受固定三档尺寸，
     按所选画幅比例就近映射 1024x1024 / 1536x1024（横）/ 1024x1536（竖）。
     精确画幅仍由 buildRemoteParams 的隐藏提示词辅助描述。 */
  function openAISize(aspect) {
    if (!aspect || typeof aspect !== 'string' || !aspect.includes(':')) return '1024x1024';
    const [w, h] = aspect.split(':').map(Number);
    if (!w || !h) return '1024x1024';
    const r = w / h;
    if (r > 1.15) return '1536x1024';
    if (r < 0.87) return '1024x1536';
    return '1024x1024';
  }

  /* lk888「tt-image-2」等支持任意比例尺寸的 OpenAI 兼容模型：
     把 13 种画幅精确映射为具体分辨率，比例写进 size 而非只靠提示词。
     取值均满足 lk888 规则：宽高 16 的倍数、比例 1:3~3:1、总像素 65.5万~829万、单边 ≤3840 */
  function openAISizeExact(aspect) {
    const MAP = {
      '1:1': '1024x1024',
      '1:2': '960x1920',
      '2:1': '1920x960',
      '9:16': '1088x1920',
      '16:9': '1920x1088',
      '3:4': '960x1280',
      '4:3': '1280x960',
      '3:2': '1536x1024',
      '2:3': '1024x1536',
      '5:4': '1280x1024',
      '4:5': '1024x1280',
      '21:9': '2688x1152',
      '9:21': '1152x2688',
      'webtoon': '1024x1536',
    };
    return MAP[aspect] || '1024x1024';
  }

  /* 尺寸能力封顶：Seedream 5.0 pro 仅支持到 2K（无 4K 档）；
     Seedream 4.0/4.5/5.0 lite 支持 4K。返回该模型可用的最高档位 */
  function imageSizeCap(modelId) {
    return /seedream-5-0-pro/i.test(String(modelId || '')) ? '2K' : '4K';
  }

  /* Ark 生图（文生图 / 图生图编辑：genExpand、genInpaint 传 image 参数）
     单图文生图按所选画幅给具体宽高像素（硬保证比例）；其余任务仍走 2K 档位 */
  // data URL → Blob（用于 multipart 文件上传）
  function dataURLtoBlob(dataURL) {
    const m = dataURL.match(/^data:(image\/[\w+]+);/);
    const mime = m ? m[1] : 'image/png';
    const base64Data = dataURL.split(',')[1];
    const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    return { blob: new Blob([bytes], { type: mime }), ext: (mime.split('/')[1] || 'png').replace('+', '') };
  }

  /* 把 base64 dataURL 转成公网 URL（Seedance/H3 等模型要求素材必须是公网可访问 URL，不支持 base64 内联）。
     已是 http(s) 公网链接则原样返回；否则上传到云端数据仓库拿 raw 直读 URL。
     带缓存：同一 base64 只上传一次。 */
  const _urlCache = new Map();
  async function toPublicUrl(dataURL) {
    if (!dataURL) return '';
    if (/^https?:\/\//i.test(dataURL)) return dataURL;   // 已是公网 URL
    const cached = _urlCache.get(dataURL);
    if (cached) return cached;
    try {
      const url = (window.LC && LC.Cloud) ? await LC.Cloud.toPublicUrl(dataURL) : '';
      if (url && /^https?:\/\//i.test(url)) { _urlCache.set(dataURL, url); return url; }
      console.warn('[toPublicUrl] 上传失败，回退用原 dataURL');
      return dataURL;   // 上传失败回退用原 base64（部分模型可能仍接受）
    } catch (e) {
      console.warn('[toPublicUrl] 上传异常:', e.message);
      return dataURL;
    }
  }

  async function arkImage(cfg, task, params, onProgress) {
    const base = (cfg.url || ARK_BASE).replace(/\/+$/, '');
    const rp = buildRemoteParams(task, params);
    const resolution = String(params.resolution || '').toUpperCase();
    const want4K = task === 'genImage' && (resolution === '4K' || (resolution !== '2K' && Number(params.quality) === 1));
    const use4K = want4K && imageSizeCap(cfg.modelId) === '4K';
    const size = task === 'genImage' ? aspectSize(params.aspect, use4K) : '2K';

    let res;
    if (params.image) {
      // 有参考图 → 走 /images/edits（图生图/编辑端点）
      const imgUrl = params.image;
      if (/^data:/i.test(imgUrl)) {
        // data: 内联 base64 → 转 Blob → multipart 文件上传
        const { blob, ext } = dataURLtoBlob(imgUrl);
        const fd = new FormData();
        fd.append('model', cfg.modelId);
        fd.append('prompt', rp.prompt);
        fd.append('size', size);
        fd.append('response_format', 'b64_json');
        fd.append('watermark', 'false');
        fd.append('image[]', blob, 'reference.' + ext);
        onProgress?.(20);
        res = await fetch(base + '/images/edits', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.key },
          body: fd,
        });
      } else {
        // 公网 http(s) 直链 → JSON + images 数组
        const body = {
          model: cfg.modelId, prompt: rp.prompt, size,
          response_format: 'b64_json', watermark: false,
          images: [{ image_url: imgUrl }],
        };
        onProgress?.(20);
        res = await fetch(base + '/images/edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
          body: JSON.stringify(body),
        });
      }
    } else {
      // 无参考图 → 走 /images/generations（纯文生图端点）
      const body = {
        model: cfg.modelId, prompt: rp.prompt, size,
        response_format: 'b64_json', watermark: false,
      };
      onProgress?.(20);
      res = await fetch(base + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('Ark ' + res.status + (t ? ' · ' + t.slice(0, 160) : ''));
    }
    onProgress?.(85);
    const out = await res.json();
    const d = out.data && out.data[0];
    if (!d) throw new Error('Ark 返回无图片数据');
    let dataURL;
    if (d.b64_json) dataURL = 'data:image/png;base64,' + d.b64_json;
    else if (d.url) {
      const blob = await (await fetch(d.url)).blob();
      dataURL = await blobToDataURL(blob);
    } else throw new Error('Ark 返回格式异常（无 b64_json/url）');
    onProgress?.(100);
    const meta = { prompt: params.prompt, hiddenPrompt: rp.prompt, aspect: params.aspect || '1:1', size: d.size || size, model: cfg.modelId, provider: 'ark', time: U.formatTime() };
    if (task === 'genGrid') meta.grid = params.grid || '3x3';
    if (task === 'genGrid') {
      const [gw, gh] = (params.grid || '3x3').split('x').map(Number);
      const shots = ['远景·固定', '全景·慢推', '中景·环绕', '近景·手持跟拍', '特写·微距', '俯拍·摇镜', '仰拍·移镜', '过肩·固定', '侧面·弧形轨道'];
      meta.cells = Array.from({ length: (gw || 3) * (gh || 3) }, (_, i) => ({
        row: Math.floor(i / (gw || 3)), col: i % (gw || 3), shot: shots[i % shots.length],
      }));
    }
    return { kind: 'image', dataURL, meta };
  }

  /* OpenAI 兼容生图（agicto 等中转站）：POST {base}/images/generations，
     返回 data[0].url（URL 而非 b64_json，需下载转 dataURL）。 */
  async function openaiImage(cfg, task, params, onProgress) {
    const base = (cfg.url || '').replace(/\/+$/, '');
    if (!base) throw new Error('缺少接口地址（请在设置里填写 OpenAI 兼容 Base URL）');
    const rp = buildRemoteParams(task, params);
    const isTtImage = /tt-image/i.test(String(cfg.modelId || ''));
    const isTt25 = /tt-image-2\.5/i.test(String(cfg.modelId || ''));
    console.log('[openaiImage] model=%s params.image类型=%s 长度=%s isTt25=%s',
      cfg.modelId,
      params.image ? (params.image.startsWith('data:') ? 'dataURL' : '非dataURL') : 'null',
      params.image ? params.image.length : 0,
      isTt25);

    // 公共：组装模型/尺寸参数到 body 对象（JSON 端点用）
    function fillJsonBody(b) {
      b.model = cfg.modelId;
      b.prompt = rp.prompt;
      if (isTt25) {
        b.aspect_ratio = params.aspect || '16:9';
        b.resolution = params.imgRes || '2K';
        if (params.imgQuality) b.quality = params.imgQuality;
        if (params.version) b.version = params.version;
        if (params.background && params.background !== 'opaque') b.background = params.background;
      } else {
        b.size = isTtImage ? openAISizeExact(params.aspect) : openAISize(params.aspect);
      }
    }

    // 公共：组装模型/尺寸参数到 FormData（multipart 端点用）
    function fillFormData(fd) {
      fd.append('model', cfg.modelId);
      fd.append('prompt', rp.prompt);
      if (isTt25) {
        fd.append('aspect_ratio', params.aspect || '16:9');
        fd.append('resolution', params.imgRes || '2K');
        if (params.imgQuality) fd.append('quality', params.imgQuality);
        if (params.version) fd.append('version', params.version);
        if (params.background && params.background !== 'opaque') fd.append('background', params.background);
      } else {
        fd.append('size', isTtImage ? openAISizeExact(params.aspect) : openAISize(params.aspect));
      }
    }

    let res;
    if (params.image) {
      // 有参考图 → 走 /images/edits（图生图/编辑端点）
      const imgUrl = params.image;
      if (/^data:/i.test(imgUrl)) {
        // data: 内联 base64 → 转 Blob → multipart 文件上传
        const { blob, ext } = dataURLtoBlob(imgUrl);
        const fd = new FormData();
        fillFormData(fd);
        // TT Image 2 用 image（单数，OpenAI 兼容协议），TT Image 2.5 用 image[]（复数）。
        // 两者不可混传：混传时后端优先读单数 image 字段，会把复数 image[] 里的参考图忽略掉
        fd.append(isTt25 ? 'image[]' : 'image', blob, 'reference.' + ext);
        onProgress?.(20);
        res = await fetch(base + '/images/edits', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.key },
          body: fd,
        });
      } else {
        // 公网 http(s) 直链 → JSON + images 数组
        const body = {};
        fillJsonBody(body);
        body.images = [{ image_url: imgUrl }];
        onProgress?.(20);
        res = await fetch(base + '/images/edits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
          body: JSON.stringify(body),
        });
      }
    } else {
      // 无参考图 → 走 /images/generations（纯文生图端点）
      const body = {};
      fillJsonBody(body);
      onProgress?.(20);
      res = await fetch(base + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('OpenAI ' + res.status + (t ? ' · ' + t.slice(0, 160) : ''));
    }
    onProgress?.(85);
    const out = await res.json();
    const d = out.data && out.data[0];
    if (!d) throw new Error('OpenAI 返回无图片数据');
    let dataURL;
    if (d.b64_json) {
      const mime = d.b64_json.startsWith('iVBOR') ? 'image/png'
        : d.b64_json.startsWith('/9j/') ? 'image/jpeg'
        : d.b64_json.startsWith('UklGR') ? 'image/webp' : 'image/png';
      dataURL = 'data:' + mime + ';base64,' + d.b64_json;
    } else if (d.url) {
      const blob = await (await fetch(d.url)).blob();
      dataURL = await blobToDataURL(blob);
    } else throw new Error('OpenAI 返回格式异常（无 b64_json/url）');
    onProgress?.(100);
    const meta = { prompt: params.prompt, hiddenPrompt: rp.prompt, aspect: params.aspect || '1:1', size: isTt25 ? (params.imgRes || '2K') : (isTtImage ? openAISizeExact(params.aspect) : openAISize(params.aspect)), model: cfg.modelId, provider: 'openai', time: U.formatTime() };
    if (task === 'genGrid') {
      meta.grid = params.grid || '3x3';
      const [gw, gh] = (params.grid || '3x3').split('x').map(Number);
      const shots = ['远景·固定', '全景·慢推', '中景·环绕', '近景·手持跟拍', '特写·微距', '俯拍·摇镜', '仰拍·移镜', '过肩·固定', '侧面·弧形轨道'];
      meta.cells = Array.from({ length: (gw || 3) * (gh || 3) }, (_, i) => ({
        row: Math.floor(i / (gw || 3)), col: i % (gw || 3), shot: shots[i % shots.length],
      }));
    }
    return { kind: 'image', dataURL, meta };
  }

  /* Ark 文本模型（chat/completions）：脚本拆分镜 / 图片逆向提示词 / 合规校验 */
  async function arkChat(cfg, task, params, onProgress) {
    const base = (cfg.url || ARK_BASE).replace(/\/+$/, '');
    let user = '', imageUrl = '';
    if (task === 'scriptToShots') {
      const count = Number(params.shotCount) || 8;
      const dur = Number(params.shotDuration) || 8;
      user = `你是专业的短剧分镜导演。请把下面的剧本拆解为分镜脚本，要求：\n`
        + `- 尽量拆出接近 ${count} 个镜头（内容自然划分优先）\n`
        + `- 每个镜头约 ${dur} 秒，风格：${params.style || '通用'}\n`
        + `- 输出严格的 JSON 数组，每个元素包含字段：no(镜头序号整数)、size(景别：远景/全景/中景/近景/特写)、move(运镜方式)、lens(镜头焦段)、desc(画面描述：人物动作、表情与场景，80字内)、dialogue(台词原文，没有则空字符串)、duration(秒数)\n`
        + `- 只输出 JSON 数组本身，不要任何其他文字\n\n剧本：${params.prompt || ''}`;
    } else if (task === 'reverseImage') {
      user = '你是专业的 AI 绘画提示词工程师。请分析这张图片，直接输出一段可用于 AI 生图的中文提示词（包含画面主体、艺术风格、光影、色调、构图、镜头感，80字内）。只输出提示词本身，不要解释。';
      imageUrl = params.prompt || '';
    } else {
      const rules = (params.rules && params.rules.length ? params.rules : ['版权', '敏感词', '暴力', '肖像']).join('、');
      user = `你是内容合规审核员。请按以下规则逐项检查文本：${rules}。\n`
        + `输出严格的 JSON 对象：{"pass": true或false, "report": [{"rule":"命中的规则名","level":"warn或error","hits":["命中的具体词句"]}]}，无风险时 report 为空数组。只输出 JSON。\n\n待审核文本：${params.prompt || ''}`;
    }
    const content = imageUrl
      ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: imageUrl } }]
      : user;
    onProgress?.(15);
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({ model: cfg.modelId, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('Ark ' + res.status + (t ? ' · ' + t.slice(0, 160) : ''));
    }
    onProgress?.(80);
    const out = await res.json();
    const text = out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content;
    if (!text) throw new Error('模型未返回内容');
    onProgress?.(100);

    if (task === 'scriptToShots') {
      const j = extractJSON(text);
      const shots = Array.isArray(j) ? j : (j && Array.isArray(j.shots) ? j.shots : null);
      if (!shots || !shots.length) throw new Error('分镜解析失败（模型输出不是有效 JSON），请重试或更换文本模型');
      const dur = Number(params.shotDuration) || 8;
      const list = shots.slice(0, 60).map((s, i) => ({
        no: Number(s.no) || i + 1,
        size: s.size || '中景', move: s.move || '固定', lens: s.lens || '50mm',
        desc: String(s.desc || '').slice(0, 200),
        dialogue: String(s.dialogue || '').slice(0, 120),
        duration: Number(s.duration) || dur,
      }));
      return { kind: 'shots', shots: list, count: list.length, meta: { shotCount: params.shotCount, duration: dur, style: params.style || '', model: cfg.modelId, time: U.formatTime() } };
    }
    if (task === 'reverseImage') {
      return { kind: 'text', text: String(text).trim().slice(0, 600), meta: { type: '逆向提示词', model: cfg.modelId, time: U.formatTime() } };
    }
    /* compliance */
    const j = extractJSON(text) || {};
    const report = (Array.isArray(j.report) ? j.report : []).map((r) => ({
      rule: r.rule || '其他', level: r.level === 'error' ? 'error' : 'warn',
      hits: Array.isArray(r.hits) ? r.hits.map(String) : (r.hits ? [String(r.hits)] : []),
    })).filter((r) => r.hits.length || r.rule);
    const pass = typeof j.pass === 'boolean' ? j.pass : report.length === 0;
    return { kind: 'report', pass, report, text: String(params.prompt || '').slice(0, 800), meta: { model: cfg.modelId, time: U.formatTime() } };
  }

  /* Ark 语音（字节火山 openspeech V3 HTTP）：配音 / BGM / 音效 */
  async function arkTTS(cfg, params, onProgress) {
    const url = (cfg.url || TTS_URL).replace(/\/+$/, '');
    const text = String(params.prompt || '').slice(0, 2000);
    if (!text) throw new Error('缺少配音文本');
    /* mode：voice=配音（拼音色描述）；bgm/sfx=音乐音效（直接给生成描述） */
    const isSpeech = !params.mode || params.mode === 'voice';
    const voiceDesc = isSpeech && params.voice ? `用「${params.voice}」的音色与语气朗读以下内容：` : '';
    onProgress?.(20);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': cfg.key },
      body: JSON.stringify({
        model: cfg.modelId || 'seed-audio-1.0',
        text_prompt: voiceDesc + text,
        audio_config: { format: 'mp3' },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('语音接口 ' + res.status + (t ? ' · ' + t.slice(0, 160) : ''));
    }
    const out = await res.json();
    if (out.code != null && out.code !== 200) throw new Error('语音合成失败：' + (out.message || out.code));
    let dataURL = '';
    if (out.audio) dataURL = 'data:audio/mp3;base64,' + out.audio;
    else if (out.url) dataURL = await blobToDataURL(await (await fetch(out.url)).blob());
    else throw new Error('语音接口未返回音频数据');
    onProgress?.(100);
    return {
      kind: 'audio', dataURL, voice: params.voice || cfg.name,
      duration: Number(out.duration) || Math.max(2, Math.round(text.length / 4)),
      meta: { type: 'AI 音频', model: cfg.modelId || 'seed-audio-1.0', time: U.formatTime() },
    };
  }

  /* lk888 / 22Ai 状态响应解包：API 将业务字段包在 data 信封里
     （创建时 cj.data.task_id 已处理，但状态轮询也必须解包，
     否则 st.state / st.result_url 等全部读到 undefined → 永远检测不到完成） */
  function unwrapStatus(st) {
    if (!st) return {};
    if (st.data && typeof st.data === 'object' && !Array.isArray(st.data)) return st.data;
    return st;
  }

  /* =====================================================
   * lk888 / 22Ai 媒体协议图片（TT Image 2 系列）：
   * 创建 POST /v1/media/generate（code==200 成功，task_id 在 data.task_id）；
   * 轮询 GET /v1/skills/task-status（裸对象，顶层 state/is_final/result_url，success 即成功）。
   * 参考图统一走 params.images 数组（data:<mime>;base64 内联或公网 URL），
   * 是图生图/参考图的正规通道（OpenAI /images/edits 仅支持 multipart 文件或公网 URL）。
   * ===================================================== */
  async function lk888MediaImage(cfg, task, params, onProgress) {
    const base = LK_MEDIA_BASE;
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key };
    const rp = buildRemoteParams(task, params);
    const modelId = String(cfg.modelId || '');
    const isTt25 = /2\.5/i.test(modelId);   // tt-image-2.5 / tt-image-2.5-token
    const isBanana = /banana-pro/i.test(modelId);   // 纳米香蕉 Pro：用 aspectRatio + imageSize

    /* 参考图：统一 images 数组（支持多图参考/多图融合），单图兼容 params.image。
       images 必须是数组——复数名参数传字符串会被部分模型判为格式错误 */
    const refImgs = [
      ...(Array.isArray(params.images) ? params.images : []),
      params.image,
    ].filter(Boolean).slice(0, isTt25 || isBanana ? 16 : 14);

    /* tt-image-2 用 size；tt-image-2.5/token 用 version + aspect_ratio + resolution；banana-pro 用 aspectRatio + imageSize */
    const pv = {};
    let size = 'auto';
    if (isBanana) {
      const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
      pv.aspectRatio = ratios.includes(String(params.aspect)) ? params.aspect : '1:1';
      pv.imageSize = params.imgRes || '2K';
    } else if (isTt25) {
      const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '2:1', '1:2', '21:9', '9:21'];
      pv.version = params.version || 'flare';
      pv.aspect_ratio = ratios.includes(String(params.aspect)) ? params.aspect : 'auto';
      // 分辨率：用户动态档位（自适应/1K/2K/4K），默认 2K；自适应时两者都跟随 auto
      pv.resolution = params.imgRes || '2K';
      if (pv.resolution === 'auto') { pv.aspect_ratio = 'auto'; }
      // 2.5 画质：默认 medium（文档推荐 auto，但用户要求自选，这里由档位/默认 medium 控制，不强制 xhigh）
      pv.quality = params.imgQuality || 'medium';
      if (params.background && params.background !== 'opaque') pv.background = params.background;
    } else {
      size = params.aspect ? openAISizeExact(params.aspect) : 'auto';
      pv.size = size;
      // tt-image-2：画质由用户手动选（high/medium/low），默认 high，明确不自动
      pv.quality = params.imgQuality || 'high';
    }
    if (refImgs.length) pv.images = refImgs;

    console.log('[lk888MediaImage] model=%s isTt25=%s images=%d',
      modelId, isTt25, refImgs.length);

    onProgress?.(8);
    const create = await fetch(base + '/v1/media/generate', {
      method: 'POST', headers,
      body: JSON.stringify({ model: modelId, prompt: rp.prompt, params: pv }),
    });
    if (!create.ok) {
      const t = await create.text().catch(() => '');
      throw new Error('创建图片任务失败 HTTP ' + create.status + (t ? ' · ' + t.slice(0, 160) : ''));
    }
    const cj = await create.json().catch(() => null);
    if (cj && cj.code != null && cj.code !== 200) {
      throw new Error('创建图片任务失败：' + (cj.msg || '') + JSON.stringify(cj.data || {}).slice(0, 120));
    }
    const taskId = (cj && cj.data && cj.data.task_id != null) ? cj.data.task_id
      : ((cj && cj.task_id != null) ? cj.task_id : null);
    if (taskId == null) throw new Error('接口未返回 task_id：' + JSON.stringify(cj).slice(0, 120));
    // 注册第三方任务：刷新后据此续轮询原任务（不重新生成）
    noteExtTask({ proto: 'lk888-media', base, modelId, modelName: cfg.name, kind: 'image', extTaskId: taskId, ratio: params.aspect || '1:1' });

    /* 轮询：4s 间隔，上限 10 分钟（图片通常 20 秒 ~ 2 分钟，含 COS 转存） */
    let resultURL = '';
    for (let i = 0; i < 150; i++) {
      await U.sleep(4000);
      let st = null;
      try {
        const res = await fetch(base + '/v1/skills/task-status?task_id=' + encodeURIComponent(taskId), { headers });
        if (res.ok) st = await res.json();
      } catch (e) { /* 网络抖动：继续轮询 */ }
      if (!st) continue;
      const sd = unwrapStatus(st);
      const pct = Number(String(sd.progress || '').replace('%', '')) || 0;
      onProgress?.(pct ? Math.min(90, 8 + pct * 0.82) : Math.min(90, 10 + i));
      if (sd.state === 'failed' || sd.error) {
        throw new Error('图片任务失败：' + (sd.error || sd.status || '未知原因（费用已自动退款）'));
      }
      if (sd.is_final === true || sd.state === 'success') {
        resultURL = sd.result_url || sd.url || '';
        break;
      }
    }
    if (!resultURL) throw new Error('图片任务超时（10 分钟）');
    onProgress?.(93);

    const blob = await (await fetch(resultURL)).blob();
    const dataURL = await blobToDataURL(blob);
    onProgress?.(100);
    const meta = {
      prompt: params.prompt, hiddenPrompt: rp.prompt, aspect: params.aspect || '1:1',
      size, model: modelId, provider: 'lk888', time: U.formatTime(),
    };
    return { kind: 'image', dataURL, meta };
  }

  /* =====================================================
   * lk888 / 22Ai 媒体协议视频（统一 ViduQ3 / MiniMax H3 / Seedance 2.0 / 2.5）
   * 创建：POST {LK_MEDIA_BASE}/v1/media/generate  body { model, prompt, params }
   *       （唯一用 {code,msg,data} 信封的接口，code==200 才成功，task_id 在 data.task_id）
   * 轮询：GET  {LK_MEDIA_BASE}/v1/skills/task-status?task_id=  → 裸对象（无信封）
   *       字段在顶层 state / is_final / progress / result_url / error；success 是 success（不是 succeeded）
   * 参考素材参数（参考图/视频/音频丢失问题的权威解法，按各模型 params 表）：
   *   - ViduQ3：images 数组（1~7 张参考图，底层无 mode）
   *   - H3 / Seedance：mode=cankaosheng → image_url（参考图）/ video_url（参考视频）/ audio_url（参考音频）
   *                    mode=shouweizhen（首尾帧）→ images（1~2 张：第 1 首帧、第 2 尾帧）
   *   - 图片/音频支持 data:<mime>;base64 内联直传（免图床，杜绝过期/被墙/被上游下载失败）
   *   - 视频不支持 base64，必须公网 URL（toPublicUrl 转直链）
   * ===================================================== */
  async function lk888MediaVideo(cfg, params, onProgress) {
    const base = LK_MEDIA_BASE;
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key };
    const modelId = lkModelName(cfg.modelId);
    const isVidu = /viduq3/i.test(modelId);
    const isSeed = /seedance/i.test(modelId);
    const isSeed25 = /seedance.*2\.5|2-5/i.test(modelId);
    const mode = (params.mode === 'shouweizhen' || params.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';

    /* 参考素材上限（按各模型 params 表） */
    const capImg = isVidu ? 7 : (isSeed25 ? 30 : (isSeed ? 9 : 9));
    const capVid = isSeed25 ? 10 : (isSeed ? 3 : 3);
    const capAud = isSeed25 ? 10 : (isSeed ? 3 : 3);
    const maxDur = isSeed25 ? 30 : 15;

    const pv = {};
    if (isVidu) {
      // Vidu Q3 Turbo：images 数组参考图（不传图自动文生）；resolution 小写带 p；aspect_ratio 限 5 值；duration 3~16
      const resMap = { '540P': '540p', '720P': '720p', '768P': '720p', '1080P': '1080p', '4K': '1080p' };
      pv.resolution = resMap[params.resolution] || '720p';
      const ar = String(params.aspect || '16:9');
      pv.aspect_ratio = ['16:9', '9:16', '3:4', '4:3', '1:1'].includes(ar) ? ar : '16:9';
      pv.duration = String(Math.min(16, Math.max(3, Number(params.duration) || 5)));
      // ViduQ3 的 images 本身就是参考图（无首尾帧语义），合并 refImages + images 以防任一模式漏图
      const vImgs = [...(params.refImages || []), ...(params.images || [])].filter(Boolean);
      if (vImgs.length) pv.images = vImgs.slice(0, 7);
    } else {
      // H3 / Seedance 全形态：mode + image_url / video_url / audio_url；首尾帧用 images
      const resMap = isSeed
        ? { '480P': '480p', '720P': '720p', '1080P': '1080p', '4K': '4K' }
        : { '720P': '768P', '768P': '768P', '1080P': '1080P', '2K': '2K', '4K': '4K' };
      pv.resolution = resMap[params.resolution] || (isSeed ? '720p' : '768P');
      pv.aspect_ratio = params.aspect || 'adaptive';
      pv.duration = String(Math.min(maxDur, Math.max(4, Number(params.duration) || 5)));

      const ffImgs = (params.images || []).filter(Boolean);
      const refImgs = (params.refImages || []).filter(Boolean);
      if (mode === 'shouweizhen') {
        pv.mode = 'shouweizhen';
        if (ffImgs.length) pv.images = ffImgs.slice(0, 2);   // 第 1 张首帧、第 2 张尾帧
      } else if (mode === 'cankaosheng') {
        pv.mode = 'cankaosheng';
        if (refImgs.length) pv.image_url = refImgs.slice(0, capImg);
        const refVids = await Promise.all((params.refVideos || []).map(toPublicUrl));
        const vids = refVids.filter(Boolean).slice(0, capVid);
        if (vids.length) pv.video_url = vids;
        const auds = (params.refAudios || []).filter(Boolean).slice(0, capAud);
        if (auds.length) pv.audio_url = auds;
      } else {
        /* 纯文生（t2v）：正常不带素材；若意外带回参考图也绝不丢图，按参考生处理 */
        if (refImgs.length) { pv.mode = 'cankaosheng'; pv.image_url = refImgs.slice(0, capImg); }
      }
    }

    /* 提示词：仅拼风格等隐藏提示词；画幅/时长走显式参数 */
    const prompt = [params.prompt || '', ...stylePrompts(params)].filter(Boolean).join('，');

    /* 参考图内容指纹诊断：确认 N 张不同参考图不会被上游塌缩成同一张 */
    const _fp = (s) => (typeof s === 'string' ? (s.slice(0, 14) + '…' + s.slice(-10) + '[' + s.length + ']') : '?');
    console.log('[lk888MediaVideo] model=%s mode=%s 参考图=%d 首尾帧=%d 参考视频=%d 参考音频=%d%s',
      modelId, mode,
      (params.refImages || []).length, (params.images || []).length,
      (params.refVideos || []).length, (params.refAudios || []).length,
      (pv.image_url && pv.image_url.length) ? ' → image_url: ' + pv.image_url.map(_fp).join(' | ') : '');

    onProgress?.(8);
    const create = await fetch(base + '/v1/media/generate', {
      method: 'POST', headers,
      body: JSON.stringify({ model: modelId, prompt, params: pv }),
    });
    if (!create.ok) {
      const t = await create.text().catch(() => '');
      throw new Error('创建视频任务失败 HTTP ' + create.status + (t ? ' · ' + t.slice(0, 200) : ''));
    }
    const cj = await create.json().catch(() => null);
    if (cj && cj.code != null && cj.code !== 200) {
      throw new Error('创建视频任务失败：' + ((cj.msg || cj.message) || '') + JSON.stringify(cj.data || {}).slice(0, 160));
    }
    const taskId = (cj && cj.data && cj.data.task_id != null) ? cj.data.task_id
      : ((cj && cj.task_id != null) ? cj.task_id : null);
    if (taskId == null) throw new Error('接口未返回 task_id：' + JSON.stringify(cj).slice(0, 200));
    // 注册第三方任务：刷新后据此续轮询原任务（不重新生成）
    noteExtTask({ proto: 'lk888-media', base, modelId, modelName: cfg.name, kind: 'video', extTaskId: taskId, duration: pv.duration, resolution: pv.resolution, ratio: pv.aspect_ratio, mode });

    /* 轮询：5s 间隔，上限 60 分钟（视频常见 25~80 分钟，seedance 排队更久；is_final=false 就一直等） */
    let resultURL = '';
    for (let i = 0; i < 720; i++) {
      await U.sleep(5000);
      let st = null;
      try {
        const res = await fetch(base + '/v1/skills/task-status?task_id=' + encodeURIComponent(taskId), { headers });
        if (res.ok) st = await res.json();
      } catch (e) { /* 网络抖动：继续轮询 */ }
      if (!st) continue;
      const sd = unwrapStatus(st);
      const pct = Number(String(sd.progress || '').replace('%', '')) || 0;
      onProgress?.(pct ? Math.min(90, 8 + pct * 0.85) : Math.min(90, 8 + Math.round(i / 8)));
      if (sd.error) {
        const em = typeof sd.error === 'string' ? sd.error : (sd.error.message || JSON.stringify(sd.error));
        throw new Error('视频任务失败：' + em);
      }
      if (sd.is_final === true) {
        if (sd.state === 'success') { resultURL = sd.result_url || sd.url || ''; break; }
        throw new Error('视频任务失败：' + (sd.state || 'unknown'));
      }
    }
    if (!resultURL) throw new Error('视频任务超时（60 分钟）');
    onProgress?.(93);

    /* 取回成片 → dataURL（可持久化）+ 首帧封面 */
    const blob = await (await fetch(resultURL)).blob();
    const dataURL = await blobToDataURL(blob);
    let frame = '';
    try { frame = await videoFirstFrame(dataURL); } catch (e) { /* 首帧失败不阻塞 */ }
    onProgress?.(100);
    return {
      kind: 'video', dataURL, blob,
      frames: frame ? [frame] : [],
      duration: Number(params.duration) || 5,
      meta: {
        prompt: params.prompt, model: cfg.modelId, provider: 'lk888',
        mode: isVidu
          ? ((params.refImages && params.refImages.length) ? '参考生 · Vidu Q3' : '文生 · Vidu Q3')
          : (mode === 'shouweizhen' ? '首尾帧 · ' + (isSeed ? 'Seedance' : 'H3') : mode === 'cankaosheng' ? '参考生 · ' + (isSeed ? 'Seedance' : 'H3') : '文生视频 · ' + (isSeed ? 'Seedance' : 'H3')),
        aspect: params.aspect, resolution: pv.resolution,
        duration: Number(params.duration), videoURL: resultURL, time: U.formatTime(),
      },
    };
  }

  /* =====================================================
   * 火山 Ark anmiao 按秒版视频协议（Seedance 2.0 Pro / 2.5 Pro）
   *   创建：POST {base}/contents/generations/tasks
   *   查询：GET  {base}/contents/generations/tasks/{id}
   *   终态：status === 'succeeded' → content.video_url
   * ===================================================== */
  async function anmiaoVideo(cfg, params, onProgress) {
    const base = (cfg.url || 'https://api.lk888.ai/api/v3').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key };
    const is25 = /seedance.*2\.5|seedance-2-5/i.test(String(cfg.modelId || ''));
    onProgress?.(3);
    /* 火山方舟格式：图片/音频支持 data:base64 内联直传（免图床中转，杜绝图床被墙/过期导致参考图丢失）；
       视频不支持 base64，必须公网 URL，故只有参考视频走 toPublicUrl 转直链。 */
    const mode = (params.mode === 'shouweizhen' || params.mode === 'i2v') ? 'shouweizhen' : 'cankaosheng';
    const imgsFF = (mode === 'shouweizhen' ? (params.images || []).slice(0, 2) : []).filter(Boolean);
    const imgsRF = (mode === 'cankaosheng' ? (params.refImages || []).slice(0, 30) : []).filter(Boolean);
    const audsRF = (mode === 'cankaosheng' ? (params.refAudios || []).slice(0, 10) : []).filter(Boolean);
    const vidsRF = await Promise.all((mode === 'cankaosheng' ? (params.refVideos || []).slice(0, 10) : []).map(toPublicUrl));
    /* 组装 content 数组：text + first_frame/last_frame + reference_image/video/audio */
    const content = [];
    const prompt = [params.prompt || '', ...stylePrompts(params)].filter(Boolean).join('\n');
    if (prompt) content.push({ type: 'text', text: prompt });
    if (mode === 'shouweizhen' && imgsFF.length) {
      content.push({ type: 'image_url', role: 'first_frame', image_url: { url: imgsFF[0] } });
      if (imgsFF.length > 1 && imgsFF[1]) {
        content.push({ type: 'image_url', role: 'last_frame', image_url: { url: imgsFF[1] } });
      }
    }
    if (mode === 'cankaosheng') {
      imgsRF.forEach(u => content.push({ type: 'image_url', role: 'reference_image', image_url: { url: u } }));
      vidsRF.forEach(u => content.push({ type: 'video_url', role: 'reference_video', video_url: { url: u } }));
      audsRF.forEach(u => content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url: u } }));
    }
    /* 分辨率映射：720P → 720p, 4K → 4k（2.5 最高 1080p，4K 会被 API 拒绝） */
    const resMap = { '480P': '480p', '720P': '720p', '1080P': '1080p', '4K': '4k' };
    const resolution = resMap[params.resolution] || '720p';
    /* 比例：直接透传，空值用 adaptive */
    const ratio = params.aspect || 'adaptive';
    /* 时长：2.5 支持 4~30 秒，2.0 支持 4~15 秒 */
    const maxDur = is25 ? 30 : 15;
    const duration = Math.min(maxDur, Math.max(4, Math.floor(Number(params.duration) || 5)));

    onProgress?.(8);
    const create = await fetch(base + '/contents/generations/tasks', {
      method: 'POST', headers,
      body: JSON.stringify({ model: cfg.modelId, content, resolution, ratio, duration }),
    });
    const createText = await create.text().catch(() => '');
    let createBody = null;
    try { createBody = createText ? JSON.parse(createText) : null; } catch (e) {}
    if (!create.ok) {
      const errDetail = (createBody && createBody.error && (createBody.error.message || createBody.error.code)) || createText;
      throw new Error('创建视频任务失败 HTTP ' + create.status + (errDetail ? ' · ' + errDetail.slice(0, 160) : ''));
    }
    const cj = createBody;
    const taskId = cj && cj.id != null ? String(cj.id) : null;
    if (!taskId) throw new Error('接口未返回任务 id：' + JSON.stringify(cj).slice(0, 120));
    // 注册第三方任务：刷新后据此续轮询原任务（不重新生成）
    noteExtTask({ proto: 'anmiao', base, modelId: cfg.modelId, modelName: cfg.name, kind: 'video', extTaskId: taskId, duration, resolution, ratio, mode });

    /* 轮询：5s 间隔，上限 15 分钟；状态大小写兼容（succeeded/SUCCEEDED） */
    let videoURL = '';
    for (let i = 0; i < 180; i++) {
      await U.sleep(5000);
      let st = null;
      try {
        const res = await fetch(base + '/contents/generations/tasks/' + encodeURIComponent(taskId), { headers });
        if (res.ok) st = await res.json();
      } catch (e) { /* 网络抖动：继续轮询 */ }
      if (!st) continue;
      onProgress?.(Math.min(90, 10 + i * 0.4));
      const sts = String((st && st.status) || '').toLowerCase();
      if (sts === 'failed') {
        const errMsg = (st.error && (st.error.message || st.error.code)) || '未知原因（费用已自动退款）';
        throw new Error('视频任务失败：' + errMsg);
      }
      if (sts === 'succeeded') {
        videoURL = (st.content && st.content.video_url) || '';
        break;
      }
    }
    if (!videoURL) throw new Error('视频任务超时（15 分钟）');
    onProgress?.(93);

    /* 取回成片 → dataURL + 首帧封面：带超时与重试（大 MP4 下载偶发卡住会导致界面一直 99%） */
    let blob = null;
    for (let a = 0; a < 3 && !blob; a++) {
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), 180000);
        const resp = await fetch(videoURL, { signal: ctl.signal });
        blob = resp.ok ? await resp.blob() : null;
        clearTimeout(tm);
      } catch (e) { blob = null; }
    }
    if (!blob) throw new Error('成片下载失败（网络超时，任务实际已完成）。请重新运行节点，或直接用链接下载：' + videoURL);
    const dataURL = await blobToDataURL(blob);
    let frame = '';
    try { frame = await videoFirstFrame(dataURL); } catch (e) { /* 首帧失败不阻塞 */ }
    onProgress?.(100);
    return {
      kind: 'video', dataURL, blob,
      frames: frame ? [frame] : [],
      duration,
      meta: {
        prompt: params.prompt, model: cfg.modelId, provider: 'anmiao',
        mode: mode === 'shouweizhen' ? '首尾帧 · SD' + (is25 ? '2.5' : '2.0') : mode === 'cankaosheng' ? '参考生 · SD' + (is25 ? '2.5' : '2.0') : '文生视频 · SD' + (is25 ? '2.5' : '2.0'),
        aspect: params.aspect, resolution,
        duration, videoURL, time: U.formatTime(),
      },
    };
  }

  /* =====================================================
   * 本地工具任务（非 AI 生成：纯画布裁剪 / 视频拼接合成）
   * ===================================================== */

  /* 宫格提取单格（几何裁剪，不经过 AI） */
  async function extractGridCell(params) {
    const out = params.gridOutput;
    const [gw, gh] = out.meta.grid.split('x').map(Number);
    const img = await loadImg(out.dataURL);
    const cw = img.width / gw, chh = img.height / gh;
    const c = document.createElement('canvas');
    c.width = Math.round(cw); c.height = Math.round(chh);
    c.getContext('2d').drawImage(img, (params.index % gw) * cw, Math.floor(params.index / gw) * chh, cw, chh, 0, 0, c.width, c.height);
    const cell = out.meta.cells[params.index];
    return { kind: 'image', dataURL: c.toDataURL('image/png'), meta: { ...out.meta, cell, source: 'grid-extract' } };
  }

  /* 合成成片：canvas 实时绘制 + MediaRecorder 导出 webm。
     有真实视频源（Ark 生成 / 本地上传）时按实际内容逐段播放合成；
     无视频源时退化为首帧图 Ken Burns 动效。 */
  async function composeVideo(params, onProgress) {
    const clips = (params.clips || []).filter((c) => c.src || c.frame);
    if (!clips.length) throw new Error('没有可拼接的视频素材');
    const fps = Number(params.fps) || 25;
    const [W, H] = composeSize(params.aspect, '1280x720');
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const cx = canvas.getContext('2d');
    const rec = new MediaRecorder(canvas.captureStream(fps), { mimeType: 'video/webm', videoBitsPerSecond: 4000000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });

    /* 预载素材 */
    onProgress?.(2);
    for (const c of clips) {
      if (c.src) {
        c.vid = document.createElement('video');
        c.vid.muted = true; c.vid.playsInline = true; c.vid.preload = 'auto'; c.vid.src = c.src;
        await new Promise((r) => { c.vid.onloadeddata = r; c.vid.onerror = r; setTimeout(r, 8000); });
      } else if (c.frame) {
        c.img = await loadImg(c.frame);
      }
    }
    const durOf = (c) => (c.vid && isFinite(c.vid.duration) && c.vid.duration > 0 ? c.vid.duration : (Number(c.duration) || 6));
    const totalDur = clips.reduce((s, c) => s + durOf(c), 0);

    const badge = (i) => {
      cx.fillStyle = 'rgba(5,7,14,.5)'; cx.fillRect(10, H - 42, 180, 30);
      cx.fillStyle = '#dfe4ff'; cx.font = '15px sans-serif';
      cx.fillText(`镜头 ${i + 1} / ${clips.length}`, 22, H - 21);
    };
    const drawContain = (dr, zoom = 1, py = 0) => {
      const iw = dr.videoWidth || dr.width, ih = dr.videoHeight || dr.height;
      if (!iw || !ih) return;
      const ir = iw / ih, cr = W / H;
      let bw, bh;
      if (ir > cr) { bw = W; bh = W / ir; } else { bh = H; bw = H * ir; }
      const dw = bw * zoom, dh = bh * zoom;
      cx.drawImage(dr, (W - dw) / 2, (H - dh) / 2 - py * (dh - H) / 2, dw, dh);
    };

    rec.start(200);
    let played = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const d = durOf(c);
      if (c.vid && isFinite(c.vid.duration) && c.vid.duration > 0) {
        /* 真实视频：实时播放逐帧绘制 */
        c.vid.currentTime = 0;
        try { await c.vid.play(); } catch (e) { /* 继续用首帧图方式 */ }
        await new Promise((resolve) => {
          const step = () => {
            cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
            drawContain(c.vid);
            badge(i);
            onProgress?.(Math.min(98, 2 + ((played + (c.vid.currentTime || 0)) / totalDur) * 96));
            if (c.vid.ended || c.vid.paused) return resolve();
            requestAnimationFrame(step);
          };
          c.vid.onended = () => resolve();
          requestAnimationFrame(step);
        });
        c.vid.pause();
      } else {
        /* 首帧图 / 无源：Ken Burns 动效播满时长 */
        await new Promise((resolve) => {
          const st = performance.now();
          const step = () => {
            const p = Math.min(1, (performance.now() - st) / 1000 / d);
            cx.fillStyle = '#000'; cx.fillRect(0, 0, W, H);
            if (c.img) drawContain(c.img, 1.08 + p * .18, (.3 + p * .6) * .5);
            else if (c.vid) drawContain(c.vid, 1.08 + p * .18, (.3 + p * .6) * .5);
            else { cx.fillStyle = '#889'; cx.font = '20px sans-serif'; cx.fillText('镜头 ' + (i + 1), W / 2 - 60, H / 2); }
            badge(i);
            onProgress?.(Math.min(98, 2 + ((played + p * d) / totalDur) * 96));
            if (p >= 1) return resolve();
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
      }
      played += d;
    }
    rec.stop();
    const blob = await stopped;
    const dataURL = URL.createObjectURL(blob);
    onProgress?.(100);
    return { kind: 'video', dataURL, blob, duration: totalDur, meta: { clips: clips.length, fps, totalDur, time: U.formatTime() } };
  }

  /* =====================================================
   * 统一调度：全程真实 API，未配置模型直接报错（不回退本地）
   * ===================================================== */
  const TASK_KIND = {
    genImage: 'image', genGrid: 'image', genTriView: 'image', genHandRef: 'image',
    genExpand: 'image', genInpaint: 'image',
    genVideo: 'video',
    scriptToShots: 'text', reverseImage: 'text', compliance: 'text',
    tts: 'tts',
  };
  const KIND_TIP = { image: '生图模型', video: '视频模型', text: '文本模型', tts: '语音模型' };

  AI.run = async function (task, params = {}, onProgress, presetTaskId) {
    /* 本地工具任务（非 AI 生成） */
    if (task === 'extractGridCell') return extractGridCell(params);
    if (task === 'composeVideo') return composeVideo(params, onProgress);

    const kind = TASK_KIND[task];
    if (!kind) throw new Error('未注册的 AI 任务: ' + task);
    const S = LC.Settings;
    const name = params.model || params.voice || (S ? S.modelNames(kind)[0] : '');
    if (!name) throw new Error(`未配置${KIND_TIP[kind]}：请打开「设置 → API 接口」添加后再执行`);
    const cfg = S ? S.findModel(name, kind) : null;
    if (!cfg || !(cfg.url || cfg.modelId)) throw new Error(`「${name}」缺少接口配置，请在「设置 → API 接口」补全`);
    if ((cfg.provider === 'ark' || cfg.provider === 'openai') && !cfg.key) throw new Error(`「${name}」缺少 API Key，请在「设置 → API 接口」填写后再执行`);

    // 生成 task_id 并同步到后端（刷新可恢复）：优先用调用方预设 ID，保证运行中刷新节点也能查到
    const taskId = presetTaskId || U.uid('ai');
    aiTaskSync('start', { task_id: taskId, kind, progress: 0 });
    _curAiTaskId = taskId;   // 供协议函数挂接第三方任务信息（刷新续轮询用）
    // 进度不同步后端：executor 动画层统一同步（其值始终 ≥ API 真实进度），
    // 避免双写竞态导致刷新恢复读到偏低进度“从最开始开始”。
    const wrappedProgress = (p) => { onProgress?.(p); };

    let result;
    try {
      /* lk888 / 22Ai：按秒版 Seedance（doubao-seedance-2-0-*，走 /api/v3/anmiao 火山 content 格式）优先分流到 anmiaoVideo；
         其余图片/视频走媒体协议 /v1/media/generate（图片→lk888MediaImage，视频→lk888MediaVideo）。
         注意：url 指向 api.lk888.ai 时必须命中这里，不能落到下方 OpenAI /images 或火山方舟 /contents 的脆弱协议。 */
      const isLk = /lk888\.ai/i.test(cfg.url || '');
      const isAnmiao = /api\/v3\/anmiao/i.test(cfg.url || '') || /doubao-seedance-2-0/i.test(String(cfg.modelId || ''));
      if (isAnmiao && kind === 'video') result = await anmiaoVideo(cfg, params, wrappedProgress);
      else if (isLk && kind === 'image') result = await lk888MediaImage(cfg, task, params, wrappedProgress);
      else if (isLk && kind === 'video') result = await lk888MediaVideo(cfg, params, wrappedProgress);
      /* OpenAI 兼容生图（agicto 等非 lk888 中转站） */
      else if (cfg.provider === 'openai' && kind === 'image') result = await openaiImage(cfg, task, params, wrappedProgress);
      /* OpenAI 兼容视频：lk888 已被上面 isLk 分支接管；非 lk888 无标准 OpenAI 视频端点，明确报错避免误连 */
      else if (cfg.provider === 'openai' && kind === 'video') {
        throw new Error('视频生成不支持「OpenAI 兼容」非 lk888 中转地址，请将接口 URL 指向 api.lk888.ai，或改用 MiniMax H3 / Seedance 模型');
      }
      /* 字节火山协议（真正的 ark.cn-beijing.volces.com；lk888 的 seedance 已被上面 isLk 分支接管） */
      else if (cfg.provider === 'ark') {
        if (kind === 'video') {
          if (/seedance|anmiao/i.test((cfg.url || '') + (cfg.modelId || ''))) result = await anmiaoVideo(cfg, params, wrappedProgress);
          else throw new Error('视频生成不支持「字节火山 Ark」，请使用视频模型 MiniMax H3');
        } else if (kind === 'tts') result = await arkTTS(cfg, task, params, wrappedProgress);
        else if (kind === 'text') result = await arkChat(cfg, task, params, wrappedProgress);
        else result = await arkImage(cfg, task, params, wrappedProgress);
      } else {
        /* 自定义接口：POST {task, params} JSON */
        wrappedProgress?.(15);
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
        const res = await fetch(cfg.url, {
          method: 'POST', headers,
          body: JSON.stringify({ task, params: buildRemoteParams(task, params) }),
        });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw new Error('HTTP ' + res.status + (t ? ' · ' + t.slice(0, 120) : ''));
        }
        const out = await res.json();
        if (!out || !out.kind) throw new Error('返回格式异常（缺少 kind 字段）');
        wrappedProgress?.(100);
        result = out;
      }
      // 同步完成状态 + 结果到后端
      if (result) result._taskId = taskId;
      aiTaskSync('done', { task_id: taskId, result: _stripResultForStorage(result) });
      return result;
    } catch (err) {
      aiTaskSync('error', { task_id: taskId, error: err.message });
      throw new Error(`「${cfg.name}」调用失败：${err.message}`);
    } finally {
      _curAiTaskId = null;
    }
  };

  /* =====================================================
   * 刷新后恢复：按持久化的第三方任务信息续轮询原任务（不重新提交生成）
   * ext = { proto: 'anmiao' | 'lk888-media', base, modelId, extTaskId, kind, ... }
   * 轮询到终态后取回成片 → dataURL，返回与正常生成同构的输出
   * ===================================================== */
  AI.resumeExtTask = async function (ext, onProgress, cfg) {
    if (!ext || !ext.extTaskId) throw new Error('无第三方任务信息，无法续接');
    const base = (ext.base || '').replace(/\/+$/, '');
    // 鉴权：优先用调用方传入的 cfg；否则按模型名从设置里取
    let key = '';
    if (cfg && cfg.key) key = cfg.key;
    else if (ext.modelName) {
      const m = LC.Settings.findModel(ext.modelName, ext.kind === 'image' ? 'image' : 'video');
      if (m && m.key) key = m.key;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    if (ext.proto === 'anmiao') {
      /* 火山 Ark anmiao 协议：GET /contents/generations/tasks/{id} */
      let videoURL = '';
      for (let i = 0; i < 180; i++) {
        await U.sleep(5000);
        let st = null;
        try {
          const res = await fetch(base + '/contents/generations/tasks/' + encodeURIComponent(ext.extTaskId), { headers });
          if (res.ok) st = await res.json();
        } catch (e) { /* 网络抖动：继续轮询 */ }
        if (!st) continue;
        onProgress?.(Math.min(90, 10 + i * 0.5));
        const sts = String((st && st.status) || '').toLowerCase();
        if (sts === 'failed') {
          const errMsg = (st.error && (st.error.message || st.error.code)) || '未知原因（费用已自动退款）';
          throw new Error('视频任务失败：' + errMsg);
        }
        if (sts === 'succeeded') {
          videoURL = (st.content && st.content.video_url) || '';
          if (videoURL) break;
        }
      }
      if (!videoURL) throw new Error('视频任务续轮询超时（15 分钟）');
      onProgress?.(93);
      let blob = null;
      for (let a = 0; a < 3 && !blob; a++) {
        try {
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 180000);
          const resp = await fetch(videoURL, { signal: ctl.signal });
          blob = resp.ok ? await resp.blob() : null;
          clearTimeout(tm);
        } catch (e) { blob = null; }
      }
      if (!blob) throw new Error('成片下载失败（网络超时，任务实际已完成）。请重新运行节点，或直接用链接下载：' + videoURL);
      const dataURL = await blobToDataURL(blob);
      let frame = '';
      try { frame = await videoFirstFrame(dataURL); } catch (e) {}
      onProgress?.(100);
      return {
        kind: 'video', dataURL, blob, frames: frame ? [frame] : [],
        duration: Number(ext.duration) || 5,
        meta: { model: ext.modelId, provider: 'anmiao', extTaskId: ext.extTaskId, videoURL, time: U.formatTime() },
      };
    }
    if (ext.proto === 'lk888-media') {
      /* lk888 媒体协议：GET /v1/skills/task-status?task_id= */
      let resultURL = '';
      const isVideo = ext.kind === 'video';
      for (let i = 0; i < (isVideo ? 720 : 150); i++) {
        await U.sleep(isVideo ? 5000 : 4000);
        let st = null;
        try {
          const res = await fetch(base + '/v1/skills/task-status?task_id=' + encodeURIComponent(ext.extTaskId), { headers });
          if (res.ok) st = await res.json();
        } catch (e) { /* 网络抖动：继续轮询 */ }
        if (!st) continue;
        const sd = unwrapStatus(st);
        const pct = Number(String(sd.progress || '').replace('%', '')) || 0;
        onProgress?.(pct ? Math.min(90, 8 + pct * 0.85) : Math.min(90, 8 + Math.round(i / (isVideo ? 8 : 2))));
        if (sd.state === 'failed' || sd.error) {
          throw new Error((isVideo ? '视频' : '图片') + '任务失败：' + (sd.error || sd.state || '未知原因（费用已自动退款）'));
        }
        if (sd.is_final === true || sd.state === 'success') {
          resultURL = sd.result_url || sd.url || '';
          if (resultURL) break;
        }
      }
      if (!resultURL) throw new Error((isVideo ? '视频' : '图片') + '任务续轮询超时');
      onProgress?.(93);
      const blob = await (await fetch(resultURL)).blob();
      const dataURL = await blobToDataURL(blob);
      if (isVideo) {
        let frame = '';
        try { frame = await videoFirstFrame(dataURL); } catch (e) {}
        onProgress?.(100);
        return {
          kind: 'video', dataURL, blob, frames: frame ? [frame] : [],
          duration: Number(ext.duration) || 5,
          meta: { model: ext.modelId, provider: 'lk888', extTaskId: ext.extTaskId, videoURL: resultURL, time: U.formatTime() },
        };
      }
      onProgress?.(100);
      return { kind: 'image', dataURL, meta: { model: ext.modelId, provider: 'lk888', extTaskId: ext.extTaskId, time: U.formatTime() } };
    }
    throw new Error('未知的第三方任务协议：' + ext.proto);
  };

  /* 结果对象里可能含超大 dataURL，存后端任务表时剔除（节点 output 落盘后也只留 url） */
  function _stripResultForStorage(result) {
    if (!result || typeof result !== 'object') return result;
    const o = { ...result };
    if (o.dataURL && typeof o.dataURL === 'string' && o.dataURL.startsWith('data:')) {
      // base64 太大，只保留 url（落盘后的）；没有 url 就置空，刷新后由节点 output 自身恢复
      delete o.dataURL;
    }
    return o;
  }

  /* 3D 导演台画布截图（本地截图，非 AI 生成） */
  AI.stageSnapshot = function (canvas) {
    const c = document.createElement('canvas');
    c.width = Math.min(1600, canvas.width); c.height = Math.min(1600, canvas.height);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return { kind: 'image', dataURL: c.toDataURL('image/png'), meta: { type: '导演台截图', size: `${c.width}x${c.height}`, time: U.formatTime() } };
  };

  /* 视觉风格清单（供 UI 风格选择器使用） */
  AI.STYLES = Object.keys(STYLE_PROMPTS);

  window.LC.AI = AI;
})();
