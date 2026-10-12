"""Pump Group SA bid pack pages: cover page, envelope labels, index of returnables,
section dividers, the compiled print-ready pack with page numbers, and the
submission checklist. PDF pages sit on the company letterhead; the cover and
index are also written as Word files so they can be edited before printing."""
from __future__ import annotations

import io
import re
from pathlib import Path

from pypdf import PageObject, PdfReader, PdfWriter
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, Table, TableStyle

from . import brand
from .brand import BLUE, CHARCOAL, GREY, INK, RULE
from .common import fmt_dt, parse_dt

W, H = A4
P = ParagraphStyle("p", fontName="Helvetica", fontSize=10, leading=13.5, alignment=TA_LEFT, textColor=INK)
PB = ParagraphStyle("pb", parent=P, fontName="Helvetica-Bold")
PS = ParagraphStyle("ps", parent=P, fontSize=8.5, leading=11, textColor=GREY)
PH = ParagraphStyle("ph", parent=P, fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=colors.white)


def _clean(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _esc(s) -> str:
    return str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _client(t):
    return _clean(t.get("organ_of_state") or t.get("department") or "")


def _closing(t):
    d = parse_dt(t.get("closes_at"))
    return (d.strftime("%d %B %Y").upper(), d.strftime("%H:%M")) if d else ("-", "")


def _pages(c_bytes: bytes) -> list[PageObject]:
    return list(PdfReader(io.BytesIO(c_bytes)).pages)


# --------------------------------------------------------------- cover page
def cover_page(t: dict, prof: dict, label: str | None = None) -> bytes:
    """Front cover of the bid document (also used as an envelope label when label is given)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    brand.draw_letterhead(c)
    x0, ytop, x1, ybot = brand.safe_box()
    width = x1 - x0
    y = ytop - 8 * mm
    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x0, y, "TENDER SUBMISSION")
    c.setStrokeColor(BLUE)
    c.setLineWidth(2)
    c.line(x0, y - 3 * mm, x0 + 28 * mm, y - 3 * mm)
    y -= 13 * mm
    client = Paragraph(_esc(_client(t).upper()), ParagraphStyle("cl", parent=P, fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=CHARCOAL))
    _, h = client.wrap(width, 200)
    client.drawOn(c, x0, y - h)
    y -= h + 5 * mm
    no = Paragraph("CONTRACT No. " + _esc(_clean(t.get("tender_no"))), ParagraphStyle("no", parent=P, fontName="Helvetica-Bold", fontSize=13, leading=16, textColor=BLUE))
    _, h = no.wrap(width, 100)
    no.drawOn(c, x0, y - h)
    y -= h + 4 * mm
    desc = Paragraph(_esc(_clean(t.get("description")).upper()), ParagraphStyle("ds", parent=P, fontName="Helvetica-Bold", fontSize=12.5, leading=16.5, textColor=INK))
    _, h = desc.wrap(width, 260)
    desc.drawOn(c, x0, y - h)
    y -= h + 10 * mm

    day, time = _closing(t)
    rows = [
        ("CLOSING DATE", f"{day}   TIME: {time}"),
        ("DELIVER TO", _clean(re.sub(r"\s*-{2,}\s*", ", ", t.get("delivery") or "As stated in the tender document"))),
        ("SUBMITTED BY", _clean(prof.get("legal_name") or "PUMP GROUP SA (PTY) LTD")),
        ("REGISTRATION", "  |  ".join(x for x in [f"Reg. {prof.get('reg_number')}" if prof.get("reg_number") else "",
                                                  f"CSD {prof.get('csd_number')}" if prof.get("csd_number") else "",
                                                  f"CIDB {prof.get('cidb_grading')}" if prof.get("cidb_grading") else ""] if x)),
        ("CONTACT", "  |  ".join(x for x in [prof.get("contact_person"), prof.get("cellphone") or prof.get("telephone"), prof.get("email")] if x)),
    ]
    data = [[Paragraph(_esc(k), ParagraphStyle("k", parent=PS, fontName="Helvetica-Bold", textColor=GREY)), Paragraph(_esc(v), P)] for k, v in rows]
    tb = Table(data, colWidths=[34 * mm, width - 34 * mm])
    tb.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEABOVE", (0, 0), (-1, 0), 1.2, CHARCOAL),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    _, th = tb.wrapOn(c, width, 300)
    tb.drawOn(c, x0, y - th)
    if label:
        by = ybot + 4 * mm
        c.setFillColor(CHARCOAL)
        c.rect(x0, by, width * 0.72, 14 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 15)
        c.drawString(x0 + 5 * mm, by + 4.8 * mm, label.upper()[:48])
    c.showPage()
    c.save()
    return buf.getvalue()


def envelope_labels(t: dict, prof: dict, out: str, labels: list[str]):
    w = PdfWriter()
    for lab in labels:
        for p in _pages(cover_page(t, prof, lab)):
            w.add_page(p)
    with open(out, "wb") as fh:
        w.write(fh)


# ------------------------------------------------------------------ divider
def divider_page(no: str, title: str, ref: str, t: dict, note: str = "", missing: bool = False) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    brand.draw_letterhead(c)
    x0, ytop, x1, ybot = brand.safe_box()
    width = x1 - x0
    ymid = (ytop + ybot) / 2 + 20 * mm
    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 72)
    c.drawString(x0, ymid, str(no))
    c.setFillColor(CHARCOAL)
    c.rect(x0, ymid - 6 * mm, 34 * mm, 2.2 * mm, stroke=0, fill=1)
    para = Paragraph(_esc(title.upper()), ParagraphStyle("t", parent=P, fontName="Helvetica-Bold", fontSize=20, leading=25, textColor=CHARCOAL))
    _, h = para.wrap(width, 300)
    para.drawOn(c, x0, ymid - 14 * mm - h)
    y = ymid - 18 * mm - h
    if ref:
        c.setFont("Helvetica", 10.5)
        c.setFillColor(GREY)
        c.drawString(x0, y - 4 * mm, f"Tender reference: {ref}")
        y -= 8 * mm
    if note:
        st = ParagraphStyle("n", parent=P, fontSize=10.5, leading=14, textColor=colors.HexColor("#B42318") if missing else GREY)
        np_ = Paragraph(_esc(note), st)
        _, nh = np_.wrap(width, 200)
        np_.drawOn(c, x0, y - 6 * mm - nh)
    c.setFont("Helvetica", 8.5)
    c.setFillColor(GREY)
    c.drawString(x0, ybot + 2 * mm, f"{_clean(t.get('tender_no'))}  |  {_client(t)}"[:110])
    c.showPage()
    c.save()
    return buf.getvalue()


# --------------------------------------------------------------------- index
def index_pages(entries: list[dict], t: dict) -> bytes:
    """entries: [{no, title, ref, pages}] -> branded index page(s) in Pump Group's own format."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    x0, ytop, x1, ybot = brand.safe_box()
    width = x1 - x0
    cw = [12 * mm, width - 12 * mm - 26 * mm - 20 * mm, 26 * mm, 20 * mm]
    avail1 = (ytop - 4 * mm - 11 * mm - 15 * mm) - ybot
    for fs in (10, 9, 8.2):  # smaller type before spilling onto a second page
        p_ = ParagraphStyle("ip", parent=P, fontSize=fs, leading=fs * 1.3)
        pb_ = ParagraphStyle("ipb", parent=PB, fontSize=fs, leading=fs * 1.3)
        head = [Paragraph("NO.", PH), Paragraph("DOCUMENT", PH), Paragraph("TENDER REF.", PH), Paragraph("PAGE", PH)]
        rows = [[Paragraph(_esc(e["no"]), pb_), Paragraph(_esc(e["title"].upper()), p_), Paragraph(_esc(e.get("ref", "")), PS),
                 Paragraph(_esc(e.get("pages", "")), pb_)] for e in entries]
        tb = Table([head] + rows, colWidths=cw)
        tb.setStyle(_index_style())
        if tb.wrap(width, avail1)[1] <= avail1:
            break
    day, time = _closing(t)
    i = 0
    first = True
    while i < len(rows) or first:
        brand.draw_letterhead(c)
        y = ytop - 4 * mm
        c.setFillColor(CHARCOAL)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(x0, y, f"CLOSING DATE: {day}")
        c.drawRightString(x1, y, f"TIME: {time}")
        y -= 11 * mm
        c.setFont("Helvetica-Bold", 22)
        c.drawString(x0, y, "INDEX")
        c.setFillColor(BLUE)
        c.rect(x0, y - 4 * mm, 24 * mm, 1.8 * mm, stroke=0, fill=1)
        c.setFillColor(GREY)
        c.setFont("Helvetica", 9)
        c.drawString(x0, y - 10 * mm, f"{_clean(t.get('tender_no'))}  |  {_clean(t.get('description'))}"[:118])
        top = y - 15 * mm
        avail = top - ybot
        chunk = []
        while i < len(rows):
            tb = Table([head] + chunk + [rows[i]], colWidths=cw)
            tb.setStyle(_index_style())
            _, th = tb.wrap(width, avail)
            if th > avail and chunk:
                break
            chunk.append(rows[i])
            i += 1
        tb = Table([head] + chunk, colWidths=cw)
        tb.setStyle(_index_style())
        _, th = tb.wrap(width, avail)
        tb.drawOn(c, x0, top - th)
        c.showPage()
        first = False
    c.save()
    return buf.getvalue()


def _index_style():
    return TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), CHARCOAL),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ALIGN", (3, 0), (3, -1), "RIGHT"),
    ])


