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
  ok: ["ok", "On file"], missing: ["bad", "Missing"], expired: ["warn", "Out of date"], to_generate: ["info", "Tender Desk prepares it"],
  in_document: ["", "In the tender document"], manual: ["warn", "Attach by hand"], na: ["", "Not needed"]
};
const ACTIVE = ["interested", "purchase", "purchased", "docs_uploaded", "preparing", "pack_ready"];

let me = null;
const st = {
  status: "matched", q: "", province: "", klass: "", maxGrade: "", sort: "closing",
  flags: new Set(), offset: 0, rows: [], total: 0, dash: null, cats: [], lib: [], current: null, rates: [], settings: {},
  people: [], cost: null, reqs: null
};

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
  if (d.missing_bids) loadMissing().catch(() => {}); else $("#missingPanel").hidden = true;
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
  if (!rows || !rows.length) { P.hidden = true; return; }
  P.className = "missingpanel";
  P.innerHTML = `<h3>Documents to upload</h3>
    <p class="muted" style="margin:0 0 8px;color:var(--ink-2)">These bids need documents the library does not have, or has only in an out-of-date copy. Upload them from the bid's requirements list.</p>
    <ul>${rows.map(r => `<li><b class="mono">${esc(r.tender_no || "")}</b><span>${esc((r.description || "").replace(/\s+/g, " ").slice(0, 80))}</span>
      <span class="muted">closes ${esc(fmtDate(r.closes_at, true))}</span>
      <span class="chips">${(r.items || []).slice(0, 6).map(i => `<span class="chip ${i.status === "expired" ? "warn" : "bad"}">${esc(i.title)}</span>`).join("")}${(r.items || []).length > 6 ? `<span class="chip">+${r.items.length - 6} more</span>` : ""}</span>
      <button class="btn small" type="button" data-openbid="${esc(r.id)}">Open bid</button></li>`).join("")}</ul>`;
  P.hidden = false;
  $$("[data-openbid]", P).forEach(b => b.onclick = () => openTender(b.dataset.openbid));
}

function filtersPayload() {
  const f = {};
  if (st.status === "active") { f.status = "all"; f.bid_status = "active"; }
  else f.status = st.status;
  if (st.q) f.q = st.q;
  if (st.province) f.province = st.province;
  if (st.klass) f.class = st.klass;
  if (st.maxGrade) f.max_grade = Number(st.maxGrade);
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
function rowChips(t) {
  const c = [gradeChips(t)];
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
  $("#resultline").textContent = st.total ? `${st.total.toLocaleString("en-ZA")} ${st.status === "excluded" ? "excluded adverts" : st.status === "to_screen" ? "adverts waiting for a document check" : st.status === "active" ? "bids in progress" : "matching open bids"}` : "";
  if (!st.rows.length) {
    L.innerHTML = `<div class="empty">${st.status === "active" ? "No bids in progress yet. Open a matching bid and set its status to Interested to start one." : "Nothing matches these filters. Clear a filter or search for something else."}</div>`;
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
  if (k === "missing") {
    safe(async () => { await loadMissing(); const P = $("#missingPanel"); if (P.hidden) toast("No bids are missing documents."); else P.scrollIntoView({ behavior: "smooth", block: "start" }); });
    return;
  }
  st.flags.clear(); $$("[data-flag]").forEach(t => t.setAttribute("aria-pressed", "false"));
  st.status = k === "to_screen" ? "to_screen" : k === "active" ? "active" : "matched";
  if (k === "closing") st.flags.add("closing7");
  if (k === "briefing") st.flags.add("briefing");
  if (k === "purchase") st.flags.add("purchase");
  $$("[data-flag]").forEach(t => t.setAttribute("aria-pressed", st.flags.has(t.dataset.flag)));
  $$("#segStatus button").forEach(x => x.setAttribute("aria-pressed", x.dataset.status === st.status));
  safe(() => loadTenders());
}));

/* ---------- tender sheet ---------- */
function closeSheet() { $("#sheet").hidden = true; $("#scrim").hidden = true; st.current = null; }
$("#scrim").addEventListener("click", closeSheet);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

