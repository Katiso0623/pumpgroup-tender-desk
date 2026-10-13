if (!window.supabase) {
  document.body.innerHTML = '<p style="font-family:sans-serif;padding:24px">The Tender Desk could not load. Check your internet connection and reload the page.</p>';
  throw new Error("supabase client not loaded");
}

const CFG = window.PG_CONFIG;
const sb = supabase.createClient(CFG.url, CFG.anonKey, { auth: { persistSession: true, autoRefreshToken: true } });
const BUCKET = "bid-files";
const TZ = "Africa/Johannesburg";
const STATUS_LABEL = {
  open: "Not started", interested: "Interested", no_bid: "Not bidding", purchase: "Must buy documents",
  purchased: "Documents bought", docs_uploaded: "Documents uploaded", preparing: "Bid pack being prepared",
  pack_ready: "Bid pack ready", submitted: "Submitted", won: "Won", lost: "Not awarded"
};
const FILE_KIND = {
  tender_doc: "Tender document", purchased_scan: "Purchased document (scan)", addendum: "Addendum", briefing_cert: "Briefing attendance certificate",
  out_filled: "Filling guide (red)", out_blank: "Blank copy for manual filling", out_priced_boq: "Priced BoQ", out_index: "Index of returnables",
  out_cover: "Cover page / envelope labels", out_returnables: "Returnables pack for printing", out_checklist: "Submission checklist", other: "Other"
};
const CORE_CATS = ["cipc","director_ids","csd","tax","bbbee","cidb","coida","municipal_account","bank_letter","appointment_letter","completion_certificate","reference_letter","cv","health_safety","letterhead"];
const PERSON_CATS = ["cv", "qualification", "personnel_appointment"];
const REQ_STATUS = {
  ok: ["ok", "On file"], missing: ["bad", "Missing"], expired: ["warn", "Out of date"], to_generate: ["info", "Prepared automatically"],
  in_document: ["", "In the tender document"], manual: ["warn", "Attach by hand"], na: ["", "Not needed"]
};
const ACTIVE = ["interested", "purchase", "purchased", "docs_uploaded", "preparing", "pack_ready"];

let me = null;
const st = {
  status: "matched", q: "", province: "", klass: "", maxGrade: "", sort: "closing",
  flags: new Set(), offset: 0, rows: [], total: 0, dash: null, cats: [], lib: [], current: null, rates: [], settings: {},
  people: [], cost: null, reqs: null, work: new Set(), workCounts: {}
};
const WORK = [["water", "Water supply"], ["sanitation", "Sewer and sanitation"], ["pumps", "Pumps and pump stations"], ["pipelines", "Pipelines"],
  ["roads", "Roads and paving"], ["stormwater", "Stormwater and drainage"], ["structures", "Bridges and structures"], ["geotech", "Geotechnical and earthworks"],
  ["dams", "Dams and rivers"], ["services", "Township services"], ["buildings", "Buildings and facilities"], ["mechanical", "Mechanical plant and HVAC"],
  ["power", "Power and electrical"], ["transport", "Rail, ports and airports"], ["other", "Other"]];
const WORK_LABEL = Object.fromEntries(WORK);
try { (JSON.parse(localStorage.getItem("pg-work") || "[]") || []).forEach(w => { if (WORK_LABEL[w]) st.work.add(w); }); } catch (_) {}

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d, withTime) => d ? new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, day: "numeric", month: "short", year: withTime ? undefined : "numeric", hour: withTime ? "2-digit" : undefined, minute: withTime ? "2-digit" : undefined, hour12: false }).format(new Date(d)) : "–";
const fmtDay = (d) => d ? new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(new Date(d)) : "–";
const fmtTime = (d) => d ? new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d)) : "";
const daysLeft = (d) => d ? Math.ceil((new Date(d) - Date.now()) / 86400000) : null;
const rand = (n) => n == null || n === "" ? "–" : "R " + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let toastTimer;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 3200); }
function notice(kind, html) { const n = $("#notice"); if (!html) { n.hidden = true; return; } n.className = "notice " + kind; n.innerHTML = html; n.hidden = false; }

function b64utf8(str) { const bytes = new TextEncoder().encode(str); let bin = ""; bytes.forEach(b => bin += String.fromCharCode(b)); return btoa(bin); }

function errorCopy(e) {
  const m = (e && (e.message || e.error_description || e.error)) || "";
  if (/JWT|not authenticated|sign in again|refresh token/i.test(m)) return "Your sign-in has expired. Sign in again.";
  if (/team list/i.test(m)) return esc(m);
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "No connection to the Tender Desk. Check your internet connection and press Refresh.";
  return m ? esc(m.slice(0, 300)) : "Something went wrong. Press Refresh.";
}

async function api(action, payload = {}) {
  const { data, error } = await sb.rpc("web_api", { p: { action, ...payload } });
  if (error) throw error;
  return data;
}

async function fn(op, payload = {}) {
  const { data, error } = await sb.functions.invoke("site-api", { body: { op, ...payload } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw { message: msg };
  }
  if (data && data.error) throw { message: data.error };
  return data;
}

/* ---------- files in private storage ---------- */
const extOf = (name) => ((String(name || "").match(/\.[A-Za-z0-9]+$/) || [""])[0]).toLowerCase();
const safeFile = (s) => String(s || "file").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 100);
async function signedUrl(path, download) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 600, download ? { download } : undefined);
  if (error) throw error;
  return data.signedUrl;
}
function fileButtons(path, name) {
  if (!path) return "";
  return `<span class="filebtns"><button class="btn ghost small" type="button" data-open="${esc(path)}">Open</button><button class="btn ghost small" type="button" data-dl="${esc(path)}" data-name="${esc(name || path.split("/").pop())}">Download</button></span>`;
}
function fileLink(d) {
  return d.storage_path ? `<button class="linkbtn" type="button" data-open="${esc(d.storage_path)}">${esc(d.title)}</button>` : esc(d.title);
}
function wireOpen(root) {
  $$("[data-open]", root).forEach(b => b.onclick = async () => {
    const w = window.open("", "_blank");
    try { const u = await signedUrl(b.dataset.open); if (w) w.location = u; else location.href = u; }
    catch (e) { if (w) w.close(); toast("Could not open the file: " + errorCopy(e).replace(/<[^>]+>/g, "")); }
  });
  $$("[data-dl]", root).forEach(b => b.onclick = async () => {
    try { const u = await signedUrl(b.dataset.dl, b.dataset.name || true); const a = document.createElement("a"); a.href = u; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
    catch (e) { toast("Could not download the file: " + errorCopy(e).replace(/<[^>]+>/g, "")); }
  });
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-open],[data-dl]");
  if (b && !b.onclick) { wireOpen(b.parentElement || document); b.click(); }
});

/* ---------- tabs ---------- */
$$(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
  $$("[data-panel]").forEach(p => p.hidden = p.dataset.panel !== name);
  try { localStorage.setItem("pg-tab", name); } catch (_) {}
  if (name === "library" && !st.libLoaded) safe(loadLibrary);
  if (name === "people") safe(loadPeople);
  if (name === "profile" && !st.profLoaded) safe(loadProfile);
  if (name === "rates") { safe(loadCosts); if (!st.ratesLoaded) safe(loadRates); }
  if (name === "scanner") loadScanner();
  if (name === "team") safe(loadTeam);
  if (name === "uploads") safe(loadUploads);
  if (name === "activity") safe(() => loadActivity());
  activityTimer(name === "activity");
}

/* ---------- dashboard + list ---------- */
async function loadDashboard() {
  const d = await api("dashboard");
  st.dash = d;
  const s = $$("#summary .stat b");
  [d.matched_open, d.closing_7d, d.briefings_7d, d.purchase_open, d.in_progress, d.to_screen_open, d.missing_bids].forEach((v, i) => { if (s[i]) s[i].textContent = v ?? 0; });
  $("#cBids").textContent = d.matched_open ?? "";
  $("#cLib").textContent = d.library_count || "";
  $("#cPeople").textContent = d.personnel_count || "";
  $("#cProf").textContent = d.profile_total ? `${d.profile_filled}/${d.profile_total}` : "";
  $("#cRates").textContent = (d.rates_count || 0) + (d.resources_count || 0) || "";
  if (d.missing_bids) loadMissing().catch(() => {}); else { $("#missingPanel").hidden = true; setUploadsCount(0); }
  const sel = $("#province");
  if (sel.options.length <= 1) (d.provinces || []).forEach(p => sel.add(new Option(p, p)));
  const ls = d.last_scan;
  if (ls) {
    const ago = Math.round((Date.now() - new Date(ls.started_at)) / 60000);
    $("#scanDot").classList.toggle("bad", !!ls.error || ago > 130);
    $("#scanText").textContent = ls.error ? `Last scan failed ${fmtTime(ls.started_at)}: ${ls.error.slice(0, 80)}`
      : `Scanned ${fmtTime(ls.started_at)} · ${Number(ls.fetched || 0).toLocaleString("en-ZA")} open adverts read · next scan :07`;
  }
  const warn = [];
  if (d.profile_filled < d.profile_total / 2) warn.push(`Company details are ${d.profile_filled} of ${d.profile_total} filled. <button class="linkbtn" data-go="profile">Fill them in</button> so bid forms can be completed.`);
  if (d.library_count === 0) warn.push(`The document library is empty. <button class="linkbtn" data-go="library">Upload your returnables</button> (CSD, tax PIN, CIDB, B-BBEE, appointment and reference letters).`);
  else if (d.library_expiring) warn.push(`${d.library_expiring} library document(s) expire within 30 days. <button class="linkbtn" data-go="library">Review them</button>.`);
  if (warn.length) notice("warn", warn.join("<br>")); else notice(null);
}

async function loadMissing() {
  const rows = await api("missing_overview");
  const P = $("#missingPanel");
  setUploadsCount((rows || []).reduce((s, r) => s + (Number(r.missing) || 0), 0));
  if (!rows || !rows.length) { P.hidden = true; return; }
  P.className = "missingpanel";
  P.innerHTML = `<h3>Documents to upload</h3>
    <p class="muted" style="margin:0 0 8px;color:var(--ink-2)">These bids need documents the library does not have, or has only in an out-of-date copy. The Uploads needed tab lists each one with what it must show and an upload button.</p>
    <ul>${rows.map(r => `<li><b class="mono">${esc(r.tender_no || "")}</b><span>${esc((r.description || "").replace(/\s+/g, " ").slice(0, 80))}</span>
      <span class="muted">closes ${esc(fmtDate(r.closes_at, true))}</span>
      <span class="chips">${(r.items || []).slice(0, 6).map(i => `<span class="chip ${i.status === "expired" ? "warn" : "bad"}">${esc(i.title)}</span>`).join("")}${(r.items || []).length > 6 ? `<span class="chip">+${r.items.length - 6} more</span>` : ""}</span>
      <span class="filebtns"><button class="btn small" type="button" data-upbid="${esc(r.id)}">Show what to upload</button><button class="btn ghost small" type="button" data-openbid="${esc(r.id)}">Open bid</button></span></li>`).join("")}</ul>`;
  P.hidden = false;
  $$("[data-openbid]", P).forEach(b => b.onclick = () => openTender(b.dataset.openbid));
  $$("[data-upbid]", P).forEach(b => b.onclick = () => showUploads(b.dataset.upbid));
}

function filtersPayload() {
  const f = {};
  if (st.status === "active") { f.status = "all"; f.bid_status = "active"; }
  else f.status = st.status;
  if (st.q) f.q = st.q;
  if (st.province) f.province = st.province;
  if (st.klass) f.class = st.klass;
  if (st.maxGrade) f.max_grade = Number(st.maxGrade);
  if (st.work.size) f.work = [...st.work];
  if (st.flags.has("panel")) f.panel = true;
  if (st.flags.has("rfq")) f.rfq = true;
  if (st.flags.has("purchase")) f.purchase = true;
  if (st.flags.has("briefing")) f.briefing = true;
  if (st.flags.has("changed")) f.changed = true;
  if (st.flags.has("closing7")) f.closing_days = 7;
  f.sort = st.sort === "new" ? "new" : "closing";
  return f;
}

let listSeq = 0;
async function loadTenders(append = false) {
  const seq = ++listSeq;
  if (!append) { st.offset = 0; $("#list").innerHTML = '<div class="loading">Loading bids…</div>'; }
  const res = await api("tenders", { filters: filtersPayload(), limit: 50, offset: st.offset });
  if (seq !== listSeq) return;
  st.total = res.total;
  st.rows = append ? st.rows.concat(res.rows) : res.rows;
  renderList();
}

function gradeChips(t) {
  if (t.cidb_requirement) return t.cidb_requirement.split(", ").map(g => `<span class="chip grade">${esc(g)}</span>`).join("");
  return `<span class="chip nograde">Grade not stated</span>`;
}
function workChips(t) {
  return (t.work_types || []).filter(w => w !== "other").slice(0, 3).map(w => `<span class="chip work">${esc(WORK_LABEL[w] || w)}</span>`).join("");
}
function rowChips(t) {
  const c = [gradeChips(t), workChips(t)];
  if (t.is_panel) c.push('<span class="chip info">Panel / rate-based</span>');
  if (t.is_rfq) c.push('<span class="chip info">Quotation</span>');
  if (t.briefing_compulsory && t.briefing_at) {
    const past = new Date(t.briefing_at) < Date.now();
    c.push(`<span class="chip ${past ? "" : "warn"}">Compulsory briefing ${esc(fmtDay(t.briefing_at))}${past ? " (passed)" : ""}</span>`);
  }
  if (t.purchase_required) c.push(`<span class="chip warn">Buy documents${t.purchase_fee ? " " + esc(t.purchase_fee) : ""}</span>`);
  if (t.docs_on_etenders === false) c.push('<span class="chip bad">No documents online</span>');
  if (t.changed_at && (Date.now() - new Date(t.changed_at)) < 7 * 864e5) c.push(`<span class="chip bad">${esc(t.change_note || "Changed")}</span>`);
  if (t.first_seen && (Date.now() - new Date(t.first_seen)) < 864e5 && st.dash && st.dash.last_scan && st.dash.last_scan.id > 1) c.push('<span class="chip ok">New</span>');
  return c.join("");
}
function stamp(t) {
  const n = daysLeft(t.closes_at);
  const cls = n == null ? "" : n < 0 ? "closed" : n <= 7 ? "soon" : "";
  const big = n == null ? "–" : n < 0 ? "Closed" : n === 0 ? "Today" : n;
  return `<div class="stamp ${cls}"><b>${big}</b><small>${n > 0 ? (n === 1 ? "day left" : "days left") : n === 0 ? fmtTime(t.closes_at) : ""}</small><em>${esc(fmtDay(t.closes_at))}</em></div>`;
}
function renderList() {
  const L = $("#list");
  $("#resultline").textContent = st.total ? `${st.total.toLocaleString("en-ZA")} ${st.status === "excluded" ? "excluded adverts" : st.status === "to_screen" ? "adverts waiting for a document check" : st.status === "active" ? "bids in progress" : "matching open bids"}${st.work.size ? " · " + [...st.work].map(w => WORK_LABEL[w]).join(", ") : ""}` : "";
  if (!st.rows.length) {
    L.innerHTML = `<div class="empty">${st.status === "active" && !st.work.size ? "No bids in progress yet. Open a matching bid and press Prepare this bid to start one." : "Nothing matches these filters. Clear a filter or a type of work, or search for something else."}</div>`;
    $("#moreBtn").hidden = true; return;
  }
  L.innerHTML = st.rows.map(t => `
    <button class="row" type="button" data-id="${esc(t.id)}">
      ${stamp(t)}
      <div class="body">
        <div class="tno">${esc(t.tender_no || "")}</div>
        <div class="desc">${esc((t.description || "").replace(/\s+/g, " ").trim())}</div>
        <div class="org">${esc(t.organ_of_state || "")}${t.province ? " · " + esc(t.province) : ""}${t.category ? " · " + esc(t.category) : ""}</div>
        <div class="chips">${rowChips(t)}</div>
        ${st.status !== "matched" && t.match_reason ? `<div class="muted">${esc(t.match_reason)}</div>` : ""}
      </div>
      <div class="side"><span class="status s-${esc(t.bid_status)}">${esc(STATUS_LABEL[t.bid_status] || t.bid_status)}</span></div>
    </button>`).join("");
  $("#moreBtn").hidden = st.rows.length >= st.total;
}
$("#list").addEventListener("click", e => { const r = e.target.closest(".row"); if (r) openTender(r.dataset.id); });
$("#moreBtn").addEventListener("click", async () => { st.offset = st.rows.length; await safe(() => loadTenders(true)); });

