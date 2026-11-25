'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => n == null ? '—' : Math.round(n).toLocaleString('de-DE');
const RANGOS = [[1, '24 h'], [7, '7 días'], [30, '30 días'], [90, '90 días'], [0, 'Todo']];
const MAX_SERIES = 8;

let D = null;                       // datos del servidor
let series = new Map();             // "asin|mk" -> [[ts,bsr],...]
let ultimas = new Map();            // "asin|mk" -> última lectura (con estado)
const guardado = (() => { try { return JSON.parse(localStorage.getItem('bsr') || '{}'); } catch { return {}; } })();
const F = {
  rango: guardado.rango ?? 7,
  marcas: new Set(guardado.marcas || []),
  mercados: new Set(guardado.mercados || []),
  buscar: '',
  orden: guardado.orden || 'marca',
};
let sel = new Map(guardado.sel || []);   // clave -> hueco de color (0..7)
let selTocada = !!guardado.sel;

function guardar() {
  try {
    localStorage.setItem('bsr', JSON.stringify({ rango: F.rango, marcas: [...F.marcas], mercados: [...F.mercados], orden: F.orden, sel: [...sel] }));
  } catch { /* sin almacenamiento: no pasa nada */ }
}

// En GitHub Pages no hay servidor: el panel es de solo lectura y lee datos.json, que actualiza la tarea programada.
const ESTATICO = !['127.0.0.1', 'localhost'].includes(location.hostname);
if (ESTATICO) document.body.classList.add('estatico');
async function api(ruta, cuerpo) {
  if (ESTATICO) {
    if (!ruta.startsWith('/api/datos')) return {};
    const d = await (await fetch('datos.json?t=' + Date.now())).json();
    d.ahora = Math.floor(Date.now() / 1000);
    return d;
  }
  const r = await fetch(ruta, cuerpo ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) } : undefined);
  return r.json();
}

// ------------------------------------------------------------------ carga
async function cargar() {
  const dias = F.rango === 0 ? 0 : Math.max(F.rango, 2);   // mínimo 2 días para poder calcular la variación de 24 h
  D = await api('/api/datos?dias=' + dias);
  series = new Map();
  for (const [a, m, ts, bsr] of D.lecturas) {
    const k = a + '|' + m;
    if (!series.has(k)) series.set(k, []);
    series.get(k).push([ts, bsr]);
  }
  ultimas = new Map(D.ultimas.map(u => [u.asin + '|' + u.mercado, u]));
  for (const k of [...sel.keys()]) if (!libro(k.split('|')[0])) sel.delete(k);
  if (!selTocada && !sel.size) seleccionPorDefecto();
  pintar();
}

const libro = asin => D.libros.find(l => l.asin === asin);
const mercado = cod => D.mercados.find(m => m.cod === cod);
const tituloDe = l => l.titulo || l.asin;

function seleccionPorDefecto() {
  const l = D.libros.find(l => l.mercados.some(m => series.has(l.asin + '|' + m)));
  if (!l) return;
  l.mercados.filter(m => series.has(l.asin + '|' + m))
    .sort((a, b) => ult(l.asin, a) - ult(l.asin, b)).slice(0, 5)
    .forEach(m => anadirSel(l.asin + '|' + m));
}

function ult(asin, mk) { const s = series.get(asin + '|' + mk); return s ? s[s.length - 1][1] : Infinity; }

// variación frente a la lectura de hace ~24 h (negativa = mejora)
function delta(k) {
  const s = series.get(k);
  if (!s || s.length < 2) return null;
  const [t1, v1] = s[s.length - 1];
  let ref = null;
  for (const p of s) { if (p[0] <= t1 - 20 * 3600) ref = p; else break; }
  if (!ref) return null;
  return (v1 - ref[1]) / ref[1];
}

function enRango(s) {
  if (!s) return [];
  if (F.rango === 0) return s;
  const desde = D.ahora - F.rango * 86400;
  return s.filter(p => p[0] >= desde);
}

