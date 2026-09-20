/* 通用弹层 */
(function () {
  const U = LC.U;
  const Modal = {
    open(html, opts = {}) {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `<div class="modal ${opts.className || ''}" style="${opts.width ? 'width:' + opts.width : ''}">
        <div class="modal-head"><h3>${opts.title || ''}</h3><button class="modal-close">✕</button></div>
        <div class="modal-body">${html}</div>
        ${opts.footer ? `<div class="modal-foot">${opts.footer}</div>` : ''}
      </div>`;
      document.getElementById('modal-root').appendChild(mask);
      const modalEl = U.$('.modal', mask);
      const close = () => {
        opts.onClose?.();
        mask.remove();
      };
      U.$('.modal-close', mask).onclick = close;
      mask.addEventListener('pointerdown', (e) => { if (e.target === mask && opts.maskClose !== false) close(); });
      return { el: modalEl, body: U.$('.modal-body', mask), foot: U.$('.modal-foot', mask), close };
    },
    confirm(title, text, okText = '确定') {
      return new Promise((resolve) => {
        const m = Modal.open(`<div style="font-size:13px;color:var(--text2);line-height:1.8">${U.esc(text)}</div>`,
          { title, footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>${okText}</button>`, maskClose: false });
        U.$('[data-c]', m.foot).onclick = () => { m.close(); resolve(false); };
        U.$('[data-ok]', m.foot).onclick = () => { m.close(); resolve(true); };
        U.$('.modal-close', m.el).onclick = () => { m.close(); resolve(false); };
      });
    },
    prompt(title, dft = '', opts = {}) {
      return new Promise((resolve) => {
        const m = Modal.open(`<input type="text" class="mp-input" value="${LC.U.esc(dft)}">`,
          { title, className: opts.className, footer: `<button class="btn" data-c>取消</button><button class="btn primary" data-ok>确定</button>`, maskClose: false });
        const input = () => U.$('.mp-input', m.body);
        setTimeout(() => { const inp = input(); inp.focus(); inp.select(); }, 60);
        input().onkeydown = (e) => { if (e.key === 'Enter') U.$('[data-ok]', m.foot).click(); };
        U.$('[data-c]', m.foot).onclick = () => { m.close(); resolve(null); };
        U.$('[data-ok]', m.foot).onclick = () => { const v = input().value.trim(); m.close(); resolve(v || null); };
        U.$('.modal-close', m.el).onclick = () => { m.close(); resolve(null); };
      });
    },
  };
  LC.Modal = Modal;
})();