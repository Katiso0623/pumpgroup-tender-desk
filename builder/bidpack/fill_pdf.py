"""Fill bidder details into a PDF tender document.

1. If the PDF has form fields, fill the ones whose names/labels match.
2. Otherwise overlay typed text on the answer spaces:
   - dotted / underscored leaders that follow a recognised label on the same line
   - an empty table cell to the right of a recognised label cell
Scanned (image-only) pages have no text to find; they are reported, not guessed.
"""
from __future__ import annotations

import io
import re

import pdfplumber
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

from .common import field_value, is_blank, match_field
from .fill_docx import FillReport

LEADER_WORD = re.compile(r"^[_.…]{3,}$")


def _lines(words, tol=3):
    lines = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        for ln in lines:
            if abs(ln["top"] - w["top"]) <= tol:
                ln["words"].append(w)
                break
        else:
            lines.append({"top": w["top"], "words": [w]})
    for ln in lines:
        ln["words"].sort(key=lambda w: w["x0"])
    return lines


def _fit(c, text, x, y, max_w, size):
    s = size
    while s > 6 and c.stringWidth(text, "Helvetica", s) > max_w:
        s -= 0.5
    c.setFont("Helvetica", s)
    c.drawString(x, y, text)


def _form_fields(reader: PdfReader, profile, report) -> dict:
    fields = reader.get_fields() or {}
    values = {}
    for name, f in fields.items():
        if f.get("/FT") != "/Tx" or (f.get("/V") not in (None, "")):
            continue
        label = f.get("/TU") or name
        key = match_field(str(label).replace("_", " "))
        if not key:
            continue
        v = field_value(profile, key)
        if v:
            values[name] = v
            report.filled.append({"where": "form field", "label": str(label)[:90], "key": key, "value": v})
        else:
            report.missing.append({"where": "form field", "label": str(label)[:90], "key": key})
    return values


def fill_pdf(src: str, dst: str, profile: dict, color=(0.75, 0.0, 0.0)) -> FillReport:
    report = FillReport()
    reader = PdfReader(src)
    writer = PdfWriter(clone_from=reader)

    if reader.get_fields():
        values = _form_fields(reader, profile, report)
        if values:
            for page in writer.pages:
                writer.update_page_form_field_values(page, values, auto_regenerate=False)
            writer.set_need_appearances_writer(True)

    overlays = {}
    with pdfplumber.open(src) as pdf:
        for pno, page in enumerate(pdf.pages):
            words = page.extract_words(keep_blank_chars=False, use_text_flow=False, extra_attrs=["size"])
            if not words:
                if len(page.images):
                    report.unknown.append({"where": f"page {pno + 1}", "label": "scanned page: no text to fill, complete by hand"})
                continue
            H = float(page.height)
            buf = io.BytesIO()
            c = canvas.Canvas(buf, pagesize=(float(page.width), H))
            c.setFillColorRGB(*color)
            wrote = False

            # (a) leaders on a line after a label
            for ln in _lines(words):
                ws = ln["words"]
                i = 0
                while i < len(ws):
                    if LEADER_WORD.match(ws[i]["text"]) or re.search(r"[_.…]{4,}$", ws[i]["text"]):
                        # label = words before this leader back to the previous leader / start
                        j = i - 1
                        while j >= 0 and not LEADER_WORD.match(ws[j]["text"]):
                            j -= 1
                        label_words = ws[j + 1:i]
                        lead = ws[i]
                        # the leader may be glued to the label's last word: "bidder:......"
                        tail = re.sub(r"[_.…]{3,}$", "", lead["text"])
                        label = " ".join([w["text"] for w in label_words] + ([tail] if tail else []))
                        # the leader may continue over several words
                        k = i
                        while k + 1 < len(ws) and LEADER_WORD.match(ws[k + 1]["text"]):
                            k += 1
                        x0 = lead["x0"] + (c.stringWidth(tail, "Helvetica", lead.get("size", 9)) if tail else 0)
                        x1 = ws[k]["x1"]
                        key = match_field(re.split(r"\d+(?:\.\d+)+\s+", label)[-1]) if label else None
                        if key:
                            v = field_value(profile, key)
                            if v:
                                _fit(c, v, x0 + 2, H - lead["bottom"] + 2.5, max(40, x1 - x0 - 4), min(10, max(7, float(lead.get("size", 9)))))
                                wrote = True
                                report.filled.append({"where": f"page {pno + 1}", "label": label[:90], "key": key, "value": v})
                            else:
                                report.missing.append({"where": f"page {pno + 1}", "label": label[:90], "key": key})
                        elif label and not re.search(r"sign|date|witness|initial", label, re.I):
                            report.unknown.append({"where": f"page {pno + 1}", "label": label[:90]})
                        i = k + 1
                        continue
                    i += 1

            # (b) table rows: label cell + empty answer cell
            try:
                tables = page.find_tables()
            except Exception:
                tables = []
            for tb in tables:
                for row in tb.rows:
                    cells = [cb for cb in row.cells if cb]
                    for ci in range(len(cells) - 1):
                        lab = (page.crop(cells[ci]).extract_text() or "").strip()
                        nxt = (page.crop(cells[ci + 1]).extract_text() or "").strip()
                        if not lab or not is_blank(nxt):
                            continue
                        key = match_field(lab)
                        if not key:
                            continue
                        v = field_value(profile, key)
                        x0, top, x1, bottom = cells[ci + 1]
                        if v:
                            _fit(c, v, x0 + 3, H - (top + bottom) / 2 - 3, x1 - x0 - 6, 9)
                            wrote = True
                            report.filled.append({"where": f"page {pno + 1} table", "label": lab[:90], "key": key, "value": v})
                        else:
                            report.missing.append({"where": f"page {pno + 1} table", "label": lab[:90], "key": key})
            c.save()
            if wrote:
                overlays[pno] = buf.getvalue()

    for pno, data in overlays.items():
        writer.pages[pno].merge_page(PdfReader(io.BytesIO(data)).pages[0])
    with open(dst, "wb") as fh:
        writer.write(fh)
    return report


def write_on_pdf(src: str, dst: str, items: list[dict]):
    """Low-level helper for Tender Desk: items = [{page (1-based), x, y_from_top, text, size}] in PDF points."""
    reader = PdfReader(src)
    writer = PdfWriter(clone_from=reader)
    by_page = {}
    for it in items:
        by_page.setdefault(int(it["page"]) - 1, []).append(it)
    for pno, its in by_page.items():
        page = reader.pages[pno]
        w, h = float(page.mediabox.width), float(page.mediabox.height)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(w, h))
        c.setFillColorRGB(0.75, 0.0, 0.0)
        for it in its:
            c.setFont("Helvetica", float(it.get("size", 9)))
            c.drawString(float(it["x"]), h - float(it["y_from_top"]), str(it["text"]))
        c.save()
        writer.pages[pno].merge_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])
    with open(dst, "wb") as fh:
        writer.write(fh)