# ------------------------------------------------- editable Word cover/index
def cover_docx(t: dict, prof: dict, out: str):
    doc = brand.new_document(top_in=2.0)
    brand.para(doc, "TENDER SUBMISSION", size=9, bold=True, color=brand.DOCX_BLUE, space_after=10)
    brand.para(doc, _client(t).upper(), size=20, bold=True, color=brand.DOCX_CHARCOAL, space_after=8)
    brand.para(doc, "CONTRACT No. " + _clean(t.get("tender_no")), size=13, bold=True, color=brand.DOCX_BLUE, space_after=6)
    brand.para(doc, _clean(t.get("description")).upper(), size=12.5, bold=True, space_after=18)
    day, time = _closing(t)
    rows = [["CLOSING DATE", f"{day}   TIME: {time}"],
            ["DELIVER TO", _clean(re.sub(r"\s*-{2,}\s*", ", ", t.get("delivery") or "As stated in the tender document"))],
            ["SUBMITTED BY", prof.get("legal_name") or "PUMP GROUP SA (PTY) LTD"],
            ["REGISTRATION", "  |  ".join(x for x in [f"Reg. {prof.get('reg_number')}", f"CSD {prof.get('csd_number')}", f"CIDB {prof.get('cidb_grading')}"] if not x.endswith("None") and x.split(" ", 1)[-1])],
            ["CONTACT", "  |  ".join(x for x in [prof.get("contact_person"), prof.get("cellphone") or prof.get("telephone"), prof.get("email")] if x)]]
    brand.table(doc, ["", ""], rows, widths_in=[1.4, 4.6], header_fill="FFFFFF")
    doc.save(out)