// ------------------------------------------------------------------ selección
function anadirSel(k) {
  if (sel.has(k)) return true;
  if (sel.size >= MAX_SERIES) return false;
  const usados = new Set(sel.values());
  let h = 0; while (usados.has(h)) h++;
  sel.set(k, h);
  return true;
}
function alternar(claves) {
  selTocada = true;
  const todas = claves.every(k => sel.has(k));
  if (todas) claves.forEach(k => sel.delete(k));
  else for (const k of claves) if (!anadirSel(k)) break;
  guardar(); pintar();
}

// ------------------------------------------------------------------ filtros
function librosVisibles() {
  const q = F.buscar.trim().toLowerCase();
  let ls = D.libros.filter(l =>
    (!F.marcas.size || F.marcas.has(l.marca || '—')) &&
    (!q || [tituloDe(l), l.asin, l.marca, l.serie].some(x => (x || '').toLowerCase().includes(q))));
  const ms = mercadosVisibles(ls);
  const mejor = l => Math.min(...ms.map(m => ult(l.asin, m.cod)));
  const mejora = l => Math.min(...ms.map(m => delta(l.asin + '|' + m.cod) ?? 0));
  if (F.orden === 'mejor') ls = [...ls].sort((a, b) => mejor(a) - mejor(b));
  if (F.orden === 'mejora') ls = [...ls].sort((a, b) => mejora(a) - mejora(b));
  return ls;
}
function mercadosVisibles(ls) {
  const usados = new Set(ls.flatMap(l => l.mercados));
  return D.mercados.filter(m => usados.has(m.cod) && (!F.mercados.size || F.mercados.has(m.cod)));
}

function pintarFiltros() {
  $('#f-rango').innerHTML = RANGOS.map(([d, t]) => `<button class="chip ${F.rango === d ? 'on' : ''}" data-rango="${d}">${t}</button>`).join(' ');
  const marcas = [...new Set(D.libros.map(l => l.marca || '—'))].sort();
  $('#fila-marcas').style.display = marcas.length > 1 ? '' : 'none';
  $('#f-marcas').innerHTML = `<button class="chip ${F.marcas.size ? '' : 'on'}" data-marca="">Todas</button>` +
    marcas.map(m => `<button class="chip ${F.marcas.has(m) ? 'on' : ''}" data-marca="${esc(m)}">${esc(m === '—' ? 'Sin marca' : m)}</button>`).join('');
  const usados = new Set(D.libros.flatMap(l => l.mercados));
  $('#f-mercados').innerHTML = `<button class="chip ${F.mercados.size ? '' : 'on'}" data-mercado="">Todos</button>` +
    D.mercados.filter(m => usados.has(m.cod)).map(m =>
      `<button class="chip ${F.mercados.has(m.cod) ? 'on' : ''}" data-mercado="${m.cod}" title="${esc(m.nombre)}">${m.bandera} ${m.cod}</button>`).join('');
  $('#lista-marcas').innerHTML = marcas.filter(m => m !== '—').map(m => `<option value="${esc(m)}">`).join('');
  $('#orden').value = F.orden;
}

// ------------------------------------------------------------------ cabecera y KPIs
const hm = seg => { const m = Math.round(seg / 60); return `${Math.floor(m / 60)} h ${m % 60} min`; };
function hace(seg) {
  if (seg < 90) return 'hace un momento';
  if (seg < 3600) return `hace ${Math.round(seg / 60)} min`;
  if (seg < 86400) return `hace ${hm(seg)}`;
  return `hace ${Math.round(seg / 86400)} días`;
}
function pintarEstado() {
  const p = D.progreso, b = $('#barra');
  $('#intervalo').value = String(Math.round(D.intervalo_horas));
  $('#actualizar').disabled = p.activo;
  b.classList.toggle('activa', p.activo);
  if (p.activo) {
    b.firstElementChild.style.width = (p.total ? 100 * p.hechos / p.total : 0) + '%';
    $('#estado').textContent = `Leyendo Amazon… ${p.hechos}/${p.total}${p.actual ? ' · ' + p.actual : ''}`;
    return;
  }
  const tsUlt = Math.max(0, ...D.ultimas.map(u => u.ts));
  if (!tsUlt) { $('#estado').textContent = D.libros.length ? 'Aún sin lecturas.' : ''; return; }
  const prox = (D.proximo || D.ultimo_ciclo + D.intervalo_horas * 3600) - D.ahora;
  const proxTxt = prox <= 60 ? 'en breve' : prox < 3600 ? `en ${Math.round(prox / 60)} min` : `en ${hm(prox)}`;
  const bloq = D.ultimas.filter(u => u.estado === 'bloqueado').length;
  $('#estado').textContent = `Última lectura ${hace(D.ahora - tsUlt)} · próxima ${proxTxt}` +
    (p.aviso ? ' · ⚠ ' + p.aviso : bloq ? ` · ⚠ ${bloq} lecturas limitadas por Amazon` : '');
}