$$("#segStatus button").forEach(b => b.addEventListener("click", () => {
  st.status = b.dataset.status;
  $$("#segStatus button").forEach(x => x.setAttribute("aria-pressed", x === b));
  safe(() => loadTenders());
  loadWorkCounts();
}));
$$("[data-flag]").forEach(b => b.addEventListener("click", () => {
  const f = b.dataset.flag; st.flags.has(f) ? st.flags.delete(f) : st.flags.add(f);
  b.setAttribute("aria-pressed", st.flags.has(f)); safe(() => loadTenders());
}));
let qTimer;
$("#q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value.trim(); safe(() => loadTenders()); }, 400); });
$("#province").addEventListener("change", e => { st.province = e.target.value; safe(() => loadTenders()); });
$("#klass").addEventListener("change", e => { st.klass = e.target.value; safe(() => loadTenders()); });
$("#maxGrade").addEventListener("change", e => { st.maxGrade = e.target.value; safe(() => loadTenders()); try { localStorage.setItem("pg-maxgrade", st.maxGrade); } catch (_) {} });
$("#sort").addEventListener("change", e => { st.sort = e.target.value; safe(() => loadTenders()); });
for (let g = 1; g <= 8; g++) $("#maxGrade").add(new Option(`We hold grade ${g} or lower jobs`, g));

$$("#summary .stat").forEach(b => b.addEventListener("click", () => {
  const k = b.dataset.quick;
  if (k === "missing") { showUploads(); return; }
  st.flags.clear(); $$("[data-flag]").forEach(t => t.setAttribute("aria-pressed", "false"));
  st.status = k === "to_screen" ? "to_screen" : k === "active" ? "active" : "matched";
  if (k === "closing") st.flags.add("closing7");
  if (k === "briefing") st.flags.add("briefing");
  if (k === "purchase") st.flags.add("purchase");
  $$("[data-flag]").forEach(t => t.setAttribute("aria-pressed", st.flags.has(t.dataset.flag)));
  $$("#segStatus button").forEach(x => x.setAttribute("aria-pressed", x.dataset.status === st.status));
  safe(() => loadTenders());
}));

/* ---------- type of work ---------- */
function renderWorkChips() {
  const box = $("#workTypes"); if (!box) return;
  const counts = st.workCounts || {};
  box.innerHTML = `<span class="wlabel">Type of work</span>${WORK.map(([k, label]) => `<button class="toggle" type="button" data-work="${k}" aria-pressed="${st.work.has(k)}">${esc(label)}${counts[k] != null ? `<span class="n">${counts[k]}</span>` : ""}</button>`).join("")}
    <button class="linkbtn" type="button" id="workClear" ${st.work.size ? "" : "hidden"}>Show all types</button>`;
  $$("[data-work]", box).forEach(b => b.onclick = () => {
    const k = b.dataset.work; st.work.has(k) ? st.work.delete(k) : st.work.add(k);
    saveWork(); renderWorkChips(); safe(() => loadTenders());
  });
  $("#workClear").onclick = () => { st.work.clear(); saveWork(); renderWorkChips(); safe(() => loadTenders()); };
}
function saveWork() { try { localStorage.setItem("pg-work", JSON.stringify([...st.work])); } catch (_) {} }
async function loadWorkCounts() {
  try { st.workCounts = st.status === "active" ? {} : (await api("work_counts", { status: st.status })) || {}; } catch (_) { st.workCounts = {}; }
  renderWorkChips();
}

/* ---------- automatic bid preparation ---------- */
const TENDER_KINDS = ["tender_doc", "purchased_scan", "addendum"];
const PREP_TIMES = "every hour on weekdays from 07:00 to 18:00";
const GEN_KIND = { cv: "CV", appointment: "Letter", authority_letter: "Letter", experience: "Schedule", personnel_schedule: "Schedule",
  methodology: "Method", programme: "Programme", functionality_schedule: "Schedule" };

// The preparation check runs at :54 past each hour, 06:54 to 17:54, Monday to Friday, South African time (UTC+2 all year).
function nextCheck(from = new Date()) {
  const off = 2 * 3600e3;
  const s = new Date(from.getTime() + off);
  for (let i = 0; i < 24 * 8; i++) {
    const c = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), s.getUTCHours() + i, 54));
    const wd = c.getUTCDay(), h = c.getUTCHours();
    if (c > s && wd >= 1 && wd <= 5 && h >= 6 && h <= 17) return new Date(c.getTime() - off);
  }
  return null;
}
function whenText(d) {
  if (!d) return "";
  return (fmtDay(d) === fmtDay(new Date()) ? "today" : fmtDay(d)) + " at about " + fmtTime(d);
}
const isOutput = f => String(f.kind).startsWith("out_") || /^Bid pack build /.test(f.note || "");

/* ---------- tender sheet ---------- */
let pollTimer = null;
function closeSheet() { clearTimeout(pollTimer); $("#sheet").hidden = true; $("#scrim").hidden = true; st.current = null; }
$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

async function loadBid(id) {
  const [t, w] = await Promise.all([api("tender", { id }), api("bid_work", { id }).catch(() => ({}))]);
  t.work = w || {};
  const tracked = ACTIVE.includes(t.bid_status) || ["submitted", "won", "lost"].includes(t.bid_status) || t.work.prepare || t.work.pack;
  await ensureCats();
  t.reqs = tracked ? (await api("requirements", { id })) || [] : null;
  return t;
}
function bidSignature(t) {
  const w = t.work || {};
  return JSON.stringify([w.prepare && [w.prepare.status, w.prepare.progress], w.build && [w.build.id, w.build.status], w.pack && w.pack.id,
    (t.files || []).map(f => [f.id, f.text_status])]);
}
async function openTender(id, keep) {
  const sh = $("#sheet");
  const scroll = keep ? sh.scrollTop : 0;
  if (!keep) { clearTimeout(pollTimer); sh.innerHTML = '<div class="loading">Loading tender…</div>'; sh.hidden = false; $("#scrim").hidden = false; }
  try {
    const t = await loadBid(id);
    if (keep && (sh.hidden || !st.current || st.current.id !== id)) return;
    st.current = t; st.reqs = t.reqs;
    renderSheet();
    sh.scrollTop = scroll;
    schedulePoll(t);
  } catch (e) {
    if (keep) { toast(errorCopy(e).replace(/<[^>]+>/g, "")); return; }
    sh.innerHTML = `<div class="notice bad">${errorCopy(e)}</div><button class="btn ghost" type="button" id="closeSheet">Close</button>`; $("#closeSheet").onclick = closeSheet;
  }
}
// while preparation or the builder is busy, look again every 45 seconds and redraw when something changed
function schedulePoll(t) {
  clearTimeout(pollTimer);
  const w = t.work || {};
  const busy = (w.prepare && ["queued", "waiting", "running"].includes(w.prepare.status)) || (w.build && ["queued", "running"].includes(w.build.status))
    || (t.files || []).some(f => f.text_status === "queued");
  if (!busy) return;
  pollTimer = setTimeout(async () => {
    if ($("#sheet").hidden || st.current !== t) return;
    try {
      const fresh = await loadBid(t.id);
      if ($("#sheet").hidden || st.current !== t) return;
      if (bidSignature(fresh) !== bidSignature(t)) {
        const scroll = $("#sheet").scrollTop;
        st.current = fresh; st.reqs = fresh.reqs; renderSheet(); $("#sheet").scrollTop = scroll;
        refreshRow(fresh); loadDashboard().catch(() => {});
        if (fresh.work.pack && (!t.work.pack || fresh.work.pack.id !== t.work.pack.id)) toast("The bid pack is ready");
        schedulePoll(fresh); return;
      }
    } catch (_) {}
    schedulePoll(t);
  }, 45000);
}

/* ---------- requirements (per bid) ---------- */
function catLabel(k) { const c = st.cats.find(x => x.key === k); return c ? c.label : k; }
async function ensureCats() {
  if (st.cats.length) return;
  const settings = await api("settings"); st.settings = settings || {}; st.cats = (settings && settings.library_categories) || [];
}
function renderReqs(t) {
  const box = $("#reqBox"); if (!box) return;
  const rows = t.reqs || [];
  box.innerHTML = `${rows.length ? rows.map(r => {
      const [cls, label] = REQ_STATUS[r.status] || ["", r.status];
      const canUpload = (r.categories || []).length && ["missing", "expired", "manual", "ok"].includes(r.status);
      const meta = [r.ref ? "Ref " + r.ref : "", (r.categories || []).map(catLabel).join(", "), r.role ? (r.role + (r.person ? ": " + r.person : "")) : "",
        r.max_points ? `${r.est_points != null ? r.est_points + " of " : ""}${r.max_points} points` : ""].filter(Boolean).join(" · ");
      return `<div class="req" data-req="${esc(r.id)}"><div><div class="t">${esc(r.title)}</div>
          ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
          ${(r.docs || []).length ? `<div class="meta">${r.docs.map(fileLink).join(" · ")}</div>` : ""}
          ${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}</div>
        <div class="acts"><span class="chip ${cls}">${esc(label)}</span>
          ${canUpload ? `<button class="btn ${r.status === "ok" ? "ghost " : ""}small" type="button" data-requp="${esc(r.id)}">${r.status === "ok" ? "Replace" : "Upload"}</button>` : ""}
          ${r.status === "manual" ? `<button class="btn ghost small" type="button" data-reqset="ok" data-id="${esc(r.id)}">Mark done</button>` : ""}
          ${["missing", "expired", "manual", "to_generate"].includes(r.status) ? `<button class="linkbtn" type="button" data-reqset="na" data-id="${esc(r.id)}">Not needed</button>` : ""}
        </div></div>`;
    }).join("") : '<p class="muted" style="margin:0">No requirements yet.</p>'}
    <div class="actions"><button class="btn ghost small" type="button" id="reqRecheck">Recheck against the library</button><span class="muted">Uploads go into the document library, so the next bid has them too.</span></div>`;
  $("#reqRecheck").onclick = () => safe(async () => { await api("refresh_requirements", { id: t.id }); await openTender(t.id, true); loadDashboard(); toast("Rechecked against the library"); });
  $$("[data-reqset]", box).forEach(b => b.onclick = () => safe(async () => { await api("set_requirement_status", { id: b.dataset.id, status: b.dataset.reqset }); await openTender(t.id, true); loadDashboard(); }));
  $$("[data-requp]", box).forEach(b => b.onclick = () => openReqUpload(t, rows.find(r => r.id === b.dataset.requp), b));
  wireOpen(box);
}
function maxAge(cats) {
  const d = (cats || []).map(k => Number((st.cats.find(c => c.key === k) || {}).max_age_days || 0)).filter(Boolean);
  return d.length ? Math.min(...d) : 0;
}
function uploadFormHtml(r) {
  const cats = r.categories || [];
  const age = maxAge(cats);
  return `${cats.length > 1 ? `<label class="field"><span>Type</span><select name="cat">${cats.map(c => `<option value="${esc(c)}">${esc(catLabel(c))}</option>`).join("")}</select></label>` : `<input type="hidden" name="cat" value="${esc(cats[0] || "other")}">`}
    <label class="field"><span>Title</span><input type="text" name="title" value="${esc(r.title)}" required></label>
    <label class="field"><span>PDF or image</span><input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required></label>
    <label class="field"><span>${age ? "Issued or certified on (needed)" : "Issued or certified on"}</span><input type="date" name="issued" ${age ? "required" : ""}></label>
    <label class="field"><span>Expires on</span><input type="date" name="expires"></label>
    <div class="field"><span>&nbsp;</span><button class="btn small" type="submit">Save to the library</button></div>`;
}
async function saveReqUpload(f, r, tenderId) {
  const file = f.elements.file.files[0]; if (!file) return false;
  const btnS = $("button[type=submit]", f); btnS.disabled = true; btnS.textContent = "Uploading…";
  try {
    const up = await uploadFile(file, r.person_id ? "people" : "library", true);
    await api("save_library_doc", { category: f.elements.cat.value, title: f.elements["title"].value.trim(), storage_path: up.path, file_name: file.name,
      content_type: file.type || "application/pdf", size_bytes: up.size, issued_on: f.elements.issued.value, expires_on: f.elements.expires.value, person_id: r.person_id || "" });
    await api("refresh_requirements", { id: tenderId });
    st.libLoaded = false;
    return true;
  } catch (err) { toast(uploadError(err)); btnS.disabled = false; btnS.textContent = "Save to the library"; return false; }
}
function openReqUpload(t, r, btn) {
  const row = btn.closest(".req");
  if ($("form", row)) { $("form", row).remove(); return; }
  const f = document.createElement("form");
  f.innerHTML = uploadFormHtml(r);
  row.appendChild(f);
  f.onsubmit = async e => {
    e.preventDefault();
    if (await saveReqUpload(f, r, t.id)) { toast("Saved to the library"); await openTender(t.id, true); loadDashboard(); }
  };
}

/* ---------- the bid sheet: four steps ---------- */
const OUT_GROUPS = [
  { title: "Returnables pack for printing", why: "Cover page, index, dividers and every returnable in the tender's order, page-numbered, with the CVs, letters and schedules prepared for this bid. Print it as it is.", match: f => f.kind === "out_returnables" },
  { title: "Filling guide (red) and the blank original", why: "Print the blank original and complete it in pen, copying every red entry from the guide. It goes behind its divider in the returnables pack, where its pages are already counted.", match: f => f.kind === "out_filled" || f.kind === "out_blank" },
  { title: "Priced BoQ and cost model", why: "Every BoQ rate (column H) and the tender total, with the build-ups and escalation behind them. Copy the rates into the original in pen.", match: f => f.kind === "out_priced_boq" },
  { title: "Cover page", why: "Already inside the returnables pack. The Word file is there if you want to change it.", match: f => f.kind === "out_cover" && !/envelope/i.test((f.title || "") + (f.file_name || "")) },
  { title: "Index", why: "Already inside the returnables pack. Edit the Word file if you add or remove pages.", match: f => f.kind === "out_index" },
  { title: "Envelope labels", why: "Print and stick on the sealed envelope(s).", match: f => f.kind === "out_cover" && /envelope/i.test((f.title || "") + (f.file_name || "")) },
  { title: "Submission checklist", why: "Everything to sign, certify and check before you seal. The same list is on the Uploads needed tab.", match: f => f.kind === "out_checklist" },
  { title: "Everything in one zip", why: "All of the above, plus Word files of every letter and CV.", match: f => f.kind === "other" },
];
function fileChoice(f) {
  const ext = (extOf(f.file_name || f.storage_path) || ".file").slice(1);
  const label = { pdf: "PDF", docx: "Word", xlsx: "Excel", zip: "Zip" }[ext] || ext.toUpperCase();
  const name = f.kind === "out_filled" || f.kind === "out_blank" ? (f.title || "").replace(/: .*$/, "") + (f.title && f.title.includes(": ") ? " · " + f.title.split(": ").slice(1).join(": ").replace(/^\d+ /, "") : "") : "";
  return `<div class="fchoice"><span class="ext">${esc(label)}</span>${name ? `<span class="fname">${esc(name)}</span>` : ""}<span class="filebtns">
    ${ext === "pdf" ? `<button class="btn ghost small" type="button" data-open="${esc(f.storage_path)}">Open</button>` : ""}
    <button class="btn ghost small" type="button" data-dl="${esc(f.storage_path)}" data-name="${esc(f.file_name || "")}">Download</button></span></div>`;
}
function packList(files) {
  let i = 0;
  return `<ol class="outlist">${OUT_GROUPS.map(g => {
    const rank = f => (f.kind === "out_blank" ? 1 : 0) * 10 + (extOf(f.file_name) === ".pdf" ? 0 : 1);
    const fs = files.filter(g.match).sort((a, b) => rank(a) - rank(b) || String(a.file_name).localeCompare(String(b.file_name)));
    if (!fs.length) return "";
    i += 1;
    return `<li><span class="no">${i}</span><div><div class="what">${esc(g.title)}</div><div class="why">${esc(g.why)}</div></div><div class="choices">${fs.map(fileChoice).join("")}</div></li>`;
  }).join("")}</ol>`;
}
function preparedList(pack) {
  const gen = ((pack && pack.summary) || {}).generated || [];
  if (!gen.length) return "";
  const withFiles = gen.filter(g => g.pdf || g.docx);
  const base = s => safeFile(s).replace(/\.+$/, "");
  return `<h4 class="sub">Documents prepared for this bid</h4>
    <p class="muted" style="margin:0 0 6px">Each one is already in the returnables pack on the letterhead. Open one to read it; download the Word file to edit it.</p>
    <ul class="doclist">${gen.map(g => `<li><span class="nm"><span class="ext">${esc(GEN_KIND[g.kind] || "Doc")}</span>${esc(g.title)}</span>
      <span class="filebtns">${g.pdf ? `<button class="btn ghost small" type="button" data-open="${esc(g.pdf)}">Open</button>` : ""}${g.docx ? `<button class="btn ghost small" type="button" data-dl="${esc(g.docx)}" data-name="${esc(base(g.title))}.docx">Word</button>` : ""}
      ${!withFiles.length ? '<span class="muted">In the returnables pack and the zip</span>' : ""}</span></li>`).join("")}</ul>`;
}
function teamAndScore(pack, prep) {
  const S = (pack && pack.summary) || {};
  const reasons = {};
  ((prep && prep.details && prep.details.team) || []).forEach(m => { if (m && m.role) reasons[m.role.toLowerCase()] = m; });
  const team = (S.team && S.team.length ? S.team : (prep && prep.details && prep.details.team) || []);
  const func = S.functionality || [];
  const fMax = func.reduce((s, f) => s + (Number(f.max_points) || 0), 0), fEst = func.reduce((s, f) => s + (Number(f.est_points) || 0), 0);
  let html = "";
  if (team.length) html += `<h4 class="sub">Key personnel proposed</h4><div class="tablewrap"><table><thead><tr><th>Position</th><th>Person</th><th>Why</th></tr></thead><tbody>${team.map(m => {
    const r = reasons[(m.role || "").toLowerCase()] || {};
    return `<tr><td>${esc(m.role || "")}</td><td>${m.person ? esc(m.person) : '<span class="chip bad">Nobody on record meets this</span>'}</td><td class="muted">${esc(r.reason || "")}</td></tr>`;
  }).join("")}</tbody></table></div>`;
  if (fMax) html += `<h4 class="sub">Functionality (estimate)</h4><p style="margin:0 0 6px"><b class="big">${fEst.toLocaleString("en-ZA")} of ${fMax.toLocaleString("en-ZA")}</b> points</p>
    <ul class="plainlist">${func.map(f => `<li><b>${esc(f.criterion || "")}</b>: ${f.est_points != null ? esc(f.est_points) + " of " : ""}${esc(f.max_points ?? "–")}${f.person ? ` · ${esc(f.person)}` : ""}${(f.gaps || []).length ? `<br><span class="muted">${esc(f.gaps.slice(0, 2).join(" · "))}</span>` : ""}</li>`).join("")}</ul>`;
  return html;
}