def index_docx(entries: list[dict], t: dict, out: str):
    doc = brand.new_document()
    day, time = _closing(t)
    p = brand.para(doc, "", space_after=4)
    brand.runs(p, [(f"CLOSING DATE: {day}", True), ("        ", False), (f"TIME: {time}", True)], size=10.5)
    brand.para(doc, "INDEX", size=22, bold=True, color=brand.DOCX_CHARCOAL, space_after=2)
    brand.para(doc, f"{_clean(t.get('tender_no'))}  |  {_clean(t.get('description'))}", size=9, color=brand.DOCX_CHARCOAL, space_after=10)
    brand.table(doc, ["NO.", "DOCUMENT", "TENDER REF.", "PAGE"],
                [[e["no"], e["title"].upper(), e.get("ref", ""), e.get("pages", "")] for e in entries], widths_in=[0.5, 4.0, 1.0, 0.8])
    doc.save(out)


# ---------------------------------------------------------- page numbering
def _stamp(page: PageObject, text: str, on_letterhead: bool):
    pw, ph = float(page.mediabox.width), float(page.mediabox.height)
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(pw, ph))
    c.setFont("Helvetica", 7.5)
    if on_letterhead:
        # just above the letterhead's dark footer band, clear of the blue corner artwork
        c.setFillColor(GREY)
        c.drawString(pw * brand.SAFE["left"], ph * 0.072 + 2.2 * mm, text)
    else:
        tw = c.stringWidth(text, "Helvetica", 7.5)
        c.setFillColor(colors.white)
        c.rect(pw - 9.5 * mm - tw, 1.6 * mm, tw + 3 * mm, 4.2 * mm, stroke=0, fill=1)
        c.setFillColor(GREY)
        c.drawRightString(pw - 8 * mm, 2.8 * mm, text)
    c.save()
    page.merge_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])


def _file_pages(path: str) -> list[PageObject]:
    p = path.lower()
    if p.endswith(".pdf"):
        r = PdfReader(path)
        if r.is_encrypted:
            try:
                r.decrypt("")
            except Exception:
                pass
        return list(r.pages)
    if p.endswith((".png", ".jpg", ".jpeg", ".webp")):
        from reportlab.lib.utils import ImageReader
        img = ImageReader(path)
        iw, ih = img.getSize()
        scale = min((W - 20 * mm) / iw, (H - 20 * mm) / ih)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=A4)
        c.drawImage(img, (W - iw * scale) / 2, (H - ih * scale) / 2, iw * scale, ih * scale, mask="auto")
        c.showPage()
        c.save()
        return _pages(buf.getvalue())
    raise ValueError(f"Cannot add {Path(path).name} to the pack (PDF or image only)")