async function openTender(id) {
  const sh = $("#sheet");
  sh.innerHTML = '<div class="loading">Loading tender…</div>'; sh.hidden = false; $("#scrim").hidden = false;
  try {
    const t = await api("tender", { id });
    st.current = t; renderSheet();
  } catch (e) { sh.innerHTML = `<div class="notice bad">${errorCopy(e)}</div><button class="btn ghost" type="button" id="closeSheet">Close</button>`; $("#closeSheet").onclick = closeSheet; }
}

function promptFor(t) {
  return `Prepare the complete bid for ${t.tender_no || "tender"} (eTenders ID ${t.id}) – ${(t.description || "").replace(/\s+/g, " ").trim().slice(0, 140)}, ${t.organ_of_state || ""}, closing ${fmtDate(t.closes_at, true)}.
The tender documents are on the Tender Desk website under this bid. Read them, including the returnables list, the functionality criteria and the pricing instructions.
Propose our best person for each key position and tailor their CV to the requirement. Draft the appointment letters, the resolution, the method statement and the programme, and price the BoQ with the cost model.
Then queue the bid pack build so it appears on the website: the red filling guide for the original tender document, the returnables pack ready to print (cover, index, dividers, CVs, letters and our documents in the tender's order, with the original's pages reserved), the editable Word cover and index, the priced BoQ and cost model, the envelope labels and the checklist. Update the requirements list.`;
}

/* ---------- requirements (per bid) ---------- */
function catLabel(k) { const c = st.cats.find(x => x.key === k); return c ? c.label : k; }
async function ensureCats() {
  if (st.cats.length) return;
  const settings = await api("settings"); st.settings = settings || {}; st.cats = (settings && settings.library_categories) || [];
}
async function loadReqs(t) {
  const box = $("#reqBox"); if (!box) return;
  box.innerHTML = '<div class="loading">Checking the library against this tender…</div>';
  await ensureCats();
  const rows = await api("requirements", { id: t.id });
  if (st.current !== t) return;
  st.reqs = rows || [];
  renderReqs(t);
}
function renderReqs(t) {
  const box = $("#reqBox"); if (!box) return;
  const rows = st.reqs || [];
  const count = k => rows.filter(r => r.status === k).length;
  const need = rows.filter(r => r.status === "missing" || r.status === "expired").length;
  box.innerHTML = `<div class="reqhead"><div class="tally">
      <span class="chip ok">${count("ok")} on file</span>${need ? `<span class="chip bad">${need} to upload</span>` : ""}
      ${count("to_generate") ? `<span class="chip info">${count("to_generate")} Tender Desk prepares</span>` : ""}${count("manual") ? `<span class="chip warn">${count("manual")} by hand</span>` : ""}
      <span class="chip">${count("in_document")} in the tender document</span></div>
      <button class="btn ghost small" type="button" id="reqRecheck">Recheck</button></div>
    ${rows.length ? rows.map(r => {
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
    <p class="muted" style="margin:10px 0 0">Tender Desk replaces this list with the tender's own returnables, functionality and key personnel when it reads the document. Uploads go into the document library, so the next bid has them too.</p>`;
  $("#reqRecheck").onclick = () => safe(async () => { await api("refresh_requirements", { id: t.id }); await loadReqs(t); loadDashboard(); toast("Rechecked against the library"); });
  $$("[data-reqset]", box).forEach(b => b.onclick = () => safe(async () => { await api("set_requirement_status", { id: b.dataset.id, status: b.dataset.reqset }); await loadReqs(t); loadDashboard(); }));
  $$("[data-requp]", box).forEach(b => b.onclick = () => openReqUpload(t, rows.find(r => r.id === b.dataset.requp), b));
  wireOpen(box);
}
function openReqUpload(t, r, btn) {
  const row = btn.closest(".req");
  if ($("form", row)) { $("form", row).remove(); return; }
  const cats = r.categories || [];
  const f = document.createElement("form");
  f.innerHTML = `${cats.length > 1 ? `<label class="field"><span>Type</span><select name="cat">${cats.map(c => `<option value="${esc(c)}">${esc(catLabel(c))}</option>`).join("")}</select></label>` : `<input type="hidden" name="cat" value="${esc(cats[0])}">`}
    <label class="field"><span>Title</span><input type="text" name="title" value="${esc(r.title)}" required></label>
    <label class="field"><span>PDF or image</span><input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp" required></label>
    <label class="field"><span>Issued or certified on</span><input type="date" name="issued"></label>
    <label class="field"><span>Expires on</span><input type="date" name="expires"></label>
    <div class="field"><span>&nbsp;</span><button class="btn small" type="submit">Save to library</button></div>`;
  row.appendChild(f);
  f.onsubmit = async e => {
    e.preventDefault();
    const file = f.elements.file.files[0]; if (!file) return;
    const btnS = $("button[type=submit]", f); btnS.disabled = true; btnS.textContent = "Uploading…";
    try {
      const up = await uploadFile(file, "library", true);
      await api("save_library_doc", { category: f.elements.cat.value, title: f.elements["title"].value.trim(), storage_path: up.path, file_name: file.name,
        content_type: file.type || "application/pdf", size_bytes: up.size, issued_on: f.elements.issued.value, expires_on: f.elements.expires.value, person_id: r.person_id || "" });
      await api("refresh_requirements", { id: t.id });
      st.libLoaded = false; toast("Saved to the library"); await loadReqs(t); loadDashboard();
    } catch (err) { toast(uploadError(err)); btnS.disabled = false; btnS.textContent = "Save to library"; }
  };
}