function pintarKpis(ls, ms) {
  let mejor = null, suben = 0, bajan = 0, n = 0, top = null;
  for (const l of ls) for (const m of ms) {
    if (!l.mercados.includes(m.cod)) continue;
    const k = l.asin + '|' + m.cod, v = ult(l.asin, m.cod);
    if (v === Infinity) continue;
    n++;
    if (!mejor || v < mejor.v) mejor = { v, l, m };
    const d = delta(k);
    if (d != null) {
      if (d <= -0.02) suben++; else if (d >= 0.02) bajan++;
      if (!top || d < top.d) top = { d, l, m };
    }
  }
  const t = (rot, val, nota) => `<div class="tarjeta kpi"><div class="rotulo">${rot}</div><div class="valor">${val}</div><div class="nota" title="${esc(nota)}">${esc(nota) || '&nbsp;'}</div></div>`;
  $('#kpis').innerHTML =
    t('Libros', ls.length, `${ms.length} países · ${n} rankings activos`) +
    t('Mejor BSR ahora', mejor ? '#' + num(mejor.v) : '—', mejor ? `${mejor.m.bandera} ${mejor.m.cod} · ${tituloDe(mejor.l)}` : 'Sin lecturas todavía') +
    t('Mejoran en 24 h', `<span class="sube"><span class="ic">▲</span></span> ${suben}`, `${bajan} empeoran (▼) · umbral ±2 %`) +
    t('Mayor subida 24 h', top && top.d < 0 ? `▲ ${Math.round(-top.d * 100)} %` : '—', top && top.d < 0 ? `${top.m.bandera} ${top.m.cod} · ${tituloDe(top.l)}` : 'Hace falta un día de historial');
}

// ------------------------------------------------------------------ tabla
function chispa(pts) {
  if (pts.length < 2) return '<svg width="64" height="18"></svg>';
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const ls = pts.map(p => Math.log(p[1])), lo = Math.min(...ls), hi = Math.max(...ls);
  const d = pts.map((p, i) => {
    const x = 1 + 62 * (p[0] - t0) / (t1 - t0 || 1);
    const y = hi === lo ? 9 : 2 + 14 * (ls[i] - lo) / (hi - lo);   // rank bajo = arriba
    return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }).join('');
  return `<svg width="64" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--text-muted)" stroke-width="1.25" stroke-linejoin="round"/></svg>`;
}
const ESTADOS = { bloqueado: ['⚠', 'Amazon limitó esta lectura; se reintentará'], sin_ranking: ['—', 'El libro existe en este país pero aún no tiene BSR'],
  no_disponible: ['∅', 'Este ASIN no existe en este país'], error: ['⚠', 'No se pudo leer la página'] };

