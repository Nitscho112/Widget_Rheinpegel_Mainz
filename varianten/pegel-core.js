/* Gemeinsame Datenlogik für die Design-Varianten.
   Jede Variante definiert window.renderPegel(model) und optional window.CHART_OPTS. */
(function(){
const UUID = "a37a9aa3-45e9-4d90-9df6-109f3a28a5af"; // Pegel Mainz
const BASE = "https://www.pegelonline.wsv.de/webservices/rest-api/v2";

const params = new URLSearchParams(location.search);
const numParam = (k, def) => { const v = params.get(k); return v != null && v !== "" && isFinite(+v) ? +v : def; };
const RANGE_H    = Math.min(720, Math.max(6, numParam("h", 24)));
const FORECAST_H = Math.min(48, Math.max(0, numParam("prognose", 6)));
const WARN_OVR   = numParam("warn", null);
const ALARM_OVR  = numParam("alarm", null);
const TITLE_OVR  = params.get("titel");
const TREND_WINDOW_H = 2, TREND_THRESH = 0.5, STALE_MIN = 90;

const MARK_KEYS = ["MNW", "MW", "MHW", "HSW"];
const TZ = "Europe/Berlin";

const P = window.Pegel = {
  RANGE_H, FORECAST_H, TREND_THRESH,
  rangeLabel: () => RANGE_H >= 48 && RANGE_H % 24 === 0 ? `${RANGE_H / 24} Tage` : `${RANGE_H} h`,
  fmtDateTime: t => new Intl.DateTimeFormat("de-DE", { timeZone:TZ, weekday:"short", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }).format(t),
  fmtTime: t => new Intl.DateTimeFormat("de-DE", { timeZone:TZ, hour:"2-digit", minute:"2-digit" }).format(t),
  fmtDay: t => new Intl.DateTimeFormat("de-DE", { timeZone:TZ, weekday:"short", day:"2-digit", month:"2-digit" }).format(t),
  fmtSigned: (v, d = 0) => (v > 0 ? "+" : v < 0 ? "−" : "±") + Math.abs(v).toFixed(d).replace(".", ","),
  ARROWS: {
    up:   '<path d="M14 25V4M14 4l8 8M14 4l-8 8" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
    down: '<path d="M14 3v21M14 24l8-8M14 24l-8-8" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
    flat: '<path d="M3 14h21M24 14l-7-7M24 14l-7 7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
};
const tzHour = t => +new Intl.DateTimeFormat("en-GB", { timeZone:TZ, hour:"2-digit", hourCycle:"h23" }).format(t);

async function j(url){
  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) throw new Error(r.status + " " + r.statusText);
  return r.json();
}

function slopePerHour(points){
  if (points.length < 2) return 0;
  const t0 = points[0].t;
  const xs = points.map(p => (p.t - t0) / 3600e3), ys = points.map(p => p.v);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++){ const dx = xs[i] - mx; num += dx * (ys[i] - my); den += dx * dx; }
  return den === 0 ? 0 : num / den;
}

let station = null, stationAt = 0, marks = {}, title = "Rhein in Mainz";
async function loadStation(){
  if (station && Date.now() - stationAt < 3600e3) return;
  station = await j(`${BASE}/stations/${UUID}.json?includeTimeseries=true&includeCharacteristicValues=true`);
  stationAt = Date.now();
  const ts = (station.timeseries || []).find(t => t.shortname === "W");
  marks = {};
  for (const cv of ts?.characteristicValues || [])
    if (MARK_KEYS.includes(cv.shortname) && typeof cv.value === "number") marks[cv.shortname] = Math.round(cv.value);
  title = TITLE_OVR || `${station.water?.longname || "Rhein"} in ${station.longname || "Mainz"}`;
  document.title = `${title} – Pegel`;
}

function buildModel(points){
  const last = points[points.length - 1];
  const th = {
    low: marks.MNW ?? null,
    warn: WARN_OVR ?? marks.MHW ?? null,
    alarm: ALARM_OVR ?? marks.HSW ?? null,
    warnLabel: WARN_OVR != null ? "Warnschwelle" : "MHW",
    alarmLabel: ALARM_OVR != null ? "Alarmschwelle" : "HSW",
  };
  let status;
  if (th.alarm != null && last.v >= th.alarm) status = { key:"alarm", text:"Hochwasser" };
  else if (th.warn != null && last.v >= th.warn) status = { key:"warn", text:"Erhöhter Wasserstand" };
  else if (th.low != null && last.v <= th.low) status = { key:"low", text:"Niedrigwasser" };
  else status = { key:"ok", text:(th.warn ?? th.alarm) == null ? "Aktueller Wasserstand" : "Normal" };

  let recent = points.filter(p => p.t >= last.t - TREND_WINDOW_H * 3600e3);
  if (recent.length < 3) recent = points.slice(-3);
  const slope = slopePerHour(recent);
  const trend = slope > TREND_THRESH ? { key:"up", text:"steigend" }
              : slope < -TREND_THRESH ? { key:"down", text:"fallend" } : { key:"flat", text:"gleichbleibend" };
  const forecast = [];
  for (let h = 1; h <= FORECAST_H; h++) forecast.push({ t:last.t + h * 3600e3, v:last.v + slope * h });

  // nächste Schwelle oberhalb
  const next = [[th.warnLabel, th.warn], [th.alarmLabel, th.alarm]]
    .filter(([, x]) => x != null && last.v < x).sort((a, b) => a[1] - b[1])[0];
  const nextTh = next ? { label:next[0], value:next[1], dist:next[1] - last.v,
                          etaH: slope > TREND_THRESH ? (next[1] - last.v) / slope : null } : null;
  const vals = points.map(p => p.v);
  return {
    title, marks, th, status, trend, slope, points, forecast, last, nextTh,
    value: Math.round(last.v),
    delta: last.v - points[0].v,
    min: Math.round(Math.min(...vals)), max: Math.round(Math.max(...vals)),
    ageMin: (Date.now() - last.t) / 60e3, stale: (Date.now() - last.t) / 60e3 > STALE_MIN,
    forecastEnd: forecast.length ? forecast[forecast.length - 1].v : null,
  };
}

let lastModel = null;
async function load(){
  const errEl = document.getElementById("err");
  try{
    try { await loadStation(); } catch(e){ if (!station) console.warn("Stammdaten:", e); }
    const startIso = new Date(Date.now() - RANGE_H * 3600e3).toISOString();
    const ms = await j(`${BASE}/stations/${UUID}/W/measurements.json?start=${encodeURIComponent(startIso)}`);
    const points = (ms || []).filter(m => m?.value != null && m?.timestamp)
      .map(m => ({ t:Date.parse(m.timestamp), v:Number(m.value) })).sort((a, b) => a.t - b.t);
    if (points.length < 2) throw new Error("Zu wenige Messwerte.");
    lastModel = buildModel(points);
    document.body.dataset.status = lastModel.status.key;
    document.body.dataset.trend = lastModel.trend.key;
    window.renderPegel(lastModel);
    if (errEl) errEl.textContent = "";
  } catch(err){
    if (errEl) errEl.textContent = "Aktualisierung fehlgeschlagen: " + (err.message || err);
  }
}

/* ===== Chart (über Optionen je Variante gestaltbar) ===== */
const SVGNS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, text) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  return e;
};

