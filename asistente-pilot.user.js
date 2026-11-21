// ==UserScript==
// @name         Asistente Entregas → Pilot
// @namespace    resascoentregas
// @version      1.0
// @description  Hace en Pilot los pasos de cada entrega que marcás en la app Entregas (pre-entrega, controles, planificar, entregado, transferir a Azul, etiqueta).
// @match        https://app.pilotsolution.com.ar/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://resascoentregas.github.io/entregas/asistente-pilot.user.js
// @downloadURL  https://resascoentregas.github.io/entregas/asistente-pilot.user.js
// ==/UserScript==

(function () {
  'use strict';
  const W = unsafeWindow;
  const DANIEL = 88999, AZUL = 93885, CASA_CENTRAL = 1;
  const ESTADO_PREENTREGA = 5, ETIQUETA_ENTREGADO = 7, CONTROL_PRE_OK = 1;
  const YA_EN_PREENTREGA = ['en preentrega', 'en entrega', 'cierre de legajo'];

  /* ---------- Conexión con la app Entregas ---------- */
  const cfg = () => GM_getValue('cfg', null);
  function api(fn, args) {
    const c = cfg();
    return new Promise((res, rej) => {
      if (!c) return rej(new Error('Falta el código de acceso'));
      GM_xmlhttpRequest({
        method: 'POST', url: 'https://script.google.com/macros/s/' + c.u + '/exec',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        data: JSON.stringify({ fn, args: args || [], k: c.k }),
        onload: r => { try { const j = JSON.parse(r.responseText); j.ok ? res(j.r) : rej(new Error(j.e)); } catch (e) { rej(new Error('Respuesta rara de la app')); } },
        onerror: () => rej(new Error('Sin conexión con la app'))
      });
    });
  }

  /* ---------- Ayudas ---------- */
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const esperar = ms => new Promise(r => setTimeout(r, ms));
  async function post(url, data) {
    const r = await W.$.post(url, data);
    const j = typeof r === 'string' ? JSON.parse(r) : r;
    if (!j || !j.success) throw new Error((j && j.message) || 'Pilot no aceptó el cambio');
    return j;
  }
  const dmyGuion = f => f.split('/').join('-');            // 25/11/2026 → 25-11-2026
  const hhmm = h => h.replace(':', '').padStart(4, '0');    // 10:30 → 1030
  const QUE = {
    preentrega: 'Pasar a pre-entrega',
    preok: 'Pre-entrega OK + fecha en Controles',
    cita: 'Planificar la entrega (Daniel Diaz · Casa Central)',
    entregado: 'Entregado → transferir a Azul + etiqueta Entregado'
  };
  const detalle = t => QUE[t.accion] + (t.fecha ? ' · ' + t.fecha : '') + (t.hora ? ' ' + t.hora : '');

  /* ---------- Panel ---------- */
  const css = document.createElement('style');
  css.textContent = `
  #ae-btn{position:fixed;right:18px;bottom:18px;z-index:99999;background:#e11d48;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:700 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer}
  #ae-panel{position:fixed;right:18px;bottom:74px;z-index:99999;width:380px;max-height:70vh;overflow:auto;background:#14171c;color:#eceef2;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:14px system-ui,sans-serif;padding:14px;display:none}
  #ae-panel h3{margin:0 0 10px;font-size:15px}
  #ae-panel .it{background:#1e222a;border:1px solid #2a2f39;border-radius:12px;padding:10px 12px;margin-bottom:8px}
  #ae-panel .it b{display:block}#ae-panel .it small{color:#8b93a1;display:block;margin:2px 0 8px}
  #ae-panel button.h{background:#e11d48;color:#fff;border:0;border-radius:9px;padding:7px 12px;font-weight:700;cursor:pointer;margin-right:6px}
  #ae-panel button.s{background:none;color:#8b93a1;border:1px solid #2a2f39;border-radius:9px;padding:7px 10px;cursor:pointer}
  #ae-panel input{width:100%;box-sizing:border-box;padding:9px;border-radius:9px;border:1px solid #2a2f39;background:#0e1014;color:#eceef2;margin:6px 0}
  #ae-log{position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:100000;width:440px;background:#14171c;color:#eceef2;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px system-ui,sans-serif;padding:16px 18px}
  #ae-log li{margin:4px 0}#ae-log button{margin-top:10px;background:#e11d48;color:#fff;border:0;border-radius:9px;padding:8px 14px;font-weight:700;cursor:pointer}`;
  document.head.appendChild(css);
  const btn = document.createElement('button'); btn.id = 'ae-btn'; btn.textContent = '🚗 Entregas';
  const panel = document.createElement('div'); panel.id = 'ae-panel';
  document.body.appendChild(btn); document.body.appendChild(panel);
  btn.onclick = () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; if (panel.style.display === 'block') cargar(); };

  let lista = [];
  async function cargar() {
    if (!cfg()) {
      panel.innerHTML = '<h3>🚗 Asistente Entregas</h3><small>Pegá el código de acceso de la app (el del mail "Clave de la app Entregas"):</small><input id="ae-cod" placeholder="Código de acceso"><button class="h" id="ae-ok">Guardar</button>';
      panel.querySelector('#ae-ok').onclick = () => {
        const v = panel.querySelector('#ae-cod').value.trim().replace(/^.*#c=/, ''), p = v.split('.');
        if (p.length !== 2 || p[0].length < 20 || p[1].length < 20) return alert('Ese código no parece correcto');
        GM_setValue('cfg', { u: p[0], k: p[1] }); cargar();
      };
      return;
    }
    panel.innerHTML = '<h3>🚗 Para hacer en Pilot</h3><small>Buscando…</small>';
    try { lista = await api('getPilotPendientes'); } catch (e) { panel.innerHTML = '<h3>🚗 Asistente Entregas</h3><small>No pude leer la app: ' + e.message + '</small>'; return; }
    btn.textContent = '🚗 Entregas' + (lista.length ? ' (' + lista.length + ')' : '');
    panel.innerHTML = '<h3>🚗 Para hacer en Pilot' + (lista.length ? ' (' + lista.length + ')' : '') + '</h3>' + (lista.length ? lista.map((t, i) =>
      `<div class="it"><b>${t.cliente}</b><small>${t.modelo || ''} · VIN …${t.vin.slice(-8)}<br>➜ ${detalle(t)}</small>
       <button class="h" data-i="${i}">Hacer</button><button class="s" data-x="${i}">Ya está hecho</button></div>`).join('')
      : '<small>Nada pendiente 👍</small>');
  }
  panel.addEventListener('click', async e => {
    const h = e.target.closest('[data-i]'), x = e.target.closest('[data-x]');
    if (x) { const t = lista[+x.dataset.x]; if (!confirm('¿Marcar como hecho sin tocar Pilot?\n\n' + t.cliente + ' – ' + detalle(t))) return;
      await api('marcarPilot', [t.clave, 'marcado a mano']); cargar(); }
    if (h) abrirLegajo(lista[+h.dataset.i]);
  });

  /* ---------- 1) Buscar el legajo por VIN y abrirlo ---------- */
  async function abrirLegajo(t) {
    panel.innerHTML = '<h3>🚗 Buscando el legajo de ' + t.cliente + '…</h3>';
    const r = await W.$.post('/adminfiles/services/adminfiles.list.php', { status_filter: 'todos', business_type_filter: '1', page: '', favorites: '',
      filter_seeker: t.vin.slice(-8), filter_users_select: '', context_users: '', label_filter: '', sort: '', order: '', current_user_id: W.gl_user_id || '' });
    const filas = (r && r.data && r.data.dataRows) || [];
    if (filas.length !== 1) { panel.innerHTML = '<h3>🚗 Asistente Entregas</h3><small>' + (filas.length ? 'Encontré ' + filas.length + ' legajos con ese VIN; abrilo a mano.' : 'No encontré un legajo con el VIN …' + t.vin.slice(-8) + '.') + '</small>'; return; }
    const guid = (String(filas[0].customer_rsocial).match(/open\('([0-9A-F-]{36})'\)/i) || [])[1];
    if (!guid) { panel.innerHTML = '<small>No pude abrir el legajo.</small>'; return; }
    GM_setValue('tarea', Object.assign({}, t, { adminFileId: String(filas[0].admin_file_id).replace(/\D/g, ''), estadoPilot: norm(String(filas[0].admin_file_status).replace(/<[^>]+>/g, '')) }));
    location.href = '/adminfileContext/index.php?guid=' + guid + '#asistente';
  }

  /* ---------- 2) Ya en el legajo: hacer los pasos ---------- */
  if (location.pathname.indexOf('/adminfileContext/') === 0 && location.hash === '#asistente' && GM_getValue('tarea', null)) hacer(GM_getValue('tarea'));

  async function hacer(t) {
    const caja = document.createElement('div'); caja.id = 'ae-log';
    caja.innerHTML = '<b>🚗 ' + t.cliente + '</b><div style="color:#8b93a1;margin:2px 0 8px">' + detalle(t) + '</div><ul id="ae-pasos" style="padding-left:18px;margin:0"></ul>';
    document.body.appendChild(caja);
    const paso = txt => { const li = document.createElement('li'); li.textContent = txt; caja.querySelector('#ae-pasos').appendChild(li); return li; };
    const fin = (ok, txt) => { GM_deleteValue('tarea'); paso((ok ? '✔ ' : '✖ ') + txt);
      const b = document.createElement('button'); b.textContent = ok ? 'Listo, recargar el legajo' : 'Cerrar';
      b.onclick = () => { history.replaceState(null, '', location.pathname + location.search); ok ? location.reload() : caja.remove(); }; caja.appendChild(b); };
    try {
      // Esperar a que Pilot termine de cargar tareas y unidad
      for (let i = 0; i < 40 && !(document.querySelector('[id^="chk_tarea_"]') && document.querySelector('#stockVin')); i++) await esperar(500);
      const vinPilot = (W.$('#stockVin').attr('data-value') || '').toUpperCase();
      if (vinPilot !== t.vin.toUpperCase()) return fin(false, 'El VIN del legajo (' + (vinPilot || 'sin VIN') + ') no coincide con ' + t.vin + '. No toqué nada.');
      const id = t.adminFileId, sale = W.getSaleId ? W.getSaleId() : W.$('#sale_id').val();
      const textoEntregas = norm((document.getElementById('entregas') || document.body).innerText);

      const tarea = nombre => { const n = norm(nombre);
        for (const inp of document.querySelectorAll('[id^="chk_tarea_"]')) {
          const tit = inp.closest('li') && inp.closest('li').querySelector('.task-title-sp');
          if (tit && norm(tit.textContent).indexOf(n) === 0) return { id: inp.getAttribute('data-id'), hecha: inp.checked };
        } return null; };
      const cerrarTarea = async (nombre, opcional) => { const x = tarea(nombre);
        if (!x) { if (!opcional) paso('• La tarea "' + nombre + '" no está en este legajo'); return; }
        if (x.hecha) { paso('• "' + nombre + '" ya estaba tildada'); return; }
        await post('/api/adminfiles_event_logs/close.php', { admin_file_event_log_id: x.id }); paso('✔ Tildé "' + nombre + '"'); };
      const pasarAPreentrega = async () => {
        if (YA_EN_PREENTREGA.indexOf(t.estadoPilot) >= 0) { paso('• El legajo ya está en "' + t.estadoPilot + '"'); return; }
        await post('/api/adminfiles/updatebyfieldname.php', { name: 'admin_file_status_id', value: ESTADO_PREENTREGA, pk: id }); paso('✔ Estado → En preentrega'); };
      const horarioPilot = async (fecha, hora) => {   // Pilot solo acepta sus horarios (cada 30 min); uso el más cercano anterior
        const r = await post('/adminfileContext/services/get.delivery.rep.available.slots.php', { branch_id: CASA_CENTRAL, rep_id: DANIEL, approximate_date: dmyGuion(fecha) });
        const slots = (String(r.data).match(/value="(\d{4})"/g) || []).map(s => s.slice(7, 11));
        if (!slots.length) throw new Error('Pilot no tiene horarios libres para Daniel Diaz el ' + fecha);
        const h = hhmm(hora), antes = slots.filter(s => s <= h);
        return antes.length ? antes[antes.length - 1] : slots[0]; };

      if (t.accion === 'preentrega' || t.accion === 'preok') {
        await cerrarTarea('Asignar turno pre-entrega y accesorios', true);
        await pasarAPreentrega();
      }
      if (t.accion === 'preok') {
        await cerrarTarea('Pre entrega ok');
        if (/pre entrega ok \d/.test(textoEntregas) || /controles.*pre entrega ok/.test(textoEntregas)) paso('• Controles ya tenía "Pre Entrega ok"');
        else { await post('/adminfileContext/services/add.delivery.check.php', { delivery_check_stage_id: CONTROL_PRE_OK, delivery_check_dt: t.fecha, sale_id: sale }); paso('✔ Controles: Pre Entrega ok ' + t.fecha); }
      }
      if (t.accion === 'cita') {
        if (textoEntregas.indexOf('no hay planificacion de entrega') < 0) paso('• Ya había una entrega planificada: si cambió la fecha, cambiala a mano en Planificar');
        else {
          const h = await horarioPilot(t.fecha, t.hora);
          const d = { sale_id: sale, sale_admin_id: W.$('#sale_admin_id').val(), sale_delivery_rep_id: DANIEL, sale_delivered_branch_id: CASA_CENTRAL,
            sale_approximate_delivery_last_time: h, sale_approximate_delivery_last_date: dmyGuion(t.fecha) };
          if (W.$('#sale_rep_id').val()) d.sale_rep_id = W.$('#sale_rep_id').val();
          await post('/adminfileContext/services/schedule.delivery.php', d); paso('✔ Planificada: ' + t.fecha + ' ' + h.slice(0, 2) + ':' + h.slice(2) + ' · Daniel Diaz · Casa Central');
        }
        await cerrarTarea('Agendar cita para retirar la unidad');
      }
      if (t.accion === 'entregado') {
        if (!(W.$('#stockDomain').attr('data-value') || '') && !confirm('Este auto no tiene patente cargada en Pilot. ¿Lo marco como entregado igual?')) return fin(false, 'Cancelado: falta la patente.');
        if (/fecha de entrega: \d/.test(textoEntregas)) paso('• La entrega ya estaba marcada');
        else {
          const h = await horarioPilot(t.fecha, t.hora || '12:00');
          const d = { sale_id: sale, sale_delivery_rep_id: DANIEL, sale_delivered_branch_id: CASA_CENTRAL, sale_delivered_time: h,
            sale_delivered_inconvenience_flag: 0, sale_delivered_inconvenience_notes: '', sale_delivered_dt: dmyGuion(t.fecha) };
          if (W.$('#sale_rep_id').val()) d.sale_rep_id = W.$('#sale_rep_id').val();
          await post('/adminfileContext/services/marcar.delivery.php', d); paso('✔ Entrega realizada ' + t.fecha + ' ' + h.slice(0, 2) + ':' + h.slice(2));
        }
        await cerrarTarea('Entrega Realizada');
        await post('/api/adminfiles/transfer.php', { admin_file_id: id, to_user_id: AZUL, comment: 'Unidad entregada (Daniel Diaz).' }); paso('✔ Legajo transferido a Azul Anabel Behotas');
        await post('/api/adminfiles/labels.php', { admin_file_id: id, admin_file_label_id: ETIQUETA_ENTREGADO }); paso('✔ Etiqueta → Entregado');
      }
      await api('marcarPilot', [t.clave, 'asistente']);
      fin(true, 'Todo hecho en Pilot');
    } catch (e) { fin(false, 'Se frenó: ' + e.message + '. Lo que ya se hizo quedó hecho; revisá el legajo.'); }
  }

  // Contador al abrir Pilot
  if (cfg()) api('getPilotPendientes').then(l => { lista = l; btn.textContent = '🚗 Entregas' + (l.length ? ' (' + l.length + ')' : ''); }).catch(() => {});
  // Señal de vida: la app muestra "● Pilot" en verde mientras Pilot esté abierto y con sesión
  if (cfg() && !/login/.test(location.host + location.pathname)) { const latir = () => api('pilotLatido').catch(() => {}); latir(); setInterval(latir, 120000); }
})();