function renderSheet() {
  const t = st.current; if (!t) return;
  const w = t.work || {}, prep = w.prepare, build = w.build, pack = w.pack;
  const n = daysLeft(t.closes_at);
  const files = t.files || [];
  const docsHere = files.filter(f => TENDER_KINDS.includes(f.kind) && f.storage_path);
  const inFiles = files.filter(f => !isOutput(f));
  const outFiles = files.filter(isOutput);
  const packTag = pack ? "Bid pack build " + String(pack.id).slice(0, 8) : null;
  const current = packTag ? outFiles.filter(f => f.note === packTag) : [];
  const older = outFiles.filter(f => !packTag || f.note !== packTag);
  const docs = t.documents || [];
  const reqs = t.reqs;
  const need = reqs ? reqs.filter(r => r.status === "missing" || r.status === "expired") : [];
  const prepActive = !!(prep && ["queued", "waiting", "running"].includes(prep.status));
  const buildActive = !!(build && ["queued", "running"].includes(build.status));
  const reading = docsHere.some(f => f.text_status === "queued");
  const ready = !!pack && !prepActive && !buildActive;
  const state = [docsHere.length ? "done" : "now", ready ? "done" : docsHere.length ? "now" : "todo",
    !reqs ? "todo" : ready && !need.length ? "done" : (pack || prepActive || buildActive) ? "now" : "todo", ready ? "now" : "todo"];
  const statusOpts = Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === t.bid_status ? "selected" : ""}>${esc(v)}</option>`).join("");
  const TEXT = { ok: ["ok", "Text read"], ocr: ["ok", "Text read from scan"], queued: ["info", "Reading text…"], empty: ["warn", "No text found"], failed: ["bad", "Could not read"], not_read: ["", ""] };
  const fileRow = f => { const tx = TEXT[f.text_status] || ["", ""]; return `<li><span class="nm"><span class="ext">${esc((f.file_name || "").split(".").pop() || "file")}</span>${esc(f.title)} <span class="muted">· ${esc(FILE_KIND[f.kind] || f.kind)}${f.size_bytes ? " · " + (f.size_bytes > 1048576 ? (f.size_bytes / 1048576).toFixed(1) + " MB" : Math.round(f.size_bytes / 1024) + " KB") : ""}</span>${tx[1] ? ` <span class="chip ${tx[0]}">${esc(tx[1])}</span>` : ""}</span>
      <span class="actions" style="margin:0">${f.storage_path ? fileButtons(f.storage_path, f.file_name || f.title) : '<span class="muted">Not on the website</span>'}
      <button class="linkbtn" type="button" data-rmfile="${esc(f.id)}">Remove</button></span></li>`; };
  const uploadForm = `<form id="bidUpload" class="grid3" style="margin-top:10px">
      <label class="field"><span>What is it</span><select id="bfKind"><option value="tender_doc">Tender document</option><option value="purchased_scan">Purchased document (scan)</option><option value="addendum">Addendum</option><option value="briefing_cert">Briefing attendance certificate</option><option value="other">Other</option></select></label>
      <label class="field"><span>PDF, Word, Excel or image (up to 45 MB)</span><input type="file" id="bfFile" accept=".pdf,.docx,.doc,.xlsx,.xls,image/png,image/jpeg,image/webp" required></label>
      <div class="field"><span>&nbsp;</span><button class="btn small" type="submit" id="bfBtn">Upload</button></div>
    </form>`;
  const next = nextCheck();

  // step 1: documents
  let s1;
  if (docsHere.length) {
    s1 = `<p style="margin:0 0 8px">${docsHere.length} tender document${docsHere.length === 1 ? " is" : "s are"} on this bid.${reading ? " The text of scanned pages is being read; this takes a few minutes." : " They are read when the bid is prepared."}</p>
      <ul class="doclist">${inFiles.map(fileRow).join("")}</ul>
      <details class="more"><summary>Upload another document (addendum, briefing certificate, purchased scan)</summary>${uploadForm}</details>`;
  } else if (docs.length) {
    s1 = `<p style="margin:0 0 8px">The tender documents are published on eTenders. Copy them into this bid with one click, or let step 2 do it for you.</p>
      <div class="actions" style="margin:0"><button class="btn" type="button" id="fetchDocs">Get the documents from eTenders</button><span class="muted" id="fetchMsg">${docs.length} document${docs.length === 1 ? "" : "s"} on the advert.</span></div>
      ${inFiles.length ? `<ul class="doclist" style="margin-top:10px">${inFiles.map(fileRow).join("")}</ul>` : ""}
      <details class="more"><summary>Or upload them yourself</summary>${uploadForm}</details>`;
  } else if (t.purchase_required || t.bid_status === "purchase") {
    s1 = `<div class="box alert" style="margin:0 0 10px"><b>The documents must be bought.</b> ${t.purchase_fee ? "Fee: <b>" + esc(t.purchase_fee) + "</b>. " : ""}${esc(t.purchase_where || "See the advert for where to buy.")}
        <ol class="steps" style="margin-top:6px"><li>Buy the set and keep the receipt for the bid.</li><li>Scan every page to one PDF (or upload the Word and Excel files if you were given them).</li><li>Upload it below as <b>Purchased document (scan)</b>. The bid can then be prepared.</li></ol>
        <div class="actions"><button class="btn warn small" type="button" data-setstatus="purchase">Mark: must buy</button><button class="btn ghost small" type="button" data-setstatus="purchased">Mark: bought</button></div></div>
      ${inFiles.length ? `<ul class="doclist">${inFiles.map(fileRow).join("")}</ul>` : ""}${uploadForm}`;
  } else {
    s1 = `<p style="margin:0 0 8px">No documents were published on eTenders. Get them from the organ of state (or its website) and upload them here.</p>
      ${inFiles.length ? `<ul class="doclist">${inFiles.map(fileRow).join("")}</ul>` : ""}${uploadForm}`;
  }
  if (docs.length) s1 += `<details class="more"><summary>Documents on the eTenders advert (${docs.length})</summary><ul class="doclist">${docs.map(d => `<li><span class="nm"><span class="ext">${esc((d.ext || "").replace(".", ""))}</span>${esc(d.name)}</span><a href="${esc(d.url)}" target="_blank" rel="noopener">Download from eTenders</a></li>`).join("")}</ul></details>`;

  // step 2: automatic preparation
  const noteBox = (val, label) => `<label class="field" style="margin-top:10px"><span>${label || "Anything the preparation should take into account (optional)"}</span><textarea id="prepNote" rows="3" placeholder="For example: propose Kabelo as contracts manager; we bid as a JV with another firm; leave out the Maselspoort project; the site meeting is on 21 Oct.">${esc(val || "")}</textarea></label>`;
  const WHAT = `<ul class="ticklist">
      <li>Reads the returnables list, the functionality criteria, the pricing instructions and the contract data.</li>
      <li>Picks the best person for each key position and tailors their CV to that position's requirement.</li>
      <li>Drafts the appointment letters, the resolution, the schedules, the method statement and the programme on the letterhead.</li>
      <li>Fills the tender document in red for you to copy in pen, and prices the BoQ with the cost model.</li>
      <li>Builds the returnables pack, cover page, index, envelope labels and checklist, and lists every document still to upload.</li></ul>`;
  const message = prep && prep.message ? `<div class="message"><b>Preparation notes for this bid</b>\n${esc(prep.message)}</div>` : "";
  const qs = prep && prep.details ? [...(prep.details.questions || []), ...(prep.details.not_found || []).map(x => "Not found in the document: " + x)] : [];
  const questions = qs.length ? `<h4 class="sub">For you to decide or check</h4><ul class="plainlist">${qs.map(q => `<li>${esc(q)}</li>`).join("")}</ul>` : "";
  let s2;
  if (prepActive) {
    const who = esc(prep.requested_name || prep.requested_by || "the team");
    const line = prep.status === "running"
      ? `<span class="spin" aria-hidden="true"></span><div><b>Preparing this bid now.</b><br>${esc(prep.progress || "Reading the tender documents")}</div>`
      : prep.status === "waiting"
        ? `<span class="spin slow" aria-hidden="true"></span><div><b>On hold.</b> ${esc(prep.progress || "")}</div>`
        : `<span class="spin slow" aria-hidden="true"></span><div><b>Sent for preparation</b> by ${who}, ${esc(fmtDate(prep.created_at, true))}.<br>Requests are picked up ${PREP_TIMES}. Next check: <b>${esc(whenText(next))}</b>. The bid pack follows within about half an hour of preparation. This page updates by itself.</div>`;
    s2 = `<div class="statusline ${prep.status === "waiting" ? "warn" : "info"}">${line}</div>
      ${prep.note ? `<p class="muted" style="margin:6px 0 0">Your instructions: ${esc(prep.note)}</p>` : ""}
      ${prep.status !== "running" ? `<details class="more"><summary>Change the instructions, or cancel</summary>${noteBox(prep.note)}<div class="actions"><button class="btn small" type="button" id="prepBtn">Save the instructions</button><button class="btn ghost small" type="button" id="prepCancel">Cancel the request</button></div></details>` : ""}`;
  } else if (buildActive) {
    s2 = `<div class="statusline info"><span class="spin" aria-hidden="true"></span><div><b>${build.status === "running" ? "Building the bid pack now." : "The bid is prepared. The bid pack is being built."}</b><br>This usually takes 10 to 30 minutes. This page updates by itself.</div></div>${message}${questions}`;
  } else if (prep && prep.status === "failed") {
    s2 = `<div class="statusline bad"><div><b>This bid could not be prepared.</b><br>${esc(prep.error || "")}</div></div>
      ${noteBox(prep.note)}<div class="actions"><button class="btn" type="button" id="prepBtn" ${!docsHere.length && !docs.length ? "disabled" : ""} ${!docsHere.length && docs.length ? 'data-fetch="1"' : ""}>Try again</button></div>`;
  } else if (pack || (prep && prep.status === "done")) {
    const when = (prep && prep.status === "done" && prep.finished_at) || (pack && pack.finished_at);
    s2 = `<div class="statusline ${build && build.status === "failed" ? "bad" : "ok"}"><div><b>Prepared${prep && prep.status === "done" ? " automatically" : ""}, ${esc(fmtDate(when, true))}.</b>${build && build.status === "failed" ? `<br>The last bid pack build failed: ${esc(build.error || "")}` : ""}</div></div>
      ${message}${teamAndScore(pack, prep)}${questions}
      <details class="more"><summary>Something changed? Add instructions and prepare again</summary>${noteBox("", "What should change?")}<div class="actions"><button class="btn small" type="button" id="prepBtn">Prepare again</button><span class="muted">Preparation starts from the last plan and applies your instructions.</span></div></details>`;
  } else if (!docsHere.length) {
    s2 = `<p style="margin:0 0 6px">When the tender documents are on this bid, the Tender Desk:</p>${WHAT}
      ${docs.length ? noteBox("") + `<div class="actions"><button class="btn" type="button" id="prepBtn" data-fetch="1">Get the documents and prepare this bid</button><span class="muted">Requests are picked up ${PREP_TIMES}. Next check: ${esc(whenText(next))}.</span></div>`
        : `<div class="actions"><button class="btn" type="button" disabled>Prepare this bid</button><span class="muted">Upload the tender document in step 1 first.</span></div>`}`;
  } else {
    s2 = `<p style="margin:0 0 6px">The Tender Desk:</p>${WHAT}${noteBox("")}
      <div class="actions"><button class="btn" type="button" id="prepBtn">Prepare this bid</button><span class="muted">Requests are picked up ${PREP_TIMES}. Next check: ${esc(whenText(next))}.</span></div>`;
  }

  // step 3: uploads
  let s3;
  if (!reqs) {
    s3 = `<p class="muted" style="margin:0 0 8px">Preparation lists exactly what this tender asks for. You can check the usual returnables against the library now.</p>
      <button class="btn ghost small" type="button" id="reqStart">Check the usual returnables now</button>`;
  } else {
    const count = k => reqs.filter(r => r.status === k).length;
    s3 = `<div class="tally"><span class="chip ok">${count("ok") + count("to_generate")} ready</span>${count("missing") ? `<span class="chip bad">${count("missing")} missing</span>` : ""}${count("expired") ? `<span class="chip warn">${count("expired")} out of date</span>` : ""}${count("manual") ? `<span class="chip info">${count("manual")} to attach by hand</span>` : ""}${count("in_document") ? `<span class="chip">${count("in_document")} form${count("in_document") === 1 ? "" : "s"} in the tender document</span>` : ""}</div>
      ${need.length ? `<ul class="needlist">${need.slice(0, 6).map(r => `<li><span class="chip ${r.status === "expired" ? "warn" : "bad"}">${r.status === "expired" ? "Out of date" : "Missing"}</span><span>${esc(r.title)}${r.person && !(r.title || "").includes(r.person) ? ` <span class="muted">· ${esc(r.person)}</span>` : ""}</span></li>`).join("")}${need.length > 6 ? `<li class="muted">and ${need.length - 6} more</li>` : ""}</ul>`
        : `<p style="margin:8px 0 0">${pack ? "Every document the library can supply is on file." : "Nothing is missing so far. Preparation may add items when it reads the tender."}</p>`}
      <div class="actions"><button class="btn${need.length ? "" : " ghost"}" type="button" id="toUploads">Open the upload list for this bid</button><span class="muted">What each document must show, where to get it, and an upload button for each.</span></div>
      <details class="more"><summary>Everything this bid needs (${reqs.length})</summary><div id="reqBox"></div></details>`;
  }

  // step 4: print and submit
  let s4;
  if (!pack) {
    s4 = `<p class="muted" style="margin:0">The bid pack appears here once the bid is prepared: the returnables pack ready to print, the red filling guide with the blank original, the priced BoQ and cost model, the cover page, the index, the envelope labels, the checklist, and every CV and letter on its own.</p>`;
  } else {
    const tdIdx = ((pack.summary || {}).index || []).find(e => /tender document/i.test(e.title || ""));
    s4 = `${buildActive ? '<div class="notice info" style="margin:0 0 10px">A new bid pack is being built. The files below are from the last build.</div>' : ""}
      <p class="muted" style="margin:0 0 6px">Built ${esc(fmtDate(pack.finished_at, true))}. Open them in this order:</p>
      ${packList(current)}
      ${preparedList(pack)}
      <h4 class="sub">Then, by hand</h4>
      <ol class="steps">
        <li>Print the returnables pack.</li>
        <li>Print the blank original tender document and complete it in pen, copying the red entries from the filling guide and the rates from column H of the cost model.${tdIdx ? ` Insert it behind divider ${esc(tdIdx.no)} (pages ${esc(tdIdx.pages)}).` : ""}</li>
        <li>Sign and date every CV, letter and form, and answer the declarations yourself. The Tender Desk never signs or answers them.</li>
        <li>Certify the copies and have any affidavit commissioned.</li>
        <li>Seal the envelope(s), stick on the labels and deliver before ${esc(fmtDate(t.closes_at, true))}.</li>
      </ol>
      <p class="muted" style="margin:6px 0 0">The full checklist is on the <button class="linkbtn" type="button" id="toUploads2">Uploads needed</button> tab.</p>
      <div class="actions"><button class="btn ghost small" type="button" id="rebuild">Build again with today's documents and rates</button><span class="muted">Use this after uploading missing documents. The preparation plan stays the same.</span></div>
      ${older.length ? `<details class="more"><summary>Earlier bid packs (${older.length} files)</summary><ul class="doclist">${older.map(fileRow).join("")}</ul></details>` : ""}`;
  }

  const step = (i, title, body) => `<section class="box step ${state[i - 1]}"><h3><span class="n">${state[i - 1] === "done" ? "✓" : i}</span>${esc(title)}</h3>${body}</section>`;
  $("#sheet").innerHTML = `
    <div class="sheet-head"><div class="tno">${esc(t.tender_no || "")} · eTenders ${esc(t.id)}</div><button class="btn ghost small" type="button" id="closeSheet">Close</button></div>
    <h2>${esc((t.description || "").replace(/\s+/g, " ").trim())}</h2>
    <div class="org">${esc(t.organ_of_state || "")}${t.province ? " · " + esc(t.province) : ""}</div>
    <div class="chips" style="margin-top:8px">${rowChips(t)}</div>
    ${t.change_note ? `<div class="notice bad" style="margin-top:10px">${esc(t.change_note)} · ${esc(fmtDate(t.changed_at, true))}</div>` : ""}

    <dl class="facts">
      <div class="fact"><dt>Closes</dt><dd><b>${esc(fmtDate(t.closes_at, true))}</b> ${n != null ? `<span class="muted">(${n < 0 ? "closed" : n === 0 ? "today" : n + (n === 1 ? " day" : " days") + " left"})</span>` : ""}</dd></div>
      <div class="fact"><dt>CIDB grading</dt><dd>${t.cidb_requirement ? esc(t.cidb_requirement) : "Not stated in the advert"}${t.pe_allowed ? " · PE allowed" : ""}</dd></div>
      <div class="fact"><dt>Briefing</dt><dd>${t.briefing_session ? `${t.briefing_compulsory ? "<b>Compulsory</b> · " : "Optional · "}${esc(fmtDate(t.briefing_at, true))}<br><span class="muted">${esc(t.briefing_venue || "")}</span>` : "No briefing session"}</dd></div>
      <div class="fact"><dt>Submission</dt><dd>${t.e_submission ? "Electronic submission" : "Hard copy"}${t.two_envelope ? " · two envelopes" : ""}${t.validity_days ? ` · valid ${esc(t.validity_days)} days` : ""}<br><span class="muted">${esc(t.delivery || "")}</span></dd></div>
    </dl>

    <ol class="flow" aria-label="Steps for this bid">${["Tender documents", "Prepare the bid", "Upload what is missing", "Print and submit"].map((l, i) => `<li class="${state[i]}"><span>Step ${i + 1}${state[i] === "done" ? " · done" : state[i] === "now" ? " · now" : ""}</span><b>${esc(l)}</b></li>`).join("")}</ol>

    ${step(1, "Tender documents", s1)}
    ${step(2, "Prepare the bid", s2)}
    ${step(3, "Upload what is missing", s3)}
    ${step(4, "Print, sign and submit", s4)}

    <details class="box more-box"><summary><b>More about this tender</b></summary>
      <dl class="facts">
        <div class="fact"><dt>Type</dt><dd>${esc(t.tender_type || "–")}${t.is_panel ? " · panel / rate-based" : ""}</dd></div>
        <div class="fact"><dt>Category</dt><dd>${esc(t.category || "–")}</dd></div>
        <div class="fact"><dt>Contact</dt><dd>${esc(t.contact_person || "–")}<br><span class="mono" style="user-select:all">${esc(t.contact_email || "")}</span> <span class="mono">${esc(t.contact_phone || "")}</span></dd></div>
        <div class="fact"><dt>Why it is on the list</dt><dd>${esc(t.match_reason || "–")}${t.screened_at ? ` <span class="muted">(documents checked ${esc(fmtDate(t.screened_at))})</span>` : ""}</dd></div>
      </dl>
      ${t.conditions ? `<h4 class="sub">Special conditions</h4><div class="pre">${esc(t.conditions)}</div>` : ""}
      ${t.screening_notes ? `<h4 class="sub">Notes from the document check</h4><div class="pre">${esc(t.screening_notes)}</div>` : ""}
    </details>

    <div class="box"><h3>Our bid</h3>
      <div class="grid2">
        <label class="field"><span>Status</span><select id="bidStatus">${statusOpts}</select></label>
        <div></div>
      </div>
      <label class="field" style="margin-top:10px"><span>Notes for the team</span><textarea id="bidNotes" rows="3" placeholder="Who is attending the briefing, JV partner, pricing notes…">${esc(t.bid_notes || "")}</textarea></label>
      <div class="actions"><button class="btn small" type="button" id="saveNotes">Save notes</button></div>
    </div>`;

  $("#closeSheet").onclick = closeSheet;
  if ($("#reqStart")) $("#reqStart").onclick = () => safe(async () => { await api("set_bid_status", { id: t.id, bid_status: ACTIVE.includes(t.bid_status) ? t.bid_status : "interested" }); await openTender(t.id, true); refreshRow({ ...t, bid_status: ACTIVE.includes(t.bid_status) ? t.bid_status : "interested" }); loadDashboard(); });
  if ($("#reqBox")) renderReqs(t);
  $("#bidStatus").onchange = async e => { await safe(async () => { await api("set_bid_status", { id: t.id, bid_status: e.target.value }); t.bid_status = e.target.value; toast("Status saved"); refreshRow(t); loadDashboard(); await openTender(t.id, true); }); };
  $("#saveNotes").onclick = async () => { await safe(async () => { await api("save_notes", { id: t.id, notes: $("#bidNotes").value }); toast("Notes saved"); }); };
  $$("[data-setstatus]", $("#sheet")).forEach(b => b.onclick = async () => { await safe(async () => { await api("set_bid_status", { id: t.id, bid_status: b.dataset.setstatus }); t.bid_status = b.dataset.setstatus; refreshRow(t); loadDashboard(); toast("Status saved"); await openTender(t.id, true); }); });
  if ($("#bidUpload")) $("#bidUpload").onsubmit = async e => {
    e.preventDefault();
    const file = $("#bfFile").files[0]; if (!file) return;
    const btn = $("#bfBtn"); btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const kind = $("#bfKind").value;
      const up = await uploadFile(file, `bids/${safeFile(t.id)}/uploads`, false);
      const res = await api("add_bid_file", { tender_id: t.id, kind, title: file.name.replace(/\.[^.]+$/, ""), storage_path: up.path, file_name: file.name, content_type: file.type || "", size_bytes: up.size });
      if (TENDER_KINDS.includes(kind) && res && res.id) { try { await fn("extract", { file_id: res.id }); } catch (_) {} }
      toast("Uploaded"); await openTender(t.id, true); refreshRow(st.current || t); loadDashboard();
    } catch (err) { toast(uploadError(err)); btn.disabled = false; btn.textContent = "Upload"; }
  };
  if ($("#fetchDocs")) $("#fetchDocs").onclick = async () => {
    const b = $("#fetchDocs"); b.disabled = true; $("#fetchMsg").textContent = "Downloading from eTenders… this can take a minute.";
    try { await fetchDocs(t); await openTender(t.id, true); loadDashboard(); }
    catch (err) { $("#fetchMsg").textContent = errorCopy(err).replace(/<[^>]+>/g, ""); b.disabled = false; }
  };
  if ($("#prepBtn")) $("#prepBtn").onclick = async () => {
    const b = $("#prepBtn"); const label = b.textContent; b.disabled = true;
    const note = $("#prepNote") ? $("#prepNote").value.trim() : "";
    try {
      if (b.dataset.fetch) {
        b.textContent = "Getting the documents from eTenders…";
        const saved = await fetchDocs(t);
        if (!saved) throw { message: "No documents could be copied from eTenders. Upload the tender document in step 1, then press Prepare this bid." };
      }
      b.textContent = "Sending…";
      const r = await api("request_prepare", { tender_id: t.id, note });
      toast(r.existing ? "Instructions saved" : `Sent for preparation. Next check ${whenText(nextCheck())}.`);
      await openTender(t.id, true); refreshRow(st.current || t); loadDashboard();
    } catch (err) { toast(errorCopy(err).replace(/<[^>]+>/g, "")); b.disabled = false; b.textContent = label; if (b.dataset.fetch) openTender(t.id, true); }
  };
  if ($("#prepCancel")) $("#prepCancel").onclick = () => safe(async () => { await api("cancel_prepare", { id: prep.id }); toast("Request cancelled"); await openTender(t.id, true); });
  const goUploads = () => { closeSheet(); showUploads(t.id); };
  if ($("#toUploads")) $("#toUploads").onclick = goUploads;
  if ($("#toUploads2")) $("#toUploads2").onclick = goUploads;
  if ($("#rebuild")) $("#rebuild").onclick = () => safe(async () => { await api("queue_job", { tender_id: t.id, kind: "build" }); toast("Build queued. The new pack is usually ready within half an hour."); await openTender(t.id, true); });
  wireFileButtons($("#sheet"), () => openTender(t.id, true));
  wireOpen($("#sheet"));
}

async function fetchDocs(t) {
  const r = await fn("fetch_tender_docs", { tender_id: t.id });
  const res = r.results || [];
  const saved = res.filter(x => x.status === "saved").length;
  const here = res.filter(x => x.status === "already here").length;
  const other = res.filter(x => x.status !== "saved" && x.status !== "already here");
  toast(saved ? `Saved ${saved} document${saved === 1 ? "" : "s"} from eTenders` : here ? "The documents are already on this bid" : "Nothing could be downloaded");
  if (other.length) notice("warn", "Some documents could not be downloaded: " + other.map(x => esc(x.name) + " (" + esc(x.status) + ")").join("; "));
  return saved + here;
}

function refreshRow(t) { const r = st.rows.find(x => x.id === t.id); if (r) { r.bid_status = t.bid_status; renderList(); } }

function wireFileButtons(root, after) {
  $$("[data-rmfile]", root).forEach(b => b.onclick = () => {
    const span = document.createElement("span"); span.className = "confirm";
    span.innerHTML = 'Remove this file? <button class="btn small danger" type="button">Remove</button><button class="btn ghost small" type="button">Keep</button>';
    b.replaceWith(span);
    const [yes, no] = span.querySelectorAll("button");
    no.onclick = () => span.replaceWith(b);
    yes.onclick = async () => { await safe(async () => { await api("remove_bid_file", { id: b.dataset.rmfile }); toast("Removed"); after(); }); };
  });
}

async function uploadFile(file, folder, pdfOrImageOnly) {
  const ok = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  const ext = extOf(file.name);
  if (pdfOrImageOnly && !(ok.includes(file.type) || [".pdf", ".png", ".jpg", ".jpeg", ".webp"].includes(ext))) throw { code: "unsupported_type" };
  if (file.size > 45 * 1048576) throw { code: "too_large" };
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())).slice(0, 8);
  const path = `${folder}/${id}-${safeFile(file.name)}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
  if (error) throw error;
  return { path, size: file.size };
}
function uploadError(e) {
  switch (e && e.code) {
    case "unsupported_type": return "Library documents must be PDF or image files, because they are printed in the bid pack.";
    case "too_large": return "That file is over 45 MB. Split or compress the PDF and try again.";
    default: return errorCopy(e).replace(/<[^>]+>/g, "");
  }
}