function pintarTabla(ls, ms) {
  if (!ls.length) { $('#tabla').innerHTML = '<div class="vacio-total">Ningún libro coincide con los filtros.</div>'; return; }
  let h = '<table><thead><tr><th class="libro">Libro</th>' +
    ms.map(m => `<th><button data-col="${m.cod}" title="Comparar ${esc(m.nombre)} entre libros">${m.bandera} ${m.cod}</button></th>`).join('') + '</tr></thead><tbody>';
  for (const l of ls) {
    h += `<tr class="${l.activo ? '' : 'pausado'}"><td class="libro"><div class="lib">` +
      (l.portada ? `<img src="${esc(l.portada)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="sinp"></div>') +
      `<div class="t"><button data-fila="${l.asin}" title="Ver este libro en todos los países">${esc(tituloDe(l))}</button>
        <div class="m">${l.marca ? `<span class="marca">${esc(l.marca)}</span>` : ''}${l.asin}${l.serie ? ' · ' + esc(l.serie) : ''}${l.activo ? '' : ' · en pausa'}</div></div>
       <button class="ed" data-editar="${l.asin}" title="Editar" aria-label="Editar">✎</button></div></td>`;
    for (const m of ms) {
      const k = l.asin + '|' + m.cod;
      if (!l.mercados.includes(m.cod)) { h += '<td class="nada">·</td>'; continue; }
      const u = ultimas.get(k), s = series.get(k), d = delta(k);
      const color = sel.has(k) ? `style="border-left-color:var(--s${sel.get(k) + 1})"` : '';
      const url = `https://www.${m.dominio}/dp/${l.asin}`;
      let dentro;
      if (s) {
        const cats = u && u.categorias.length ? '\n' + u.categorias.map(c => `#${num(c[0])} en ${c[1]}`).join('\n') : '';
        const dtxt = d == null ? '' : Math.abs(d) < 0.005 ? '= 24 h' : `<span class="ic">${d < 0 ? '▲' : '▼'}</span> ${Math.round(Math.abs(d) * 100)} %`;
        dentro = `<button class="celda ${sel.has(k) ? 'sel' : ''}" ${color} data-celda="${k}" title="${esc(tituloDe(l))} · ${esc(m.nombre)}\nLeído ${hace(D.ahora - s[s.length - 1][0])}${esc(cats)}\n${url}">
          <div class="n">${num(s[s.length - 1][1])}</div><div class="d ${d < 0 ? 'sube' : d > 0 ? 'baja' : ''}">${dtxt}</div>${chispa(enRango(s))}</button>`;
      } else {
        const [ic, txt] = u ? (ESTADOS[u.estado] || ['…', '']) : ['…', 'Pendiente de la primera lectura'];
        dentro = `<a class="celda x" href="${url}" target="_blank" rel="noopener" title="${esc(txt)}">${ic}</a>`;
      }
      h += `<td>${dentro}</td>`;
    }
    h += '</tr>';
  }
  $('#tabla').innerHTML = h + '</tbody></table>';
}

