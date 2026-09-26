/* =====================================================
 * credit.js — 积分系统（云端充值入口，1 元 = 1 积分）
 * 余额与兑换全部走后端 /api/credit/*，前端改数据无效。
 * 生成前 consume 扣积分（后端按 kind 定价），余额不足弹充值窗；
 * 生成失败且未提交到上游时自动 refund 退款。
 * ===================================================== */
(function () {
  const U = LC.U;

  const Credit = {
    device: null,
    balance: 0,
    prices: { image: 1, video: 2, audio: 1, text: 0 },

    /* 浏览器设备号：同一浏览器积分共享，跨浏览器不互通（每人各自充值） */
    _devId() {
      let d = localStorage.getItem('lcc_device');
      if (!d) {
        d = 'dev' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
        localStorage.setItem('lcc_device', d);
      }
      return d;
    },

    async _post(action, body) {
      const r = await fetch('/api/credit' + action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return r.json().catch(() => null);
    },

    /* 页面启动：注册设备 + 拉余额 */
    async init() {
      this.device = this._devId();
      const j = await this._post('/register', { device: this.device });
      if (j && typeof j.credits === 'number') {
        this.balance = j.credits;
        if (j.prices) this.prices = j.prices;
      }
      this.render();
      const btn = U.$('#credit-btn');
      if (btn) btn.onclick = () => this.openRecharge();
    },

    render() {
      const btn = U.$('#credit-btn');
      if (btn) {
        btn.innerHTML = `${U.icon('dot', 12)} 积分 ${this.balance}`;
        btn.classList.toggle('credit-low', this.balance <= 0);
      }
      const bal = U.$('#credit-bal-b');
      if (bal) bal.textContent = this.balance;
    },

    async refresh() {
      try {
        const r = await fetch('/api/credit?device=' + encodeURIComponent(this.device));
        const j = await r.json().catch(() => null);
        if (j && typeof j.credits === 'number') {
          this.balance = j.credits;
          if (j.prices) this.prices = j.prices;
        }
      } catch (e) {}
      this.render();
    },

    /* 生成前扣费：后端定价（kind: image/video/audio）。
       返回 true=可继续生成；false=余额不足（已弹充值窗）。
       后端不可达时放行（fail-open）：充值系统故障不应卡死整个画布。 */
    async consume(kind) {
      if (!this.device) this.device = this._devId();
      try {
        const j = await this._post('/consume', { device: this.device, kind });
        if (!j) return true;
        if (typeof j.credits === 'number') this.balance = j.credits;
        this.render();
        if (j.ok) return true;
        LC.App.toast(`「积分不足」本次生成需 ${j.price} 积分（当前 ${j.credits}）`, 'warn');
        this.openRecharge();
        return false;
      } catch (e) { return true; }
    },

    /* 生成失败且未提交到上游时退款（调用方触发） */
    async refund(kind) {
      try {
        const j = await this._post('/refund', { device: this.device, kind });
        if (j && typeof j.credits === 'number') { this.balance = j.credits; this.render(); }
        if (j) LC.App.toast(`本次生成失败，${j.price} 积分已退回`, 'ok');
      } catch (e) {}
    },

    /* ---------- 充值弹窗：动态支付码（自动到账）+ 卡密兑换 ---------- */
    _qrTimer: null,
    _payType: 'alipay',

    /* 按需加载二维码生成库（失败时降级为跳转链接） */
    _loadQRLib() {
      if (this._qrLib) return Promise.resolve(this._qrLib);
      this._qrLib = new Promise((res) => {
        if (window.QRCode) return res(true);
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
        s.onload = () => res(true);
        s.onerror = () => {
          const s2 = document.createElement('script');
          s2.src = 'https://lf3-cdn-tos.bytecdntp.com/cdn/expire-1-M/qrcodejs/1.0.0/qrcode.min.js';
          s2.onload = () => res(true);
          s2.onerror = () => res(false);
          document.head.appendChild(s2);
        };
        document.head.appendChild(s);
      });
      return this._qrLib;
    },

    /* 轮询支付结果：TRADE_SUCCESS 后余额已由后端自动加好 */
    _pollOrder(body, m, timerRef) {
      const box = body;
      let tries = 0;
      timerRef.t = setInterval(async () => {
        tries++;
        const last = this._lastOrder;
        if (!last) { clearInterval(timerRef.t); timerRef.t = null; return; }
        try {
          const r = await fetch('/api/credit/order?device=' + encodeURIComponent(this.device) + '&out=' + encodeURIComponent(last));
          const j = await r.json().catch(() => null);
          if (j && j.status === 'paid') {
            clearInterval(timerRef.t); timerRef.t = null;
            this.balance = j.credits;
            this.render();
            const qrwrap = U.$('#credit-pay-qrwrap', box);
            if (qrwrap) qrwrap.innerHTML = `<div class="credit-paid">✅ 支付成功，<b>${j.credits}</b> 积分已到账</div>`;
            LC.App.toast('支付成功，积分已自动到账', 'ok');
          }
        } catch (e) {}
        if (tries > 120) { clearInterval(timerRef.t); timerRef.t = null; }
      }, 3000);
    },

    openRecharge() {
      if (this._modalEl) return;
      const priceHtml = Object.entries(this.prices)
        .map(([k, v]) => `${({ image: '图片', video: '视频', audio: '音频', text: '文本' })[k] || k} ${v}`)
        .join(' · ');
      const m = LC.Modal.open(`
        <div class="credit-box">
          <div class="credit-bal">当前积分：<b id="credit-bal-b">${this.balance}</b><span class="credit-rate">1 元 = 1 积分</span></div>
          <div class="credit-pay">
            <div class="credit-pay-row">
              <input id="credit-pay-amt" class="mp-input" type="number" min="1" max="500" step="1" value="10" title="充值金额（元）">
              <button class="btn credit-type on" id="credit-pay-alipay" data-paytype="alipay">支付宝</button>
              <button class="btn credit-type" id="credit-pay-wxpay" data-paytype="wxpay">微信</button>
            </div>
            <button class="btn primary credit-pay-go" id="credit-pay-go">生成支付二维码</button>
            <div class="credit-pay-qr" id="credit-pay-qrwrap" hidden></div>
            <div class="credit-qr-tip" id="credit-pay-err"></div>
          </div>
          <div class="credit-divider">卡密兑换（备用）</div>
          <div class="credit-row">
            <input id="credit-code" class="mp-input" placeholder="输入卡密，如 CARD005-xxxxxxxx-xxxxxxxx" spellcheck="false">
            <button id="credit-redeem" class="btn primary">兑换</button>
          </div>
          <div class="credit-prices">计费：${priceHtml}（价格可调整，以页面显示为准）</div>
        </div>`,
        { title: `${U.icon('dot', 14)} 积分充值`, width: '470px', maskClose: true });
      this._modalEl = m;
      const box = m.body;
      const origClose = m.close;
      m.close = () => {
        this._modalEl = null;
        if (this._pollRef && this._pollRef.t) { clearInterval(this._pollRef.t); this._pollRef.t = null; }
        origClose();
      };
      this._pollRef = { t: null };
      this._lastOrder = null;

      // 支付方式切换
      U.$$('.credit-type', box).forEach((b) => {
        b.onclick = () => {
          this._payType = b.dataset.paytype;
          U.$$('.credit-type', box).forEach((x) => x.classList.toggle('on', x === b));
        };
      });

      // 生成支付码 → 显示二维码 → 轮询到账
      U.$('#credit-pay-go', box).onclick = async () => {
        const amt = Number(U.$('#credit-pay-amt', box).value);
        const errEl = U.$('#credit-pay-err', box);
        const wrap = U.$('#credit-pay-qrwrap', box);
        errEl.textContent = '';
        if (!amt || amt < 1 || amt > 500) { errEl.textContent = '金额需在 1~500 元之间'; return; }
        const go = U.$('#credit-pay-go', box);
        go.disabled = true; go.textContent = '下单中…';
        try {
          const r = await fetch('/api/credit/epay-order', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device: this.device, money: amt, type: this._payType }),
          });
          const j = await r.json().catch(() => null);
          if (!j) { errEl.innerHTML = '服务器无响应（云端后端未部署时无法自动收款，请改用卡密充值）'; }
          else if (j.error) { errEl.textContent = j.error; }
          else {
            this._lastOrder = j.order;
            wrap.hidden = false;
            const okLib = await this._loadQRLib();
            if (okLib && window.QRCode) {
              wrap.innerHTML = `
                <div class="credit-pay-qrbox" id="credit-pay-qr"></div>
                <div class="credit-qr-tip">打开${this._payType === 'wxpay' ? '微信' : '支付宝'}扫一扫付款，<b>付款成功后积分自动到账</b>（请勿关闭弹窗）</div>`;
              new window.QRCode(U.$('#credit-pay-qr', box), { text: j.payUrl, width: 180, height: 180, correctLevel: 2 });
            } else {
              wrap.innerHTML = `
                <a class="btn primary" href="${U.esc(j.payUrl)}" target="_blank" rel="noopener">点击打开支付页面 →</a>
                <div class="credit-qr-tip">支付成功后回到本页，积分自动到账</div>`;
            }
            if (this._pollRef.t) clearInterval(this._pollRef.t);
            this._pollOrder(box, m, this._pollRef);
          }
        } catch (e) { errEl.textContent = '网络错误，请重试'; }
        go.disabled = false; go.textContent = '生成支付二维码';
      };
      U.$('#credit-pay-amt', box).onkeydown = (e) => { if (e.key === 'Enter') U.$('#credit-pay-go', box).click(); };

      // 卡密兑换
      U.$('#credit-redeem', box).onclick = async () => {
        const code = U.$('#credit-code', box).value.trim();
        if (!code) { LC.App.toast('请先输入卡密', 'warn'); return; }
        const btn = U.$('#credit-redeem', box);
        btn.disabled = true; btn.textContent = '兑换中…';
        try {
          const j = await this._post('/redeem', { device: this.device, code });
          if (!j) { LC.App.toast('兑换失败：服务器无响应，请稍后再试', 'err'); }
          else if (j.error) { LC.App.toast(j.error, 'err'); }
          else {
            this.balance = j.credits;
            LC.App.toast(`兑换成功：+${j.added} 积分（当前 ${j.credits}）`, 'ok');
            this.render();
            U.$('#credit-code', box).value = '';
          }
        } catch (e) { LC.App.toast('兑换失败：' + e.message, 'err'); }
        btn.disabled = false; btn.textContent = '兑换';
        this.refresh();
      };
      U.$('#credit-code', box).onkeydown = (e) => {
        if (e.key === 'Enter') U.$('#credit-redeem', box).click();
      };

      // 支付完跳回页面（return_url 带 ?credit_out=订单号）：打开弹窗时自动查一次
      const q = new URLSearchParams(location.search);
      const backOrder = q.get('credit_out');
      if (backOrder) {
        this._lastOrder = backOrder;
        try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {}
        this._pollOrder(box, m, this._pollRef);
      }
    },
  };

  LC.Credit = Credit;

  /* 页面就绪后自动初始化（main.js 在 后台启动后调用亦可） */
  window.addEventListener('load', () => {
    setTimeout(() => Credit.init().catch(() => {}), 300);
  });
})();