/* ---------- uploads needed (per bid) ---------- */
const CAT_GUIDE = {
  cipc: "Company registration certificate from CIPC (CoR14.3, or CK1 for a close corporation) and the latest CoR39 showing the current directors. Download them from CIPC e-Services or use the filed copies.",
  shareholding: "Share certificates or the share register, showing the same ownership as the CSD report.",
  director_ids: "A certified copy of the ID of every director, certified by a Commissioner of Oaths (police station, attorney or bank) with the stamp and date visible.",
  csd: "The full CSD registration report showing the MAAA number, tax compliance and B-BBEE status. Log in at secure.csd.gov.za and download it on the day you finalise the bid.",
  tax: "The SARS tax compliance status (TCS) PIN letter from SARS eFiling, showing the PIN and the status Compliant.",
  bbbee: "A valid B-BBEE certificate from a SANAS-accredited verification agency or, for an EME or QSE, the sworn affidavit (DTIC template) signed before a Commissioner of Oaths. Valid for 12 months.",
  cidb: "The current CIDB registration certificate showing the CRS number, the CE and ME gradings and the expiry date, printed from the CIDB Register of Contractors.",
  coida: "A valid letter of good standing from the Compensation Fund (Department of Employment and Labour), or from the company's COID insurer.",
  uif: "Proof of UIF registration (uFiling or the Department of Employment and Labour).",
  municipal_account: "The latest municipal rates and services statement for the business premises (and for each director if the tender asks), with no arrears older than 90 days; or a signed lease agreement with the landlord's statement.",
  proof_of_address: "A municipal or utility statement, or a lease, showing the business address.",
  bank_letter: "A bank confirmation or rating letter on the bank's letterhead, stamped and signed by the bank, showing the account holder and account details.",
  financials: "The latest annual financial statements, audited or independently reviewed and signed, for the years the tender asks for (usually two or three).",
  surety: "A letter of intent from a bank or insurer to issue the guarantee the tender asks for (for example a performance guarantee).",
  insurance: "Policy schedules or a broker's letter showing public liability and contract works (CAR) cover, with the limits the tender asks for.",
  appointment_letter: "The client's letter appointing Pump Group to a completed project, showing the client, contract value, scope and dates.",
  completion_certificate: "The practical or final completion certificate for the same project, signed by the client or the engineer.",
  reference_letter: "A reference letter from the client on their letterhead, signed, with a contact name and telephone number.",
  cv: "The person's own CV, signed and dated. A tailored CV is written for each bid, so this is needed only when the tender asks for the person's original CV too.",
  qualification: "Certified copies of the person's degree or diploma and professional registration certificates (for example ECSA or SACPCMP), with proof that the registration is current.",
  plant: "A plant list with proof of ownership (invoices or registration papers), or hire agreements or letters of intent from the hire company.",
  health_safety: "The SHE policy signed by the MD, the health and safety plan or baseline risk assessment, and the appointment of the health and safety officer.",
  quality: "The quality policy or quality plan, and the ISO 9001 certificate if held (it counts only for the scope it states).",
  company_profile: "The current company profile (PDF).",
  jv: "The signed joint venture or subcontract agreement, and the partner's own compliance documents (CSD, tax, CIDB, B-BBEE).",
  personnel_appointment: "A signed Pump Group letter appointing the person to the position. A new one is drafted for each bid in the pack, so upload only signed copies you already have.",
  other: "The document exactly as the tender describes it."
};

function showUploads(id) {
  if (id) { st.upBid = id; try { localStorage.setItem("pg-upbid", id); } catch (_) {} }
  showTab("uploads");
  window.scrollTo({ top: 0 });
}
function setUploadsCount(n) { const c = $("#cUp"); if (c) c.textContent = n ? n : ""; }