// ------------------------------------------------------------------ gráfica
function nombreSerie(k, modo) {
  const [a, m] = k.split('|'), l = libro(a), mk = mercado(m);
  const t = tituloDe(l);
  if (modo === 'pais') return `${mk.bandera} ${mk.nombre}`;
  if (modo === 'libro') return t;
  return `${mk.bandera} ${m} · ${t}`;
}
function pintarGrafica() {
  const caja = $('#lienzo');
  const claves = [...sel.keys()].filter(k => libro(k.split('|')[0]));
  const asins = new Set(claves.map(k => k.split('|')[0])), mks = new Set(claves.map(k => k.split('|')[1]));
  const modo = claves.length > 1 && asins.size === 1 ? 'pais' : claves.length > 1 && mks.size === 1 ? 'libro' : 'ambos';
  const S = claves.map(k => ({ k, hueco: sel.get(k), nombre: nombreSerie(k, modo), pts: enRango(series.get(k)) }));
  const contexto = modo === 'pais' ? tituloDe(libro([...asins][0])) : modo === 'libro' ? `${mercado([...mks][0]).bandera} ${mercado([...mks][0]).nombre}` : '';

  $('#leyenda').innerHTML = (contexto ? `<span class="ley" style="border:0;padding-left:0"><b>${esc(contexto)}</b></span>` : '') + S.map(s =>
    `<span class="ley"><i style="background:var(--s${s.hueco + 1})"></i>${esc(s.nombre.length > 46 ? s.nombre.slice(0, 45) + '…' : s.nombre)}
     <b>${s.pts.length ? '#' + num(s.pts[s.pts.length - 1][1]) : '—'}</b><button data-quitar="${s.k}" title="Quitar" aria-label="Quitar">×</button></span>`).join('');

  const todos = S.flatMap(s => s.pts);
  if (!todos.length) {
    caja.innerHTML = `<div class="vacio">${claves.length ? 'No hay lecturas en este periodo para la selección.' : 'Selecciona celdas de la tabla para ver su evolución.'}</div>`;
    return;
  }
  const W = Math.max(320, caja.clientWidth), H = Math.max(200, caja.clientHeight);
  const etiquetas = S.length <= 4;
  const mg = { l: 62, r: etiquetas ? 112 : 18, t: 12, b: 28 };
  let t0 = Math.min(...todos.map(p => p[0])), t1 = Math.max(...todos.map(p => p[0]));
  if (t1 - t0 < 3600) { t0 -= 1800; t1 += 1800; }
  let lo = Math.min(...todos.map(p => p[1])), hi = Math.max(...todos.map(p => p[1]));
  const log = hi / lo > 5;
  const f = log ? Math.log10 : (v => v);
  let a = f(lo), b = f(hi);
  if (a === b) { a -= log ? 0.1 : Math.max(1, lo * 0.1); b += log ? 0.1 : Math.max(1, lo * 0.1); }
  const pad = (b - a) * 0.08; a -= pad; b += pad;
  const X = t => mg.l + (W - mg.l - mg.r) * (t - t0) / (t1 - t0);
  const Y = v => mg.t + (H - mg.t - mg.b) * (f(v) - a) / (b - a);     // menor rank = más arriba

  // marcas del eje Y
  let ticks = [];
  if (log) {
    for (let e = Math.floor(a); e <= Math.ceil(b); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (f(v) >= a && f(v) <= b) ticks.push(v); }
    if (ticks.length > 9) ticks = ticks.filter(v => /^1/.test(String(v)));
  } else {
    const paso0 = (b - a) / 5, mag = 10 ** Math.floor(Math.log10(paso0)), paso = [1, 2, 5, 10].map(m => m * mag).find(p => p >= paso0) || mag;
    for (let v = Math.ceil(a / paso) * paso; v <= b; v += paso) if (v >= 1) ticks.push(v);
  }
  const dia = t1 - t0 > 2.5 * 86400;
  const fx = t => { const d = new Date(t * 1000); return dia ? d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }) : d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); };
  const nx = Math.max(2, Math.min(8, Math.floor((W - mg.l - mg.r) / 110)));

  let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del BSR de la selección">`;
  for (const v of ticks) g += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rejilla)"/><text x="${mg.l - 8}" y="${Y(v) + 4}" text-anchor="end" font-size="11.5" fill="var(--text-muted)">${num(v)}</text>`;
  for (let i = 0; i <= nx; i++) { const t = t0 + (t1 - t0) * i / nx; g += `<text x="${X(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === nx ? 'end' : 'middle'}" font-size="11.5" fill="var(--text-muted)">${fx(t)}</text>`; }
  const finales = [];
  for (const s of S) {
    if (!s.pts.length) continue;
    const c = `var(--s${s.hueco + 1})`;
    g += `<path d="${s.pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join('')}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (s.pts.length <= 30) for (const p of s.pts) g += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="${c}" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    const u = s.pts[s.pts.length - 1];
    finales.push({ y: Y(u[1]), x: X(u[0]), s });
  }
  if (etiquetas) {
    finales.sort((p, q) => p.y - q.y);
    for (let i = 1; i < finales.length; i++) if (finales[i].y - finales[i - 1].y < 15) finales[i].y = finales[i - 1].y + 15;
    for (const e of finales) {
      const [a2, m2] = e.s.k.split('|');
      const txt = modo === 'libro' ? tituloDe(libro(a2)).slice(0, 13) : modo === 'pais' ? m2 : `${m2} ${tituloDe(libro(a2)).slice(0, 9)}`;
      g += `<circle cx="${W - mg.r + 10}" cy="${e.y}" r="4" fill="var(--s${e.s.hueco + 1})"/><text x="${W - mg.r + 18}" y="${e.y + 4}" font-size="11.5" fill="var(--text-secondary)">${esc(txt)}</text>`;
    }
  }
  g += `<line id="cruz" y1="${mg.t}" y2="${H - mg.b}" stroke="var(--text-muted)" stroke-dasharray="3 3" visibility="hidden"/><g id="puntos"></g>
        <rect id="zona" x="${mg.l}" y="${mg.t}" width="${W - mg.l - mg.r}" height="${H - mg.t - mg.b}" fill="transparent"/></svg><div class="tip" id="tip"></div>`;
  caja.innerHTML = g;

  const tiempos = [...new Set(todos.map(p => p[0]))].sort((x, y) => x - y);
  const tol = Math.max(2700, (t1 - t0) / 40);
  const zona = caja.querySelector('#zona'), cruz = caja.querySelector('#cruz'), puntos = caja.querySelector('#puntos'), tip = $('#tip');
  zona.addEventListener('mousemove', ev => {
    const r = caja.getBoundingClientRect(), px = ev.clientX - r.left;
    const t = t0 + (t1 - t0) * (px - mg.l) / (W - mg.l - mg.r);
    const tc = tiempos.reduce((m, x) => Math.abs(x - t) < Math.abs(m - t) ? x : m, tiempos[0]);
    const filas = [];
    for (const s of S) {
      const p = s.pts.reduce((m, q) => !m || Math.abs(q[0] - tc) < Math.abs(m[0] - tc) ? q : m, null);
      if (p && Math.abs(p[0] - tc) <= tol) filas.push({ s, p });
    }
    filas.sort((p, q) => p.p[1] - q.p[1]);
    cruz.setAttribute('x1', X(tc)); cruz.setAttribute('x2', X(tc)); cruz.setAttribute('visibility', 'visible');
    puntos.innerHTML = filas.map(f2 => `<circle cx="${X(f2.p[0])}" cy="${Y(f2.p[1])}" r="4.5" fill="var(--s${f2.s.hueco + 1})" stroke="var(--surface-1)" stroke-width="2"/>`).join('');
    tip.innerHTML = `<div class="f">${new Date(tc * 1000).toLocaleString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` +
      filas.map(f2 => `<div class="l"><i style="background:var(--s${f2.s.hueco + 1})"></i><span>${esc(f2.s.nombre)}</span><b>#${num(f2.p[1])}</b></div>`).join('');
    tip.style.display = 'block';
    const tw = tip.offsetWidth, x = X(tc) + 14 + tw > W ? X(tc) - 14 - tw : X(tc) + 14;
    tip.style.left = Math.max(0, x) + 'px'; tip.style.top = Math.max(0, Math.min(H - tip.offsetHeight, ev.clientY - r.top - 20)) + 'px';
  });
  zona.addEventListener('mouseleave', () => { cruz.setAttribute('visibility', 'hidden'); puntos.innerHTML = ''; tip.style.display = 'none'; });
}

