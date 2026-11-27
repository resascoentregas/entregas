// ==UserScript==
// @name         Asistente Entregas → WhatsApp (garantías)
// @namespace    resascoentregas
// @version      1.1
// @description  Manda sola la felicitación con la foto de garantía por WhatsApp Web a los clientes entregados cuya cita se mandó desde la PC.
// @match        https://web.whatsapp.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://resascoentregas.github.io/entregas/asistente-whatsapp.user.js
// @downloadURL  https://resascoentregas.github.io/entregas/asistente-whatsapp.user.js
// ==/UserScript==

(function () {
  'use strict';
  const VER = '1.1';
  const CADA = 60000;              // revisa cada 1 minuto si hay garantías para mandar
  const HORARIO = [8, 21];         // solo manda de 8 a 21 hs (nunca de noche)
  const espera = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- Conexión con la app Entregas (el botón "Conectar WhatsApp Web" de la app trae el código en el link) ---------- */
  const m = location.hash.match(/aecod=([\w-]+\.[\w-]+)/);
  if (m) { const p = m[1].split('.'); GM_setValue('cfg', { u: p[0], k: p[1] }); history.replaceState(null, '', location.pathname); }
  const cfg = () => GM_getValue('cfg', null);
  function api(fn, args) {
    const c = cfg();
    return new Promise((res, rej) => {
      if (!c) return rej(new Error('Falta conectar con la app'));
      GM_xmlhttpRequest({
        method: 'POST', url: 'https://script.google.com/macros/s/' + c.u + '/exec',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, data: JSON.stringify({ fn, args: args || [], k: c.k }), timeout: 60000,
        onload: r => { try { const j = JSON.parse(r.responseText); j.ok ? res(j.r) : rej(new Error(j.e)); } catch (e) { rej(new Error('Respuesta rara de la app')); } },
        onerror: () => rej(new Error('Sin conexión')), ontimeout: () => rej(new Error('La app tardó demasiado'))
      });
    });
  }

  /* ---------- Panelito abajo a la izquierda ---------- */
  const css = document.createElement('style');
  css.textContent = '#aew{position:fixed;left:12px;bottom:12px;z-index:99999;background:#111827;color:#f3f4f6;font:13px/1.35 system-ui,sans-serif;border-radius:12px;padding:9px 12px;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:300px}' +
    '#aew b{color:#fff}#aew .e{color:#9ca3af;font-size:12px;margin-top:2px}#aew .mal{color:#fca5a5}#aew button{background:#16a34a;color:#fff;border:0;border-radius:8px;padding:4px 9px;font:600 12px system-ui;cursor:pointer;margin:6px 6px 0 0}' +
    '#aew button.g{background:#374151}#aew input{width:100%;margin-top:6px;padding:5px;border-radius:6px;border:0}';
  document.head.appendChild(css);
  const panel = document.createElement('div'); panel.id = 'aew'; document.body.appendChild(panel);
  const on = () => GM_getValue('on', true);
  function estado(txt, mal) {
    if (!cfg()) {
      panel.innerHTML = '<b>🛡️ Garantías · WhatsApp</b><div class="e">Abrí la app Entregas → Más → 🤖 Automático → "Conectar WhatsApp Web", o pegá el código de acceso:</div><input id="aew-c" placeholder="Código de acceso"><button id="aew-ok">Conectar</button>';
      panel.querySelector('#aew-ok').onclick = () => { const v = panel.querySelector('#aew-c').value.trim().replace(/^.*(#c=|aecod=)/, ''), p = v.split('.');
        if (p.length !== 2 || p[0].length < 20 || p[1].length < 20) return alert('Ese código no parece correcto'); GM_setValue('cfg', { u: p[0], k: p[1] }); estado('Conectado'); ciclo(); };
      return;
    }
    panel.innerHTML = '<b>🛡️ Garantías · WhatsApp</b> <small>v' + VER + '</small><div class="e ' + (mal ? 'mal' : '') + '">' + (on() ? '' : '⏸ Pausado · ') + esc(txt) + '</div>' +
      '<button id="aew-ya">Revisar ahora</button><button class="g" id="aew-on">' + (on() ? 'Pausar' : 'Activar') + '</button><button class="g" id="aew-pr">Probar con mi número</button>';
    panel.querySelector('#aew-pr').onclick = probar;
    panel.querySelector('#aew-ya').onclick = () => ciclo(true);
    panel.querySelector('#aew-on').onclick = () => { GM_setValue('on', !on()); estado(on() ? 'Activo' : 'Pausado'); };
  }

  /* ---------- Piezas de WhatsApp Web ---------- */
  const visible = el => !!el && el.getClientRects().length > 0;
  const cajaChat = () => [...document.querySelectorAll('footer div[contenteditable="true"]')].find(visible);
  const cajaComentario = () => [...document.querySelectorAll('div[contenteditable="true"]')].find(el => visible(el) && !el.closest('footer') && !el.closest('#side') && !el.closest('#aew'));
  const botonEnviar = () => { const i = [...document.querySelectorAll('[data-icon="send"],[data-icon="wds-ic-send-filled"],[data-icon="send-light"]')].find(visible);
    return i ? (i.closest('[role="button"],button') || i) : [...document.querySelectorAll('[aria-label="Enviar"],[aria-label="Send"]')].find(visible); };
  const numeroInvalido = () => /no es válido|isn.t valid|is not valid|inválido/i.test((document.querySelector('[data-animate-modal-popup="true"],[role="dialog"]') || {}).innerText || '');
  async function esperar(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const r = fn(); if (r) return r; await espera(400); } return null; }
  function pegar(el, dt) { el.focus(); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }
  async function fotoGarantia() {
    let f = GM_getValue('foto', null);
    if (!f || Date.now() - f.t > 6 * 3600000) { const url = await api('getGarantiaImg'); if (!url) throw new Error('No hay foto de garantía cargada en la app (Más → Mensajes)'); f = { url, t: Date.now() }; GM_setValue('foto', f); }
    const [cab, b64] = f.url.split(','), tipo = (cab.match(/data:([^;]+)/) || [])[1] || 'image/jpeg', bin = atob(b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);    // sin fetch: WhatsApp Web no deja pedir "data:"
    return new File([u8], 'garantia.jpg', { type: tipo });
  }

  /* ---------- Un envío: abre el chat del cliente, pega la foto, escribe el texto y toca Enviar ---------- */
  async function enviar(job) {
    estado('Mandando la garantía a ' + job.cliente + '…');
    const caja = await esperar(() => numeroInvalido() ? 'mal' : cajaChat(), 45000);
    if (!caja || caja === 'mal') throw new Error(caja === 'mal' ? 'WhatsApp dice que el número no es válido (' + job.tel + ')' : 'No se abrió el chat del cliente');
    await espera(1500);
    const dt = new DataTransfer(); dt.items.add(await fotoGarantia());
    pegar(caja, dt);
    const com = await esperar(cajaComentario, 15000); if (!com) throw new Error('No se abrió la vista de la foto');
    await espera(700);
    const tx = new DataTransfer(); tx.setData('text/plain', job.texto); pegar(com, tx);
    await espera(900);
    if (!(com.innerText || '').trim()) { com.focus(); document.execCommand('insertText', false, job.texto); await espera(600); }
    const b = await esperar(botonEnviar, 8000); if (!b) throw new Error('No encontré el botón Enviar');
    job.enviado = Date.now(); GM_setValue('job', job);     // si la página se recarga ahora, no se vuelve a mandar
    b.click();
    const ok = await esperar(() => !cajaComentario(), 20000);
    if (!ok) throw new Error('La foto quedó sin enviar');
  }
  async function terminar(job, ok, motivo) {
    GM_deleteValue('job');
    if (job.prueba) return estado(ok ? '✔ Prueba enviada: fijate en tu chat' : '⚠ Prueba: ' + motivo, !ok);
    const h = GM_getValue('hechos', {}); h[job.vin] = Date.now(); GM_setValue('hechos', h);
    try { await api('marcarGarantiaWa', [job.vin, ok, 'pc', motivo || '']); } catch (e) {}
    estado(ok ? '✔ Garantía enviada a ' + job.cliente : '⚠ ' + job.cliente + ': ' + motivo, !ok);
  }

  /* ---------- Ciclo: pide a la app la próxima garantía y la manda ---------- */
  let corriendo = false;
  async function ciclo(forzar) {
    if (corriendo || !cfg()) return; corriendo = true;
    try {
      const job = GM_getValue('job', null);
      if (job) {     // venimos de abrir el chat del cliente
        if (job.enviado) return await terminar(job, true);
        if (Date.now() - job.t > 5 * 60000) { GM_deleteValue('job'); return; }
        try { await enviar(job); await terminar(job, true); } catch (e) { await terminar(job, false, e.message); }
        return;
      }
      if (!on() && !forzar) return estado('Pausado');
      const h = new Date().getHours(); if (!forzar && (h < HORARIO[0] || h >= HORARIO[1])) return estado('Fuera de horario: manda de ' + HORARIO[0] + ' a ' + HORARIO[1] + ' hs');
      if (!cajaChat() && !document.querySelector('#side')) return estado('Esperando que cargue WhatsApp Web…');
      const hechos = GM_getValue('hechos', {});
      const lista = (await api('getGarantiasWa', ['pc'])).filter(x => !hechos[x.vin] || Date.now() - hechos[x.vin] > 30 * 60000);
      if (!lista.length) return estado('Activo · no hay garantías para mandar');
      const x = lista[0];
      GM_setValue('job', { vin: x.vin, cliente: x.cliente, tel: x.tel, texto: x.texto, t: Date.now() });
      estado('Abriendo el chat de ' + x.cliente + '…');
      location.href = 'https://web.whatsapp.com/send?phone=' + x.tel;
    } catch (e) { estado(e.message, true); }
    finally { corriendo = false; }
  }
  /* Prueba: manda la garantía a tu propio número (no anota nada en la app) */
  function probar() {
    const v = prompt('Tu número de WhatsApp para la prueba (ej. 2954 123456):', GM_getValue('miNum', '')); if (!v) return;
    let d = v.replace(/\D/g, '').replace(/^0+/, ''); if (d.indexOf('54') === 0) d = d.slice(2); if (d[0] === '9') d = d.slice(1);
    for (const n of [2, 3, 4]) if (d.length === 12 && d.substr(n, 2) === '15') { d = d.slice(0, n) + d.slice(n + 2); break; }
    if (d.length !== 10) return alert('Poné el número con característica, por ejemplo 2954 123456');
    GM_setValue('miNum', v);
    GM_setValue('job', { prueba: true, vin: 'PRUEBA', cliente: 'vos (prueba)', tel: '549' + d, t: Date.now(),
      texto: 'Buenas tardes *Cliente de prueba* 🎉 ¡Felicitaciones por tu nuevo *Jeep Compass*! Te dejamos la información de la *garantía* de tu 0km 🛡️.\n\n(Esto es una prueba del asistente de garantías)' });
    estado('Prueba: abriendo tu chat…'); location.href = 'https://web.whatsapp.com/send?phone=549' + d;
  }
  estado(cfg() ? 'Arrancando…' : '');
  setTimeout(ciclo, GM_getValue('job', null) ? 4000 : 15000);
  setInterval(ciclo, CADA);
})();
