// Pump Group Tender Desk website: server-side actions that need the service role.
// Auth: a signed-in staff member (Supabase Auth JWT) or the internal scanner token (pg_net / Tender Desk).
//   team_add, team_reset, team_set      administrators: manage who can sign in
//   bootstrap                           internal: create the first administrator
//   fetch_tender_docs                   staff: copy a tender's documents from eTenders into the bid's files
//   extract                             staff: read the text of an uploaded tender document (PDFs go to the builder)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { strFromU8, unzipSync } from "npm:fflate@0.8.2";

const BUCKET = "bid-files";
const MAX_BYTES = 45 * 1024 * 1024;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scanner-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

class UserError extends Error {}

function docxText(buf: Uint8Array): string {
  const files = unzipSync(buf, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  if (!xml) return "";
  return strFromU8(xml)
    .replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<w:br[^>]*>/g, "\n").replace(/<\/w:tc>/g, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function safeName(s: string): string {
  return (s || "file").normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "file";
}

function tempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(a, (x) => chars[x % chars.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".zip": "application/zip",
};

async function findUserByEmail(admin: SupabaseClient, email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function addUser(admin: SupabaseClient, emailIn: string, fullName: string, role: string) {
  const email = String(emailIn || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError("Enter a valid email address.");
  if (!["admin", "member"].includes(role)) throw new UserError("Role must be admin or member.");
  const password = tempPassword();
  let user = await findUserByEmail(admin, email);
  if (user) {
    const { error } = await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true, ban_duration: "none" });
    if (error) throw error;
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error) throw error;
    user = data.user;
  }
  const { error: e2 } = await admin.from("staff").upsert({
    user_id: user!.id, email, full_name: fullName || null, role, active: true, must_change_password: true,
  });
  if (e2) throw e2;
  return { ok: true, email, temp_password: password };
}

async function readText(admin: SupabaseClient, file: any) {
  const ext = (String(file.file_name || file.storage_path || "").match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
  if (ext === ".docx") {
    const { data, error } = await admin.storage.from(BUCKET).download(file.storage_path);
    if (error) throw error;
    const text = docxText(new Uint8Array(await data.arrayBuffer()));
    await admin.from("bid_files").update({ doc_text: text.slice(0, 600000), text_status: text.trim() ? "ok" : "empty" }).eq("id", file.id);
    return { id: file.id, text_status: text.trim() ? "ok" : "empty", chars: text.length };
  }
  if (ext === ".pdf") {
    await admin.from("pack_jobs").insert({ tender_id: file.tender_id, kind: "extract", file_id: file.id, requested_by: "website" });
    await admin.from("bid_files").update({ text_status: "queued" }).eq("id", file.id);
    return { id: file.id, text_status: "queued" };
  }
  await admin.from("bid_files").update({ text_status: "not_read" }).eq("id", file.id);
  return { id: file.id, text_status: "not_read" };
}

async function fetchTenderDocs(admin: SupabaseClient, tenderId: string, who: string) {
  const { data: t, error } = await admin.from("tenders").select("id, tender_no, documents, bid_status").eq("id", tenderId).single();
  if (error || !t) throw new UserError("Tender not found.");
  const docs = (t.documents || []) as any[];
  if (!docs.length) throw new UserError("This advert has no documents on eTenders. Buy or download them and upload them here.");
  const { data: have } = await admin.from("bid_files").select("storage_path").eq("tender_id", tenderId);
  const got = new Set((have || []).map((h: any) => h.storage_path));
  const results: any[] = [];
  // Tender documents first; standards, drawings and manuals last. At most 20 per request.
  const score = (d: any) => {
    const n = String(d.name || "").toLowerCase();
    const e = String(d.ext || "").toLowerCase();
    if (![".pdf", ".docx", ".doc", ".xlsx", ".xls"].includes(e)) return -100;
    let s = 0;
    if (/(tender|bid|rfq|quotation|itt|invitation|returnable|form|schedule|pricing|price|boq|bill of quantities|offer|scope|sow|specification|evaluation|criteria|sbd|mbd|declaration|contract data|addend)/.test(n)) s += 5;
    if (e === ".docx" || e === ".xlsx") s += 1;
    if (/(drawing|layout|section|standard|manual|guideline|procedure|work instruction|policy|plan_|photo)/.test(n)) s -= 4;
    return s;
  };
  const ranked = [...docs].map((d) => ({ d, s: score(d) })).filter((x) => x.s > -100).sort((a, b) => b.s - a.s);
  const started = Date.now();
  let skipped = 0;
  for (const { d } of ranked) {
    if (results.filter((r) => r.status === "saved").length >= 20 || Date.now() - started > 110000) { skipped++; continue; }
    const ext = String(d.ext || (String(d.name || "").match(/\.[A-Za-z0-9]+$/) || [""])[0]).toLowerCase();
    const base = safeName(String(d.name || "document").replace(/\.[A-Za-z0-9]+$/, ""));
    const path = `bids/${safeName(tenderId)}/etenders/${base}${ext}`;
    if (got.has(path)) { results.push({ name: d.name, status: "already here" }); continue; }
    try {
      const res = await fetch(d.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PumpGroupTenderDesk/1.0)" } });
      if (!res.ok) { results.push({ name: d.name, status: `eTenders answered ${res.status}` }); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) { results.push({ name: d.name, status: "too large to store" }); continue; }
      const ctype = MIME[ext] || res.headers.get("content-type") || "application/octet-stream";
      const up = await admin.storage.from(BUCKET).upload(path, buf, { contentType: ctype, upsert: true });
      if (up.error) { results.push({ name: d.name, status: up.error.message }); continue; }
      const { data: row, error: e3 } = await admin.from("bid_files").insert({
        tender_id: tenderId, kind: "tender_doc", title: String(d.name || base), file_name: `${base}${ext}`,
        content_type: ctype, size_bytes: buf.byteLength, storage_path: path, note: `Downloaded from eTenders by ${who}`,
      }).select("*").single();
      if (e3) { results.push({ name: d.name, status: e3.message }); continue; }
      const tx = await readText(admin, row);
      results.push({ name: d.name, status: "saved", text_status: tx.text_status });
    } catch (e) {
      results.push({ name: d.name, status: e instanceof Error ? e.message.slice(0, 160) : "failed" });
    }
  }
  if (results.some((r) => r.status === "saved") && ["open", "interested", "purchased"].includes(t.bid_status)) {
    await admin.from("tenders").update({ bid_status: "docs_uploaded", updated_at: new Date().toISOString() }).eq("id", tenderId);
  }
  if (skipped) results.push({ name: `${skipped} more document(s)`, status: "not downloaded: press the button again, or download them from eTenders" });
  return { ok: true, results };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const op = String(body.op || "");

  let internal = false;
  let caller: any = null;
  const tokHeader = req.headers.get("x-scanner-token");
  if (tokHeader) {
    const { data } = await admin.from("settings").select("value").eq("key", "scanner_token").single();
    internal = !!data?.value?.token && tokHeader === data.value.token;
    if (!internal) return json({ error: "forbidden" }, 403);
  } else {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const { data: s } = await admin.from("staff").select("*").eq("user_id", u.user.id).eq("active", true).maybeSingle();
    if (!s) return json({ error: "Your account is not on the Pump Group team list." }, 403);
    caller = s;
  }
  const needAdmin = () => { if (!internal && caller?.role !== "admin") throw new UserError("Only administrators can do this."); };
  // activity log for administrators (never stores passwords)
  const log = async (action: string, area: string, detail: string, tenderId: string | null = null) => {
    try {
      await admin.from("activity_log").insert({
        user_id: caller?.user_id ?? null, email: caller?.email ?? null, full_name: caller ? (caller.full_name || caller.email) : "Tender Desk",
        action, area, tender_id: tenderId, detail: detail.slice(0, 500),
      });
    } catch (_) { /* logging never blocks the action */ }
  };
  const staffName = async (userId: string) => {
    const { data } = await admin.from("staff").select("full_name, email").eq("user_id", userId).maybeSingle();
    return data ? (data.full_name || data.email) : "a team member";
  };

  try {
    switch (op) {
      case "bootstrap":
        if (!internal) return json({ error: "forbidden" }, 403);
        return json(await addUser(admin, body.email, body.full_name || "", "admin"));
      case "team_add": {
        needAdmin();
        const r = await addUser(admin, body.email, body.full_name || "", body.role || "member");
        await log("team_add", "team", `Added ${body.full_name || r.email} (${r.email}) to the team as ${body.role === "admin" ? "an administrator" : "a member"}`);
        return json(r);
      }
      case "team_reset": {
        needAdmin();
        const password = tempPassword();
        const { error } = await admin.auth.admin.updateUserById(String(body.user_id), { password });
        if (error) throw error;
        await admin.from("staff").update({ must_change_password: true }).eq("user_id", body.user_id);
        const { data: s } = await admin.from("staff").select("email").eq("user_id", body.user_id).single();
        await log("team_reset", "team", `Gave ${await staffName(String(body.user_id))} a new temporary password`);
        return json({ ok: true, email: s?.email, temp_password: password });
      }
      case "team_set": {
        needAdmin();
        if (caller && body.user_id === caller.user_id && (body.active === false || body.role === "member")) {
          throw new UserError("You can't remove your own administrator access.");
        }
        const patch: Record<string, unknown> = {};
        if (typeof body.active === "boolean") patch.active = body.active;
        if (body.role) patch.role = body.role;
        if (body.full_name !== undefined) patch.full_name = body.full_name;
        const { error } = await admin.from("staff").update(patch).eq("user_id", body.user_id);
        if (error) throw error;
        if (typeof body.active === "boolean") {
          await admin.auth.admin.updateUserById(String(body.user_id), { ban_duration: body.active ? "none" : "876000h" });
        }
        const who = await staffName(String(body.user_id));
        if (typeof body.active === "boolean") await log("team_set", "team", body.active ? `Restored access for ${who}` : `Removed access for ${who}`);
        if (body.role) await log("team_set", "team", `Made ${who} ${body.role === "admin" ? "an administrator" : "a member"}`);
        return json({ ok: true });
      }
      case "fetch_tender_docs": {
        const r = await fetchTenderDocs(admin, String(body.tender_id), caller?.full_name || caller?.email || "Tender Desk");
        const saved = (r.results || []).filter((x: any) => x.status === "saved").length;
        if (saved) await log("fetch_tender_docs", caller ? "bids" : "auto", `Copied ${saved} document${saved === 1 ? "" : "s"} from eTenders`, String(body.tender_id));
        return json(r);
      }
      case "extract": {
        const { data: f, error } = await admin.from("bid_files").select("*").eq("id", body.file_id).single();
        if (error || !f?.storage_path) throw new UserError("File not found.");
        return json(await readText(admin, f));
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: e instanceof UserError ? msg : `Something went wrong: ${msg.slice(0, 200)}` }, e instanceof UserError ? 400 : 500);
  }
});
