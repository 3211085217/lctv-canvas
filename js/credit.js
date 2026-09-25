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

    /* ---------- 充值弹窗 ---------- */
    openRecharge() {
      if (this._modalEl) return;
      const priceHtml = Object.entries(this.prices)
        .map(([k, v]) => `${({ image: '图片', video: '视频', audio: '音频', text: '文本' })[k] || k} ${v}`)
        .join(' · ');
      const m = LC.Modal.open(`
        <div class="credit-box">
          <div class="credit-bal">当前积分：<b id="credit-bal-b">${this.balance}</b><span class="credit-rate">1 元 = 1 积分</span></div>
          <div class="credit-qrs">
            <div class="credit-qr">
              <img src="qrcode_wechat.jpg" alt="微信收款码" onerror="this.style.display='none'">
              <div class="credit-qr-label">微信支付</div>
            </div>
            <div class="credit-qr">
              <img src="qrcode_alipay.jpg" alt="支付宝收款码" onerror="this.style.display='none'">
              <div class="credit-qr-label">支付宝</div>
            </div>
          </div>
          <div class="credit-qr-tip">扫码付款后，<b>找我拿卡密</b>，卡密在下方兑换<br>（收款码未显示？把图片放到 <b>web/qrcode_wechat.jpg</b> / <b>web/qrcode_alipay.jpg</b>）</div>
          <div class="credit-row">
            <input id="credit-code" class="mp-input" placeholder="输入卡密，如 CARD005-xxxxxxxx-xxxxxxxx" spellcheck="false">
            <button id="credit-redeem" class="btn primary">兑换</button>
          </div>
          <div class="credit-prices">计费：${priceHtml}（价格可调整，以页面显示为准）</div>
        </div>`,
        { title: `${U.icon('dot', 14)} 积分充值`, width: '460px', maskClose: true });
      this._modalEl = m;
      const origClose = m.close;
      m.close = () => { this._modalEl = null; origClose(); };
      U.$('#credit-redeem', m.body).onclick = async () => {
        const code = U.$('#credit-code', m.body).value.trim();
        if (!code) { LC.App.toast('请先输入卡密', 'warn'); return; }
        const btn = U.$('#credit-redeem', m.body);
        btn.disabled = true; btn.textContent = '兑换中…';
        try {
          const j = await this._post('/redeem', { device: this.device, code });
          if (!j) { LC.App.toast('兑换失败：服务器无响应，请稍后再试', 'err'); }
          else if (j.error) { LC.App.toast(j.error, 'err'); }
          else {
            this.balance = j.credits;
            LC.App.toast(`兑换成功：+${j.added} 积分（当前 ${j.credits}）`, 'ok');
            this.render();
            U.$('#credit-code', m.body).value = '';
          }
        } catch (e) { LC.App.toast('兑换失败：' + e.message, 'err'); }
        btn.disabled = false; btn.textContent = '兑换';
        this.refresh();
      };
      U.$('#credit-code', m.body).onkeydown = (e) => {
        if (e.key === 'Enter') U.$('#credit-redeem', m.body).click();
      };
    },
  };

  LC.Credit = Credit;

  /* 页面就绪后自动初始化（main.js 在 后台启动后调用亦可） */
  window.addEventListener('load', () => {
    setTimeout(() => Credit.init().catch(() => {}), 300);
  });
})();