P.drawChart = function(svg, m, o = {}){
  o = Object.assign({
    line:"#9cc1ff", fill:"#3b82f6", forecast:"#fbbf24", grid:"rgba(255,255,255,.08)", axis:"rgba(255,255,255,.22)",
    text:"#a0a6b3", bands:true, marks:true, grid_y:true, xLabels:true, yLabels:true, lineWidth:null, endLabel:false,
    markColors:{ MNW:"#38bdf8", MW:"#94a3b8", MHW:"#f59e0b", HSW:"#ef4444" },
  }, o);
  const box = svg.parentElement;
  const W = Math.max(160, box.clientWidth), H = Math.max(60, box.clientHeight);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "";
  const { points, forecast, marks, th } = m;
  const fs = Math.max(11, Math.min(17, W / 60));
  const PADL = o.yLabels ? fs * 3.6 : fs * .5, PADR = o.endLabel ? fs * 4.5 : fs * 1.2;
  const PADT = fs * 0.9, PADB = o.xLabels ? fs * 2.8 : fs * .6;

  const minX = points[0].t, nowT = m.last.t;
  const maxX = forecast.length ? forecast[forecast.length - 1].t : nowT;
  const ys = points.map(p => p.v).concat(forecast.map(p => p.v));
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  const near = Math.max(40, (maxY - minY) * 0.6);
  const vis = o.marks ? Object.keys(marks).filter(k => marks[k] >= minY - near && marks[k] <= maxY + near) : [];
  for (const k of vis){ minY = Math.min(minY, marks[k]); maxY = Math.max(maxY, marks[k]); }
  if (maxY - minY < 30){ const mid = (minY + maxY) / 2; minY = mid - 15; maxY = mid + 15; }
  const pad = (maxY - minY) * 0.1, plotH = H - PADT - PADB;
  const step = [5, 10, 20, 25, 50, 100, 200, 500].find(s => (maxY - minY + 2 * pad) / s <= Math.max(2, Math.floor(plotH / (fs * 2.6)))) || 1000;
  const y0 = Math.floor((minY - pad) / step) * step, y1 = Math.ceil((maxY + pad) / step) * step;
  const toX = t => PADL + (t - minX) / (maxX - minX) * (W - PADL - PADR);
  const toY = v => H - PADB - (v - y0) / (y1 - y0) * plotH;

  const defs = el("defs"), g = el("linearGradient", { id:"gA", x1:0, y1:0, x2:0, y2:1 });
  g.append(el("stop", { offset:"0%", "stop-color":o.fill, "stop-opacity":.5 }), el("stop", { offset:"100%", "stop-color":o.fill, "stop-opacity":0 }));
  defs.append(g); svg.append(defs);

  if (o.bands){
    const band = (a, b, c) => { if (a == null) return; a = Math.max(a, y0); b = Math.min(b ?? y1, y1); if (b > a)
      svg.append(el("rect", { x:PADL, y:toY(b), width:W - PADL - PADR, height:toY(a) - toY(b), fill:c })); };
    band(th.warn, th.alarm, "rgba(245,158,11,.10)");
    band(th.alarm, null, "rgba(239,68,68,.13)");
  }
  if (forecast.length) svg.append(el("rect", { x:toX(nowT), y:PADT, width:toX(maxX) - toX(nowT), height:plotH, fill:"rgba(255,255,255,.04)" }));

  for (let v = y0; v <= y1 + 1e-6; v += step){
    const y = toY(v);
    if (o.grid_y) svg.append(el("line", { x1:PADL, x2:W - PADR, y1:y, y2:y, stroke:o.grid }));
    if (o.yLabels) svg.append(el("text", { x:PADL - fs * .5, y:y + fs * .35, fill:o.text, "font-size":fs * .9, "text-anchor":"end" }, v));
  }
  if (o.xLabels){
    svg.append(el("line", { x1:PADL, x2:W - PADR, y1:H - PADB, y2:H - PADB, stroke:o.axis }));
    const spanH = (maxX - minX) / 3600e3, maxTicks = Math.max(2, Math.floor((W - PADL - PADR) / 70));
    const stepH = [1, 2, 3, 4, 6, 12, 24, 48, 72, 168].find(s => spanH / s <= maxTicks) || 168;
    let lastDay = null;
    for (let t = Math.ceil(minX / 3600e3) * 3600e3; t <= maxX; t += 3600e3){
      const h = tzHour(t);
      if (stepH >= 24 ? h !== 0 : h % stepH) continue;
      const x = toX(t), day = P.fmtDay(t);
      svg.append(el("line", { x1:x, x2:x, y1:H - PADB, y2:H - PADB + 5, stroke:o.axis }));
      const lab = el("text", { x, y:H - PADB + fs * 1.2, fill:o.text, "font-size":fs * .85, "text-anchor":"middle" });
      if (stepH >= 24) lab.textContent = day;
      else { lab.append(el("tspan", { x, dy:0 }, P.fmtTime(t))); if (day !== lastDay) lab.append(el("tspan", { x, dy:fs * 1.05, opacity:.7 }, day)); }
      lastDay = day; svg.append(lab);
    }
  }
  for (const k of vis){
    const y = toY(marks[k]), c = o.markColors[k] || o.text;
    svg.append(el("line", { x1:PADL, x2:W - PADR, y1:y, y2:y, stroke:c, "stroke-width":1.4, "stroke-dasharray":"5 5" }));
    svg.append(el("text", { x:PADL + 6, y:y - 4, fill:c, "font-size":fs * .8, "font-weight":700 }, `${k} ${marks[k]}`));
  }
  let d = ""; points.forEach((p, i) => d += `${i ? "L" : "M"}${toX(p.t).toFixed(1)} ${toY(p.v).toFixed(1)}`);
  svg.append(el("path", { d:`${d}L${toX(nowT)} ${H - PADB}L${toX(minX)} ${H - PADB}Z`, fill:"url(#gA)" }));
  const lw = o.lineWidth ?? Math.max(2.2, fs * .2);
  svg.append(el("path", { d, fill:"none", stroke:o.line, "stroke-width":lw, "stroke-linejoin":"round" }));
  if (forecast.length){
    let df = `M${toX(nowT)} ${toY(m.last.v)}`; for (const p of forecast) df += `L${toX(p.t)} ${toY(p.v)}`;
    svg.append(el("path", { d:df, fill:"none", stroke:o.forecast, "stroke-width":lw * .85, "stroke-dasharray":"6 5" }));
  }
  svg.append(el("circle", { cx:toX(nowT), cy:toY(m.last.v), r:fs * .65, fill:o.line, opacity:.3 }));
  svg.append(el("circle", { cx:toX(nowT), cy:toY(m.last.v), r:fs * .32, fill:"#fff", stroke:o.line, "stroke-width":2 }));
  if (o.endLabel){
    const fe = forecast.length ? forecast[forecast.length - 1] : null;
    if (fe) svg.append(el("text", { x:toX(fe.t) + 6, y:toY(fe.v) + fs * .35, fill:o.forecast, "font-size":fs, "font-weight":800 }, `≈${Math.round(fe.v)}`));
  }
};

new ResizeObserver(() => { if (lastModel && window.onPegelResize) window.onPegelResize(lastModel); }).observe(document.body);
window.addEventListener("DOMContentLoaded", () => { load(); setInterval(load, 60e3); });
})();