async function loadUploads() {
  await ensureCats();
  const rows = (await api("uploads_overview")) || [];
  st.upBids = rows;
  setUploadsCount(rows.reduce((s, b) => s + (b.n_missing || 0) + (b.n_expired || 0), 0));
  const sel = $("#upBid");
  if (!rows.length) {
    sel.innerHTML = ""; sel.disabled = true;
    $("#upBody").innerHTML = `<div class="empty">No bids in progress. Open a matching bid and press <b>Prepare this bid</b>; it appears here with everything it still needs.</div>`;
    return;
  }
  sel.disabled = false;
  let want = st.upBid;
  if (!want) { try { want = localStorage.getItem("pg-upbid"); } catch (_) {} }
  if (!rows.some(b => b.id === want)) want = (rows.find(b => (b.n_missing || 0) + (b.n_expired || 0) > 0) || rows[0]).id;
  sel.innerHTML = rows.map(b => {
    const k = (b.n_missing || 0) + (b.n_expired || 0);
    return `<option value="${esc(b.id)}">${esc(b.tender_no || b.id)} · ${esc((b.description || "").slice(0, 70))} · closes ${esc(fmtDay(b.closes_at))} · ${k ? k + " to upload" : "nothing to upload"}</option>`;
  }).join("");
  sel.value = want; st.upBid = want;
  await renderUploads(want);
}
$("#upBid").addEventListener("change", e => { st.upBid = e.target.value; try { localStorage.setItem("pg-upbid", st.upBid); } catch (_) {} safe(() => renderUploads(st.upBid)); });

function libDocsFor(r) {
  const cats = r.categories || [];
  return (st.lib || []).filter(d => cats.includes(d.category) &&
    (!r.person_id || d.person_id === r.person_id || (!d.person_id && !["cv", "qualification"].includes(d.category))));
}
function tickKey(id) { return "pg-ticks-" + id; }
function readTicks(id) { try { return new Set(JSON.parse(localStorage.getItem(tickKey(id)) || "[]")); } catch (_) { return new Set(); } }
function writeTicks(id, set) { try { localStorage.setItem(tickKey(id), JSON.stringify([...set])); } catch (_) {} }

