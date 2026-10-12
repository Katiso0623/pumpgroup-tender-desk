// Work queue for the Pump Group bid pack builder (GitHub Actions in Katiso0623/pumpgroup-tender-desk).
// The workflow proves who it is with GitHub's OIDC token: no secrets are stored in GitHub.
//   peek                 how many jobs are waiting (also re-queues jobs stuck for 45 minutes)
//   claim                take the oldest job, with everything it needs (data, plan, signed download links)
//   upload_urls          signed upload links for the outputs of a job
//   complete             record the outputs / extracted text, update requirements and the bid status
//   fail                 mark a job as failed with a short reason
import { createClient } from "npm:@supabase/supabase-js@2";
import * as jose from "npm:jose@5.9.6";

const BUCKET = "bid-files";
const REPO = "Katiso0623/pumpgroup-tender-desk";
const AUDIENCE = "pumpgroup-pack-runner";
const JWKS = jose.createRemoteJWKSet(new URL("https://token.actions.githubusercontent.com/.well-known/jwks"));
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

async function verify(req: Request) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { payload } = await jose.jwtVerify(tok, JWKS, { issuer: "https://token.actions.githubusercontent.com", audience: AUDIENCE });
  const repo = String(payload.repository || "").toLowerCase();
  const wf = String(payload.job_workflow_ref || payload.workflow_ref || "").toLowerCase();
  if (repo !== REPO.toLowerCase() || payload.ref !== "refs/heads/main" || !wf.startsWith(`${REPO.toLowerCase()}/.github/workflows/builder.yml@`)) {
    throw new Error("not the Pump Group builder workflow");
  }
}

function ext(name: string) {
  return (String(name || "").match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
}

Deno.serve(async (req: Request) => {
  try {
    await verify(req);
  } catch (_) {
    return json({ error: "forbidden" }, 403);
  }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const sign = async (path: string) => {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (error) throw error;
    return data.signedUrl;
  };

  try {
    if (body.op === "peek") {
      const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      await db.from("pack_jobs").update({ status: "queued", started_at: null }).eq("status", "running").lt("started_at", stale);
      const { count } = await db.from("pack_jobs").select("id", { count: "exact", head: true }).eq("status", "queued");
      return json({ queued: count || 0 });
    }

    if (body.op === "claim") {
      const { data: next } = await db.from("pack_jobs").select("*").eq("status", "queued").order("created_at").limit(1);
      if (!next || !next.length) return json({ job: null });
      const job = next[0];
      const { data: claimed } = await db.from("pack_jobs").update({ status: "running", started_at: new Date().toISOString() })
        .eq("id", job.id).eq("status", "queued").select("id");
      if (!claimed || !claimed.length) return json({ job: null, retry: true });

      if (job.kind === "extract") {
        const { data: f } = await db.from("bid_files").select("id, file_name, storage_path").eq("id", job.file_id).single();
        if (!f?.storage_path) throw new Error("file missing");
        return json({ job: { id: job.id, kind: "extract", tender_id: job.tender_id }, file: { id: f.id, name: f.file_name, ext: ext(f.file_name), url: await sign(f.storage_path) } });
      }

      // build: the bid data, the plan, and links to every file the toolkit needs
      const { data: bd, error: e1 } = await db.rpc("bid_pack_data", { p_id: job.tender_id });
      if (e1) throw e1;
      const { data: tf } = await db.from("bid_files").select("id, kind, title, file_name, storage_path, created_at")
        .eq("tender_id", job.tender_id).in("kind", ["tender_doc", "purchased_scan", "addendum"]).not("storage_path", "is", null)
        .order("created_at");
      const tender_files = [];
      for (const f of tf || []) {
        if (![".docx", ".pdf", ".xlsx", ".xlsm"].includes(ext(f.file_name || f.storage_path))) continue;
        tender_files.push({ id: f.id, kind: f.kind, name: f.file_name, ext: ext(f.file_name || f.storage_path), url: await sign(f.storage_path) });
      }
      const { data: lib } = await db.from("library_docs").select("id, storage_path, file_name").eq("active", true).not("storage_path", "is", null);
      const library_files = [];
      for (const d of lib || []) library_files.push({ id: d.id, ext: ext(d.storage_path) || ".pdf", url: await sign(d.storage_path) });
      return json({ job: { id: job.id, kind: "build", tender_id: job.tender_id, plan: job.plan }, data: bd, tender_files, library_files });
    }

    if (body.op === "upload_urls") {
      const { data: job } = await db.from("pack_jobs").select("id, tender_id, status").eq("id", body.job_id).single();
      if (!job || job.status !== "running") throw new Error("job not running");
      const out = [];
      for (const name of (body.names || []) as string[]) {
        const clean = String(name).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_").slice(0, 150);
        const path = `outputs/${job.tender_id.replace(/[^A-Za-z0-9_-]+/g, "-")}/${job.id}/${clean}`;
        const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
        if (error) throw error;
        out.push({ name, path, url: data.signedUrl });
      }
      return json({ urls: out });
    }

    if (body.op === "complete") {
      const { data: job } = await db.from("pack_jobs").select("*").eq("id", body.job_id).single();
      if (!job) throw new Error("no such job");
      if (job.kind === "extract") {
        await db.from("bid_files").update({ doc_text: String(body.text || "").slice(0, 600000), text_status: body.text ? (body.ocr ? "ocr" : "ok") : "empty" }).eq("id", job.file_id);
        await db.from("pack_jobs").update({ status: "done", finished_at: new Date().toISOString(), result: { chars: (body.text || "").length, ocr: !!body.ocr } }).eq("id", job.id);
        return json({ ok: true });
      }
      for (const o of (body.outputs || []) as any[]) {
        await db.from("bid_files").insert({
          tender_id: job.tender_id, kind: o.kind || "other", title: o.title || o.name, file_name: o.name, content_type: o.content_type,
          size_bytes: o.size || null, storage_path: o.path, note: `Bid pack build ${String(job.id).slice(0, 8)}`,
        });
      }
      const summary = body.summary || {};
      if (Array.isArray(summary.db_requirements) && summary.db_requirements.length) {
        await db.rpc("set_requirements", { p_tender: job.tender_id, p_items: summary.db_requirements });
      }
      await db.from("tenders").update({ bid_status: "pack_ready", updated_at: new Date().toISOString() }).eq("id", job.tender_id)
        .in("bid_status", ["open", "interested", "purchase", "purchased", "docs_uploaded", "preparing", "pack_ready"]);
      await db.from("pack_jobs").update({ status: "done", finished_at: new Date().toISOString(), result: { summary, outputs: body.outputs || [] } }).eq("id", job.id);
      return json({ ok: true });
    }

    if (body.op === "fail") {
      await db.from("pack_jobs").update({ status: "failed", finished_at: new Date().toISOString(), error: String(body.error || "failed").slice(0, 2000) }).eq("id", body.job_id);
      if (body.file_id) await db.from("bid_files").update({ text_status: "failed" }).eq("id", body.file_id);
      return json({ ok: true });
    }
    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 300) : "failed" }, 500);
  }
});
