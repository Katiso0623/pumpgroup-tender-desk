#!/usr/bin/env python3
"""Build a complete Pump Group SA bid for one tender, ready to print, sign and certify.

python make_pack.py --data bid_data.json --plan plan.json --assets assets/ --docs "Tender.docx" ["BoQ.pdf" ...] --out out/

bid_data.json   select public.bid_pack_data('<tender id>')
plan.json       written by the Tender Desk after reading the tender document (see PLAN below)
assets/         library files fetched from the Tender Desk, each named <asset_id>.<ext>

PLAN (every key optional):
{
  "contract_months": 12,
  "cpap": false,                                                # true when the contract pays price adjustment (default: over 12 months)
  "contingency": 0.10,                                          # only when the BoQ summary has a contingency line
  "certified_within_days": 90,                                  # the tender's limit for certified copies
  "tender": {"closes_at": "...", "delivery": "..."},          # corrections from the document
  "envelopes": ["Envelope 1: ...", "Envelope 2: ..."],
  "returnables": [                                              # the tender's own list, in its order
    {"ref": "T2.1", "title": "Completed tender document", "kind": "tender_document"},
    {"ref": "T2.2-1", "title": "CSD report", "categories": ["csd"]},
    {"ref": "T2.2-5", "title": "Resolution / letter of authority", "generate": "authority_letter"},
    {"ref": "T2.2-9", "title": "Key personnel", "generate": "personnel"},     # or personnel_cvs / personnel_qualifications / personnel_appointments
    {"ref": "T2.2-10", "title": "Experience", "generate": "experience"},
    {"ref": "T2.2-11", "title": "Method statement", "generate": "methodology"},
    {"ref": "T2.2-12", "title": "Programme", "generate": "programme"},
    {"ref": "T2.2-13", "title": "Functionality response", "generate": "functionality_schedule"},
    {"ref": "T2.2-14", "title": "Briefing certificate", "kind": "manual", "note": "Attach the certificate issued at the briefing"},
    {"ref": "MBD 4", "title": "Declaration of interest", "kind": "form"}
  ],
  "functionality": [ ... see bidpack/functionality.py ... ],   # company_experience may add "include_flagged": true once doubtful projects are confirmed
  "personnel": [{"role": "Contracts Manager", "requirement": "BTech Civil, ECSA, 10 years", "person": "Kabelo Rasmeni", "appoint": true}],
  "methodology": {"title": "Method statement", "sections": [{"heading": "...", "body": ["...", "- bullet"]}]},
  "programme": {"unit": "week", "duration": 40, "activities": [{"name": "...", "start": 0, "length": 2, "group": "..."}]},
  "checklist": ["anything else the user must do by hand"]
}

Outputs in --out:
  <no> - 1 Returnables pack for printing.pdf     cover, index, every section with dividers, numbered pages
  <no> - 2 Cover page.pdf / .docx            editable in Word before printing
  <no> - 3 Index.pdf / .docx                 editable in Word before printing
  <no> - 4 Filled - <doc>.docx / .pdf        the tender document with company details and rates filled
  <no> - 5 Priced BoQ and cost model.xlsx    live formulas, escalated rates, P&G, escalation, VAT
  <no> - 6 Envelope labels.pdf
  <no> - 7 Submission checklist.pdf          signatures, certification, missing documents, scoring gaps
  <no> - Blank copy - <doc>                  as downloaded, to fill by hand for comparison
  Word files/                                every generated letter, CV and schedule as Word, for edits
  <no> - Bid pack.zip                        everything above
  summary.json                               for the chat summary and the Tender Desk requirements
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from bidpack import boq as B  # noqa: E402
from bidpack import costmodel, cv, functionality, letters, pack, writeups  # noqa: E402
from bidpack.common import fmt_dt, load_data, parse_date  # noqa: E402
from bidpack.fill_docx import fill_docx  # noqa: E402
from bidpack.fill_pdf import fill_pdf  # noqa: E402
from bidpack.returnables import FORM_RE, categories_for, default_list, extract_list, pick_documents  # noqa: E402

PERSON_CATS = ("qualification", "registration", "personnel_appointment", "id_copy", "commitment")
CERTIFY_CATS = {"director_ids": "director ID copies", "qualification": "qualifications", "id_copy": "ID copies",
                "cipc": "company registration documents", "share_certificate": "share certificates"}


def safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9 ._()-]+", "-", s or "").strip(" -.")[:80] or "tender"


def to_pdf(path: Path, outdir: Path) -> Path | None:
    helper = Path("/mnt/skills/public/docx/scripts/office/soffice.py")
    cmd = ([sys.executable, str(helper)] if helper.exists() else ["soffice"]) + ["--headless", "--convert-to", "pdf", "--outdir", str(outdir), str(path)]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=240)
    except Exception as e:
        print(f"PDF conversion failed for {path.name}: {e}", file=sys.stderr)
        return None
    pdf = outdir / (path.stem + ".pdf")
    return pdf if pdf.exists() else None


def recalc_with_soffice(xlsx: Path, work: Path) -> dict:
    """Let LibreOffice calculate every formula and store the values (used where the xlsx skill is absent)."""
    tmp = work / "recalc"
    tmp.mkdir(exist_ok=True)
    try:
        subprocess.run(["soffice", "--headless", "--calc", "--convert-to", "xlsx", "--outdir", str(tmp), str(xlsx)],
                       check=True, capture_output=True, timeout=240)
        out = tmp / xlsx.name
        if not out.exists():
            return {"status": "not recalculated"}
        from openpyxl import load_workbook
        errors = 0
        for ws in load_workbook(str(out), data_only=True).worksheets:
            for row in ws.iter_rows(values_only=True):
                errors += sum(1 for v in row if isinstance(v, str) and v.startswith("#") and v.endswith(("!", "?", "A")))
        shutil.move(str(out), str(xlsx))
        return {"status": "success" if not errors else "errors", "total_errors": errors}
    except Exception as e:
        return {"status": "not recalculated", "error": str(e)[:200]}


def doc_text(path: Path) -> str:
    p = path.suffix.lower()
    try:
        if p == ".docx":
            from docx import Document
            d = Document(str(path))
            parts = [x.text for x in d.paragraphs]
            for t in d.tables:
                for r in t.rows:
                    parts.append(" | ".join(c.text for c in r.cells))
            return "\n".join(parts)
        if p == ".pdf":
            return subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return ""
    return ""


def pick_team(specs: list[dict], people: list[dict]) -> list[dict]:
    """Assign one person per role: the named person if given, else the best match not already proposed."""
    used, team = set(), []
    for s in specs:
        cands = people if s.get("person") else [p for p in people if p.get("id") not in used]
        p = functionality._pick_person(s, cands) if cands else None
        if p and not s.get("person"):
            req = cv.parse_requirement(s.get("requirement") or "")
            ch = cv.checks(p, req)
            role_ok = any((s.get("role") or "").lower() in r.lower() or r.lower() in (s.get("role") or "").lower() for r in (p.get("roles") or []))
            if not role_ok and not any(x["complies"] == "Yes" for x in ch):
                p = None  # nobody on record fits: leave the slot open rather than propose the wrong person
        if p:
            used.add(p.get("id"))
        team.append({**s, "person": p})
    return team


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--plan")
    ap.add_argument("--assets", default="assets")
    ap.add_argument("--docs", nargs="*", default=[])
    ap.add_argument("--out", default="out")
    ap.add_argument("--color", default=None)
    a = ap.parse_args()

    data = load_data(a.data)
    plan = json.loads(Path(a.plan).read_text()) if a.plan else {}
    T = {**data["tender"], **(plan.get("tender") or {})}
    prof = data["profile"]
    people = [p for p in (data.get("personnel") or []) if p.get("active", True)]
    library = data.get("library") or []
    cat_info = {c["key"]: c for c in data.get("categories") or []}
    months = plan.get("contract_months")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    work = out / "_work"
    work.mkdir(exist_ok=True)
    gen = out / "Word files"
    gen.mkdir(exist_ok=True)
    tno = safe_name(T.get("tender_no") or T.get("id") or "Tender")
    assets = Path(a.assets)
    today = date.today()

    def asset_file(doc):
        aid = doc.get("asset_id") if doc else None
        if not aid:
            return None
        hits = sorted(assets.glob(f"{aid}*"))
        return str(hits[0]) if hits else None

    def gfile(name):  # generated Word file path
        return str(gen / safe_name(name)) + ".docx"

    def lh(path):  # generated PDF printed on the letterhead
        return {"path": path, "letterhead": True}

    summary = {"tender_id": T.get("id"), "tender_no": T.get("tender_no"), "built": today.isoformat(), "outputs": [],
               "fill": {}, "boq": {}, "problems": [], "generated": [], "requirements": []}
    sign, certify, attention, review = [], [], [], []
    closes = parse_date(T.get("closes_at"))

    def certify_line(what: str, cat_key: str) -> str:
        days = plan.get("certified_within_days") or (cat_info.get(cat_key) or {}).get("max_age_days")
        if days and closes:
            from datetime import timedelta
            return f"{what}: certified copies dated on or after {(closes - timedelta(days=int(days))).strftime('%d %b %Y')} ({int(days)} days before closing). Re-certify any older copy."
        return f"{what}: use recently certified copies (check the tender's date limit)."

    # escalation to build into rates: none when the contract pays CPAP (default: contracts over 12 months)
    cpap = plan.get("cpap")
    if cpap is None:
        cpap = bool(months and int(months) > 12)
    uplift = costmodel.escalation_uplift(data.get("cost") or {}, months, cpap)
    summary["escalation"] = {"cpap": cpap, "uplift": round(uplift, 4)}

    # ------------------------------------------------ 1. fill the tender documents
    filled_pdfs, all_rows, texts, reports = [], [], [], {}
    original_pages = 0  # pages of the original tender document(s), printed and filled in by pen
    for d in a.docs:
        src = Path(d)
        texts.append(doc_text(src))
        blank = out / f"{tno} - Blank copy - {src.name}"
        shutil.copy(src, blank)
        summary["outputs"].append({"kind": "out_blank", "path": str(blank)})
        ext = src.suffix.lower()
        rep = None
        if ext == ".docx":
            dst = out / f"{tno} - 4 Filling guide (red) - {src.stem}.docx"
            rep = fill_docx(str(src), str(dst), prof, color=a.color or "C00000")
            rows = B.extract_docx(str(dst))
            if rows:
                B.price(rows, data.get("rates") or [], uplift=uplift)
                B.write_docx(str(dst), rows)
                all_rows += rows
            summary["outputs"].append({"kind": "out_filled", "path": str(dst)})
            pdf = to_pdf(dst, work)
            if pdf:
                final = out / f"{tno} - 4 Filling guide (red) - {src.stem}.pdf"
                shutil.move(str(pdf), final)
                filled_pdfs.append(str(final))
                summary["outputs"].append({"kind": "out_filled", "path": str(final)})
            bpdf = to_pdf(src, work)
            if bpdf:
                bp = out / f"{tno} - Blank copy - {src.stem}.pdf"
                shutil.move(str(bpdf), bp)
                summary["outputs"].append({"kind": "out_blank", "path": str(bp)})
                try:
                    from pypdf import PdfReader as _R
                    original_pages += len(_R(str(bp)).pages)
                except Exception:
                    pass
        elif ext == ".pdf":
            dst = out / f"{tno} - 4 Filling guide (red) - {src.name}"
            rep = fill_pdf(str(src), str(dst), prof)
            rows = B.extract_pdf(str(src))
            if rows:
                B.price(rows, data.get("rates") or [], uplift=uplift)
                B.write_pdf(str(dst), str(dst), rows)
                all_rows += rows
            filled_pdfs.append(str(dst))
            summary["outputs"].append({"kind": "out_filled", "path": str(dst)})
            try:
                from pypdf import PdfReader as _R
                original_pages += len(_R(str(src)).pages)
            except Exception:
                pass
        elif ext in (".xlsx", ".xlsm"):
            rows = B.extract_xlsx(str(src))
            if rows:
                B.price(rows, data.get("rates") or [], uplift=uplift)
                all_rows += rows
        else:
            summary["problems"].append(f"{src.name}: only Word (.docx), PDF and Excel files can be processed. Convert .doc files first.")
        if rep:
            reports[src.name] = rep.as_dict()
    summary["fill"] = {k: {"filled": len(v["filled"]), "missing": len(v["missing"]), "unknown": len(v["unknown"])} for k, v in reports.items()}
    (work / "fill_report.json").write_text(json.dumps(reports, indent=2, ensure_ascii=False))
    full_text = "\n".join(texts)

    # ------------------------------------------------ 2. cost model
    stats = B.price(all_rows, data.get("rates") or [], uplift=uplift) if all_rows else {"items": 0, "priced": 0, "unpriced": 0, "subtotal": 0}
    summary["boq"] = stats
    wb = out / f"{tno} - 5 Priced BoQ and cost model.xlsx"
    team_roles = [x.get("role") for x in (plan.get("personnel") or [])] or \
                 [c.get("role") for c in plan.get("functionality") or [] if c.get("kind") == "personnel"]
    info = costmodel.build(str(wb), T, prof, data.get("cost") or {}, all_rows, months=months,
                           contingency=float(plan.get("contingency") or 0), cpap=cpap, team_roles=team_roles)
    recalc = Path("/mnt/skills/public/xlsx/scripts/recalc.py")
    if recalc.exists():
        r = subprocess.run([sys.executable, str(recalc), str(wb), "120"], capture_output=True, text=True)
        try:
            summary["cost_model_recalc"] = json.loads(r.stdout)
        except Exception:
            summary["cost_model_recalc"] = r.stdout[-400:]
    else:
        summary["cost_model_recalc"] = recalc_with_soffice(wb, work)
    summary["cost_model"] = info
    summary["outputs"].append({"kind": "out_priced_boq", "path": str(wb)})

    # ------------------------------------------------ 3. functionality and key personnel
    specs = plan.get("personnel") or [{"role": c.get("role"), "requirement": c.get("requirement", ""), "person": c.get("person")}
                                      for c in plan.get("functionality") or [] if c.get("kind") == "personnel"]
    team = pick_team(specs, people)
    # score each personnel criterion against the person actually proposed for that role
    by_role = {(m.get("role") or "").lower(): m["person"] for m in team}
    fplan = {**plan, "functionality": [({**c, "person": by_role[(c.get("role") or "").lower()]["full_name"]}
                                        if c.get("kind") == "personnel" and by_role.get((c.get("role") or "").lower()) else c)
                                       for c in plan.get("functionality") or []]}
    func = functionality.evaluate(fplan, data)
    for m in team:
        p = m["person"]
        role = m.get("role") or "Key personnel"
        m["files"], m["cv"], m["appointment"], m["docs"] = [], None, None, []
        if not p:
            attention.append(f"{role}: nobody on record meets this. Add the person under Personnel (CV details, qualifications) and rebuild.")
            continue
        m["years"] = cv.years_experience(p, today)
        res = cv.build_cv(p, role, m.get("requirement", ""), T, gfile(f"CV - {role} - {p['full_name']}"))
        m["cv"] = res
        summary["generated"].append({"kind": "cv", "title": f"CV: {p['full_name']} ({role})", "docx": res["docx"], "pdf": res["pdf"]})
        for i_ in res["issues"]:
            if "upload the current validation" in i_:
                attention.append(i_)
            elif f" as {role}:" in i_:
                continue  # shown under functionality
            else:
                review.append(i_)
        sign.append(f"CV of {p['full_name']} ({role}): signed and dated by {p.get('known_as') or p['full_name']}.")
        pdocs = [d for d in library if d.get("person_id") == p.get("id") and d.get("category") in PERSON_CATS and d.get("active", True)]
        if plan.get("attach_original_cvs"):
            pdocs += [d for d in library if d.get("person_id") == p.get("id") and d.get("category") == "cv" and d.get("active", True)]
        m["docs"] = pdocs
        if not any(d.get("category") == "qualification" for d in pdocs):
            attention.append(f"{p['full_name']}: no certified qualifications in the library. Upload them under Personnel documents.")
        else:
            certify.append(certify_line(f"{p['full_name']}: qualifications", "qualification"))
        if m.get("appoint", True):
            emp = letters.key_personnel_appointment(T, prof, p, role, gfile(f"Appointment - {role} - {p['full_name']}"), months=months)
            m["appointment"] = emp
            summary["generated"].append({"kind": "appointment", "title": f"Key personnel appointment: {p['full_name']} ({role})", "docx": emp["docx"], "pdf": emp["pdf"]})
            sign.append(f"Appointment letter for {p['full_name']} ({role}): signed by {prof.get('signatory_name') or 'the MD'} and accepted (signed) by {p.get('known_as') or p['full_name']}.")
            if not emp["employed"]:
                review.append(f"{p['full_name']} is not on record as a current Pump Group employee: the signed acceptance on the appointment letter is the commitment. Confirm availability with them.")

    # ------------------------------------------------ 4. other generated documents
    signatory = next((p for p in people if (p.get("full_name") or "").lower() == (prof.get("signatory_name") or "").lower()), None)
    generated = {}

    def make(kind):
        if kind in generated:
            return generated[kind]
        res = None
        if kind == "authority_letter":
            res = letters.authority_letter(T, prof, gfile("Resolution - letter of authority"), signatory=signatory)
            sign.append(f"Resolution / letter of authority: signed by {prof.get('signatory_name') or 'the MD'} (and other directors if the tender asks for a board resolution signed by all).")
        elif kind == "methodology":
            if plan.get("methodology"):
                res = writeups.method_statement(T, prof, plan["methodology"], gfile("Method statement"))
                sign.append("Method statement: read it against the scope, edit the Word file if needed, then sign.")
            else:
                attention.append("Method statement: not drafted yet. Ask the Tender Desk to draft it from the scope of works.")
        elif kind == "programme":
            if plan.get("programme"):
                pdf = str(out / "_work" / "Programme.pdf")
                res = writeups.programme_pdf(T, prof, plan["programme"], pdf)
                res["docx"] = None
            else:
                attention.append("Programme: not drafted yet. Ask the Tender Desk to draft it from the scope and contract period.")
        elif kind == "personnel_schedule":
            res = writeups.personnel_schedule(T, prof, team, gfile("Schedule of key personnel"))
            sign.append("Schedule of key personnel: signed.")
        elif kind == "experience":
            crit = next((c for c in plan.get("functionality") or [] if c.get("kind") == "company_experience"), None)
            crit_ = crit or {"classes": T.get("cidb_classes") or []}
            projs = functionality.company_projects(library, crit_)
            if not crit_.get("include_flagged"):
                for d in functionality.company_projects(library, crit_, flagged=True):
                    review.append(f"Left out of the experience section until you confirm it: {d.get('title')}. {d.get('notes') or ''}".strip())
            res = writeups.experience_schedule(T, prof, projs, gfile("Schedule of completed projects"))
            res["projects"] = projs
            sign.append("Schedule of completed projects: signed.")
        if res:
            title = {"authority_letter": "Resolution / letter of authority", "methodology": "Method statement", "programme": "Construction programme",
                     "personnel_schedule": "Schedule of key personnel", "experience": "Schedule of completed projects"}[kind]
            summary["generated"].append({"kind": kind, "title": title, "docx": res.get("docx"), "pdf": res.get("pdf")})
        generated[kind] = res
        return res

    # ------------------------------------------------ 5. sections in the tender's order
    if plan.get("returnables"):
        wanted = plan["returnables"]
    elif T.get("returnables"):
        wanted = [{"ref": str(i + 1), "title": t if isinstance(t, str) else t.get("title") or t.get("name")} for i, t in enumerate(T["returnables"])]
    else:
        wanted = extract_list(full_text) or default_list()
    classes = T.get("cidb_classes") or ["CE"]
    sections, forms, where = [], [], {}
    have_tender_doc = any(w.get("kind") == "tender_document" for w in wanted)
    if not have_tender_doc:
        wanted = [{"ref": "", "title": "Completed tender document", "kind": "tender_document"}] + list(wanted)
    n = 0
    for w in wanted:
        title = (w.get("title") or "").strip()
        if not title:
            continue
        kind, gen_kind = w.get("kind"), w.get("generate")
        cats = w.get("categories")
        if cats is None and not gen_kind and kind not in ("tender_document", "manual", "form"):
            cats = categories_for(title)
            if FORM_RE.search(title) and not cats:
                kind = "form"
        if kind == "form":
            forms.append(title if not w.get("ref") else f"{w['ref']} {title}")
            summary["requirements"].append({"ref": w.get("ref", ""), "title": title, "status": "in_document", "note": "Form in the tender document: complete and sign it there."})
            continue
        n += 1
        sec = {"no": str(n), "title": title, "ref": w.get("ref", ""), "files": [], "note": "", "missing": False}
        status, notes, doc_ids = "ok", [], []
        if kind == "tender_document":
            # the original is printed and completed by hand in pen; its pages are reserved after this divider
            sec["reserve"] = original_pages
            sec["is_tender_doc"] = True
            status = "manual"
            sec["note"] = ""
        elif kind == "manual":
            sec["note"] = w.get("note") or "Insert by hand."
            sec["missing"], status = True, "manual"
            attention.append(f"{title}: {sec['note']}")
        elif gen_kind:
            if gen_kind.startswith("personnel"):
                if gen_kind == "personnel":
                    res = make("personnel_schedule")
                    if res and res.get("pdf"):
                        sec["files"].append(lh(res["pdf"]))
                for m in team:
                    if not m["person"]:
                        notes.append(f"{m.get('role')}: no one assigned")
                        continue
                    if gen_kind in ("personnel", "personnel_cvs") and m["cv"] and m["cv"].get("pdf"):
                        sec["files"].append(lh(m["cv"]["pdf"]))
                    if gen_kind in ("personnel", "personnel_qualifications"):
                        for d in m["docs"]:
                            if d.get("category") in ("personnel_appointment",) and gen_kind != "personnel":
                                continue
                            f = asset_file(d)
                            if f:
                                sec["files"].append(f)
                                doc_ids.append(d.get("id"))
                            else:
                                notes.append(f"{d.get('title')}: file not fetched")
                    if gen_kind in ("personnel", "personnel_appointments") and m["appointment"] and m["appointment"].get("pdf"):
                        sec["files"].append(lh(m["appointment"]["pdf"]))
                for c in plan.get("functionality") or []:
                    if c.get("kind") == "personnel":
                        where.setdefault(c.get("criterion"), sec["no"])
            elif gen_kind == "experience":
                res = make("experience")
                if res:
                    if res.get("pdf"):
                        sec["files"].append(lh(res["pdf"]))
                    for d in res["projects"]:
                        f = asset_file(d)
                        if f:
                            sec["files"].append(f)
                            doc_ids.append(d.get("id"))
                        else:
                            notes.append(f"{d.get('title')}: file not fetched")
                    if not res["projects"]:
                        notes.append("No completed projects in the library match")
                for c in plan.get("functionality") or []:
                    if c.get("kind") == "company_experience":
                        where.setdefault(c.get("criterion"), sec["no"])
            elif gen_kind == "functionality_schedule":
                sec["_functionality"] = True
                status = "generated"
            else:
                res = make(gen_kind)
                if res and res.get("pdf"):
                    sec["files"].append(lh(res["pdf"]))
                else:
                    notes.append("Not generated yet")
                for c in plan.get("functionality") or []:
                    if c.get("kind") == gen_kind:
                        where.setdefault(c.get("criterion"), sec["no"])
            if status == "ok":
                status = "generated" if sec["files"] and not notes else ("missing" if not sec["files"] else "generated")
        if cats:
            docs, probs = pick_documents(cats, library, cat_info, classes)
            for d in docs:
                f = asset_file(d)
                if f:
                    sec["files"].append(f)
                    doc_ids.append(d.get("id"))
                else:
                    probs.append(f"{d.get('title')}: file not fetched from the library")
                if re.search(r"names the|tender-specific", d.get("notes") or "", re.I):
                    attention.append(f"{title}: {d.get('title')}: {d['notes']}")
                elif re.search(r"\bcheck\b", d.get("notes") or "", re.I):
                    review.append(f"{title}: {d.get('title')}: {d['notes']}")
            notes += probs
            for c in cats:
                if c in CERTIFY_CATS and docs:
                    certify.append(certify_line(f"{title} ({CERTIFY_CATS[c]})", c))
                    if any(d_.get("category") == c and not d_.get("issued_on") for d_ in docs):
                        attention.append(f"{title}: the certification date of the copy on file is not recorded. Upload a freshly certified copy with its date.")
            for c in plan.get("functionality") or []:
                kind_cats = {"plant": ["plant"], "financial": ["financials", "bank_letter"], "quality": ["quality"]}.get(c.get("kind"), [])
                if set(kind_cats) & set(cats):
                    where.setdefault(c.get("criterion"), sec["no"])
            if not docs:
                status = "expired" if any(re.search(r"expired|days old", p_) for p_ in probs) else "missing"
            elif probs and status == "ok":
                status = "expired" if any(re.search(r"expired|days old", p_) for p_ in probs) else status
        if notes and not sec["note"]:
            sec["note"] = "Missing: " + "; ".join(notes[:6]) if not sec["files"] else "Note: " + "; ".join(notes[:6])
            sec["missing"] = not sec["files"]
        if not sec["files"] and not sec["note"] and kind != "tender_document" and not sec.get("_functionality"):
            sec["note"], sec["missing"], status = "Nothing on file for this item: upload it on the Tender Desk.", True, "missing"
        if status in ("missing", "expired"):
            attention += [f"{title}: {x}" for x in (notes or ["nothing on file"])]
        sections.append(sec)
        summary["requirements"].append({"ref": w.get("ref", ""), "title": title, "status": status, "note": "; ".join(notes)[:500], "doc_ids": doc_ids,
                                        "categories": cats or [], "generate": gen_kind})
    tdsec = next((x for x in sections if x.get("is_tender_doc")), None)
    if forms and tdsec:
        tdsec["note"] = "Includes: " + "; ".join(forms[:16])

    # functionality schedule now that section numbers are known
    for sec in sections:
        if sec.pop("_functionality", False):
            for c in plan.get("functionality") or []:
                where.setdefault(c.get("criterion"), sections[0]["no"] if c.get("kind") == "other" else "-")
            res = writeups.functionality_schedule(T, prof, func, where, gfile("Functionality response schedule"))
            summary["generated"].append({"kind": "functionality_schedule", "title": "Functionality response schedule", "docx": res["docx"], "pdf": res["pdf"]})
            if res.get("pdf"):
                sec["files"].insert(0, lh(res["pdf"]))

    for sec in sections:
        summary.setdefault("section_notes", {})[sec["no"]] = sec.get("note", "")
        if not sec.get("note", "").startswith("Includes"):
            sec["note"] = ""
        sec["missing"] = False

    # ------------------------------------------------ 6. compile the print pack
    packf = out / f"{tno} - 1 Returnables pack for printing.pdf"
    entries = pack.compile_pack(sections, T, prof, str(packf), str(out / f"{tno} - 3 Index.pdf"), str(out / f"{tno} - 3 Index.docx"),
                                str(out / f"{tno} - 2 Cover page.pdf"), str(out / f"{tno} - 2 Cover page.docx"))
    for s in sections:
        for pr in s.get("problems", []):
            summary["problems"].append(f"Section {s['no']} {s['title']}: {pr}")
    summary["index"] = entries
    summary["outputs"] += [{"kind": "out_returnables", "path": str(packf)},
                           {"kind": "out_cover", "path": str(out / f"{tno} - 2 Cover page.pdf")},
                           {"kind": "out_index", "path": str(out / f"{tno} - 3 Index.pdf")}]

    if plan.get("envelopes"):
        labels = plan["envelopes"]
    elif T.get("two_envelope") or re.search(r"two[- ]envelope|separate(ly)? seal", full_text, re.I):
        labels = ["Envelope 1: Technical proposal and returnables", "Envelope 2: Financial offer (price)"]
    else:
        labels = ["Tender submission: original"]
        if re.search(r"(one|two|three|1|2|3)\s*(\(\d\)\s*)?(additional )?cop(y|ies)", full_text, re.I):
            labels.append("Tender submission: copy")
    env = out / f"{tno} - 6 Envelope labels.pdf"
    pack.envelope_labels(T, prof, str(env), labels)
    summary["outputs"].append({"kind": "out_cover", "path": str(env)})

    # ------------------------------------------------ 7. checklist
    form_names = sorted(set(m_.group(0).upper() for m_ in re.finditer(r"\b(SBD|MBD)\s?\d+(\.\d)?\b", full_text, re.I)))
    sign_first = ["Form of Offer and Acceptance (tenderer's part): write the tendered amount exactly as the form asks, the same as the BoQ total on the tender's summary page, then sign."]
    if re.search(r"witness", full_text, re.I):
        sign_first.append("Have the Form of Offer (and any other form with a witness line) witnessed.")
    if form_names:
        sign_first.append("Sign and date: " + ", ".join(form_names) + ".")
    sign_first.append("Answer every declaration yourself (declaration of interest, past supply chain practices, independent bid determination, state employment). These are never pre-filled.")
    if re.search(r"initial (each|every|all) page", full_text, re.I):
        sign_first.append("Initial every page of the tender document.")
    tdentry = next((e for e, x in zip(entries, sections) if x.get("is_tender_doc")), None)
    if tdentry:
        sign_first.insert(0, f"Print the original tender document (the blank copy, {original_pages} pages) and complete it in pen, "
                             f"copying the red entries from the filling guide. Insert it behind divider {tdentry['no']} (pages {tdentry['pages']}).")
    sign = sign_first + sign
    if re.search(r"commissioner of oaths|sworn affidavit|commissioned", full_text, re.I):
        certify.append("Have the sworn affidavit(s) commissioned by a Commissioner of Oaths.")
    if T.get("briefing_compulsory"):
        certify.append(f"Attach the compulsory briefing attendance certificate ({fmt_dt(T.get('briefing_at'))}, {T.get('briefing_venue') or ''}).")
    fill_lines = []
    for name, rep in reports.items():
        fill_lines.append(f"{name}: {len(rep['filled'])} fields filled automatically. Compare with the blank copy.")
        for mm_ in rep["missing"][:12]:
            fill_lines.append(f"Missing company detail '{mm_['key']}' for '{mm_['label']}'. Add it under Company details.")
        for u in rep["unknown"][:15]:
            fill_lines.append(f"Fill by hand: '{u['label']}' ({u['where']})")
    price_lines = []
    if all_rows:
        price_lines.append(f"{stats['priced']} of {stats['items']} BoQ items priced from the rates library (escalated to the latest indices).")
        if stats["unpriced"]:
            price_lines.append(f"{stats['unpriced']} item(s) have no rate: type them in the yellow 'Your rate' column of the cost model.")
    else:
        price_lines.append("No Bill of Quantities table was recognised: price it in the cost model's BoQ sheet or by hand.")
    price_lines += [f"Rates already include {summary['escalation']['uplift'] * 100:.1f}% escalation to mid-contract (fixed-price contract)." if summary["escalation"]["uplift"]
                    else "No escalation is built into the rates (contract price adjustment applies, or no CPI data).",
                    "Section totals in the printed BoQ are left blank until every item in the section has a rate.",
                    "Price the BoQ's own P&G items from the P&G sheet (only the proposed team is counted there). Check contingency and CPAP on the Summary sheet.",
                    "Write every rate from column H of the cost model's BoQ sheet. The BoQ total on the tender's summary page and the Form of Offer amount must be the same."]
    func_lines = []
    for r in func:
        est = f"estimated {r['est_points']:g} of {r['max_points']}" if r.get("est_points") is not None and r.get("max_points") else ""
        func_lines.append(f"{r['criterion']}: {est}{'. ' if est else ''}" + ("; ".join(r["gaps"][:3]) if r["gaps"] else "evidence attached"))
    where_to = re.sub(r"\s+", " ", T.get("delivery") or "see the tender document")
    deliver = [f"Closes {fmt_dt(T.get('closes_at'))}. Deliver before this time; late bids are rejected.",
               f"Deliver to: {where_to}."]
    m_copies = re.search(r"(one|two|three|1|2|3)\s*(\(\d\)\s*)?(additional )?cop(y|ies)[^.]{0,60}", full_text, re.I)
    if m_copies:
        deliver.append(f"Submit the original and the copies the tender asks for ('{m_copies.group(0).strip()}'). Mark them ORIGINAL and COPY.")
    deliver += ["Update the index page numbers by hand if you add or remove pages (the Word index is editable).",
                "Seal the envelope(s) and attach the envelope labels."]
    seen = set()
    attention = [x for x in attention if not (x in seen or seen.add(x))]
    review = [x for x in review if not (x in seen or seen.add(x))]
    checklist = out / f"{tno} - 7 Submission checklist.pdf"
    check_sections = [
        ("Upload or replace (on the Tender Desk, then rebuild)", attention[:40]),
        ("Check before you rely on it", review[:25]),
        ("Sign before you seal", sign),
        ("Certify and commission", sorted(set(certify))),
        ("Functionality: estimated score and gaps", func_lines),
        ("Bid document details", fill_lines),
        ("Pricing", price_lines),
        ("Also do", plan.get("checklist") or []),
        ("Delivery", deliver),
    ]
    pack.checklist_pdf(str(checklist), T, prof, check_sections)
    summary["outputs"].append({"kind": "out_checklist", "path": str(checklist)})
    # the same checklist for the Tender Desk's "Uploads needed" page
    summary["checklist"] = [{"key": k, "heading": h, "items": list(items)} for k, (h, items) in
                            zip(("upload", "check", "sign", "certify", "functionality", "details", "pricing", "also", "delivery"), check_sections) if items]
    summary["functionality"] = [{k: r.get(k) for k in ("criterion", "max_points", "est_points", "person", "gaps")} for r in func]
    # ready for: select public.set_requirements('<tender id>', '<db_requirements json>'::jsonb)
    gen_cats = {"authority_letter": ["authority_letter"], "methodology": ["methodology"], "programme": ["programme"],
                "experience": ["completion_certificate", "reference_letter", "appointment_letter"], "functionality_schedule": ["methodology"],
                "personnel": ["cv"], "personnel_cvs": ["cv"], "personnel_qualifications": ["qualification"], "personnel_appointments": ["personnel_appointment"]}
    dbreq = []
    for r in summary["requirements"]:
        if r["status"] == "in_document":
            dbreq.append({"ref": r["ref"], "title": r["title"], "kind": "form", "categories": []})
        elif r.get("generate"):
            dbreq.append({"ref": r["ref"], "title": r["title"], "kind": "generated", "categories": gen_cats.get(r["generate"], []), "note": r.get("note") or None})
        else:
            dbreq.append({"ref": r["ref"], "title": r["title"], "kind": "returnable" if r.get("categories") else "other", "categories": r.get("categories") or [],
                          "note": r.get("note") or None})
    fr = {(f.get("role") or "").lower(): f for f in func if f.get("kind") == "personnel"}
    for m in team:
        p_, role = m.get("person"), m.get("role") or ""
        f = fr.get(role.lower(), {})
        gaps = "; ".join((f.get("gaps") or [])[:3])
        est = f"Estimated {f['est_points']:g} of {f['max_points']} points. " if f.get("est_points") is not None and f.get("max_points") else ""
        dbreq.append({"title": f"Key personnel: {role}" + (f" ({p_['full_name']})" if p_ else ""), "kind": "personnel", "role": role,
                      "person_id": (p_ or {}).get("id"), "categories": ["qualification"], "max_points": f.get("max_points"),
                      "requirement": m.get("requirement"), "note": (est + gaps).strip() or None})
    summary["db_requirements"] = dbreq
    summary["team"] = [{"role": m.get("role"), "person": (m["person"] or {}).get("full_name")} for m in team]
    summary["attention"] = attention
    summary["review"] = review

    # Word copies of everything generated, then one zip
    zpath = out / f"{tno} - Bid pack.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.iterdir()):
            if f.is_file() and f.suffix.lower() in (".pdf", ".docx", ".xlsx") and f != zpath:
                z.write(f, f.name)
        for f in sorted(gen.glob("*.docx")):
            z.write(f, f"Word files/{f.name}")
    summary["outputs"].append({"kind": "other", "path": str(zpath)})
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=str))
    print(json.dumps({k: summary[k] for k in ("tender_no", "fill", "boq", "team")}, indent=1, default=str))
    print("\n".join(o["path"] for o in summary["outputs"]))


if __name__ == "__main__":
    main()