async function renderUploads(id) {
  const B = $("#upBody");
  B.innerHTML = '<div class="loading">Loading what this bid needs…</div>';
  const [t, w, reqs, lib, people] = await Promise.all([api("tender", { id }), api("bid_work", { id }), api("requirements", { id }), api("library"), api("personnel")]);
  if (st.upBid !== id) return;
  st.lib = lib || []; st.people = people || [];
  const prep = w && w.prepare, build = w && w.build, pack = w && w.pack;
  const S = (pack && pack.summary) || {};
  const rows = reqs || [];
  const index = S.index || [];
  const check = S.checklist || [];
  const section = k => (check.find(c => c.key === k) || {}).items || [];
  const whereIn = r => { const e = index.find(x => (x.title || "").trim().toLowerCase() === (r.title || "").trim().toLowerCase()); return e ? `Divider ${e.no}, pages ${e.pages}` : ""; };

  // attach the builder's notes ("<title>: <what is wrong>") to their requirement; keep the rest as a separate list
  const attention = section("upload").length ? section("upload") : (S.attention || []);
  const flags = {}, loose = [];
  attention.forEach(a => {
    const r = rows.find(x => x.title && a.toLowerCase().startsWith(x.title.toLowerCase() + ":"));
    if (r) (flags[r.id] = flags[r.id] || []).push(a.slice(r.title.length + 1).trim()); else loose.push(a);
  });
  const missing = rows.filter(r => r.status === "missing"), expired = rows.filter(r => r.status === "expired");
  const manual = rows.filter(r => r.status === "manual");
  const forms = rows.filter(r => r.status === "in_document");
  const ready = rows.filter(r => ["ok", "to_generate"].includes(r.status)), na = rows.filter(r => r.status === "na");
  const counted = rows.filter(r => r.status !== "na");
  const readyN = counted.filter(r => ["ok", "to_generate", "in_document"].includes(r.status)).length;
  const pct = counted.length ? Math.round(readyN / counted.length * 100) : 0;
  const n = daysLeft(t.closes_at);
  const func = S.functionality || [];
  const fMax = func.reduce((s, f) => s + (Number(f.max_points) || 0), 0), fEst = func.reduce((s, f) => s + (Number(f.est_points) || 0), 0);
  const PREP = { queued: "Waiting for preparation (next check " + whenText(nextCheck()) + ")", waiting: "On hold: " + ((prep && prep.progress) || ""), running: "Working on it now",
    done: "Prepared " + fmtDate(prep && prep.finished_at, true), failed: "Could not prepare: " + ((prep && prep.error) || ""), cancelled: "Request cancelled" };
  const prepText = prep ? PREP[prep.status] : pack ? "Prepared " + fmtDate(pack.finished_at, true) : "Not prepared yet";
  const buildText = build && ["queued", "running"].includes(build.status) ? "Being built now" : pack ? "Built " + fmtDate(pack.finished_at, true) : build && build.status === "failed" ? "Build failed" : "Not built yet";

  let num = 0;
  const item = (r, kind) => {
    num += 1;
    const [cls, label] = r.status === "expired" ? ["warn", "Out of date"] : r.status === "missing" ? ["bad", "Missing"] : r.status === "manual" ? ["info", "Attach by hand"] : REQ_STATUS[r.status] || ["", r.status];
    const cats = r.categories || [];
    const person = r.person_id ? st.people.find(p => p.id === r.person_id) : null;
    const guide = r.kind === "personnel" ? CAT_GUIDE.qualification : cats.map(c => CAT_GUIDE[c] || (st.cats.find(x => x.key === c) || {}).hint).filter(Boolean)[0] || "";
    const days = maxAge(cats);
    const limit = days ? (t.closes_at ? `Dated or certified on or after ${fmtDate(new Date(new Date(t.closes_at).getTime() - days * 864e5))}, so it is not older than ${days} days at closing.` : `Not older than ${days} days.`) : "";
    const onFile = libDocsFor(r).map(d => {
      if (!d.storage_path) return `${esc(d.title)} <span class="chip warn">Listed, but the file is not uploaded yet</span> <button class="btn small no-print" type="button" data-attachdoc="${esc(d.id)}">Add the file</button>`;
      const s_ = docState(d, st.cats.find(c => c.key === d.category)); return `${esc(d.title)} <span class="chip ${s_.cls}">${esc(s_.text)}</span>`;
    });
    const regs = person && person.registrations && person.registrations.length ? person.registrations.map(x => { const [c_, txt] = regState(x); return `${esc(x.body || "")} ${esc(x.category || "")} <span class="chip ${c_}">${esc(txt)}</span>`; }) : [];
    const notes = [...(flags[r.id] || []), r.note].filter(Boolean);
    const where = whereIn(r);
    const canUpload = cats.length && ["missing", "expired"].includes(r.status);
    return `<article class="upitem ${kind}" data-req="${esc(r.id)}">
      <header><h4><span class="n">${num}</span>${esc(r.title)}</h4><span class="chip ${cls}">${esc(label)}</span></header>
      <dl>
        ${r.ref ? `<dt>Tender reference</dt><dd>${esc(r.ref)}</dd>` : ""}
        ${where ? `<dt>In the pack</dt><dd>${esc(where)}</dd>` : ""}
        ${r.role ? `<dt>Position</dt><dd>${esc(r.role)}${r.person ? ": " + esc(r.person) : " (nobody proposed yet)"}</dd>` : ""}
        ${r.requirement ? `<dt>The tender asks for</dt><dd>${esc(r.requirement)}</dd>` : ""}
        ${cats.length && r.kind !== "personnel" ? `<dt>Upload</dt><dd>${esc(cats.map(catLabel).join(" or "))}</dd>` : ""}
        ${guide ? `<dt>What it must show</dt><dd>${esc(guide)}</dd>` : ""}
        ${limit ? `<dt>Date limit</dt><dd>${esc(limit)}</dd>` : ""}
        ${regs.length ? `<dt>Registrations on record</dt><dd>${regs.join("<br>")}</dd>` : ""}
        ${onFile.length ? `<dt>On file now</dt><dd>${onFile.join("<br>")}</dd>` : ""}
        ${notes.length ? `<dt>Note</dt><dd>${esc(notes.join(" · "))}</dd>` : ""}
        ${r.max_points ? `<dt>Points</dt><dd>${r.est_points != null ? esc(r.est_points) + " of " : ""}${esc(r.max_points)}</dd>` : ""}
      </dl>
      <div class="actions no-print" style="margin-top:2px">
        ${canUpload ? `<button class="btn small" type="button" data-upform="${esc(r.id)}">${r.status === "expired" ? "Upload the new copy" : "Upload"}</button>` : ""}
        ${r.status === "manual" ? `<button class="btn ghost small" type="button" data-upset="ok" data-id="${esc(r.id)}">Mark as done</button>` : ""}
        <button class="linkbtn" type="button" data-upset="na" data-id="${esc(r.id)}">Not needed for this bid</button>
      </div>
    </article>`;
  };
  const block = (title, sub, list, kind) => list.length ? `<section class="upsec"><h3>${esc(title)} <span class="count">${list.length}</span></h3>${sub ? `<p class="muted">${sub}</p>` : ""}<div class="uplist">${list.map(r => item(r, kind)).join("")}</div></section>` : "";

  const ticks = readTicks(id);
  const tickList = (items) => `<ul class="ticks">${items.map(x => `<li><label><input type="checkbox" data-tick="${esc(x)}" ${ticks.has(x) ? "checked" : ""}><span>${esc(x)}</span></label></li>`).join("")}</ul>`;
  const byHand = [];
  const sign = section("sign"), certify = section("certify"), details = section("details"), also = section("also"), delivery = section("delivery"), pricing = section("pricing");
  if (sign.length) byHand.push(["Sign", sign]);
  if (forms.length) byHand.push(["Forms in the tender document (complete and sign them there)", forms.map(r => (r.ref && !(r.title || "").toLowerCase().startsWith(r.ref.toLowerCase()) ? r.ref + " " : "") + r.title)]);
  if (details.length) byHand.push(["Fill in the original tender document", details]);
  if (pricing.length) byHand.push(["Pricing", pricing]);
  if (certify.length) byHand.push(["Certify and commission", certify]);
  if (also.length) byHand.push(["Also do", also]);
  if (delivery.length) byHand.push(["Deliver", delivery]);
  if (!byHand.length) byHand.push(["Before you seal", [
    "Print the returnables pack.",
    "Print the blank original tender document and complete it in pen, copying the red entries from the filling guide.",
    "Sign and date every CV, letter and form. Answer the declarations yourself.",
    "Certify the copies and have any affidavit commissioned.",
    `Seal the envelope(s), stick on the labels and deliver before ${fmtDate(t.closes_at, true)}.`]]);
  const review = section("check").length ? section("check") : (S.review || []);

  const total = missing.length + expired.length;
  B.innerHTML = `
    <div class="upcard">
      <div class="tno">${esc(t.tender_no || "")} · eTenders ${esc(t.id)}</div>
      <h3>${esc((t.description || "").replace(/\s+/g, " ").trim())}</h3>
      <div class="org">${esc(t.organ_of_state || "")}${t.province ? " · " + esc(t.province) : ""}</div>
      <dl class="facts">
        <div class="fact"><dt>Closes</dt><dd><b>${esc(fmtDate(t.closes_at, true))}</b> ${n != null ? `<span class="muted">(${n < 0 ? "closed" : n === 0 ? "today" : n + (n === 1 ? " day" : " days") + " left"})</span>` : ""}</dd></div>
        <div class="fact"><dt>Preparation</dt><dd>${esc(prepText)}</dd></div>
        <div class="fact"><dt>Bid pack</dt><dd>${esc(buildText)}</dd></div>
        <div class="fact"><dt>Functionality (estimate)</dt><dd>${fMax ? `<b>${esc(fEst)} of ${esc(fMax)}</b> points` : "Once the bid is prepared"}</dd></div>
      </dl>
      <div class="readiness"><div><b>${readyN} of ${counted.length}</b> <span class="muted">items ready${total ? ` · ${total} to upload` : ""}</span></div><div class="meter" aria-hidden="true"><i style="width:${pct}%"></i></div></div>
      <div class="actions no-print"><button class="btn small" type="button" id="upOpen">Open the bid</button><button class="btn ghost small" type="button" id="upPrint">Print this list</button>
        ${pack || build ? `<button class="btn ghost small" type="button" id="upRebuild">Build the pack again with the new documents</button>` : ""}</div>
    </div>
    ${!prep && !pack ? `<div class="notice info">This bid has not been prepared yet, so this list comes from the advert and the usual returnables. Open the bid and press <b>Prepare this bid</b> for the tender's own list.</div>` : ""}
    ${!total && !manual.length && rows.length ? `<div class="notice info" style="background:var(--ok-bg);color:var(--ok)">Nothing to upload for this bid. ${pack ? "Check the list at the end, then print." : ""}</div>` : ""}
    ${block("Upload these", "Not in the document library, or listed there without its file. Each upload is saved to the library, so the next bid has it too.", missing, "")}
    ${block("Replace these: out of date", "The library has a copy, but it has expired or is older than the tender allows.", expired, "expired")}
    ${block("Attach by hand for this bid", "Only you can provide these. Print them and put them behind their divider in the returnables pack.", manual, "manual")}
    ${loose.length ? `<section class="upsec"><h3>Also flagged when the bid pack was built <span class="count">${loose.length}</span></h3>
      <p class="muted">Upload these under <button class="linkbtn" type="button" data-go="people">People</button> or the <button class="linkbtn" type="button" data-go="library">Document library</button>, then build the pack again.</p>
      <ul class="plainlist flagged">${loose.map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
    ${review.length ? `<section class="upsec"><h3>Check before you rely on it <span class="count">${review.length}</span></h3><ul class="plainlist">${review.map(x => `<li>${esc(x)}</li>`).join("")}</ul></section>` : ""}
    <section class="upsec"><h3>At the end, by hand</h3><p class="muted">Tick them off as you go. Ticks are kept on this device.</p>
      ${byHand.map(([h, items]) => `<h4 class="sub">${esc(h)}</h4>${tickList(items)}`).join("")}</section>
    ${ready.length || na.length ? `<details class="upsec more-box"><summary><b>Ready: on file or prepared automatically (${ready.length})</b></summary>
      <ul class="doclist">${ready.map(r => `<li><span class="nm">${esc(r.title)}${r.person && !(r.title || "").includes(r.person) ? ` <span class="muted">· ${esc(r.person)}</span>` : ""}<br>${(r.docs || []).length ? r.docs.map(fileLink).join(" · ") : `<span class="muted">${r.status === "to_generate" ? "Prepared automatically in the bid pack" : "On file"}</span>`}</span><span class="chip ${(REQ_STATUS[r.status] || [""])[0]}">${esc((REQ_STATUS[r.status] || ["", r.status])[1])}</span></li>`).join("")}
        ${na.map(r => `<li><span class="nm">${esc(r.title)} <span class="muted">· marked not needed</span></span><button class="linkbtn" type="button" data-upset="missing" data-id="${esc(r.id)}">Undo</button></li>`).join("")}</ul></details>` : ""}`;

  $("#upOpen").onclick = () => openTender(t.id);
  $("#upPrint").onclick = () => window.print();
  if ($("#upRebuild")) $("#upRebuild").onclick = () => safe(async () => { await api("queue_job", { tender_id: t.id, kind: "build" }); toast("Build queued. The new pack is usually ready within half an hour."); await renderUploads(id); });
  $$("[data-upform]", B).forEach(b => b.onclick = () => {
    const card = b.closest(".upitem");
    const open = $("form", card); if (open) { open.remove(); return; }
    const r = rows.find(x => x.id === b.dataset.upform);
    const f = document.createElement("form"); f.className = "upform"; f.innerHTML = uploadFormHtml(r);
    card.appendChild(f);
    f.onsubmit = async e => {
      e.preventDefault();
      if (await saveReqUpload(f, r, t.id)) { toast(pack ? "Saved. Build the pack again when everything is uploaded." : "Saved to the library"); await loadUploads(); loadDashboard(); }
    };
  });
  $$("[data-upset]", B).forEach(b => b.onclick = () => safe(async () => {
    await api("set_requirement_status", { id: b.dataset.id, status: b.dataset.upset });
    if (b.dataset.upset === "missing") await api("refresh_requirements", { id: t.id });
    await loadUploads(); loadDashboard();
  }));
  $$("[data-attachdoc]", B).forEach(b => b.onclick = () => {
    const doc = (st.lib || []).find(d => d.id === b.dataset.attachdoc); if (!doc) return;
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = "application/pdf,image/png,image/jpeg,image/webp";
    inp.onchange = () => safe(async () => {
      const file = inp.files[0]; if (!file) return;
      b.disabled = true; b.textContent = "Uploading…";
      await attachFile(doc, file);
      await api("refresh_requirements", { id: t.id });
      st.libLoaded = false; toast("File added"); await loadUploads(); loadDashboard();
    });
    inp.click();
  });
  $$("[data-tick]", B).forEach(c => c.onchange = () => { const s_ = readTicks(id); c.checked ? s_.add(c.dataset.tick) : s_.delete(c.dataset.tick); writeTicks(id, s_); });
  wireOpen(B);
}

/* ---------- library ---------- */
async function loadLibrary() {
  const [settings, lib, people] = await Promise.all([api("settings"), api("library"), api("personnel")]);
  st.settings = settings || {}; st.cats = (settings && settings.library_categories) || []; st.lib = lib || []; st.libLoaded = true; st.people = people || [];
  const sel = $("#libCat");
  if (!sel.options.length) st.cats.forEach(c => sel.add(new Option(`${c.group}: ${c.label}`, c.key)));
  const ps = $("#libPerson");
  ps.length = 1; st.people.forEach(p => ps.add(new Option(p.full_name, p.id)));
  catChanged();
  renderLibrary();
}
function docState(d, cat) {
  const today = new Date(new Date().toDateString());
  if (d.expires_on) {
    const left = Math.round((new Date(d.expires_on) - today) / 864e5);
    if (left < 0) return { cls: "bad", text: "Expired " + fmtDate(d.expires_on) };
    if (left <= 30) return { cls: "warn", text: `Expires in ${left} days` };
    return { cls: "ok", text: "Valid to " + fmtDate(d.expires_on) };
  }
  if (cat && cat.max_age_days && d.issued_on) {
    const age = Math.round((today - new Date(d.issued_on)) / 864e5);
    if (age > cat.max_age_days) return { cls: "bad", text: `${age} days old (tenders want under ${cat.max_age_days})` };
    if (age > cat.max_age_days - 14) return { cls: "warn", text: `${age} days old; refresh soon` };
    return { cls: "ok", text: `Issued ${fmtDate(d.issued_on)}` };
  }
  if (cat && cat.max_age_days && !d.issued_on) return { cls: "warn", text: "Add the issue date" };
  return { cls: "ok", text: d.issued_on ? "Issued " + fmtDate(d.issued_on) : "On file" };
}
function renderLibrary() {
  const byCat = {}; st.lib.forEach(d => (byCat[d.category] = byCat[d.category] || []).push(d));
  const covered = CORE_CATS.filter(k => (byCat[k] || []).some(d => docState(d, st.cats.find(c => c.key === k)).cls !== "bad")).length;
  $("#readyText").textContent = `${covered} of ${CORE_CATS.length}`;
  $("#readyBar").style.width = Math.round(covered / CORE_CATS.length * 100) + "%";
  const groups = [...new Set(st.cats.map(c => c.group))];
  $("#libGroups").innerHTML = groups.map(g => `<div class="libgroup"><h3>${esc(g)}</h3><div class="cats">${st.cats.filter(c => c.group === g).map(c => {
    const docs = byCat[c.key] || [];
    return `<div class="cat ${docs.length ? "" : "missing"}"><header><b>${esc(c.label)}</b><span class="muted">${docs.length || "none"}</span></header>
      <div class="hint">${esc(c.hint)}</div>
      ${docs.length ? `<ul class="doclist">${docs.map(d => { const s = docState(d, c); const who = d.person_id ? (st.people.find(p => p.id === d.person_id) || {}).full_name : "";
        return `<li><span class="nm">${esc(d.title)}${who ? ` <span class="muted">· ${esc(who)}</span>` : ""}${d.client ? ` <span class="muted">· ${esc(d.client)}${d.project_value ? " · " + rand(d.project_value) : ""}</span>` : ""}<br><span class="chip ${s.cls}">${esc(s.text)}</span></span>
        <span class="actions" style="margin:0">${d.storage_path ? `<button class="btn ghost small" type="button" data-open="${esc(d.storage_path)}">Open</button>` : `<button class="btn warn small" type="button" data-attach="${esc(d.id)}">Add file</button>`}<button class="linkbtn" type="button" data-archive="${esc(d.id)}">Retire</button></span></li>`; }).join("")}</ul>` : ""}
      <div><button class="linkbtn" type="button" data-addcat="${esc(c.key)}">Add ${docs.length ? "another" : "one"}</button></div></div>`;
  }).join("")}</div></div>`).join("");
  wireOpen($("#libGroups"));
  const waiting = st.lib.filter(d => !d.storage_path);
  $("#moveBox").hidden = !waiting.length;
  if (waiting.length) $("#moveText").textContent = `${waiting.length} document${waiting.length === 1 ? " is" : "s are"} listed without a file (${waiting.slice(0, 3).map(d => d.file_name || d.title).join(", ")}${waiting.length > 3 ? "…" : ""}). Select the files and each one is matched to its document by file name.`;
  $$("[data-attach]").forEach(b => b.onclick = () => { st.attachId = b.dataset.attach; $("#attachOne").value = ""; $("#attachOne").click(); });
  $$("[data-addcat]").forEach(b => b.onclick = () => { $("#libCat").value = b.dataset.addcat; catChanged(); $("#libForm").scrollIntoView({ behavior: "smooth", block: "start" }); $("#libTitle").focus(); });
  $$("[data-archive]").forEach(b => b.onclick = () => {
    const span = document.createElement("span"); span.className = "confirm";
    span.innerHTML = 'Retire it? <button class="btn small warn" type="button">Retire</button><button class="btn ghost small" type="button">Keep</button>';
    b.replaceWith(span); const [yes, no] = span.querySelectorAll("button");
    no.onclick = () => span.replaceWith(b);
    yes.onclick = () => safe(async () => { await api("archive_library_doc", { id: b.dataset.archive }); st.lib = await api("library"); renderLibrary(); loadDashboard(); toast("Retired from the library"); });
  });
}
function catChanged() {
  const c = st.cats.find(x => x.key === $("#libCat").value);
  $("#expFields").hidden = !(c && c.group === "Experience");
  $("#libPersonField").hidden = !(c && PERSON_CATS.includes(c.key));
  $("#catHint").textContent = c ? c.hint : "";
}
$("#libCat").addEventListener("change", catChanged);
async function attachFile(doc, file) {
  const up = await uploadFile(file, doc.person_id ? "people" : "library", true);
  await api("attach_library_file", { id: doc.id, storage_path: up.path, size_bytes: up.size, content_type: file.type || "application/pdf" });
}
$("#attachOne").addEventListener("change", () => safe(async () => {
  const file = $("#attachOne").files[0]; const doc = st.lib.find(d => d.id === st.attachId);
  if (!file || !doc) return;
  toast("Uploading…"); await attachFile(doc, file);
  st.lib = await api("library"); renderLibrary(); toast("File added");
}));
$("#moveFiles").addEventListener("change", () => safe(async () => {
  const files = [...$("#moveFiles").files]; if (!files.length) return;
  const norm = n => String(n || "").toLowerCase().replace(/^.*[\\/]/, "").trim();
  const waiting = st.lib.filter(d => !d.storage_path);
  let done = 0; const unmatched = [];
  for (const f of files) {
    const doc = waiting.find(d => norm(d.file_name) === norm(f.name) && !d._done);
    if (!doc) { unmatched.push(f.name); continue; }
    $("#moveMsg").textContent = `Uploading ${done + 1} of ${files.length}: ${f.name}`;
    try { await attachFile(doc, f); doc._done = true; done++; } catch (e) { unmatched.push(f.name + " (" + uploadError(e) + ")"); }
  }
  $("#moveMsg").textContent = `Added ${done} file${done === 1 ? "" : "s"}.` + (unmatched.length ? ` Not matched: ${unmatched.join(", ")}. Use Add file next to the document instead.` : "");
  $("#moveFiles").value = "";
  st.lib = await api("library"); renderLibrary(); loadDashboard();
}));
$("#libForm").addEventListener("submit", async e => {
  e.preventDefault();
  const file = $("#libFile").files[0]; if (!file) return;
  const btn = $("#libSave"); btn.disabled = true; $("#libMsg").textContent = "Uploading…";
  try {
    const up = await uploadFile(file, "library", true);
    await api("save_library_doc", {
      category: $("#libCat").value, title: $("#libTitle").value.trim(), storage_path: up.path, file_name: file.name, content_type: file.type || "application/pdf", size_bytes: up.size,
      issued_on: $("#libIssued").value, expires_on: $("#libExpires").value, notes: $("#libNotes").value.trim(),
      client: $("#libClient").value.trim(), project_value: $("#libValue").value, completed_on: $("#libCompleted").value, cidb_class: $("#libClass").value,
      person_id: PERSON_CATS.includes($("#libCat").value) ? $("#libPerson").value : ""
    });
    ["#libTitle", "#libIssued", "#libExpires", "#libNotes", "#libClient", "#libValue", "#libCompleted", "#libFile"].forEach(s => $(s).value = "");
    $("#libMsg").textContent = "Saved to the library.";
    st.lib = await api("library"); renderLibrary(); loadDashboard();
  } catch (err) { $("#libMsg").textContent = uploadError(err); }
  btn.disabled = false;
});

/* ---------- people ---------- */
const lines = (arr, f) => (arr || []).map(f).join("\n");
const parseLines = (text, keys) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
  const parts = l.split("|").map(x => x.trim()); const o = {};
  keys.forEach((k, i) => { if (parts[i]) o[k] = parts[i]; });
  return o;
});
function regState(r) {
  const today = new Date(new Date().toDateString());
  if (r.valid_to) {
    const d = new Date(r.valid_to);
    if (d < today) return ["bad", "Validation expired " + fmtDate(r.valid_to)];
    if ((d - today) / 864e5 < 60) return ["warn", "Renew by " + fmtDate(r.valid_to)];
    return ["ok", "Valid to " + fmtDate(r.valid_to)];
  }
  return ["ok", r.valid_from ? "Registered " + fmtDate(r.valid_from) : "Registered"];
}
async function loadPeople() {
  await ensureCats();
  st.people = await api("personnel") || [];
  renderPeople();
}
function renderPeople() {
  const L = $("#peopleList");
  if (!st.people.length) { L.innerHTML = '<div class="empty">No people yet. Add your contracts manager, site agent, engineers and health and safety officer.</div>'; return; }
  const year = new Date().getFullYear();
  L.innerHTML = st.people.map(p => {
    const yrs = p.career_start_year ? year - p.career_start_year : null;
    const docs = p.docs || [];
    const hasQual = docs.some(d => d.category === "qualification");
    return `<article class="person" data-person="${esc(p.id)}">
      <header><div style="min-width:0"><h3>${esc(p.full_name)}</h3><div class="pos">${esc(p.current_position || "")}${p.known_as && p.known_as !== p.full_name ? ` · known as ${esc(p.known_as)}` : ""}</div></div>
        ${yrs != null ? `<div class="yrs">${yrs}<small>years</small></div>` : ""}</header>
      <div class="chips">${(p.roles || []).map(r => `<span class="chip info">${esc(r)}</span>`).join("")}${p.has_id ? '<span class="chip">ID on file</span>' : '<span class="chip warn">No ID number on file</span>'}</div>
      ${(p.qualifications || []).length ? `<div><h4>Qualifications</h4><ul class="plain">${p.qualifications.map(q => `<li>${esc(q.name)}${q.institution ? ` <span class="muted">· ${esc(q.institution)}</span>` : ""}${q.year ? ` <span class="muted">· ${esc(q.year)}</span>` : ""}</li>`).join("")}</ul></div>` : ""}
      <div><h4>Registration</h4>${(p.registrations || []).length ? `<ul class="plain">${p.registrations.map(r => { const [c, t] = regState(r); return `<li>${esc(r.body || "")} ${esc(r.category || "")}${r.number ? ` <span class="mono">${esc(r.number)}</span>` : ""} <span class="chip ${c}">${esc(t)}</span></li>`; }).join("")}</ul>` : '<span class="muted">None on record</span>'}</div>
      <div><h4>Projects on record</h4><span class="muted">${(p.projects || []).length} project${(p.projects || []).length === 1 ? "" : "s"}${(p.employment || []).length ? ` · ${p.employment.length} employer${p.employment.length === 1 ? "" : "s"}` : ""}</span></div>
      <div><h4>Documents</h4>${docs.length ? `<ul class="plain">${docs.map(d => `<li>${fileLink(d)} <span class="muted">· ${esc(catLabel(d.category))}</span>${d.expires_on ? ` <span class="chip ${new Date(d.expires_on) < new Date() ? "bad" : "ok"}">to ${esc(fmtDate(d.expires_on))}</span>` : ""}</li>`).join("")}</ul>` : ""}
        ${!hasQual ? '<span class="chip bad">No certified qualifications uploaded</span>' : ""}</div>
      ${p.notes ? `<div class="muted">${esc(p.notes)}</div>` : ""}
      <div class="actions" style="margin:0"><button class="btn small" type="button" data-pup="${esc(p.id)}">Upload a document</button><button class="btn ghost small" type="button" data-pedit="${esc(p.id)}">Edit details</button><button class="linkbtn" type="button" data-parch="${esc(p.id)}">Retire</button></div>
    </article>`;
  }).join("");
  wireOpen(L);
  $$("[data-pedit]", L).forEach(b => b.onclick = () => editPerson(st.people.find(p => p.id === b.dataset.pedit)));
  $$("[data-pup]", L).forEach(b => b.onclick = () => personUpload(st.people.find(p => p.id === b.dataset.pup), b));
  $$("[data-parch]", L).forEach(b => b.onclick = () => {
    const span = document.createElement("span"); span.className = "confirm";
    span.innerHTML = 'Retire this person? <button class="btn small danger" type="button">Retire</button><button class="btn ghost small" type="button">Keep</button>';
    b.replaceWith(span); const [yes, no] = span.querySelectorAll("button");
    no.onclick = () => span.replaceWith(b);
    yes.onclick = () => safe(async () => { await api("archive_person", { id: b.dataset.parch }); await loadPeople(); loadDashboard(); toast("Retired"); });
  });
}
function personUpload(p, btn) {
  const card = btn.closest(".person");
  const old = $("form", card); if (old) { old.remove(); return; }
  const f = document.createElement("form");
  f.className = "grid2";
  f.style.cssText = "background:var(--wash);border-radius:var(--r);padding:10px";
  f.innerHTML = `<label class="field"><span>Document</span><select name="cat">${PERSON_CATS.map(c => `<option value="${c}">${esc(catLabel(c))}</option>`).join("")}</select></label>
    <label class="field"><span>Title</span><input type="text" name="ttl" required placeholder="e.g. Certified BTech certificate, Aug 2026"></label>
    <label class="field"><span>PDF or image</span><input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required></label>
    <label class="field"><span>Certified or issued on</span><input type="date" name="issued"></label>
    <label class="field"><span>Expires on</span><input type="date" name="expires"></label>
    <div class="field"><span>&nbsp;</span><button class="btn small" type="submit">Save</button></div>`;
  card.appendChild(f);
  f.onsubmit = async e => {
    e.preventDefault();
    const el = f.elements, file = el.file.files[0]; if (!file) return;
    const btnS = $("button[type=submit]", f); btnS.disabled = true; btnS.textContent = "Uploading…";
    try {
      const up = await uploadFile(file, "people", true);
      await api("save_library_doc", { category: el.cat.value, title: el.ttl.value.trim(), storage_path: up.path, file_name: file.name, content_type: file.type || "application/pdf",
        size_bytes: up.size, issued_on: el.issued.value, expires_on: el.expires.value, person_id: p.id });
      st.libLoaded = false; toast("Saved"); await loadPeople(); loadDashboard();
    } catch (err) { toast(uploadError(err)); btnS.disabled = false; btnS.textContent = "Save"; }
  };
}
function editPerson(p) {
  const F = $("#personForm");
  const v = p || {};
  F.innerHTML = `<h3>${p ? "Edit " + esc(p.full_name) : "Add a person"}</h3>
    <div class="grid3">
      <label class="field"><span>Full name</span><input type="text" id="pnName" required value="${esc(v.full_name || "")}"></label>
      <label class="field"><span>Known as</span><input type="text" id="pnKnown" value="${esc(v.known_as || "")}"></label>
      <label class="field"><span>Current position</span><input type="text" id="pnPos" value="${esc(v.current_position || "")}"></label>
      <label class="field" style="grid-column: span 2"><span>Positions they can fill (comma separated)</span><input type="text" id="pnRoles" value="${esc((v.roles || []).join(", "))}" placeholder="Contracts Manager, Site Agent"></label>
      <label class="field"><span>Working since (year)</span><input type="number" id="pnStart" min="1960" max="2100" value="${esc(v.career_start_year || "")}"></label>
      <label class="field"><span>Phone</span><input type="text" id="pnPhone" value="${esc(v.phone || "")}"></label>
      <label class="field"><span>Email</span><input type="email" id="pnEmail" value="${esc(v.email || "")}"></label>
      <label class="field"><span>Languages</span><input type="text" id="pnLang" value="${esc(v.languages || "")}"></label>
    </div>
    <div class="grid2" style="margin-top:10px">
      <label class="field"><span>Qualifications: name | institution | year</span><textarea id="pnQual" rows="3">${esc(lines(v.qualifications, q => [q.name, q.institution, q.year].filter(x => x != null).join(" | ")))}</textarea></label>
      <label class="field"><span>Registrations: body | category | number | registered on | valid to</span><textarea id="pnReg" rows="3">${esc(lines(v.registrations, r => [r.body, r.category, r.number, r.valid_from || "", r.valid_to || ""].join(" | ")))}</textarea></label>
      <label class="field"><span>Employment: employer | position | from | to</span><textarea id="pnEmp" rows="3">${esc(lines(v.employment, e => [e.employer, e.position, e.from, e.to].join(" | ")))}</textarea></label>
      <label class="field"><span>Projects: project | client | value (R) | role | from | to | CE or ME</span><textarea id="pnProj" rows="4">${esc(lines(v.projects, x => [x.project, x.client || "", x.value ?? "", x.role || "", x.from || "", x.to || "", x.cidb_class || ""].join(" | ")))}</textarea></label>
      <label class="field"><span>Skills</span><textarea id="pnSkills" rows="2">${esc(v.skills || "")}</textarea></label>
      <label class="field"><span>Notes</span><textarea id="pnNotes" rows="2">${esc(v.notes || "")}</textarea></label>
    </div>
    <div class="actions"><button class="btn" type="submit">Save person</button><button class="btn ghost" type="button" id="pnCancel">Cancel</button><span class="muted" id="pnMsg"></span></div>`;
  F.hidden = false; F.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#pnCancel").onclick = () => { F.hidden = true; };
  F.onsubmit = e => {
    e.preventDefault();
    const projects = parseLines($("#pnProj").value, ["project", "client", "value", "role", "from", "to", "cidb_class"]).map(x => ({ ...x, value: x.value ? Number(String(x.value).replace(/[R\s,]/g, "")) || null : null }));
    const quals = parseLines($("#pnQual").value, ["name", "institution", "year"]).map(q => ({ ...q, year: q.year ? Number(q.year) || q.year : null }));
    const body = { ...(p ? { id: p.id } : {}), full_name: $("#pnName").value.trim(), known_as: $("#pnKnown").value.trim(), current_position: $("#pnPos").value.trim(),
      employed_since: v.employed_since || "", roles: $("#pnRoles").value.split(",").map(x => x.trim()).filter(Boolean), qualifications: quals,
      registrations: parseLines($("#pnReg").value, ["body", "category", "number", "valid_from", "valid_to"]), career_start_year: $("#pnStart").value,
      employment: parseLines($("#pnEmp").value, ["employer", "position", "from", "to"]), projects, skills: $("#pnSkills").value.trim(),
      languages: $("#pnLang").value.trim(), phone: $("#pnPhone").value.trim(), email: $("#pnEmail").value.trim(), notes: $("#pnNotes").value.trim() };
    $("#pnMsg").textContent = "Saving…";
    safe(async () => { await api("save_person", body); F.hidden = true; await loadPeople(); loadDashboard(); toast("Saved"); });
  };
}
$("#addPerson").onclick = () => editPerson(null);