function renderSheet() {
  const t = st.current; if (!t) return;
  const n = daysLeft(t.closes_at);
  const files = t.files || [];
  const inFiles = files.filter(f => !String(f.kind).startsWith("out_"));
  const outFiles = files.filter(f => String(f.kind).startsWith("out_"));
  const docs = t.documents || [];
  const statusOpts = Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === t.bid_status ? "selected" : ""}>${esc(v)}</option>`).join("");
  const TEXT = { ok: ["ok", "Text read"], ocr: ["ok", "Text read from scan"], queued: ["info", "Reading text…"], empty: ["warn", "No text found"], failed: ["bad", "Could not read"], not_read: ["", ""] };
  const fileRow = f => { const tx = TEXT[f.text_status] || ["", ""]; return `<li><span class="nm"><span class="ext">${esc((f.file_name || "").split(".").pop() || "file")}</span>${esc(f.title)} <span class="muted">· ${esc(FILE_KIND[f.kind] || f.kind)}${f.size_bytes ? " · " + (f.size_bytes > 1048576 ? (f.size_bytes / 1048576).toFixed(1) + " MB" : Math.round(f.size_bytes / 1024) + " KB") : ""}</span>${tx[1] ? ` <span class="chip ${tx[0]}">${esc(tx[1])}</span>` : ""}</span>
      <span class="actions" style="margin:0">${f.storage_path ? fileButtons(f.storage_path, f.file_name || f.title) : (f.asset_url ? '<span class="muted">In the Tender Desk</span>' : '<span class="muted">Sent in the Tender Desk</span>')}
      <button class="linkbtn" type="button" data-rmfile="${esc(f.id)}">Remove</button></span></li>`; };
  const jobs = t.jobs || [];
  const lastBuild = jobs.find(j => j.kind === "build");
  const JOB = { queued: ["info", "Waiting for the builder (usually within 10 minutes)"], running: ["info", "Building now"], done: ["ok", "Ready"], failed: ["bad", "Failed"] };

  $("#sheet").innerHTML = `
    <div class="sheet-head"><div class="tno">${esc(t.tender_no || "")} · eTenders ${esc(t.id)}</div><button class="btn ghost small" type="button" id="closeSheet">Close</button></div>
    <h2>${esc((t.description || "").replace(/\s+/g, " ").trim())}</h2>
    <div class="org">${esc(t.organ_of_state || "")}${t.province ? " · " + esc(t.province) : ""}</div>
    <div class="chips" style="margin-top:8px">${rowChips(t)}</div>

    <dl class="facts">
      <div class="fact"><dt>Closes</dt><dd><b>${esc(fmtDate(t.closes_at, true))}</b> ${n != null ? `<span class="muted">(${n < 0 ? "closed" : n === 0 ? "today" : n + (n === 1 ? " day" : " days") + " left"})</span>` : ""}</dd></div>
      <div class="fact"><dt>CIDB grading</dt><dd>${t.cidb_requirement ? esc(t.cidb_requirement) : "Not stated in the advert"}${t.pe_allowed ? " · PE allowed" : ""}</dd></div>
      <div class="fact"><dt>Briefing</dt><dd>${t.briefing_session ? `${t.briefing_compulsory ? "<b>Compulsory</b> · " : "Optional · "}${esc(fmtDate(t.briefing_at, true))}<br><span class="muted">${esc(t.briefing_venue || "")}</span>` : "No briefing session"}</dd></div>
      <div class="fact"><dt>Type</dt><dd>${esc(t.tender_type || "–")}${t.is_panel ? " · panel / rate-based" : ""}</dd></div>
      <div class="fact"><dt>Category</dt><dd>${esc(t.category || "–")}</dd></div>
      <div class="fact"><dt>Submission</dt><dd>${t.e_submission ? "Electronic submission" : "Hard copy"}${t.two_envelope ? " · two envelopes" : ""}${t.validity_days ? ` · valid ${esc(t.validity_days)} days` : ""}<br><span class="muted">${esc(t.delivery || "")}</span></dd></div>
      <div class="fact"><dt>Contact</dt><dd>${esc(t.contact_person || "–")}<br><span class="mono" style="user-select:all">${esc(t.contact_email || "")}</span> <span class="mono">${esc(t.contact_phone || "")}</span></dd></div>
      <div class="fact"><dt>Why it is on the list</dt><dd>${esc(t.match_reason || "–")}${t.screened_at ? ` <span class="muted">(checked by the Tender Desk ${esc(fmtDate(t.screened_at))})</span>` : ""}</dd></div>
    </dl>

    ${t.change_note ? `<div class="notice bad">${esc(t.change_note)} · ${esc(fmtDate(t.changed_at, true))}</div>` : ""}

    ${t.purchase_required || t.bid_status === "purchase" ? `<div class="box alert"><h3>Documents must be bought</h3>
      <p style="margin:0 0 6px">${t.purchase_fee ? "Fee: <b>" + esc(t.purchase_fee) + "</b>. " : ""}${esc(t.purchase_where || "See the advert for where to buy.")}</p>
      <p class="muted" style="margin:0">Buy the set, scan every page to PDF, and upload it below as <b>Purchased document (scan)</b>. Then ask the Tender Desk to prepare the bid pack.</p>
      <div class="actions"><button class="btn warn small" type="button" data-setstatus="purchase">Mark: must buy</button><button class="btn ghost small" type="button" data-setstatus="purchased">Mark: bought</button></div></div>` : ""}

    <div class="box"><h3>Tender documents on eTenders</h3>
      ${docs.length ? `<ul class="doclist">${docs.map(d => `<li><span class="nm"><span class="ext">${esc((d.ext || "").replace(".", ""))}</span>${esc(d.name)}</span><a href="${esc(d.url)}" target="_blank" rel="noopener">Download from eTenders</a></li>`).join("")}</ul>`
        : `<p class="muted" style="margin:0">${esc(t.purchase_where || "No documents were published on eTenders. Check the advert or the municipal website.")}</p>`}
      ${t.screening_notes ? `<p class="pre" style="margin-top:10px">${esc(t.screening_notes)}</p>` : ""}
    </div>

    <div class="box"><h3>What this bid needs</h3><div id="reqBox">${ACTIVE.includes(t.bid_status) || ["submitted", "won", "lost"].includes(t.bid_status)
      ? '<div class="loading">Checking the library against this tender…</div>'
      : `<p class="muted" style="margin:0 0 8px">${t.returnables && t.returnables.length ? t.returnables.length + " returnables listed in the advert or document." : "The tender's own returnables list is read when Tender Desk prepares the bid."} See which ones are on file and upload the rest.</p><button class="btn small" type="button" id="reqStart">Check what this tender needs</button>`}</div></div>

    ${t.conditions ? `<div class="box"><h3>Special conditions</h3><div class="pre">${esc(t.conditions)}</div></div>` : ""}

    <div class="box"><h3>Our bid</h3>
      <div class="grid2">
        <label class="field"><span>Status</span><select id="bidStatus">${statusOpts}</select></label>
        <div></div>
      </div>
      <label class="field" style="margin-top:10px"><span>Notes</span><textarea id="bidNotes" rows="3" placeholder="Who is attending the briefing, JV partner, pricing notes…">${esc(t.bid_notes || "")}</textarea></label>
      <div class="actions"><button class="btn small" type="button" id="saveNotes">Save notes</button></div>
    </div>

    <div class="box"><h3>Tender documents and files for this bid</h3>
      ${inFiles.length ? `<ul class="doclist">${inFiles.map(fileRow).join("")}</ul>` : '<p class="muted" style="margin:0">Nothing here yet.</p>'}
      ${docs.length ? `<div class="actions"><button class="btn small" type="button" id="fetchDocs">Get the documents from eTenders</button><span class="muted" id="fetchMsg">Copies every document on the advert into this bid.</span></div>` : ""}
      <form id="bidUpload" class="grid3" style="margin-top:12px">
        <label class="field"><span>What is it</span><select id="bfKind"><option value="purchased_scan">Purchased document (scan)</option><option value="tender_doc">Tender document</option><option value="addendum">Addendum</option><option value="briefing_cert">Briefing attendance certificate</option><option value="other">Other</option></select></label>
        <label class="field"><span>PDF, Word, Excel or image (up to 45 MB)</span><input type="file" id="bfFile" accept=".pdf,.docx,.doc,.xlsx,.xls,image/png,image/jpeg,image/webp" required></label>
        <div class="field"><span>&nbsp;</span><button class="btn small" type="submit" id="bfBtn">Upload</button></div>
      </form>
      <p class="muted" style="margin:8px 0 0">Upload the purchased document as a scan, or the Word and Excel files. Their text is read automatically so Tender Desk can prepare the bid.</p>
    </div>

    <div class="box"><h3>Bid pack</h3>
      ${jobs.filter(j => j.kind === "build").length ? `<ul class="jobs">${jobs.filter(j => j.kind === "build").slice(0, 4).map(j => `<li><span class="chip ${JOB[j.status][0]}">${esc(JOB[j.status][1])}</span><span class="muted">requested ${esc(fmtDate(j.created_at, true))}${j.finished_at ? " · finished " + esc(fmtDate(j.finished_at, true)) : ""}</span>${j.error ? `<span class="muted">${esc(j.error.slice(0, 160))}</span>` : ""}</li>`).join("")}</ul>` : ""}
      ${outFiles.length ? `<ul class="doclist">${outFiles.map(fileRow).join("")}</ul>` : '<p class="muted" style="margin:0 0 8px">No bid pack yet.</p>'}
      ${lastBuild ? `<div class="actions"><button class="btn ghost small" type="button" id="rebuild">Build again with today's documents and rates</button><span class="muted">Uses the Tender Desk's last plan for this bid. Upload missing documents first.</span></div>` : ""}
      <ol class="steps" style="margin-top:10px">
        <li>Get the tender documents above (or upload the purchased scan).</li>
        <li>Copy the request below into the <b>Pump Group Bidding Platform</b> project chat in Tender Desk.</li>
        <li>Tender Desk reads the tender, prepares the CVs, letters and pricing, and queues the build. The pack appears here when it is ready, and you get an email.</li>
        <li>Print the returnables pack. Print the original tender document and fill it in by pen from the red filling guide. Sign, certify and submit.</li>
      </ol>
      <div class="copybox" id="promptBox" style="margin-top:10px">${esc(promptFor(t))}</div>
      <div class="actions"><button class="btn" type="button" id="copyPrompt">Copy request</button><span class="muted" id="copyMsg"></span></div>
    </div>`;

  $("#closeSheet").onclick = closeSheet;
  if ($("#reqStart")) $("#reqStart").onclick = () => safe(() => loadReqs(t)); else safe(() => loadReqs(t));
  $("#bidStatus").onchange = async e => { await safe(async () => { await api("set_bid_status", { id: t.id, bid_status: e.target.value }); t.bid_status = e.target.value; toast("Status saved"); refreshRow(t); loadDashboard(); if (ACTIVE.includes(t.bid_status)) loadReqs(t); }); };
  $("#saveNotes").onclick = async () => { await safe(async () => { await api("save_notes", { id: t.id, notes: $("#bidNotes").value }); toast("Notes saved"); }); };
  $$("[data-setstatus]", $("#sheet")).forEach(b => b.onclick = async () => { await safe(async () => { await api("set_bid_status", { id: t.id, bid_status: b.dataset.setstatus }); t.bid_status = b.dataset.setstatus; renderSheet(); refreshRow(t); loadDashboard(); toast("Status saved"); }); });
  $("#copyPrompt").onclick = async () => {
    const text = promptFor(t);
    try { await navigator.clipboard.writeText(text); $("#copyMsg").textContent = "Copied. Paste it in the project chat."; }
    catch (_) { const r = document.createRange(); r.selectNodeContents($("#promptBox")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $("#copyMsg").textContent = "Selected. Press Ctrl+C to copy."; }
    if (["open", "interested", "purchased", "docs_uploaded"].includes(t.bid_status)) { try { await api("set_bid_status", { id: t.id, bid_status: "preparing" }); t.bid_status = "preparing"; $("#bidStatus").value = "preparing"; refreshRow(t); } catch (_) {} }
  };
  $("#bidUpload").onsubmit = async e => {
    e.preventDefault();
    const file = $("#bfFile").files[0]; if (!file) return;
    const btn = $("#bfBtn"); btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const up = await uploadFile(file, `bids/${safeFile(t.id)}/uploads`, false);
      const res = await api("add_bid_file", { tender_id: t.id, kind: $("#bfKind").value, title: file.name.replace(/\.[^.]+$/, ""), storage_path: up.path, file_name: file.name, content_type: file.type || "", size_bytes: up.size });
      if (["tender_doc", "purchased_scan", "addendum"].includes($("#bfKind").value) && res && res.id) { try { await fn("extract", { file_id: res.id }); } catch (_) {} }
      toast("Uploaded"); await openTender(t.id);
    } catch (err) { toast(uploadError(err)); btn.disabled = false; btn.textContent = "Upload"; }
  };
  if ($("#fetchDocs")) $("#fetchDocs").onclick = async () => {
    const b = $("#fetchDocs"); b.disabled = true; $("#fetchMsg").textContent = "Downloading from eTenders… this can take a minute.";
    try {
      const r = await fn("fetch_tender_docs", { tender_id: t.id });
      const saved = (r.results || []).filter(x => x.status === "saved").length;
      const other = (r.results || []).filter(x => x.status !== "saved" && x.status !== "already here");
      toast(saved ? `Saved ${saved} document${saved === 1 ? "" : "s"} from eTenders` : "Nothing new to download");
      if (other.length) notice("warn", "Some documents could not be downloaded: " + other.map(x => esc(x.name) + " (" + esc(x.status) + ")").join("; "));
      await openTender(t.id); loadDashboard();
    } catch (err) { $("#fetchMsg").textContent = errorCopy(err).replace(/<[^>]+>/g, ""); b.disabled = false; }
  };
  if ($("#rebuild")) $("#rebuild").onclick = () => safe(async () => { await api("queue_job", { tender_id: t.id, kind: "build" }); toast("Build queued. It usually starts within 10 minutes."); await openTender(t.id); });
  wireFileButtons($("#sheet"), () => openTender(t.id));
  wireOpen($("#sheet"));
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
  if (!st.rates.length) { tb.innerHTML = `<tr><td colspan="8" class="muted">No rates yet. Add them above, paste a block from Excel, build one from resources, or ask the Tender Desk to load the rates from a BoQ you have already priced.</td></tr>`; return; }
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
  if (me.must_change_password) askPassword(true);
  try { const g = localStorage.getItem("pg-maxgrade"); if (g) { st.maxGrade = g; $("#maxGrade").value = g; } } catch (_) {}
  await safe(async () => {
    await loadDashboard();
    await loadTenders();
    let tab = null; try { tab = localStorage.getItem("pg-tab"); } catch (_) {}
    const hash = (location.hash || "").replace("#", "");
    if (["bids", "library", "people", "profile", "rates", "scanner", "team"].includes(hash)) tab = hash;
    if (tab && tab !== "bids" && !(tab === "team" && me.role !== "admin")) showTab(tab);
  });
}

(async function boot() {
  if ("serviceWorker" in navigator) { try { navigator.serviceWorker.register("sw.js"); } catch (_) {} }
  const { data } = await sb.auth.getSession();
  if (data && data.session) startApp(); else showLogin();
})();
