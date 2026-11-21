// ==UserScript==
// @name         Asistente Entregas → Pilot
// @namespace    resascoentregas
// @version      2.0
// @description  Hace en Pilot los pasos de cada entrega que marcás en la app Entregas (pre-entrega, controles, planificar, entregado, transferir a Azul, etiqueta). Con Pilot abierto, lo hace solo cada 3 minutos.
// @match        https://app.pilotsolution.com.ar/*
// @noframes
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
  const CADA = 3 * 60000;   // modo automático: cada 3 minutos

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
  const dmyGuion = f => f.split('/').join('-');            // 25/11/2026 → 25-11-2026
  const hhmm = h => h.replace(':', '').padStart(4, '0');    // 10:30 → 1030
  const QUE = {
    preentrega: 'Pasar a pre-entrega',
    preok: 'Pre-entrega OK + fecha en Controles',
    cita: 'Planificar la entrega (Daniel Diaz · Casa Central)',
    entregado: 'Entregado → transferir a Azul + etiqueta Entregado'
  };
  const detalle = t => QUE[t.accion] + (t.fecha ? ' · ' + t.fecha : '') + (t.hora ? ' ' + t.hora : '');
  const autoOn = () => GM_getValue('auto', false);
  const esperanVos = () => GM_getValue('esperanVos', {});   // clave → motivo (lo que el automático no hizo solo)
  function marcarEsperaVos(t, motivo) { const e = esperanVos(); e[t.clave] = motivo; GM_setValue('esperanVos', e); }
  function sacarEsperaVos(t) { const e = esperanVos(); delete e[t.clave]; GM_setValue('esperanVos', e); }
  function historial(txt) { const h = GM_getValue('historial', []); h.unshift(new Date().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' · ' + txt); GM_setValue('historial', h.slice(0, 20)); }
  class NecesitaVos extends Error {}

  /* ---------- Panel ---------- */
  const css = document.createElement('style');
  css.textContent = `
  #ae-btn{position:fixed;right:18px;bottom:18px;z-index:99999;background:#e11d48;color:#fff;border:0;border-radius:999px;padding:12px 18px;font:700 14px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);cursor:pointer}
  #ae-btn i{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:7px;vertical-align:1px}
  #ae-btn.off i{background:#9ca3af}
  #ae-panel{position:fixed;right:18px;bottom:74px;z-index:99999;width:390px;max-height:72vh;overflow:auto;background:#14171c;color:#eceef2;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:14px system-ui,sans-serif;padding:14px;display:none}
  #ae-panel h3{margin:0 0 10px;font-size:15px}
  #ae-panel h4{margin:14px 0 6px;font-size:12px;color:#8b93a1;text-transform:uppercase;letter-spacing:.05em}
  #ae-panel .it{background:#1e222a;border:1px solid #2a2f39;border-radius:12px;padding:10px 12px;margin-bottom:8px}
  #ae-panel .it.av{border-color:#b45309}
  #ae-panel .it b{display:block}#ae-panel .it small{color:#8b93a1;display:block;margin:2px 0 8px}
  #ae-panel .it .mv{color:#fbbf24}
  #ae-panel button.h{background:#e11d48;color:#fff;border:0;border-radius:9px;padding:7px 12px;font-weight:700;cursor:pointer;margin-right:6px}
  #ae-panel button.s{background:none;color:#8b93a1;border:1px solid #2a2f39;border-radius:9px;padding:7px 10px;cursor:pointer}
  #ae-panel input[type=text]{width:100%;box-sizing:border-box;padding:9px;border-radius:9px;border:1px solid #2a2f39;background:#0e1014;color:#eceef2;margin:6px 0}
  #ae-panel .auto{display:flex;align-items:center;gap:8px;background:#1e222a;border-radius:12px;padding:9px 12px;margin-bottom:10px;cursor:pointer}
  #ae-panel .hist{color:#8b93a1;font-size:12px;line-height:1.6}
  #ae-log{position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:100000;width:440px;background:#14171c;color:#eceef2;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:14px system-ui,sans-serif;padding:16px 18px}
  #ae-log li{margin:4px 0}#ae-log button{margin-top:10px;background:#e11d48;color:#fff;border:0;border-radius:9px;padding:8px 14px;font-weight:700;cursor:pointer}`;
  document.head.appendChild(css);
  const btn = document.createElement('button'); btn.id = 'ae-btn';
  const panel = document.createElement('div'); panel.id = 'ae-panel';
  document.body.appendChild(btn); document.body.appendChild(panel);
  let lista = [], estadoAuto = '';
  const pintarBtn = () => { btn.className = autoOn() ? '' : 'off'; btn.innerHTML = '<i></i>Entregas' + (lista.length ? ' (' + lista.length + ')' : '') + (estadoAuto ? ' · ' + estadoAuto : ''); };
  pintarBtn();
  btn.onclick = () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; if (panel.style.display === 'block') cargar(); };

  async function cargar() {
    if (!cfg()) {
      panel.innerHTML = '<h3>🚗 Asistente Entregas</h3><small>Pegá el código de acceso de la app (el del mail "Clave de la app Entregas"):</small><input type="text" id="ae-cod" placeholder="Código de acceso"><button class="h" id="ae-ok">Guardar</button>';
      panel.querySelector('#ae-ok').onclick = () => {
        const v = panel.querySelector('#ae-cod').value.trim().replace(/^.*#c=/, ''), p = v.split('.');
        if (p.length !== 2 || p[0].length < 20 || p[1].length < 20) return alert('Ese código no parece correcto');
        GM_setValue('cfg', { u: p[0], k: p[1] }); cargar(); latir(); setTimeout(autoCiclo, 3000);
      };
      return;
    }
    panel.innerHTML = '<h3>🚗 Para hacer en Pilot</h3><small>Buscando…</small>';
    try { lista = await api('getPilotPendientes'); } catch (e) { panel.innerHTML = '<h3>🚗 Asistente Entregas</h3><small>No pude leer la app: ' + e.message + '</small>'; return; }
    pintarBtn();
    const ev = esperanVos();
    const item = (t, i) => `<div class="it ${ev[t.clave] ? 'av' : ''}"><b>${t.cliente}</b><small>${t.modelo || ''} · VIN …${t.vin.slice(-8)}<br>➜ ${detalle(t)}${ev[t.clave] ? '<br><span class="mv">⚠ ' + ev[t.clave] + '</span>' : ''}</small>
       <button class="h" data-i="${i}">Hacer</button><button class="s" data-x="${i}">Ya está hecho</button></div>`;
    const hist = GM_getValue('historial', []);
    panel.innerHTML = '<h3>🚗 Para hacer en Pilot' + (lista.length ? ' (' + lista.length + ')' : '') + '</h3>' +
      `<label class="auto"><input type="checkbox" id="ae-auto" ${autoOn() ? 'checked' : ''}> <span><b>Modo automático</b><br><small style="color:#8b93a1">Con Pilot abierto, hace solo los pendientes cada 3 minutos</small></span></label>` +
      (lista.length ? lista.map(item).join('') : '<small>Nada pendiente 👍</small>') +
      (hist.length ? '<h4>Últimos movimientos</h4><div class="hist">' + hist.slice(0, 8).join('<br>') + '</div>' : '');
    panel.querySelector('#ae-auto').onchange = e => { GM_setValue('auto', e.target.checked); pintarBtn(); if (e.target.checked) setTimeout(autoCiclo, 1000); };
  }
  panel.addEventListener('click', async e => {
    const h = e.target.closest('[data-i]'), x = e.target.closest('[data-x]');
    if (x) { const t = lista[+x.dataset.x]; if (!confirm('¿Marcar como hecho sin tocar Pilot?\n\n' + t.cliente + ' – ' + detalle(t))) return;
      await api('marcarPilot', [t.clave, 'marcado a mano']); sacarEsperaVos(t); historial(t.cliente + ': marcado a mano'); cargar(); }
    if (h) abrirLegajo(lista[+h.dataset.i]);
  });

  /* ---------- Buscar el legajo (por Cód. Referencia ≈ final del VIN, o por nombre) ---------- */
  async function buscarLegajos(t) {
    const buscar = async s => { const r = await W.$.post('/adminfiles/services/adminfiles.list.php', { status_filter: 'todos', business_type_filter: '', page: '', favorites: '',
      filter_seeker: s, filter_users_select: '', context_users: '', label_filter: '', sort: '', order: '', current_user_id: W.gl_user_id || '' });
      return (r && r.data && r.data.dataRows) || []; };
    let filas = [];
    for (const s of [t.vin.slice(-8), t.vin.slice(-6), t.vin.slice(-5)]) { filas = await buscar(s); if (filas.length) break; }
    if (!filas.length) {
      const pal = norm(t.cliente).replace(/[.,]/g, ' ').split(' ').filter(p => p.length > 2 && !/^(srl|sa|sas)$/.test(p));
      const larga = pal.slice().sort((a, b) => b.length - a.length)[0] || norm(t.cliente);
      filas = (await buscar(larga)).filter(f => { const n = nombreFila(f); return pal.filter(p => n.indexOf(p) >= 0).length >= Math.min(2, pal.length); });
    }
    return filas;
  }
  const nombreFila = f => norm(String(f.customer_rsocial).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\d+\s*$/, ''));
  const guidFila = f => (String(f.customer_rsocial).match(/open\('([0-9A-F-]{36})'\)/i) || [])[1];
  const datosFila = f => ({ adminFileId: String(f.admin_file_id).replace(/\D/g, ''), estadoPilot: norm(String(f.admin_file_status).replace(/<[^>]+>/g, '')) });

  /* ---------- Manual: botón "Hacer" (abre el legajo y lo hace a la vista) ---------- */
  async function abrirLegajo(t) {
    panel.innerHTML = '<h3>🚗 Buscando el legajo de ' + t.cliente + '…</h3>';
    const filas = await buscarLegajos(t);
    if (!filas.length) { panel.innerHTML = '<h3>🚗 Asistente Entregas</h3><small>No encontré el legajo de ' + t.cliente + ' (VIN …' + t.vin.slice(-8) + '). Abrilo a mano.</small>'; return; }
    const ir = f => { const g = guidFila(f); if (!g) { panel.innerHTML = '<small>No pude abrir el legajo.</small>'; return; }
      GM_setValue('tarea', Object.assign({}, t, datosFila(f))); location.href = '/adminfileContext/index.php?guid=' + g + '#asistente'; };
    if (filas.length === 1) return ir(filas[0]);
    panel.innerHTML = '<h3>🚗 ¿Cuál es el legajo de ' + t.cliente + '?</h3>' + filas.map((f, i) =>
      `<div class="it"><b>${nombreFila(f)}</b><small>Legajo #${datosFila(f).adminFileId} · ${String(f.unit_description || '').replace(/<[^>]+>/g, ' ')}</small><button class="h" data-leg="${i}">Este</button></div>`).join('');
    panel.querySelectorAll('[data-leg]').forEach(b => b.onclick = e => { e.stopPropagation(); ir(filas[+b.dataset.leg]); });
  }
  if (location.pathname.indexOf('/adminfileContext/') === 0 && location.hash === '#asistente' && GM_getValue('tarea', null)) hacerAlaVista(GM_getValue('tarea'));

  async function hacerAlaVista(t) {
    const caja = document.createElement('div'); caja.id = 'ae-log';
    caja.innerHTML = '<b>🚗 ' + t.cliente + '</b><div style="color:#8b93a1;margin:2px 0 8px">' + detalle(t) + '</div><ul id="ae-pasos" style="padding-left:18px;margin:0"></ul>';
    document.body.appendChild(caja);
    const paso = txt => { const li = document.createElement('li'); li.textContent = txt; caja.querySelector('#ae-pasos').appendChild(li); };
    const fin = (ok, txt) => { GM_deleteValue('tarea'); paso((ok ? '✔ ' : '✖ ') + txt);
      const b = document.createElement('button'); b.textContent = ok ? 'Listo, recargar el legajo' : 'Cerrar';
      b.onclick = () => { history.replaceState(null, '', location.pathname + location.search); ok ? location.reload() : caja.remove(); }; caja.appendChild(b); };
    try {
      await pasos(t, W, paso, msg => confirm(msg));
      await api('marcarPilot', [t.clave, 'asistente']); sacarEsperaVos(t); historial(t.cliente + ': ' + QUE[t.accion] + ' ✔');
      fin(true, 'Todo hecho en Pilot');
    } catch (e) { fin(false, (e instanceof NecesitaVos ? 'Cancelado: ' : 'Se frenó: ') + e.message + '. Lo que ya se hizo quedó hecho; revisá el legajo.'); }
  }

  /* ---------- Los pasos (sirven a la vista o en segundo plano). w = ventana del legajo ---------- */
  async function pasos(t, w, paso, preguntar) {
    const d = w.document, $ = w.$;
    const post = async (url, data) => { const r = await $.post(url, data); const j = typeof r === 'string' ? JSON.parse(r) : r;
      if (!j || !j.success) throw new Error((j && j.message) || 'Pilot no aceptó el cambio'); return j; };
    const sinUnidad = () => /SIN UNIDAD/i.test((d.getElementById('entregas') || {}).innerText || '');
    const vinActual = () => ($('#stockVin').attr('data-value') || '').toUpperCase();
    // Esperar tareas; si la pestaña de la unidad no cargó, abrirla
    for (let i = 0; i < 40 && !d.querySelector('[id^="chk_tarea_"]'); i++) await esperar(500);
    if (!vinActual() && !sinUnidad()) { const tb = d.getElementById('tab-entregas'); if (tb) tb.click();
      for (let i = 0; i < 30 && !vinActual() && !sinUnidad(); i++) await esperar(500); }
    if (!d.querySelector('[id^="chk_tarea_"]')) throw new Error('el legajo no terminó de cargar');
    const vinPilot = vinActual();
    if (!vinPilot) {
      if (!preguntar('Este legajo todavía no tiene la unidad (VIN) asignada en Pilot.\n\n¿Es el legajo de ' + t.cliente + '? Si confirmás, sigo igual.'))
        throw new NecesitaVos('el legajo no tiene VIN para controlar: confirmá con "Hacer"');
      paso('• El legajo no tiene unidad asignada: seguí porque confirmaste que es de ' + t.cliente);
    } else if (vinPilot !== t.vin.toUpperCase()) throw new NecesitaVos('el VIN del legajo (' + vinPilot + ') no coincide con ' + t.vin + ': no toqué nada');
    const id = t.adminFileId, sale = w.getSaleId ? w.getSaleId() : $('#sale_id').val();
    const textoEntregas = norm((d.getElementById('entregas') || d.body).innerText);

    const tarea = nombre => { const n = norm(nombre);
      for (const inp of d.querySelectorAll('[id^="chk_tarea_"]')) {
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
        const dd = { sale_id: sale, sale_admin_id: $('#sale_admin_id').val(), sale_delivery_rep_id: DANIEL, sale_delivered_branch_id: CASA_CENTRAL,
          sale_approximate_delivery_last_time: h, sale_approximate_delivery_last_date: dmyGuion(t.fecha) };
        if ($('#sale_rep_id').val()) dd.sale_rep_id = $('#sale_rep_id').val();
        await post('/adminfileContext/services/schedule.delivery.php', dd); paso('✔ Planificada: ' + t.fecha + ' ' + h.slice(0, 2) + ':' + h.slice(2) + ' · Daniel Diaz · Casa Central');
      }
      await cerrarTarea('Agendar cita para retirar la unidad');
    }
    if (t.accion === 'entregado') {
      if (!($('#stockDomain').attr('data-value') || '') && !preguntar('Este auto no tiene patente cargada en Pilot. ¿Lo marco como entregado igual?'))
        throw new NecesitaVos('el auto no tiene patente cargada en Pilot: confirmá con "Hacer"');
      if (/fecha de entrega: \d/.test(textoEntregas)) paso('• La entrega ya estaba marcada');
      else {
        const h = await horarioPilot(t.fecha, t.hora || '12:00');
        const dd = { sale_id: sale, sale_delivery_rep_id: DANIEL, sale_delivered_branch_id: CASA_CENTRAL, sale_delivered_time: h,
          sale_delivered_inconvenience_flag: 0, sale_delivered_inconvenience_notes: '', sale_delivered_dt: dmyGuion(t.fecha) };
        if ($('#sale_rep_id').val()) dd.sale_rep_id = $('#sale_rep_id').val();
        await post('/adminfileContext/services/marcar.delivery.php', dd); paso('✔ Entrega realizada ' + t.fecha + ' ' + h.slice(0, 2) + ':' + h.slice(2));
      }
      await cerrarTarea('Entrega Realizada');
      await post('/api/adminfiles/transfer.php', { admin_file_id: id, to_user_id: AZUL, comment: 'Unidad entregada (Daniel Diaz).' }); paso('✔ Legajo transferido a Azul Anabel Behotas');
      await post('/api/adminfiles/labels.php', { admin_file_id: id, admin_file_label_id: ETIQUETA_ENTREGADO }); paso('✔ Etiqueta → Entregado');
    }
  }

  /* ---------- Modo automático: en segundo plano, con el legajo cargado en un marco invisible ---------- */
  function abrirOculto(guid) {
    return new Promise((res, rej) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-3000px;top:0;width:1280px;height:900px;border:0;visibility:hidden';
      f.src = '/adminfileContext/index.php?guid=' + guid;
      const to = setTimeout(() => { f.remove(); rej(new Error('el legajo tardó demasiado en abrir')); }, 60000);
      f.onload = () => { clearTimeout(to); res(f); };
      document.body.appendChild(f);
    });
  }
  async function hacerSolo(t) {
    const filas = await buscarLegajos(t);
    if (!filas.length) throw new NecesitaVos('no encontré el legajo: abrilo con "Hacer"');
    if (filas.length > 1) throw new NecesitaVos('hay ' + filas.length + ' legajos posibles: elegí el correcto con "Hacer"');
    const g = guidFila(filas[0]); if (!g) throw new Error('no pude abrir el legajo');
    t = Object.assign({}, t, datosFila(filas[0]));
    const f = await abrirOculto(g);
    const hechos = [];
    try { await pasos(t, f.contentWindow, txt => hechos.push(txt), () => false); }
    finally { f.remove(); }
    await api('marcarPilot', [t.clave, 'automático']);
    return hechos.filter(x => x[0] === '✔').length;
  }
  async function autoCiclo() {
    if (!cfg() || !autoOn() || /\/login|logout/.test(location.pathname) || !W.$ || !W.gl_user_id) return;
    if (Date.now() - GM_getValue('autoLock', 0) < CADA - 10000) return;   // otra pestaña de Pilot ya lo está haciendo
    GM_setValue('autoLock', Date.now());
    try {
      lista = await api('getPilotPendientes'); pintarBtn();
      const ev = esperanVos();
      for (const t of lista) {
        if (ev[t.clave] || !autoOn()) continue;
        GM_setValue('autoLock', Date.now());
        estadoAuto = '🤖 ' + t.cliente.split(' ')[0]; pintarBtn();
        try { const n = await hacerSolo(t); historial('🤖 ' + t.cliente + ': ' + QUE[t.accion] + (n ? ' ✔' : ' (ya estaba hecho)')); }
        catch (e) { marcarEsperaVos(t, e instanceof NecesitaVos ? e.message : 'se frenó: ' + e.message + ' (probá con "Hacer")'); historial('⚠ ' + t.cliente + ': ' + (e.message || e)); }
      }
      lista = await api('getPilotPendientes');
    } catch (e) { /* sin conexión: reintenta en el próximo ciclo */ }
    finally { estadoAuto = ''; pintarBtn(); if (panel.style.display === 'block') cargar(); }
  }

  /* ---------- Arranque ---------- */
  const latir = () => api('pilotLatido').catch(() => {});   // la app muestra "● Pilot" en verde mientras esto llegue
  if (cfg() && !/login/.test(location.host + location.pathname)) {
    api('getPilotPendientes').then(l => { lista = l; pintarBtn(); }).catch(() => {});
    latir(); setInterval(latir, 120000);
    setTimeout(autoCiclo, 20000); setInterval(autoCiclo, CADA);
  }
})();