/* ---------- costs ---------- */
const MARKET_RE = /estimate|market|indicative|price list|rate card|midpoint|wageindicator/i;
function spark(hist) {
  const h = (hist || []).map(x => Number(x.value)).filter(x => !isNaN(x));
  if (h.length < 2) return '<span class="muted">–</span>';
  const W = 110, H = 26, min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
  const pts = h.map((v, i) => [2 + i * (W - 4) / (h.length - 1), H - 3 - (v - min) / span * (H - 6)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend from ${min} to ${max}"><path class="a" d="${d} L${last[0].toFixed(1)} ${H} L2 ${H} Z"></path><path class="l" d="${d}"></path><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.4"></circle></svg>`;
}
async function loadCosts() {
  st.cost = await api("cost_overview");
  renderCosts();
}
function renderCosts() {
  const c = st.cost || { indices: [], resources: [], buildups: [] };
  const opts = c.indices.map(i => `<option value="${esc(i.key)}">${esc(i.key)}: ${esc(i.label)}</option>`).join("");
  ["#idxKey"].forEach(s => { $(s).innerHTML = opts; });
  ["#resIndex", "#rateIndex"].forEach(s => { const cur = $(s).value; $(s).innerHTML = '<option value="">No escalation</option>' + opts; $(s).value = cur; });
  { const cur = $("#rateBu").value; $("#rateBu").innerHTML = '<option value="">None</option>' + c.buildups.map(b => `<option value="${esc(b.code)}">${esc(b.code)}: ${esc(b.description)}</option>`).join(""); $("#rateBu").value = cur; }
  $("#idxRows").innerHTML = c.indices.map(i => `<tr><td><b class="mono">${esc(i.key)}</b><br><span class="muted">${esc(i.label)}</span></td>
      <td>${i.latest ? esc(String(i.latest.period).slice(0, 7)) : '<span class="chip warn">No value yet</span>'}</td>
      <td class="num">${i.latest ? Number(i.latest.value).toLocaleString("en-ZA") : "–"}<br><span class="muted">${esc(i.unit || "")}</span></td>
      <td>${spark(i.history)}</td><td class="muted">${i.latest ? esc(i.latest.source || "") : esc(i.how || "")}</td></tr>`).join("");
  $("#resRows").innerHTML = c.resources.length ? c.resources.map(r => {
    const ch = r.base_rate ? (Number(r.current_rate) / Number(r.base_rate) - 1) : 0;
    const market = MARKET_RE.test((r.source || "") + " " + (r.notes || ""));
    return `<tr class="clickable" data-res="${esc(r.id)}"><td class="mono">${esc(r.code)}</td><td>${esc(r.description)}${market ? ' <span class="chip warn">Market estimate</span>' : ""}<br><span class="muted">${esc(r.type)}</span></td>
      <td>${esc(r.unit)}</td><td class="num">${rand(r.base_rate)}</td><td>${esc(fmtDate(r.base_date))}</td><td class="mono">${esc(r.index_key || "–")}</td>
      <td class="num"><b>${rand(r.current_rate)}</b></td><td class="num"><span class="delta ${ch > 0.0005 ? "up" : ch < -0.0005 ? "down" : ""}">${ch ? (ch > 0 ? "+" : "") + (ch * 100).toFixed(1) + "%" : "0.0%"}</span></td>
      <td class="muted">${esc(r.source || "")}</td><td><button class="linkbtn" type="button" data-resarch="${esc(r.id)}">Retire</button></td></tr>`;
  }).join("") : '<tr><td colspan="10" class="muted">No resources yet.</td></tr>';
  $$("tr[data-res]").forEach(tr => tr.onclick = e => { if (e.target.closest("[data-resarch]")) return; editResource(c.resources.find(r => r.id === tr.dataset.res)); });
  $$("[data-resarch]").forEach(b => b.onclick = () => safe(async () => { await api("archive_resource", { id: b.dataset.resarch }); await loadCosts(); toast("Resource retired"); }));
  $("#buRows").innerHTML = c.buildups.length ? c.buildups.map(b => `<tr class="clickable" data-bu="${esc(b.code)}"><td class="mono">${esc(b.code)}</td><td>${esc(b.description)}${b.missing_resources ? ' <span class="chip bad">Unknown resource code</span>' : ""}</td><td>${esc(b.unit)}</td>
      <td class="muted">${(b.components || []).map(x => `${esc(x.resource)} × ${esc(x.qty)}${x.waste_pct ? ` +${Math.round(x.waste_pct * 100)}%` : ""}`).join(", ")}</td>
      <td class="num">${Math.round(Number(b.ohp_pct || 0) * 100)}%</td><td class="num"><b>${rand(b.rate)}</b></td></tr>`).join("") : '<tr><td colspan="6" class="muted">No build-ups yet.</td></tr>';
  $$("tr[data-bu]").forEach(tr => tr.onclick = () => editBuildup(c.buildups.find(b => b.code === tr.dataset.bu)));
}
function editResource(r) {
  $("#resId").value = r ? r.id : ""; $("#resCode").value = r?.code || ""; $("#resType").value = r?.type || "material"; $("#resUnit").value = r?.unit || "";
  $("#resDesc").value = r?.description || ""; $("#resRate").value = r?.base_rate ?? ""; $("#resDate").value = r?.base_date || ""; $("#resIndex").value = r?.index_key || "";
  $("#resSupplier").value = r?.supplier || ""; $("#resSource").value = r?.source || ""; $("#resNotes").value = r?.notes || "";
  $("#resSave").textContent = r ? "Save changes" : "Save resource";
  if (r) $("#resForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
function editBuildup(b) {
  $("#buCode").value = b?.code || ""; $("#buDesc").value = b?.description || ""; $("#buUnit").value = b?.unit || "";
  $("#buComps").value = lines(b?.components, x => [x.resource, x.qty, x.waste_pct ? Math.round(x.waste_pct * 1000) / 10 : ""].filter(v => v !== "").join(" | "));
  $("#buOhp").value = b ? Math.round(Number(b.ohp_pct || 0) * 1000) / 10 : 15;
  if (b) $("#buForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
$("#resClear").onclick = () => editResource(null);
$("#buClear").onclick = () => editBuildup(null);
$("#idxForm").addEventListener("submit", e => {
  e.preventDefault();
  safe(async () => {
    await api("save_index", { key: $("#idxKey").value, period: $("#idxPeriod").value + "-01", value: $("#idxValue").value, source: $("#idxSource").value.trim() || "Entered on the Tender Desk" });
    $("#idxValue").value = ""; toast("Index saved. Rates updated."); await loadCosts(); await loadRates();
  });
});
$("#resForm").addEventListener("submit", e => {
  e.preventDefault();
  const p = { code: $("#resCode").value.trim(), type: $("#resType").value, description: $("#resDesc").value.trim(), unit: $("#resUnit").value.trim(), base_rate: $("#resRate").value,
    base_date: $("#resDate").value, index_key: $("#resIndex").value, supplier: $("#resSupplier").value.trim(), source: $("#resSource").value.trim(), notes: $("#resNotes").value.trim() };
  if ($("#resId").value) p.id = $("#resId").value;
  $("#resMsg").textContent = "Saving…";
  safe(async () => { await api("save_resource", p); $("#resMsg").textContent = "Saved."; editResource(null); await loadCosts(); await loadRates(); loadDashboard(); });
});
$("#buForm").addEventListener("submit", e => {
  e.preventDefault();
  const comps = parseLines($("#buComps").value, ["resource", "qty", "waste"]).map(x => ({ resource: x.resource, qty: Number(x.qty) || 0, ...(x.waste ? { waste_pct: Number(x.waste) / 100 } : {}) })).filter(x => x.resource);
  if (!comps.length) { $("#buMsg").textContent = "Add at least one resource line."; return; }
  const body = { code: $("#buCode").value.trim(), description: $("#buDesc").value.trim(), unit: $("#buUnit").value.trim(), components: comps, ohp_pct: Number($("#buOhp").value || 0) / 100 };
  $("#buMsg").textContent = "Saving…";
  safe(async () => {
    await api("save_buildup", body);
    if ($("#buToRates").checked && !(st.rates || []).some(r => r.buildup_code === body.code)) {
      await api("save_rate", { code: body.code, description: body.description, unit: body.unit, category: "Build-up", source: "Build-up " + body.code, buildup_code: body.code });
    }
    $("#buMsg").textContent = "Saved."; editBuildup(null); await loadCosts(); await loadRates(); loadDashboard();
  });
});

/* ---------- profile ---------- */
async function loadProfile() {
  const rows = await api("profile"); st.profLoaded = true;
  const sections = [...new Set(rows.map(r => r.section))];
  const multi = new Set(["directors", "key_staff", "plant_summary", "physical_address", "postal_address"]);
  $("#profFields").innerHTML = sections.map(s => `<div class="profile-section formcard"><h3>${esc(s)}</h3><div class="grid2">${rows.filter(r => r.section === s).map(r => `
    <label class="field" ${multi.has(r.key) ? 'style="grid-column:1/-1"' : ""}><span>${esc(r.label)}</span>
      ${multi.has(r.key) ? `<textarea id="pf-${esc(r.key)}" data-key="${esc(r.key)}" rows="3">${esc(r.value || "")}</textarea>` : `<input type="text" id="pf-${esc(r.key)}" data-key="${esc(r.key)}" value="${esc(r.value || "")}">`}
      ${r.help ? `<small class="muted">${esc(r.help)}</small>` : ""}</label>`).join("")}</div></div>`).join("");
}
$("#profForm").addEventListener("submit", e => {
  e.preventDefault();
  const values = {}; $$("#profFields [data-key]").forEach(i => values[i.dataset.key] = i.value.trim());
  $("#profMsg").textContent = "Saving…";
  safe(async () => { await api("save_profile", { values }); $("#profMsg").textContent = "Saved."; loadDashboard(); });
});

/* ---------- rates ---------- */
async function loadRates() {
  st.rates = await api("rates", st.rateQ ? { q: st.rateQ } : {}); st.ratesLoaded = true; renderRates();
}
function renderRates() {
  const tb = $("#rateRows");
  if (!st.rates.length) { tb.innerHTML = `<tr><td colspan="8" class="muted">No rates yet. Add them above, paste a block from Excel, build one from resources, or load the rates from a BoQ you have already priced.</td></tr>`; return; }
  const BASIS = { "build-up": ["info", "Build-up"], escalated: ["ok", "Escalated"], "as entered": ["", "Fixed"] };
  tb.innerHTML = st.rates.map(r => { const today = r.current_rate ?? r.rate; const [bc, bl] = BASIS[r.rate_basis] || ["", "Fixed"];
    return `<tr class="clickable" data-rate="${esc(r.id)}"><td class="mono">${esc(r.code || "")}</td><td>${esc(r.description)}</td><td>${esc(r.unit || "")}</td><td class="num"><b>${today == null ? "–" : Number(today).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b></td><td><span class="chip ${bc}">${esc(bl)}${r.buildup_code ? " " + esc(r.buildup_code) : r.index_key ? " · " + esc(r.index_key) : ""}</span></td><td>${esc(r.category || "")}</td><td class="muted">${esc(r.source || "")}</td><td><button class="linkbtn" type="button" data-rarch="${esc(r.id)}">Retire</button></td></tr>`; }).join("");
  $$("tr[data-rate]").forEach(tr => tr.onclick = e => { if (e.target.closest("[data-rarch]")) return; editRate(st.rates.find(r => r.id === tr.dataset.rate)); });
  $$("[data-rarch]").forEach(b => b.onclick = () => safe(async () => { await api("archive_rate", { id: b.dataset.rarch }); await loadRates(); toast("Rate retired"); }));
}
function editRate(r) {
  $("#rateFormTitle").textContent = r ? "Edit rate" : "Add a rate";
  $("#rateId").value = r ? r.id : "";
  $("#rateCode").value = r?.code || ""; $("#rateDesc").value = r?.description || ""; $("#rateUnit").value = r?.unit || "";
  $("#rateRate").value = r?.rate ?? ""; $("#rateCat").value = r?.category || ""; $("#rateSrc").value = r?.source || "";
  $("#rateFrom").value = r?.valid_from || ""; $("#rateNotes").value = r?.notes || "";
  $("#rateIndex").value = r?.index_key || ""; $("#rateBu").value = r?.buildup_code || "";
  if (r) $("#rateForm").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#rateReset").onclick = () => editRate(null);
$("#rateForm").addEventListener("submit", e => {
  e.preventDefault();
  const p = { code: $("#rateCode").value.trim(), description: $("#rateDesc").value.trim(), unit: $("#rateUnit").value.trim(), rate: $("#rateRate").value, category: $("#rateCat").value.trim(), source: $("#rateSrc").value.trim(), valid_from: $("#rateFrom").value, notes: $("#rateNotes").value.trim(), index_key: $("#rateIndex").value, buildup_code: $("#rateBu").value };
  if ($("#rateId").value) p.id = $("#rateId").value;
  safe(async () => { await api("save_rate", p); $("#rateMsg").textContent = "Saved."; editRate(null); await loadRates(); loadDashboard(); });
});
$("#rateImportBtn").onclick = () => safe(async () => {
  const lines = $("#rateImport").value.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = lines.map(l => { const c = l.includes("\t") ? l.split("\t") : l.split(/[,;]/); const [code, description, unit, rate, category] = c.map(x => (x || "").trim()); return { code, description, unit, rate: (rate || "").replace(/[R\s]/g, "").replace(",", "."), category, source: "Imported" }; }).filter(r => r.description);
  if (!rows.length) { $("#rateImportMsg").textContent = "No rows found. Paste code, description, unit, rate, category."; return; }
  $("#rateImportMsg").textContent = `Importing ${rows.length} rows…`;
  await api("import_rates", { rows });
  $("#rateImportMsg").textContent = `Imported ${rows.length} rates.`; $("#rateImport").value = "";
  await loadRates(); loadDashboard();
});
let rqTimer; $("#rateQ").addEventListener("input", e => { clearTimeout(rqTimer); rqTimer = setTimeout(() => { st.rateQ = e.target.value.trim(); safe(loadRates); }, 350); });

/* ---------- scanner ---------- */
for (let g = 1; g <= 9; g++) { $("#mMin").add(new Option("Grade " + g, g)); $("#mMax").add(new Option("Grade " + g, g)); }
async function loadScanner() {
  await safe(async () => {
    const [settings, runs] = await Promise.all([api("settings"), api("scan_runs")]);
    const m = settings.match || {};
    $("#mCE").checked = (m.classes || []).includes("CE"); $("#mME").checked = (m.classes || []).includes("ME");
    $("#mMin").value = m.grade_min || 1; $("#mMax").value = m.grade_max || 8; st.matchSettings = m;
    $("#runRows").innerHTML = (runs || []).map(r => `<tr><td>${esc(fmtDate(r.started_at, true))}</td><td class="num">${r.fetched ?? "–"}</td><td class="num">${r.inserted ?? "–"}</td><td class="num">${r.changed ?? "–"}</td><td class="num">${r.matched_new ?? "–"}</td><td class="num">${r.to_screen_new ?? "–"}</td><td>${r.error ? `<span class="chip bad">${esc(r.error.slice(0, 90))}</span>` : r.finished_at ? '<span class="chip ok">Done</span>' : '<span class="chip">Running</span>'}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No scans yet.</td></tr>';
  });
}
$("#matchForm").addEventListener("submit", e => {
  e.preventDefault();
  const classes = [$("#mCE"), $("#mME")].filter(c => c.checked).map(c => c.value);
  if (!classes.length) { $("#matchMsg").textContent = "Pick at least one class."; return; }
  const value = { ...(st.matchSettings || {}), classes, grade_min: Number($("#mMin").value), grade_max: Number($("#mMax").value) };
  $("#matchMsg").textContent = "Re-sorting adverts…";
  safe(async () => { await api("save_match_settings", { value }); $("#matchMsg").textContent = "Saved. Lists updated."; loadDashboard(); loadTenders(); });
});

/* ---------- boot ---------- */
async function safe(fn_) {
  try { return await fn_(); }
  catch (e) {
    console.error(e);
    const m = (e && (e.message || "")) || "";
    if (/JWT|not authenticated|refresh token/i.test(m)) { await sb.auth.signOut(); showLogin("Your sign-in has expired. Sign in again."); return; }
    toast(errorCopy(e).replace(/<[^>]+>/g, ""));
  }
}
document.addEventListener("click", e => { const g = e.target.closest("[data-go]"); if (g) showTab(g.dataset.go); });
$("#refreshBtn").onclick = () => safe(async () => { await loadDashboard(); await loadTenders(); if (!$("#tab-library").hidden) loadLibrary(); if (!$("#tab-scanner").hidden) loadScanner(); });

/* ---------- team (administrators) ---------- */
async function loadTeam() {
  const rows = await api("team");
  $("#teamRows").innerHTML = (rows || []).map(r => `<tr><td>${esc(r.full_name || "")}${r.user_id === (me && me.user_id) ? ' <span class="chip">you</span>' : ""}</td><td class="mono">${esc(r.email)}</td>
    <td>${r.role === "admin" ? "Administrator" : "Member"}${r.active ? "" : ' <span class="chip bad">No access</span>'}${r.must_change_password && r.active ? ' <span class="chip warn">Has not chosen a password</span>' : ""}</td>
    <td>${r.last_seen ? esc(fmtDate(r.last_seen, true)) : '<span class="muted">Never</span>'}</td>
    <td><span class="filebtns"><button class="btn ghost small" type="button" data-reset="${esc(r.user_id)}">New password</button>
      <button class="btn ghost small" type="button" data-role="${esc(r.user_id)}" data-to="${r.role === "admin" ? "member" : "admin"}">${r.role === "admin" ? "Make member" : "Make administrator"}</button>
      <button class="btn ghost small" type="button" data-active="${esc(r.user_id)}" data-to="${r.active ? "0" : "1"}">${r.active ? "Remove access" : "Restore access"}</button></span></td></tr>`).join("");
  $$("[data-reset]").forEach(b => b.onclick = () => safe(async () => { const r = await fn("team_reset", { user_id: b.dataset.reset }); showSecret(r.email, r.temp_password); await loadTeam(); }));
  $$("[data-role]").forEach(b => b.onclick = () => safe(async () => { await fn("team_set", { user_id: b.dataset.role, role: b.dataset.to }); toast("Access changed"); await loadTeam(); }));
  $$("[data-active]").forEach(b => b.onclick = () => safe(async () => { await fn("team_set", { user_id: b.dataset.active, active: b.dataset.to === "1" }); toast(b.dataset.to === "1" ? "Access restored" : "Access removed"); await loadTeam(); }));
}
function showSecret(email, pw) {
  $("#secretFor").textContent = `Temporary password for ${email}:`;
  $("#secretValue").textContent = pw;
  $("#secretCopy").onclick = async () => { try { await navigator.clipboard.writeText(pw); toast("Copied"); } catch (_) { toast("Select the password and copy it."); } };
  $("#secretDialog").showModal();
}
$("#teamForm").addEventListener("submit", e => {
  e.preventDefault();
  $("#tmMsg").textContent = "Adding…";
  safe(async () => {
    const r = await fn("team_add", { email: $("#tmEmail").value.trim(), full_name: $("#tmName").value.trim(), role: $("#tmRole").value });
    $("#tmMsg").textContent = ""; $("#tmEmail").value = ""; $("#tmName").value = "";
    showSecret(r.email, r.temp_password); await loadTeam();
  }).finally(() => { if ($("#tmMsg").textContent === "Adding…") $("#tmMsg").textContent = ""; });
});

/* ---------- activity (administrators) ---------- */
const AREA = {
  bids: ["info", "Bid"], uploads: ["warn", "Uploads"], library: ["ok", "Library"], people: ["ok", "People"], company: ["", "Company"],
  costs: ["", "Costs"], scanner: ["", "Scanner"], team: ["bad", "Team"], auto: ["info", "Tender Desk"], view: ["", "Opened"], signin: ["", "Signed in"]
};
const act = { days: 7, user: "", area: "changes", q: "", offset: 0, rows: [], total: 0, people: [], timer: null };
function agoText(d) {
  if (!d) return "Never signed in";
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  if (m < 2) return "Active now";
  if (m < 60) return `Active ${m} minutes ago`;
  if (fmtDay(d) === fmtDay(new Date())) return "Last active today at " + fmtTime(d);
  return "Last active " + fmtDate(d, true);
}
function actFilters(extra = {}) {
  return { days: act.days, user_id: act.user, area: act.area === "all" ? "" : act.area, q: act.q, ...extra };
}
async function loadActivity(append) {
  if (!append) act.offset = 0;
  const [people, feed] = await Promise.all([append ? Promise.resolve(act.people) : api("activity_people", { days: act.days }),
    api("activity", actFilters({ limit: 100, offset: act.offset }))]);
  act.people = people || [];
  act.total = feed.total || 0;
  act.rows = append ? act.rows.concat(feed.rows || []) : (feed.rows || []);
  renderActivity();
}
function renderActivity() {
  const sel = $("#actUser");
  const cur = act.user;
  sel.innerHTML = `<option value="">Everyone</option>${act.people.map(p => `<option value="${esc(p.user_id)}">${esc(p.full_name || p.email)}</option>`).join("")}<option value="auto">Tender Desk (automatic preparation and builder)</option>`;
  sel.value = cur;
  const period = { 1: "today", 7: "in the last 7 days", 30: "in the last 30 days", 90: "in the last 90 days" }[act.days] || `in the last ${act.days} days`;
  $("#actPeople").innerHTML = act.people.map(p => {
    const now = p.active_now;
    return `<button class="pcard ${act.user === p.user_id ? "on" : ""}" type="button" data-actuser="${esc(p.user_id)}">
      <header><span class="dot ${now ? "live" : ""}" aria-hidden="true"></span><b>${esc(p.full_name || p.email)}</b>${p.role === "admin" ? '<span class="chip">Administrator</span>' : ""}${p.active ? "" : '<span class="chip bad">No access</span>'}</header>
      <div class="seen ${now ? "live" : ""}">${esc(agoText(p.last_seen))}</div>
      <dl class="nums">
        <div><dt>Changes today</dt><dd>${p.actions_today}</dd></div>
        <div><dt>Changes ${esc(period.replace("in the ", ""))}</dt><dd>${p.actions}</dd></div>
        <div><dt>Bids worked on</dt><dd>${p.bids}</dd></div>
        <div><dt>Bids opened</dt><dd>${p.views}</dd></div>
      </dl>
      <div class="last">${p.last_action ? `Last change: ${esc(p.last_action.detail)} <span class="muted">· ${esc(fmtDate(p.last_action.at, true))}</span>` : '<span class="muted">No changes yet</span>'}</div>
    </button>`;
  }).join("") || '<div class="empty">No one on the team yet.</div>';
  $$("[data-actuser]").forEach(b => b.onclick = () => { act.user = act.user === b.dataset.actuser ? "" : b.dataset.actuser; safe(() => loadActivity()); });

  const F = $("#actFeed");
  $("#actCount").textContent = act.total ? `${act.total.toLocaleString("en-ZA")} entr${act.total === 1 ? "y" : "ies"} ${period}` : "";
  if (!act.rows.length) { F.innerHTML = `<div class="empty">Nothing recorded ${esc(period)} for these filters.</div>`; $("#actMore").hidden = true; return; }
  let lastDay = "";
  const today = fmtDay(new Date()), yest = fmtDay(new Date(Date.now() - 864e5));
  F.innerHTML = `<div class="tablewrap"><table class="acttable"><thead><tr><th>Time</th><th>Who</th><th>What</th><th>Bid</th></tr></thead><tbody>${act.rows.map(r => {
    const day = fmtDay(r.at);
    const head = day !== lastDay ? `<tr class="dayrow"><td colspan="4">${esc(day === today ? "Today" : day === yest ? "Yesterday" : day)}</td></tr>` : "";
    lastDay = day;
    const [cls, label] = AREA[r.area] || ["", r.area];
    return `${head}<tr><td class="mono">${esc(fmtTime(r.at))}</td><td>${esc(r.full_name || r.email || "Tender Desk")}</td>
      <td><span class="chip ${cls}">${esc(label)}</span> ${esc(r.detail || "")}</td>
      <td>${r.tender_id ? `<button class="linkbtn" type="button" data-actbid="${esc(r.tender_id)}">${esc(r.tender_no || r.tender_id)}</button><br><span class="muted">${esc(r.tender_desc || "")}</span>` : ""}</td></tr>`;
  }).join("")}</tbody></table></div>`;
  $$("[data-actbid]", F).forEach(b => b.onclick = () => openTender(b.dataset.actbid));
  $("#actMore").hidden = act.rows.length >= act.total;
}
$("#actDays").addEventListener("change", e => { act.days = Number(e.target.value); safe(() => loadActivity()); });
$("#actUser").addEventListener("change", e => { act.user = e.target.value; safe(() => loadActivity()); });
$("#actArea").addEventListener("change", e => { act.area = e.target.value; safe(() => loadActivity()); });
let actQTimer;
$("#actQ").addEventListener("input", e => { clearTimeout(actQTimer); actQTimer = setTimeout(() => { act.q = e.target.value.trim(); safe(() => loadActivity()); }, 400); });
$("#actMore").addEventListener("click", () => { act.offset = act.rows.length; safe(() => loadActivity(true)); });
$("#actExport").addEventListener("click", () => safe(async () => {
  const feed = await api("activity", actFilters({ limit: 2000, offset: 0 }));
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fmtFull = d => new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
  const lines = [["Date and time (SAST)", "Person", "Email", "Type", "What", "Tender no", "Bid"].map(q).join(",")]
    .concat((feed.rows || []).map(r => [fmtFull(r.at), r.full_name || "Tender Desk", r.email || "", (AREA[r.area] || ["", r.area])[1], r.detail || "", r.tender_no || "", r.tender_desc || ""].map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `Tender Desk activity ${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Exported ${(feed.rows || []).length} entries`);
}));
function activityTimer(on) {
  clearInterval(act.timer);
  if (on) act.timer = setInterval(() => { if (!$("#tab-activity").hidden && !document.hidden) loadActivity().catch(() => {}); }, 60000);
}

/* ---------- sign-in ---------- */
function showLogin(msg) {
  $("#appView").hidden = true; $("#loginView").hidden = false;
  $("#liErr").textContent = msg || ""; $("#liBtn").disabled = false;
  setTimeout(() => $("#liEmail").focus(), 50);
}
$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("#liBtn").disabled = true; $("#liErr").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: $("#liEmail").value.trim(), password: $("#liPass").value });
  if (error) { $("#liErr").textContent = /invalid/i.test(error.message) ? "That email and password don't match. Check them, or ask an administrator for a new password." : error.message; $("#liBtn").disabled = false; return; }
  $("#liPass").value = "";
  startApp();
});
$("#signOutBtn").onclick = async () => { await sb.auth.signOut(); location.reload(); };
function askPassword(first) {
  $("#pwTitle").textContent = first ? "Choose your password" : "Change your password";
  $("#pwLede").textContent = first ? "You signed in with a temporary password. Choose your own: at least 10 characters." : "At least 10 characters.";
  $("#pwCancel").hidden = !!first;
  $("#pwErr").textContent = ""; $("#pwNew").value = ""; $("#pwAgain").value = "";
  $("#pwDialog").showModal();
}
$("#pwBtn").onclick = () => askPassword(false);
$("#pwCancel").onclick = () => $("#pwDialog").close();
$("#pwDialog").addEventListener("cancel", e => { if ($("#pwCancel").hidden) e.preventDefault(); });
$("#pwForm").addEventListener("submit", async e => {
  e.preventDefault();
  const a = $("#pwNew").value, b = $("#pwAgain").value;
  if (a.length < 10) { $("#pwErr").textContent = "Use at least 10 characters."; return; }
  if (a !== b) { $("#pwErr").textContent = "The two passwords are different."; return; }
  $("#pwSave").disabled = true;
  const { error } = await sb.auth.updateUser({ password: a });
  $("#pwSave").disabled = false;
  if (error) { $("#pwErr").textContent = error.message; return; }
  try { await api("password_changed"); } catch (_) {}
  if (me) me.must_change_password = false;
  $("#pwDialog").close(); toast("Password saved");
});

