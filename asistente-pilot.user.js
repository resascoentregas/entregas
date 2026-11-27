// ==UserScript==
// @name         Asistente Entregas → Pilot
// @namespace    resascoentregas
// @version      3.4
// @description  Hace en Pilot los pasos de cada entrega que marcás en la app Entregas (pre-entrega, controles, planificar, entregado, transferir a Azul, etiqueta). Con Pilot abierto, lo hace al instante (se fija cada 3 segundos si marcaste algo), y te avisa en la app cuando un legajo pasa a "Ok para entrega" o alguien deja un comentario.
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
  const CADA = 60000;   // revisión completa de respaldo, cada 1 minuto
  const RAPIDO = 3000;  // cada 3 segundos pregunta si marcaste algo en la app (es instantáneo)
  const VER = '3.3', MAX_INTENTOS = 5;
  let corriendo = false;   // no arranca otra vuelta mientras termina la anterior

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
    deshacerPreok: 'Deshacer Pre-entrega OK (reabrir tarea y sacar la fecha de Controles)',
    cita: 'Planificar la entrega (Daniel Diaz · Casa Central)',
    entregado: 'Entregado → transferir a Azul + etiqueta Entregado'
  };
  const detalle = t => QUE[t.accion] + (t.fecha ? ' · ' + t.fecha : '') + (t.hora ? ' ' + t.hora : '');
  const autoOn = () => GM_getValue('auto29', true);   // prendido de entrada
  if (!GM_getValue('v29', false)) { GM_setValue('esperanVos', {}); GM_setValue('v29', true); }   // al actualizar: todo lo frenado se reintenta
  // clave → { motivo, espera (necesita que lo confirmes con "Hacer"), n (intentos), t }
  const esperanVos = () => { const e = GM_getValue('esperanVos', {}); Object.keys(e).forEach(k => { if (typeof e[k] === 'string') e[k] = { motivo: e[k], espera: true, n: 1, t: 0 }; }); return e; };
  function marcarEsperaVos(t, motivo, espera) { const e = esperanVos(), x = e[t.clave] || { n: 0 }; e[t.clave] = { motivo: motivo, espera: !!espera, n: x.n + 1, t: Date.now() }; GM_setValue('esperanVos', e); }
  const trabado = x => !!x && (x.espera || x.n >= MAX_INTENTOS);
  // Pasos ya hechos de cada pedido: si algo se corta a mitad de camino, al reintentar no se repite lo hecho
  const prog = clave => (GM_getValue('prog', {})[clave] || {});
  function anotarProg(clave, p) { const g = GM_getValue('prog', {}); (g[clave] = g[clave] || {})[p] = Date.now(); GM_setValue('prog', g); }
  function sacarEsperaVos(t) { const e = esperanVos(); delete e[t.clave]; GM_setValue('esperanVos', e); const g = GM_getValue('prog', {}); delete g[t.clave]; GM_setValue('prog', g); }
  function historial(txt) { const h = GM_getValue('historial', []); h.unshift(new Date().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' · ' + txt); GM_setValue('historial', h.slice(0, 20)); }
  class NecesitaVos extends Error {}
  const hora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  function estado(txt, mal) { GM_setValue('estado', { t: hora(), txt, mal: !!mal }); }

  /* ---------- Panel (2.9: minimalista, abre al instante con lo último que se sabe) ---------- */
  const CORTO = { preentrega: 'Pasar a pre-entrega', preok: 'Pre-entrega OK', deshacerPreok: 'Deshacer Pre-entrega OK', cita: 'Planificar entrega', entregado: 'Entrega realizada' };
  const css = document.createElement('style');
  css.textContent = `
  #ae-btn{position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;align-items:center;gap:7px;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:999px;padding:8px 13px;font:600 13px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.12);cursor:grab;touch-action:none;user-select:none}
  #ae-btn.mov{cursor:grabbing;opacity:.85}
  #ae-btn i{width:8px;height:8px;border-radius:50%;background:#22c55e}
  #ae-btn.pend i{background:#f59e0b}#ae-btn.trab i{background:#ef4444}#ae-btn.off i{background:#9ca3af}
  #ae-btn.hace i{background:#3b82f6;animation:aeLat 1s infinite}@keyframes aeLat{50%{opacity:.3}}
  #ae-btn b{background:#111827;color:#fff;border-radius:999px;font-size:11px;min-width:18px;height:18px;line-height:18px;text-align:center;padding:0 5px}
  #ae-panel{position:fixed;right:16px;bottom:60px;z-index:99999;width:330px;max-height:70vh;overflow:auto;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.15);font:13.5px/1.35 system-ui,sans-serif;display:none}
  #ae-panel .cab{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 2px}
  #ae-panel .cab b{font-size:14.5px}
  #ae-panel .sub{padding:0 14px 10px;color:#6b7280;font-size:12.5px;border-bottom:1px solid #f1f2f4}
  #ae-panel .sub.ok{color:#16a34a}#ae-panel .sub.mal{color:#dc2626}
  #ae-panel .sw{display:flex;align-items:center;gap:6px;color:#6b7280;font-size:12px;cursor:pointer}
  #ae-panel .sw input{display:none}
  #ae-panel .sw span{width:30px;height:17px;border-radius:9px;background:#d1d5db;position:relative;transition:.2s}
  #ae-panel .sw span:after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:.2s}
  #ae-panel .sw input:checked+span{background:#22c55e}#ae-panel .sw input:checked+span:after{left:15px}
  #ae-panel .fila{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #f1f2f4}
  #ae-panel .fila .tx{flex:1;min-width:0}
  #ae-panel .fila .tx b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
  #ae-panel .fila .tx small{color:#6b7280;font-size:12px}
  #ae-panel .fila .tx em{display:block;font-style:normal;font-size:11.5px;color:#d97706;margin-top:1px}
  #ae-panel .fila.av .tx em{color:#dc2626}
  #ae-panel .ac{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
  #ae-panel button.h{background:#111827;color:#fff;border:0;border-radius:8px;padding:5px 11px;font:600 12px system-ui,sans-serif;cursor:pointer}
  #ae-panel button.s{background:none;border:0;color:#9ca3af;font:11px system-ui,sans-serif;cursor:pointer;padding:0}
  #ae-panel .lnk{display:flex;gap:14px;padding:8px 14px;border-bottom:1px solid #f1f2f4}
  #ae-panel .lnk button{background:none;border:0;color:#2563eb;font:600 12px system-ui,sans-serif;cursor:pointer;padding:0}
  #ae-panel .nada{padding:22px 14px;text-align:center;color:#16a34a;font-weight:600}
  #ae-panel details{padding:8px 14px 12px;color:#6b7280;font-size:12px}
  #ae-panel summary{cursor:pointer;list-style:none}
  #ae-panel .hist{line-height:1.7;margin-top:4px}
  #ae-panel .hd{padding:12px 14px;border-bottom:1px solid #f1f2f4}#ae-panel .est{color:#6b7280;font-size:12.5px;margin-top:3px}#ae-panel .est.mal{color:#dc2626}
  #ae-panel .bd{padding:10px 14px 14px}#ae-panel .it{border-bottom:1px solid #f1f2f4;padding:8px 0}#ae-panel .cl{font-weight:600}#ae-panel .md{color:#6b7280;font-size:12px}#ae-panel .bt{margin-top:6px}
  #ae-panel input[type=text]{width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #e5e7eb;margin:6px 0}
  #ae-log{position:fixed;left:50%;top:80px;transform:translateX(-50%);z-index:100000;width:400px;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.18);font:13.5px system-ui,sans-serif;padding:14px 16px}
  #ae-log li{margin:3px 0}#ae-log button{margin-top:10px;background:#111827;color:#fff;border:0;border-radius:8px;padding:7px 13px;font-weight:600;cursor:pointer}`;
  document.head.appendChild(css);
  const btn = document.createElement('button'); btn.id = 'ae-btn';
  const panel = document.createElement('div'); panel.id = 'ae-panel';
  document.body.appendChild(btn); document.body.appendChild(panel);
  let lista = GM_getValue('listaCache', []), estadoAuto = '', listaOk = false;   // solo se reporta a la app con su lista ya leída
  const guardarLista = l => { lista = l || []; listaOk = true; GM_setValue('listaCache', lista); };
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pintarBtn = () => {
    const ev = esperanVos(), nTrab = lista.filter(t => trabado(ev[t.clave])).length;
    btn.className = !autoOn() ? 'off' : estadoAuto ? 'hace' : nTrab ? 'trab' : lista.length ? 'pend' : '';
    btn.innerHTML = '<i></i>' + esc(estadoAuto || 'Pilot') + (lista.length ? '<b>' + lista.length + '</b>' : '');
    btn.title = !autoOn() ? 'Automático apagado: tocá para prenderlo' : nTrab ? nTrab + ' necesitan que toques "Hacer"' : lista.length ? 'Pendientes: se hacen solos' : 'Pilot al día con la app';
  };
  pintarBtn();
  // 3.3: el botón se puede arrastrar a cualquier lugar (queda guardado); el panel se abre al lado
  const ubicarPanel = () => { const r = btn.getBoundingClientRect(), W0 = innerWidth, H0 = innerHeight;
    panel.style.left = Math.max(8, Math.min(r.right - 330, W0 - 338)) + 'px'; panel.style.right = 'auto';
    if (r.top > H0 / 2) { panel.style.bottom = (H0 - r.top + 8) + 'px'; panel.style.top = 'auto'; }
    else { panel.style.top = (r.bottom + 8) + 'px'; panel.style.bottom = 'auto'; } };
  const ponerBtn = (x, y) => { x = Math.max(4, Math.min(x, innerWidth - btn.offsetWidth - 4)); y = Math.max(4, Math.min(y, innerHeight - btn.offsetHeight - 4));
    btn.style.left = x + 'px'; btn.style.top = y + 'px'; btn.style.right = 'auto'; btn.style.bottom = 'auto'; };
  const pos0 = GM_getValue('btnPos', null); if (pos0) ponerBtn(pos0.x, pos0.y);
  window.addEventListener('resize', () => { const p = GM_getValue('btnPos', null); if (p) ponerBtn(p.x, p.y); if (panel.style.display === 'block') ubicarPanel(); });
  let arr = null, movido = false;
  btn.addEventListener('pointerdown', e => { const r = btn.getBoundingClientRect(); arr = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY }; movido = false; btn.setPointerCapture(e.pointerId); });
  btn.addEventListener('pointermove', e => { if (!arr) return;
    if (!movido && Math.abs(e.clientX - arr.x0) + Math.abs(e.clientY - arr.y0) < 6) return;
    movido = true; btn.classList.add('mov'); ponerBtn(e.clientX - arr.dx, e.clientY - arr.dy); if (panel.style.display === 'block') ubicarPanel(); });
  btn.addEventListener('pointerup', () => { if (!arr) return; arr = null; btn.classList.remove('mov');
    if (movido) { const r = btn.getBoundingClientRect(); GM_setValue('btnPos', { x: r.left, y: r.top }); } });
  btn.ondblclick = () => { GM_deleteValue('btnPos'); btn.style.cssText = ''; if (panel.style.display === 'block') ubicarPanel(); };   // doble clic: vuelve a la esquina
  btn.onclick = () => { if (movido) { movido = false; return; } const ver = panel.style.display !== 'block'; panel.style.display = ver ? 'block' : 'none'; if (ver) { ubicarPanel(); cargar(); } };

  function pintarPanel(cargando) {
    const ev = esperanVos(), nTrab = lista.filter(t => trabado(ev[t.clave])).length, e = GM_getValue('estado', null), on = autoOn();
    const item = (t, i) => { const x = ev[t.clave];
      return `<div class="fila ${trabado(x) ? 'av' : ''}" title="${esc((t.modelo || '') + ' · VIN ' + t.vin)}"><div class="tx"><b>${esc(t.cliente)}</b><small>${t.cambio ? 'Reprogramar entrega' : t.soloControl ? 'Fecha pre-entrega en Controles' : CORTO[t.accion] || esc(t.accion)}${t.fecha ? ' · ' + esc(t.fecha) : ''}</small>` +
        (x ? `<em>${trabado(x) ? '⚠ ' : '↻ '}${esc(x.motivo)}</em>` : '') + `</div><div class="ac"><button class="h" data-i="${i}">Hacer</button><button class="s" data-x="${i}">ya está</button></div></div>`; };
    const hist = GM_getValue('historial', []);
    const sub = e && e.mal ? '⚠ ' + esc(e.txt) : cargando && !lista.length ? 'Buscando…' : !lista.length ? 'Al día con la app ✓' :
      lista.length + ' pendiente' + (lista.length > 1 ? 's' : '') + (nTrab ? ' · ' + nTrab + ' necesita' + (nTrab > 1 ? 'n' : '') + ' tu ok' : on ? ' · se hacen solos' : '');
    panel.innerHTML = `<div class="cab"><b>Entregas → Pilot</b><label class="sw" title="Con Pilot abierto, hace solo lo que marcás en la app">Auto<input type="checkbox" id="ae-auto" ${on ? 'checked' : ''}><span></span></label></div>` +
      `<div class="sub ${e && e.mal ? 'mal' : lista.length ? '' : 'ok'}">${sub}${cargando && lista.length ? ' · actualizando…' : ''}</div>` +
      `<div class="lnk"><button id="ae-ya">↻ Revisar ahora</button><button id="ae-ped" title="Busca tanque lleno, polarizado y accesorios en los comentarios de los legajos">🧾 Buscar pedidos</button>${nTrab ? '<button id="ae-reint">Reintentar frenados</button>' : ''}</div>` +
      (lista.length ? lista.map(item).join('') : cargando ? '' : '<div class="nada">Nada pendiente 👍</div>') +
      (hist.length ? '<details><summary>Últimos movimientos ›</summary><div class="hist">' + hist.slice(0, 8).map(esc).join('<br>') + '</div></details>' : '');
    panel.querySelector('#ae-auto').onchange = x => { GM_setValue('auto29', x.target.checked); pintarBtn(); pintarPanel(); reportar(); if (x.target.checked) setTimeout(autoCiclo, 500); };
    panel.querySelector('#ae-ya').onclick = () => { GM_setValue('autoLock', 0); estado('Revisando…'); pintarPanel(true); setTimeout(autoCiclo, 200); };
    panel.querySelector('#ae-ped').onclick = e => { e.target.textContent = '🧾 Buscando…'; e.target.disabled = true; revisarPedidos(true).finally(() => pintarPanel()); };
    const ri = panel.querySelector('#ae-reint'); if (ri) ri.onclick = () => { GM_setValue('esperanVos', {}); GM_setValue('autoLock', 0); estado('Reintentando…'); pintarPanel(true); setTimeout(autoCiclo, 300); };
  }
  async function cargar() {
    if (!cfg()) {
      panel.innerHTML = '<div class="hd"><b>Asistente Entregas</b><div class="est">Pegá el código de acceso de la app Entregas:</div><input type="text" id="ae-cod" placeholder="Código de acceso"><button class="h" id="ae-ok">Conectar</button></div>';
      panel.querySelector('#ae-ok').onclick = () => {
        const v = panel.querySelector('#ae-cod').value.trim().replace(/^.*#c=/, ''), p = v.split('.');
        if (p.length !== 2 || p[0].length < 20 || p[1].length < 20) return alert('Ese código no parece correcto');
        GM_setValue('cfg', { u: p[0], k: p[1] }); cargar(); latir(); setTimeout(autoCiclo, 3000);
      };
      return;
    }
    pintarPanel(true);   // al instante, con lo último que se sabe
    try { guardarLista(await api('getPilotPendientes')); }
    catch (e) { estado('No pude leer la app: ' + e.message, true);
      panel.innerHTML = '<div class="hd"><b>Asistente Entregas</b><div class="est mal">⚠ No pude leer la app: ' + esc(e.message) + '</div></div><div class="bd"><small>Si dice "Clave incorrecta", borrá el código y cargalo de nuevo.</small><div class="bt"><button class="h" id="ae-borrar">Borrar código de acceso</button></div></div>';
      panel.querySelector('#ae-borrar').onclick = () => { GM_deleteValue('cfg'); cargar(); }; return; }
    pintarBtn(); if (panel.style.display === 'block') pintarPanel();
  }
  panel.addEventListener('click', async e => {
    const h = e.target.closest('[data-i]'), x = e.target.closest('[data-x]');
    if (x) { const t = lista[+x.dataset.x]; if (!confirm('¿Marcar como hecho sin tocar Pilot?\n\n' + t.cliente + ' – ' + detalle(t))) return;
      await api('marcarPilot', [t.clave, 'marcado a mano']); sacarEsperaVos(t); historial(t.cliente + ': marcado a mano'); lista = lista.filter(z => z.clave !== t.clave); GM_setValue('listaCache', lista); pintarPanel(); pintarBtn(); reportar(); }
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
      // Por nombre: sirve con el nombre corto ("Crivani"), completo ("Crivani Victor Ramon") o al revés ("Victor Crivani")
      const pal = palabras(t.cliente).sort((a, b) => b.length - a.length);
      const vistos = {};
      for (const p of pal.slice(0, 3)) {   // prueba con las palabras más largas, una por una
        for (const f of await buscar(p)) { const id = datosFila(f).adminFileId; if (!vistos[id] && mismoNombre(t.cliente, nombreFila(f))) { vistos[id] = 1; filas.push(f); } }
        if (filas.length) break;
      }
    }
    if (filas.length > 1) {   // varios: quedarse con los que muestran este VIN (su final) en la unidad
      const v8 = t.vin.slice(-8).toUpperCase(), conVin = filas.filter(f => String(f.unit_description || '').toUpperCase().indexOf(v8) >= 0);
      if (conVin.length) filas = conVin;
    }
    return filas;
  }
  // Palabras de un nombre, sin comas, sin SRL/SA y sin palabras de 1-2 letras
  const palabras = s => norm(s).replace(/[.,;()]/g, ' ').split(' ').filter(p => p.length > 2 && !/^(srl|sa|sas|sociedad|anonima)$/.test(p));
  // Mismo nombre aunque esté al revés o uno sea más corto: todas las palabras del nombre corto están en el largo (o coinciden 2 o más).
  // También acepta abreviaturas de 4+ letras ("Alej" = "Alejandro").
  function mismoNombre(a, b) {
    const A = palabras(a), B = palabras(b); if (!A.length || !B.length) return false;
    const igual = (p, q) => p === q || (p.length >= 4 && q.length >= 4 && (p.indexOf(q) === 0 || q.indexOf(p) === 0));
    const com = A.filter(p => B.some(q => igual(p, q))).length;
    return com >= 2 || com === Math.min(A.length, B.length);
  }
  const nombreFila = f => norm(String(f.customer_rsocial).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\d+\s*$/, ''));
  const guidFila = f => (String(f.customer_rsocial).match(/open\('([0-9A-F-]{36})'\)/i) || [])[1];
  const datosFila = f => ({ adminFileId: String(f.admin_file_id).replace(/\D/g, ''), estadoPilot: norm(String(f.admin_file_status).replace(/<[^>]+>/g, '')) });

  /* ---------- Manual: botón "Hacer" (abre el legajo y lo hace a la vista) ---------- */
  async function abrirLegajo(t) {
    panel.innerHTML = '<div class="hd"><b>🔎 Buscando el legajo</b><div class="est">' + esc(t.cliente) + '…</div></div>';
    const filas = await buscarLegajos(t);
    if (!filas.length) { panel.innerHTML = '<div class="hd"><b>🚗 Asistente Entregas</b><div class="est mal">⚠ No encontré el legajo de ' + esc(t.cliente) + ' (VIN …' + esc(t.vin.slice(-8)) + ')</div></div><div class="bd" style="color:#cbd5e1;font-size:13px">Abrilo a mano en Pilot y hacelo desde ahí, o tocá "Ya está hecho" si ya lo hiciste.</div>'; return; }
    const ir = f => { const g = guidFila(f); if (!g) { panel.innerHTML = '<small>No pude abrir el legajo.</small>'; return; }
      GM_setValue('tarea', Object.assign({}, t, datosFila(f))); location.href = '/adminfileContext/index.php?guid=' + g + '#asistente'; };
    if (filas.length === 1) return ir(filas[0]);
    panel.innerHTML = '<div class="hd"><b>¿Cuál es el legajo de ' + esc(t.cliente) + '?</b><div class="est">Encontré ' + filas.length + ' posibles</div></div><div class="bd">' + filas.map((f, i) =>
      `<div class="it"><div class="cl">${esc(nombreFila(f))}</div><div class="md">Legajo #${datosFila(f).adminFileId} · ${esc(String(f.unit_description || '').replace(/<[^>]+>/g, ' '))}</div><div class="bt"><button class="h" data-leg="${i}">Es este</button></div></div>`).join('') + '</div>';
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
      await api('marcarPilot', [t.clave, 'asistente', t.cliente + ': ' + QUE[t.accion]]); sacarEsperaVos(t); historial(t.cliente + ': ' + QUE[t.accion] + ' ✔');
      fin(true, 'Todo hecho en Pilot');
    } catch (e) { marcarEsperaVos(t, e.message, e instanceof NecesitaVos); fin(false, (e instanceof NecesitaVos ? 'Cancelado: ' : 'Se frenó: ') + e.message + '. Lo que ya se hizo quedó hecho; revisá el legajo.'); }
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

    const yaHecho = k => !!prog(t.clave)[k], hecho = k => anotarProg(t.clave, k);
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

    // Tabla "Controles" (Agenda de entrega y unidad): filas [control, fecha, responsable]; null si no está en la página
    const filasControl = () => { for (const tb of d.querySelectorAll('table')) { const rs = [...tb.rows]; if (!rs.length) continue;
        const cab = norm(rs[0].innerText); if (!/control/.test(cab) || !/fecha/.test(cab) || !/responsable/.test(cab)) continue;
        return rs.slice(1).map(r => [...r.cells].map(c => norm(c.innerText))); } return null; };
    if ((t.accion === 'preentrega' || t.accion === 'preok') && !t.soloControl) {
      await cerrarTarea('Asignar turno pre-entrega y accesorios', true);
      await pasarAPreentrega();
    }
    if (t.accion === 'preok') {
      if (!t.soloControl) await cerrarTarea('Pre entrega ok');
      // 3.2: se fija SOLO en la tabla Controles (antes leía bloques enteros y a veces creía que ya estaba)
      let ctl = filasControl();
      if (!ctl) { const tb = d.getElementById('tab-entregas'); if (tb) tb.click(); for (let i = 0; i < 20 && !(ctl = filasControl()); i++) await esperar(500); }
      if (!ctl) throw new Error('no encontré la tabla Controles del legajo');
      const yaTiene = ctl.some(c => /pre[\s-]*entrega\s*ok/.test(c[0] || '') && /\d{2}\/\d{2}\/\d{4}/.test(c[1] || ''));
      if (yaTiene || yaHecho('control')) paso('• Controles ya tenía "Pre Entrega ok" con fecha');
      else {
        if (!sale) throw new Error('no encontré el número de venta del legajo para cargar el control');
        await post('/adminfileContext/services/add.delivery.check.php', { delivery_check_stage_id: CONTROL_PRE_OK, delivery_check_dt: t.fecha, sale_id: sale });
        hecho('control'); paso('✔ Controles: Pre Entrega ok ' + t.fecha);
      }
    }
    // 3.4: destildaste "Pre-entrega OK" en la app → reabrir la tarea y sacar la fecha de Controles (con los botones de Pilot)
    if (t.accion === 'deshacerPreok') {
      if (!preguntar('¿Deshacer "Pre-entrega OK" en el legajo de ' + t.cliente + '?\n\nSe destilda la tarea "Pre entrega ok" y se borra la fecha "Pre Entrega ok" de Controles.'))
        throw new NecesitaVos('deshacer cancelado');
      const x = tarea('Pre entrega ok');
      if (!x) paso('• La tarea "Pre entrega ok" no está en este legajo');
      else if (!x.hecha) paso('• La tarea "Pre entrega ok" ya estaba sin tildar');
      else {
        const inp = d.getElementById('chk_tarea_' + x.id) || d.querySelector('[id^="chk_tarea_"][data-id="' + x.id + '"]');
        (inp.closest('label') || inp).click();
        for (let i = 0; i < 16 && inp.checked; i++) await esperar(500);
        if (inp.checked) throw new NecesitaVos('Pilot no dejó destildar la tarea "Pre entrega ok": destildala a mano y tocá "Ya está hecho"');
        paso('✔ Destildé "Pre entrega ok"');
      }
      const filaPre = () => { for (const tb of d.querySelectorAll('table')) { const rs = [...tb.rows]; if (!rs.length) continue;
          const cab = norm(rs[0].innerText); if (!/control/.test(cab) || !/fecha/.test(cab)) continue;
          return rs.slice(1).find(r => /pre[\s-]*entrega\s*ok/.test(norm(r.cells[0] && r.cells[0].innerText))) || null; } return undefined; };
      let fp = filaPre();
      if (fp === undefined) { const tb = d.getElementById('tab-entregas'); if (tb) tb.click(); for (let i = 0; i < 20 && (fp = filaPre()) === undefined; i++) await esperar(500); }
      if (!fp) paso('• Controles no tenía "Pre Entrega ok"');
      else {
        const bor = [...fp.querySelectorAll('a,button,i,span')].find(e => /elimin|borr|quitar|delete|remove|trash|times|close/i.test((e.title || '') + ' ' + (e.getAttribute('data-original-title') || '') + ' ' + e.className + ' ' + (e.getAttribute('onclick') || '')));
        fp.style.outline = '3px solid #e11d48';
        if (!bor) throw new NecesitaVos('no encontré el botón para borrar "Pre Entrega ok" en Controles (lo marqué en rojo): borralo a mano y tocá "Ya está hecho"');
        (bor.closest('a,button') || bor).click(); paso('• Toqué borrar en Controles: si Pilot pregunta, confirmá');
        for (let i = 0; i < 60 && filaPre(); i++) await esperar(500);
        if (filaPre()) throw new NecesitaVos('la fecha "Pre Entrega ok" sigue en Controles: borrala a mano y tocá "Ya está hecho"');
        paso('✔ Saqué "Pre Entrega ok" de Controles');
      }
    }
    if (t.accion === 'cita') {
      const yaPlan = textoEntregas.indexOf('no hay planificacion de entrega') < 0;   // 3.0: si en la app cambiaste el día u hora (t.cambio), se reprograma en Pilot
      if (yaHecho('plan') || (yaPlan && !t.cambio)) paso('• Ya había una entrega planificada')
      else {
        const h = await horarioPilot(t.fecha, t.hora);
        const dd = { sale_id: sale, sale_admin_id: $('#sale_admin_id').val(), sale_delivery_rep_id: DANIEL, sale_delivered_branch_id: CASA_CENTRAL,
          sale_approximate_delivery_last_time: h, sale_approximate_delivery_last_date: dmyGuion(t.fecha) };
        if ($('#sale_rep_id').val()) dd.sale_rep_id = $('#sale_rep_id').val();
        await post('/adminfileContext/services/schedule.delivery.php', dd); hecho('plan'); paso((yaPlan ? '✔ Reprogramada: ' : '✔ Planificada: ') + t.fecha + ' ' + h.slice(0, 2) + ':' + h.slice(2) + ' · Daniel Diaz · Casa Central');
      }
      await cerrarTarea('Agendar cita para retirar la unidad');
    }
    if (t.accion === 'entregado') {
      if (!($('#stockDomain').attr('data-value') || '')) paso('• El auto no tiene patente cargada en Pilot (la entrega se marca igual)');
      if (yaHecho('marcar') || /fecha de entrega: \d/.test(textoEntregas)) paso('• La entrega ya estaba marcada');
      else {
        if (!sale) throw new Error('no encontré el número de venta del legajo');
        const dd = { sale_id: sale, sale_delivery_rep_id: DANIEL, sale_delivered_branch_id: CASA_CENTRAL,
          sale_delivered_inconvenience_flag: 0, sale_delivered_inconvenience_notes: '', sale_delivered_dt: dmyGuion(t.fecha) };
        if ($('#sale_rep_id').val()) dd.sale_rep_id = $('#sale_rep_id').val();
        // la hora de la entrega redondeada a la media hora (así la pide Pilot); si no la acepta, uso un horario que Pilot ofrezca
        const hm = hhmm(t.hora || '12:00'); let h = hm.slice(0, 2) + (+hm.slice(2) >= 30 ? '30' : '00');
        try { await post('/adminfileContext/services/marcar.delivery.php', Object.assign({ sale_delivered_time: h }, dd)); }
        catch (e) { h = await horarioPilot(t.fecha, t.hora || '12:00'); await post('/adminfileContext/services/marcar.delivery.php', Object.assign({ sale_delivered_time: h }, dd)); }
        hecho('marcar'); paso('✔ Entrega realizada ' + t.fecha + ' ' + h.slice(0, 2) + ':' + h.slice(2));
      }
      await cerrarTarea('Entrega Realizada', true);
      if (yaHecho('transfer')) paso('• Ya estaba transferido a Azul');
      else { await post('/api/adminfiles/transfer.php', { admin_file_id: id, to_user_id: AZUL, comment: 'Unidad entregada (Daniel Diaz).' }); hecho('transfer'); paso('✔ Legajo transferido a Azul Anabel Behotas'); }
      if (yaHecho('label')) paso('• Ya tenía la etiqueta Entregado');
      else { await post('/api/adminfiles/labels.php', { admin_file_id: id, admin_file_label_id: ETIQUETA_ENTREGADO }); hecho('label'); paso('✔ Etiqueta → Entregado'); }
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
    if (t.accion === 'deshacerPreok') throw new NecesitaVos('para deshacer el Pre-entrega OK tocá "Hacer" y confirmalo');
    const filas = await buscarLegajos(t);
    if (!filas.length) throw new NecesitaVos('no encontré el legajo: abrilo con "Hacer"');
    if (filas.length > 1) throw new NecesitaVos('hay ' + filas.length + ' legajos posibles: elegí el correcto con "Hacer"');
    const g = guidFila(filas[0]); if (!g) throw new Error('no pude abrir el legajo');
    t = Object.assign({}, t, datosFila(filas[0]));
    const f = await abrirOculto(g);
    const hechos = [];
    try { await pasos(t, f.contentWindow, txt => hechos.push(txt), () => false); }
    finally { f.remove(); }
    await api('marcarPilot', [t.clave, 'automático', t.cliente + ': ' + QUE[t.accion]]);
    return hechos.filter(x => x[0] === '✔').length;
  }
  // Le cuenta a la app qué falta en Pilot y qué no se pudo (sale en la 🔔, sección Pilot)
  async function reportar() {
    if (!listaOk) return;
    try {
      const ev = esperanVos();
      await api('pilotReporte', [{ auto: autoOn(), ver: VER, pend: lista.map(t => { const x = ev[t.clave];
        return { clave: t.clave, cliente: t.cliente, accion: t.accion, vin: t.vin, fecha: t.fecha || '', motivo: x ? x.motivo : '', espera: !!(x && x.espera), intentos: x ? x.n : 0 }; }) }]);
    } catch (e) {}
  }
  async function autoCiclo() {
    if (!cfg()) return estado('Falta el código de acceso de la app', true);
    if (!autoOn()) { if (Date.now() - (autoCiclo.rep || 0) > 5 * 60000) { autoCiclo.rep = Date.now(); api('getPilotPendientes').then(l => { guardarLista(l); pintarBtn(); reportar(); }).catch(() => {}); } return; }
    if (/\/login|logout/.test(location.pathname)) return estado('Pilot pide iniciar sesión', true);
    if (!W.$ || !W.gl_user_id) return estado('Esta página de Pilot no sirve: abrí el listado de legajos', true);
    if (corriendo) return;   // todavía está terminando la vuelta anterior
    if (Date.now() - GM_getValue('autoLock', 0) < 45000) return;   // otra pestaña de Pilot ya lo está haciendo
    corriendo = true; GM_setValue('autoLock', Date.now());
    const latido = setInterval(() => GM_setValue('autoLock', Date.now()), 15000);   // avisa a las otras pestañas que sigue trabajando
    try {
      guardarLista(await api('getPilotPendientes')); pintarBtn();
      const ev0 = esperanVos(), vivas = {}; lista.forEach(t => vivas[t.clave] = 1);   // lo que ya no está pendiente en la app se olvida
      Object.keys(ev0).forEach(k => { if (!vivas[k]) delete ev0[k]; }); GM_setValue('esperanVos', ev0);
      const ev = esperanVos();
      const esperando = lista.filter(t => trabado(ev[t.clave])).length;
      estado('Leí la app: ' + (lista.length ? lista.length + ' pendiente' + (lista.length > 1 ? 's' : '') + (esperando ? ' (' + esperando + ' esperan que los revises)' : '') : 'nada pendiente'));
      for (const t of lista) {
        if (trabado(esperanVos()[t.clave]) || !autoOn()) continue;
        GM_setValue('autoLock', Date.now());
        estadoAuto = '🤖 ' + t.cliente.split(' ')[0]; pintarBtn();
        try { const n = await hacerSolo(t); sacarEsperaVos(t); historial('🤖 ' + t.cliente + ': ' + QUE[t.accion] + (n ? ' ✔' : ' (ya estaba hecho)')); }
        catch (e) { marcarEsperaVos(t, e instanceof NecesitaVos ? e.message : 'se frenó: ' + (e.message || e), e instanceof NecesitaVos); historial('⚠ ' + t.cliente + ': ' + (e.message || e)); }
      }
      guardarLista(await api('getPilotPendientes'));
      await reportar();
    } catch (e) { estado('No pude leer la app: ' + (e.message || e), true); }
    finally { clearInterval(latido); GM_setValue('autoLock', 0); corriendo = false; estadoAuto = ''; pintarBtn(); if (panel.style.display === 'block') pintarPanel(); }
  }

  /* ---------- Vigía: avisa en la app (solo lee Pilot, no cambia nada) ----------
     1) legajos que pasan a la etiqueta "Ok para entrega"
     2) comentarios nuevos que deja otra persona en los legajos en preentrega, en entrega u "Ok para entrega" */
  const ETIQUETA_OK = 4, YO = 'daniel diaz';
  const limpio = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  async function listaLegajos(filtro) {
    const base = { status_filter: 'todos', business_type_filter: '', page: '', favorites: '', filter_seeker: '', filter_users_select: '',
      context_users: '', label_filter: '', sort: '', order: '', current_user_id: W.gl_user_id || '' };
    let filas = [], pag = 1, tot = 1;
    do {
      const r = await W.$.post('/adminfiles/services/adminfiles.list.php', Object.assign({}, base, filtro, { page: String(pag) }));
      const d = (r && r.data) || {}; filas = filas.concat(d.dataRows || []); tot = +d.total_pages || 1; pag++;
    } while (pag <= tot && pag <= 10);
    return filas.map(f => ({ id: String(f.admin_file_id).replace(/\D/g, ''), cliente: nombreFila(f).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()),
      modelo: limpio(f.unit_description), etiqueta: limpio(f.admin_file_label_color) }));
  }
  function comentarios(html) {
    const d = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    return [...d.querySelectorAll('.todo-tasklist-item')].map(it => {
      const tx = it.querySelector('.todo-tasklist-item-text'), cuerpo0 = it.querySelector('.pilot-event-list-item');
      const tit = limpio(tx ? tx.textContent.replace(cuerpo0 ? cuerpo0.textContent : '', '') : '');
      const cuerpo = it.querySelector('.pilot-event-list-item');
      const ctl = it.querySelector('.todo-tasklist-controls');
      return { tipo: tit, texto: cuerpo ? limpio(cuerpo.innerHTML.replace(/<br\s*\/?>/gi, ' · ')) : '',
        cuando: ctl ? limpio((ctl.querySelector('.pull-left') || {}).textContent) : '', quien: ctl ? limpio((ctl.querySelector('.pull-right') || {}).textContent) : '' };
    }).filter(e => /^comentario/i.test(e.tipo) && e.texto);
  }
  const fechaDe = s => { const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/); return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5]).getTime() : 0; };
  async function vigilar() {
    if (!cfg() || /\/login|logout/.test(location.pathname) || !W.$ || !W.gl_user_id) return;
    if (Date.now() - GM_getValue('vigLock', 0) < 8 * 60000) return;   // otra pestaña de Pilot ya lo hizo hace poco
    GM_setValue('vigLock', Date.now());
    try {
      const avisos = [], primera = !GM_getValue('vigInicio', 0);
      // 1) Ok para entrega
      const ok = await listaLegajos({ label_filter: String(ETIQUETA_OK) });
      api('pilotOkLista', [ok.map(l => ({ cliente: l.cliente, modelo: l.modelo }))]).catch(() => {});   // para la tarjeta Mi día
      const okVistos = GM_getValue('okVistos', {}), okAhora = {};
      ok.forEach(l => { okAhora[l.id] = 1; if (!primera && !okVistos[l.id]) avisos.push({ tipo: 'ok', id: 'ok|' + l.id + '|' + new Date().toDateString(), cliente: l.cliente, modelo: l.modelo }); });
      // 2) Comentarios de otros en los legajos que estás trabajando
      const mios = {}; ok.concat(await listaLegajos({ status_filter: String(ESTADO_PREENTREGA) }), await listaLegajos({ status_filter: '12' })).forEach(l => { if (!/^entregado$/i.test(l.etiqueta)) mios[l.id] = l; });   // los ya entregados no
      const vistos = GM_getValue('notasVistas', {}), lim = Date.now() - 24 * 3600000;
      for (const l of Object.values(mios)) {
        const r = await W.$.post('/adminfileContext/services/get.events.list.php', { admin_file_id: l.id, page: 1, show_historical_events: false });
        for (const c of comentarios((r && r.data) || '')) {
          const k = l.id + '|' + c.cuando + '|' + c.texto.slice(0, 60);
          if (vistos[k]) continue;
          vistos[k] = Date.now();
          if (norm(c.quien) === YO || (primera && fechaDe(c.cuando) < lim)) continue;   // lo tuyo no; la primera vez, solo lo de las últimas 24 h
          avisos.push({ tipo: 'nota', id: 'nota|' + k, cliente: l.cliente, modelo: l.modelo, texto: c.texto, quien: c.quien });
        }
      }
      if (avisos.length) await api('pilotAvisos', [avisos]);
      GM_setValue('okVistos', okAhora);
      const corte = Date.now() - 30 * 86400000; Object.keys(vistos).forEach(k => { if (vistos[k] < corte) delete vistos[k]; });
      GM_setValue('notasVistas', vistos); GM_setValue('vigInicio', Date.now());
      if (avisos.length) historial('🔔 ' + avisos.length + ' aviso' + (avisos.length > 1 ? 's' : '') + ' de Pilot enviado' + (avisos.length > 1 ? 's' : '') + ' a la app');
    } catch (e) { GM_setValue('vigLock', 0); /* reintenta en el próximo ciclo */ }
  }

  /* ---------- Pedidos del legajo (3.1): tanque lleno, polarizado y accesorios ----------
     Lee TODOS los comentarios de los legajos de los autos que todavía no se entregaron (también los viejos)
     y le manda a la app lo que encuentra. Solo lee Pilot, no cambia nada. Cada 2 horas. */
  const PEDIDOS = [
    ['tanque', /tanque\s*(lleno|completo|full)|full\s*tank|llenar\s*(el\s*)?tanque|cargar?\s*(el\s*)?tanque|carga\s*(de\s*)?(nafta|combustible)|(nafta|combustible|gasoil)\s*(lleno|completo|full)|\bnafta\b/],
    ['polarizado', /polariz/],
    ['accesorio', /accesorio|cubre\s*alfombra|alfombra|enganche|estribo|barras?\s*(de\s*techo|antivuelco|portaequipaje)|antivuelco|lona\s*(maritima|marinera)?|cobertor|protector\s*de\s*(caja|carter|batea|caja de carga)|cubre\s*batea|jaula|cupula|sensor(es)?\s*de\s*estacionamiento|camara\s*(de\s*)?(retroceso|trasera)|deflector|portaequipaje|bola\s*de\s*enganche|kit\s*de\s*seguridad|matafuego/]
  ];
  const NIEGA = /\b(sin|no\s+(lleva|quiere|va|tiene|lleve|quiso)|no)\s+(\S+\s+){0,2}$/;
  function buscarPedidos(texto) {
    const n = norm(texto), out = [];
    for (const [tipo, re] of PEDIDOS) {
      const m = n.match(re); if (!m) continue;
      if (NIEGA.test(n.slice(Math.max(0, m.index - 25), m.index))) continue;   // "sin polarizado", "no lleva accesorios"
      out.push(tipo === 'accesorio' ? 'accesorios' : tipo);
    }
    return out;
  }
  function textosLegajo(html) {
    const d = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    return [...d.querySelectorAll('.todo-tasklist-item')].map(it => {
      const cuerpo = it.querySelector('.pilot-event-list-item'), ctl = it.querySelector('.todo-tasklist-controls');
      return { texto: cuerpo ? limpio(cuerpo.innerHTML.replace(/<br\s*\/?>/gi, ' · ')) : '',
        cuando: ctl ? limpio((ctl.querySelector('.pull-left') || {}).textContent) : '', quien: ctl ? limpio((ctl.querySelector('.pull-right') || {}).textContent) : '' };
    }).filter(x => x.texto);   // solo lo que alguien escribió (comentarios, notas), no los cambios automáticos
  }
  async function revisarPedidos(forzar) {
    if (!cfg() || /\/login|logout/.test(location.pathname) || !W.$ || !W.gl_user_id) return;
    if (!forzar && Date.now() - GM_getValue('pedLock', 0) < 2 * 3600000) return;   // cada 2 horas (entre todas las pestañas)
    GM_setValue('pedLock', Date.now());
    let autos; try { autos = await api('getAutosPilot'); } catch (e) { GM_setValue('pedLock', 0); return; }
    const encontrados = []; let leidos = 0;
    for (const a of autos) {
      while (corriendo) await esperar(5000);   // primero lo que marcás en la app
      try {
        const filas = (await buscarLegajos(a)).slice(0, 2);
        for (const f of filas) {
          const id = datosFila(f).adminFileId, vistos = {};
          for (let pag = 1; pag <= 6; pag++) {
            const r = await W.$.post('/adminfileContext/services/get.events.list.php', { admin_file_id: id, page: pag, show_historical_events: true });
            const items = textosLegajo((r && r.data) || ''); let nuevos = 0;
            for (const x of items) {
              const k = x.cuando + '|' + x.texto.slice(0, 80); if (vistos[k]) continue; vistos[k] = 1; nuevos++;
              buscarPedidos(x.texto).forEach(tipo => encontrados.push({ vin: a.vin, cliente: a.cliente, tipo, texto: x.texto.slice(0, 400), quien: x.quien, cuando: x.cuando }));
            }
            if (!nuevos) break;   // no hay más páginas
          }
          leidos++;
        }
      } catch (e) { /* ese legajo se revisa en la próxima vuelta */ }
      await esperar(400);   // sin apurar a Pilot
    }
    try { const n = await api('pilotPedidos', [encontrados]);
      historial('🧾 Revisé ' + leidos + ' legajos: ' + (n ? n + ' auto' + (n > 1 ? 's' : '') + ' con pedidos nuevos (tanque, polarizado o accesorios)' : 'nada nuevo'));
    } catch (e) { GM_setValue('pedLock', 0); }
  }

  /* ---------- Arranque ---------- */
  const latir = () => api('pilotLatido').catch(() => {});   // la app muestra "● Pilot" en verde mientras esto llegue
  if (!/login/.test(location.host + location.pathname)) {   // arranca aunque todavía no esté el código: cuando lo cargues, sigue solo
    if (cfg()) api('getPilotPendientes').then(l => { guardarLista(l); pintarBtn(); reportar(); }).catch(e => estado('No pude leer la app: ' + e.message, true));
    latir(); setInterval(latir, 120000);
    setTimeout(autoCiclo, 3000); setInterval(autoCiclo, CADA);
    // Al instante: la app anota la hora de cada cambio (getPilotVer); si cambió, hace la revisión completa ya
    let verVista = null;
    setInterval(async () => {
      if (!cfg() || !autoOn() || corriendo) return;
      try { const v = await api('getPilotVer'); if (v !== verVista) { const primera = verVista === null; verVista = v; if (!primera) autoCiclo(); } } catch (e) {}
    }, RAPIDO);
    // Al volver a la pestaña de Pilot, se fija en el momento (sin esperar los 10 segundos)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) autoCiclo(); });
    window.addEventListener('focus', () => autoCiclo());
    setTimeout(vigilar, 40000); setInterval(vigilar, 10 * 60000);
    setTimeout(revisarPedidos, 90000); setInterval(revisarPedidos, 15 * 60000);   // pedidos del legajo: cada 2 horas   // avisos de Pilot a la app, cada 10 minutos
  }
})();