// ------------------------------------------------------------------ pintar todo
function pintar() {
  const hay = D.libros.length > 0;
  $('#panel').hidden = !hay; $('#sin-libros').hidden = hay;
  pintarEstado();
  if (!hay) return;
  const ls = librosVisibles(), ms = mercadosVisibles(ls);
  pintarFiltros(); pintarKpis(ls, ms); pintarGrafica(); pintarTabla(ls, ms);
}

// ------------------------------------------------------------------ eventos
document.addEventListener('click', async ev => {
  const b = ev.target.closest('button,[data-cerrar]');
  if (!b) return;
  const d = b.dataset;
  if ('cerrar' in d) return b.closest('dialog').close();
  if ('rango' in d) { F.rango = +d.rango; guardar(); return cargar(); }
  if ('marca' in d) { if (!d.marca) F.marcas.clear(); else F.marcas.has(d.marca) ? F.marcas.delete(d.marca) : F.marcas.add(d.marca); guardar(); return pintar(); }
  if ('mercado' in d) { if (!d.mercado) F.mercados.clear(); else F.mercados.has(d.mercado) ? F.mercados.delete(d.mercado) : F.mercados.add(d.mercado); guardar(); return pintar(); }
  if ('celda' in d) return alternar([d.celda]);
  if ('quitar' in d) return alternar([d.quitar]);
  if ('fila' in d) {
    const l = libro(d.fila), ms = mercadosVisibles(librosVisibles());
    const ks = ms.filter(m => series.has(l.asin + '|' + m.cod)).sort((a, c) => ult(l.asin, a.cod) - ult(l.asin, c.cod)).map(m => l.asin + '|' + m.cod).slice(0, MAX_SERIES);
    if (!ks.every(k => sel.has(k))) sel.clear();
    return alternar(ks);
  }
  if ('col' in d) {
    const ks = librosVisibles().filter(l => series.has(l.asin + '|' + d.col)).sort((a, c) => ult(a.asin, d.col) - ult(c.asin, d.col)).map(l => l.asin + '|' + d.col).slice(0, MAX_SERIES);
    if (!ks.every(k => sel.has(k))) sel.clear();
    return alternar(ks);
  }
  if ('editar' in d) return abrirEditar(d.editar);
  if (b.id === 'limpiar') { sel.clear(); selTocada = true; guardar(); return pintar(); }
  if (b.id === 'actualizar') { await api('/api/actualizar', {}); return sondear(); }
  if (b.id === 'anadir') {
    $('#a-texto').value = ''; $('#a-error').textContent = '';
    $('#a-mercs').innerHTML = chipsMercado(new Set(D.mercados_defecto));
    $('#dlg-anadir').showModal(); $('#a-texto').focus();
  }
});
const chipsMercado = activos => D.mercados.map(m => `<button type="button" class="chip ${activos.has(m.cod) ? 'on' : ''}" data-m="${m.cod}" title="${esc(m.nombre)}">${m.bandera} ${m.cod}</button>`).join('');
for (const id of ['#a-mercs', '#e-mercs']) $(id).addEventListener('click', ev => { const c = ev.target.closest('[data-m]'); if (c) c.classList.toggle('on'); });
const leerChips = id => [...$(id).querySelectorAll('.chip.on')].map(c => c.dataset.m);