async function startApp() {
  try { me = await api("me"); }
  catch (e) { await sb.auth.signOut(); showLogin(errorCopy(e).replace(/<[^>]+>/g, "")); return; }
  const { data: u } = await sb.auth.getUser();
  me.user_id = u && u.user ? u.user.id : null;
  $("#loginView").hidden = true; $("#appView").hidden = false;
  $("#whoami").textContent = me.full_name || me.email;
  $("#teamTab").hidden = me.role !== "admin";
  $("#activityTab").hidden = me.role !== "admin";
  if (me.must_change_password) askPassword(true);
  try { const g = localStorage.getItem("pg-maxgrade"); if (g) { st.maxGrade = g; $("#maxGrade").value = g; } } catch (_) {}
  renderWorkChips();
  await safe(async () => {
    await loadDashboard();
    await loadTenders();
    loadWorkCounts();
    let tab = null; try { tab = localStorage.getItem("pg-tab"); } catch (_) {}
    const hash = (location.hash || "").replace("#", "");
    if (["bids", "uploads", "library", "people", "profile", "rates", "scanner", "team", "activity"].includes(hash)) tab = hash;
    if (tab && tab !== "bids" && !(["team", "activity"].includes(tab) && me.role !== "admin")) showTab(tab);
  });
}

(async function boot() {
  if ("serviceWorker" in navigator) { try { navigator.serviceWorker.register("sw.js"); } catch (_) {} }
  const { data } = await sb.auth.getSession();
  if (data && data.session) startApp(); else showLogin();
})();
