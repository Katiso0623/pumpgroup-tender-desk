#!/usr/bin/env python3
"""Pump Group bid pack builder, run by .github/workflows/builder.yml.

Claims waiting jobs from the pack-runner service (authenticated with this workflow's GitHub OIDC
token, so no secrets live in this public repository), then:
  extract  reads the text of an uploaded tender document (pdftotext, or OCR for scans)
  build    runs make_pack.py with the Tender Desk's plan and the bid's documents, and uploads the outputs

This repository and its workflow logs are public: never print bid data, names or file contents.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

FN = "https://ccvmugyurqwrszyqubgw.supabase.co/functions/v1/pack-runner"
AUDIENCE = "pumpgroup-pack-runner"
HERE = Path(__file__).resolve().parent
MAX_JOBS = 6
DEADLINE = time.time() + 45 * 60

KIND_BY_NAME = [
    (r" - 1 Returnables pack for printing\.pdf$", "out_returnables", "Returnables pack for printing"),
    (r" - 2 Cover page\.(pdf|docx)$", "out_cover", "Cover page"),
    (r" - 3 Index\.(pdf|docx)$", "out_index", "Index"),
    (r" - 4 Filling guide \(red\) - ", "out_filled", "Filling guide (red)"),
    (r" - 5 Priced BoQ and cost model\.xlsx$", "out_priced_boq", "Priced BoQ and cost model"),
    (r" - 6 Envelope labels\.pdf$", "out_cover", "Envelope labels"),
    (r" - 7 Submission checklist\.pdf$", "out_checklist", "Submission checklist"),
    (r" - Blank copy - ", "out_blank", "Blank copy (original)"),
    (r" - Bid pack\.zip$", "other", "Everything, with Word files of every letter and CV"),
]
CTYPES = {".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".zip": "application/zip"}


def oidc_token() -> str:
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=" + AUDIENCE
    req = urllib.request.Request(url, headers={"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["value"]


def call(op: str, **kw) -> dict:
    data = json.dumps({"op": op, **kw}).encode()
    req = urllib.request.Request(FN, data=data, method="POST",
                                 headers={"Authorization": "Bearer " + oidc_token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def fetch(url: str, dest: Path):
    with urllib.request.urlopen(url, timeout=300) as r, open(dest, "wb") as fh:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)


def put(url: str, path: Path, ctype: str):
    req = urllib.request.Request(url, data=path.read_bytes(), method="PUT",
                                 headers={"Content-Type": ctype, "x-upsert": "true"})
    with urllib.request.urlopen(req, timeout=300) as r:
        r.read()


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9 ._()&-]+", "-", name or "file").strip(" -.")[:120] or "file"


# ------------------------------------------------------------------ extract
def run_extract(job: dict, file: dict):
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / ("doc" + (file.get("ext") or ".pdf"))
        fetch(file["url"], src)
        text = subprocess.run(["pdftotext", "-layout", str(src), "-"], capture_output=True, text=True, timeout=600).stdout
        ocr = False
        if len(re.sub(r"\s", "", text)) < 200 * max(1, 1):
            ocr = True
            pages_dir = Path(tmp) / "p"
            pages_dir.mkdir()
            subprocess.run(["pdftoppm", "-r", "200", "-gray", "-l", "120", str(src), str(pages_dir / "p")],
                           check=True, capture_output=True, timeout=1200)
            parts = []
            for img in sorted(pages_dir.glob("p-*.pgm")):
                out = subprocess.run(["tesseract", str(img), "-", "--psm", "6"], capture_output=True, text=True, timeout=300).stdout
                parts.append(f"\n\n=== page {img.stem.split('-')[-1].lstrip('0') or '1'} ===\n{out}")
            text = "".join(parts)
        call("complete", job_id=job["id"], text=text, ocr=ocr)
        print(f"extract job done ({'ocr' if ocr else 'text'}, {len(text)} characters)")


# ------------------------------------------------------------------ build
def run_build(job: dict, data: dict, tender_files: list, library_files: list):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        assets, docs, out = tmp / "assets", tmp / "docs", tmp / "out"
        for d in (assets, docs, out):
            d.mkdir()
        have = set()
        for f in library_files:
            fetch(f["url"], assets / f"{f['id']}{f.get('ext') or '.pdf'}")
            have.add(f["id"])
        for d in data.get("library") or []:
            d["asset_id"] = d["id"] if d.get("id") in have else None
        doc_paths = []
        for i, f in enumerate(tender_files):
            p = docs / f"{i + 1:02d} {safe(Path(f.get('name') or 'document').stem)}{f.get('ext') or ''}"
            fetch(f["url"], p)
            doc_paths.append(str(p))
        (tmp / "bid_data.json").write_text(json.dumps(data))
        (tmp / "plan.json").write_text(json.dumps(job.get("plan") or {}))
        log = tmp / "make_pack.log"
        with open(log, "w") as fh:
            r = subprocess.run([sys.executable, str(HERE / "make_pack.py"), "--data", str(tmp / "bid_data.json"), "--plan", str(tmp / "plan.json"),
                                "--assets", str(assets), "--out", str(out), "--docs", *doc_paths],
                               stdout=fh, stderr=subprocess.STDOUT, timeout=2400, cwd=str(HERE))
        if r.returncode != 0:
            tail = log.read_text()[-1500:]
            last = [l for l in tail.splitlines() if l.strip()][-1:] or ["unknown error"]
            raise RuntimeError(f"make_pack failed: {last[0][:300]}")
        summary = json.loads((out / "summary.json").read_text())
        files = [p for p in sorted(out.iterdir()) if p.is_file() and p.suffix.lower() in CTYPES]
        uploads = []
        for p in files:
            kind, title = "other", p.stem
            for rx, k, t in KIND_BY_NAME:
                if re.search(rx, p.name):
                    kind, title = k, t
                    if k in ("out_filled", "out_blank"):
                        title = f"{t}: {p.name.split(' - ')[-1]}"
                    elif p.suffix.lower() == ".docx":
                        title = f"{t} (Word, editable)"
                    break
            uploads.append({"local": p, "name": p.name, "kind": kind, "title": title, "size": p.stat().st_size,
                            "content_type": CTYPES[p.suffix.lower()]})
        # each prepared document (CVs, appointment letters, resolution, schedules, method statement, programme)
        # is also uploaded on its own, so the website can show it; these are not added to the bid's file list
        generated, extra = [], []
        for i, g in enumerate(summary.get("generated") or []):
            item = {"kind": g.get("kind"), "title": g.get("title")}
            for key in ("pdf", "docx"):
                p = Path(g.get(key) or "")
                if g.get(key) and p.is_file() and p.suffix.lower() in CTYPES:
                    name = f"Prepared {i + 1:02d} - {p.stem[:90]}{p.suffix.lower()}"
                    extra.append({"local": p, "name": name, "content_type": CTYPES[p.suffix.lower()], "slot": (len(generated), key)})
            generated.append(item)
        urls = call("upload_urls", job_id=job["id"], names=[u["name"] for u in uploads + extra])["urls"]
        by_name = {u["name"]: u for u in urls}
        outputs = []
        for u in uploads:
            target = by_name[u["name"]]
            put(target["url"], u["local"], u["content_type"])
            outputs.append({k: u[k] for k in ("name", "kind", "title", "size", "content_type")} | {"path": target["path"]})
        for u in extra:
            target = by_name[u["name"]]
            put(target["url"], u["local"], u["content_type"])
            idx, key = u["slot"]
            generated[idx][key] = target["path"]
        keep = ("tender_no", "built", "fill", "boq", "escalation", "cost_model", "cost_model_recalc", "index", "requirements", "db_requirements",
                "functionality", "team", "attention", "review", "problems", "checklist", "section_notes")
        slim = {k: summary.get(k) for k in keep}
        slim["generated"] = generated
        call("complete", job_id=job["id"], summary=slim, outputs=outputs)
        print(f"build job done ({len(outputs)} files, {len(extra)} prepared documents)")


def main():
    if "--peek" in sys.argv:
        try:
            print(f"queued={call('peek').get('queued', 0)}")
        except Exception:
            print("queued=0")
        return
    done = 0
    while done < MAX_JOBS and time.time() < DEADLINE:
        got = call("claim")
        job = got.get("job")
        if not job:
            if got.get("retry"):
                continue
            break
        done += 1
        try:
            if job["kind"] == "extract":
                run_extract(job, got["file"])
            else:
                run_build(job, got["data"], got.get("tender_files") or [], got.get("library_files") or [])
        except Exception as e:  # report a short reason; nothing about the bid goes to the public log
            msg = str(e)[:500]
            call("fail", job_id=job["id"], error=msg, file_id=(got.get("file") or {}).get("id"))
            print(f"{job['kind']} job failed")
    print(f"{done} job(s) handled")


if __name__ == "__main__":
    main()