def compile_pack(sections: list[dict], t: dict, prof: dict, out: str, index_pdf: str, index_word: str,
                 cover_pdf: str, cover_word: str, dividers: bool = True) -> list[dict]:
    """sections: [{no, title, ref, files: [paths], note, missing}] in the tender's order.
    Writes the complete print-ready PDF: cover, index, then each section (divider + documents),
    numbered "Page x of N". Also writes the cover and index as separate PDF and Word files."""
    bodies = []  # list of (pages, flags_on_letterhead)
    for s in sections:
        pages, flags = [], []
        if dividers:
            dp = _pages(divider_page(s["no"], s["title"], s.get("ref", ""), t, s.get("note", ""), s.get("missing", False)))
            pages += dp
            flags += [True] * len(dp)
        for f in s.get("files", []):
            path, on_lh = (f["path"], bool(f.get("letterhead"))) if isinstance(f, dict) else (f, bool(s.get("letterhead_files")))
            try:
                fp = _file_pages(path)
                pages += fp
                flags += [on_lh] * len(fp)
            except Exception as e:
                s.setdefault("problems", []).append(f"{Path(path).name}: {e}")
        bodies.append((pages, flags))
    cover = _pages(cover_page(t, prof))
    entries = [{"no": s["no"], "title": s["title"], "ref": s.get("ref", ""), "pages": ""} for s in sections]
    n_index = len(_pages(index_pages(entries, t)))
    page = len(cover) + n_index + 1
    reserves = [int(s.get("reserve") or 0) for s in sections]
    for e, (pages, _), rsv in zip(entries, bodies, reserves):
        n = len(pages) + rsv
        e["pages"] = "" if not n else (f"{page}" if n == 1 else f"{page}-{page + n - 1}")
        page += n
    idx = _pages(index_pages(entries, t))
    total = len(cover) + len(idx) + sum(len(b[0]) for b in bodies) + sum(reserves)
    w = PdfWriter()
    n = 0
    label = f"{_clean(prof.get('legal_name') or 'Pump Group SA')}  |  {_clean(t.get('tender_no'))}"
    allp = [(p, True, 0) for p in cover + idx]
    for (pages, flags), rsv in zip(bodies, reserves):
        allp += [(p, f, 0) for p, f in zip(pages, flags)]
        if rsv and allp:
            pg_, f_, r_ = allp[-1]
            allp[-1] = (pg_, f_, r_ + rsv)  # the original document's pages go in after this page
    for pg, on_lh, skip in allp:
        n += 1
        w.add_page(pg)
        if n > 1:
            _stamp(w.pages[-1], f"{label}  |  Page {n} of {total}", on_lh)
        n += skip
    with open(out, "wb") as fh:
        w.write(fh)
    for path, pages in ((index_pdf, idx), (cover_pdf, cover)):
        wi = PdfWriter()
        for p in pages:
            wi.add_page(p)
        with open(path, "wb") as fh:
            wi.write(fh)
    index_docx(entries, t, index_word)
    cover_docx(t, prof, cover_word)
    return entries


# ---------------------------------------------------------------- checklist
def checklist_pdf(out: str, t: dict, prof: dict, items: list[tuple[str, list[str]]]):
    from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Spacer
    x0, ytop, x1, ybot = brand.safe_box()
    doc = BaseDocTemplate(out, pagesize=A4, title=f"Submission checklist {_clean(t.get('tender_no'))}")
    frame = Frame(x0, ybot, x1 - x0, ytop - ybot, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="lh", frames=[frame], onPage=lambda c, d: brand.draw_letterhead(c))])
    story = [Paragraph("SUBMISSION CHECKLIST", ParagraphStyle("h", parent=P, fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=CHARCOAL)),
             Paragraph(_esc(f"{_clean(t.get('tender_no'))}  |  {_clean(t.get('description'))}"), PS),
             Paragraph(_esc(f"{_client(t)}  |  closes {fmt_dt(t.get('closes_at'))}"), PB),
             Spacer(1, 8)]

    def box():
        b = Table([[""]], colWidths=[3.4 * mm], rowHeights=[3.4 * mm])
        b.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.8, INK)]))
        return b
    for heading, lines in items:
        if not lines:
            continue
        story.append(Paragraph(_esc(heading).upper(), ParagraphStyle("hh", parent=P, fontName="Helvetica-Bold", fontSize=10, leading=14, spaceBefore=8, textColor=BLUE)))
        rows = [[box(), Paragraph(_esc(l), P)] for l in lines]
        tb = Table(rows, colWidths=[8 * mm, (x1 - x0) - 8 * mm])
        tb.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("TOPPADDING", (0, 0), (-1, -1), 2), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
        story.append(tb)
    doc.build(story)