$('#form-anadir').addEventListener('submit', async ev => {
  ev.preventDefault();
  const mercados = leerChips('#a-mercs');
  if (!mercados.length) { $('#a-error').textContent = 'Elige al menos un país.'; return; }
  const r = await api('/api/libros', { texto: $('#a-texto').value, marca: $('#a-marca').value, mercados });
  if (r.error) { $('#a-error').textContent = r.error; return; }
  if (!r.nuevos.length) { $('#a-error').textContent = 'Esos libros ya estaban en el panel.'; return; }
  $('#dlg-anadir').close(); await cargar(); sondear();
});

let editando = null;
function abrirEditar(asin) {
  const l = libro(asin); editando = asin;
  $('#e-asin').textContent = asin; $('#e-titulo').value = l.titulo; $('#e-marca').value = l.marca;
  $('#e-activo').checked = !!l.activo; $('#e-mercs').innerHTML = chipsMercado(new Set(l.mercados));
  $('#dlg-editar').showModal();
}
$('#form-editar').addEventListener('submit', async ev => {
  ev.preventDefault();
  await api('/api/libro', { asin: editando, titulo: $('#e-titulo').value, marca: $('#e-marca').value, mercados: leerChips('#e-mercs'), activo: $('#e-activo').checked });
  $('#dlg-editar').close(); cargar();
});
$('#e-borrar').addEventListener('click', async () => {
  if (!confirm('¿Eliminar este libro y todo su historial de BSR? No se puede deshacer.')) return;
  await api('/api/libro/borrar', { asin: editando });
  $('#dlg-editar').close(); cargar();
});
$('#buscar').addEventListener('input', ev => { F.buscar = ev.target.value; pintar(); });
$('#orden').addEventListener('change', ev => { F.orden = ev.target.value; guardar(); pintar(); });
$('#intervalo').addEventListener('change', async ev => { await api('/api/config', { intervalo_horas: +ev.target.value }); cargar(); });
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => D && D.libros.length && pintarGrafica(), 150); });

// mientras hay una lectura en marcha, refresca cada pocos segundos
let sondeo = null, hechosPrev = -1;
function sondear() {
  if (sondeo) return;
  sondeo = setInterval(async () => {
    const p = await api('/api/progreso');
    if (p.hechos !== hechosPrev || !p.activo) { hechosPrev = p.hechos; await cargar(); } else { D.progreso = p; pintarEstado(); }
    if (!p.activo) { clearInterval(sondeo); sondeo = null; }
  }, 4000);
}
setInterval(async () => { if (!sondeo && !document.querySelector('dialog[open]')) { await cargar(); if (D.progreso.activo) sondear(); } }, 60000);
cargar().then(() => { if (D.progreso.activo) sondear(); });
