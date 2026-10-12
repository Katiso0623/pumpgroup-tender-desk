"""Documents Pump Group writes for each tender, on the company letterhead:
method statement (from the Tender Desk's draft for the tender's scope), construction programme
(bar chart), and schedules (key personnel, completed projects, functionality response).

Drafts are written for the user to review. Nothing here claims a fact that is not in
the company details, library or personnel records."""
from __future__ import annotations

import io
import re

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

from . import brand
from .brand import BLUE, CHARCOAL, GREY, INK, RULE


def _clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _heading_block(doc, title: str, t: dict):
    brand.para(doc, title.upper(), size=18, bold=True, color=brand.DOCX_CHARCOAL, space_after=2)
    p = brand.para(doc, "", space_after=2)
    brand.runs(p, [("Contract: ", True), (_clean(t.get("tender_no")), False)], size=9.5)
    p = brand.para(doc, "", space_after=2)
    brand.runs(p, [("Project: ", True), (_clean(t.get("description"))[:220], False)], size=9.5)
    p = brand.para(doc, "", space_after=12)
    brand.runs(p, [("Employer: ", True), (_clean(t.get("organ_of_state")), False)], size=9.5)


# ------------------------------------------------------------ method statement
def method_statement(t: dict, prof: dict, spec: dict, out_docx: str) -> dict:
    """spec: {"title": "Method statement", "sections": [{"heading": "...", "body": "text" | ["para", "- bullet", ...]}]}"""
    doc = brand.new_document()
    _heading_block(doc, spec.get("title") or "Method statement", t)
    for i, s in enumerate(spec.get("sections") or [], 1):
        brand.para(doc, f"{i}. {s.get('heading', '').upper()}", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4)
        body = s.get("body") or []
        if isinstance(body, str):
            body = [x for x in body.split("\n") if x.strip()]
        for line in body:
            if line.lstrip().startswith(("- ", "* ", "• ")):
                from docx.shared import Pt
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Pt(16)
                p.paragraph_format.first_line_indent = Pt(-10)
                p.paragraph_format.space_after = Pt(2)
                b = p.add_run("•  ")
                b.font.size = Pt(10)
                b.font.color.rgb = brand.DOCX_BLUE
                r = p.add_run(line.lstrip()[2:].strip())
                r.font.size = Pt(10)
            else:
                brand.para(doc, line.strip(), size=10, space_after=5)
        if s.get("table"):
            tb = s["table"]
            brand.table(doc, tb["header"], tb["rows"], widths_in=tb.get("widths"), size=9)
            brand.para(doc, "", space_after=4)
    brand.para(doc, "", space_after=10)
    brand.para(doc, f"Prepared by {prof.get('legal_name') or 'Pump Group SA (Pty) Ltd'}", size=9.5, italic=True, space_after=0)
    brand.signature_block(doc, [(prof.get("signatory_name") or "").upper(), prof.get("signatory_capacity") or "Managing Director"])
    pdf = brand.save_docx_and_pdf(doc, out_docx)
    return {"docx": out_docx, "pdf": pdf}


# ------------------------------------------------------------------ programme
def programme_pdf(t: dict, prof: dict, spec: dict, out_pdf: str) -> dict:
    """Bar-chart programme on the letterhead.
    spec: {"unit": "week", "duration": 40, "start_label": "Site handover",
           "activities": [{"name": "Site establishment", "start": 0, "length": 2, "group": "Preliminaries", "milestone": false}]}
    start and length are in units from site handover."""
    acts = spec.get("activities") or []
    unit = spec.get("unit") or "week"
    total = int(spec.get("duration") or max([a.get("start", 0) + a.get("length", 1) for a in acts] or [1]))
    W, H = A4
    x0, ytop, x1, ybot = brand.safe_box()
    name_w = 62 * mm
    gx0, gx1 = x0 + name_w, x1
    unit_w = (gx1 - gx0) / max(total, 1)
    row_h = 5.2 * mm
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)

    def header(first: bool):
        brand.draw_letterhead(c)
        y = ytop - 2 * mm
        c.setFillColor(CHARCOAL)
        c.setFont("Helvetica-Bold", 16)
        c.drawString(x0, y - 5 * mm, (spec.get("title") or "Construction programme").upper())
        c.setFont("Helvetica", 8.5)
        c.setFillColor(GREY)
        c.drawString(x0, y - 10 * mm, f"{_clean(t.get('tender_no'))}  |  {_clean(t.get('description'))}"[:120])
        c.drawString(x0, y - 14 * mm, f"Contract period {total} {unit}s from {spec.get('start_label') or 'site handover'}. "
                                      f"Bars show planned durations; diamonds are milestones.")
        y -= 20 * mm
        # time scale
        c.setFillColor(CHARCOAL)
        c.rect(x0, y - 6 * mm, x1 - x0, 6 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 7.5)
        c.drawString(x0 + 2 * mm, y - 4.2 * mm, "ACTIVITY")
        step = 1 if total <= 20 else 2 if total <= 40 else 4 if total <= 80 else 8
        c.setFont("Helvetica", 6.5)
        for k in range(0, total, step):
            c.drawCentredString(gx0 + (k + step / 2) * unit_w if step > 1 else gx0 + (k + 0.5) * unit_w, y - 4.2 * mm, str(k + 1))
        return y - 6 * mm

    y = header(True)
    group = None
    for a in acts:
        if y - row_h < ybot + 8 * mm:
            c.showPage()
            y = header(False)
        if a.get("group") and a["group"] != group:
            group = a["group"]
            c.setFillColor(colors.HexColor("#E8F6FC"))
            c.rect(x0, y - row_h, x1 - x0, row_h, stroke=0, fill=1)
            c.setFillColor(CHARCOAL)
            c.setFont("Helvetica-Bold", 7.5)
            c.drawString(x0 + 2 * mm, y - row_h + 1.6 * mm, group.upper()[:60])
            y -= row_h
        # grid line
        c.setStrokeColor(RULE)
        c.setLineWidth(0.3)
        c.line(x0, y - row_h, x1, y - row_h)
        c.setFillColor(INK)
        c.setFont("Helvetica", 7.5)
        nm = _clean(a.get("name"))
        while c.stringWidth(nm, "Helvetica", 7.5) > name_w - 4 * mm and len(nm) > 4:
            nm = nm[:-2]
        c.drawString(x0 + 2 * mm, y - row_h + 1.6 * mm, nm if nm == _clean(a.get("name")) else nm + "…")
        s, L = float(a.get("start", 0)), float(a.get("length", 1))
        if a.get("milestone"):
            cx, cy = gx0 + s * unit_w, y - row_h / 2
            c.setFillColor(CHARCOAL)
            p = c.beginPath()
            p.moveTo(cx, cy + 2 * mm); p.lineTo(cx + 2 * mm, cy); p.lineTo(cx, cy - 2 * mm); p.lineTo(cx - 2 * mm, cy); p.close()
            c.drawPath(p, stroke=0, fill=1)
        else:
            c.setFillColor(BLUE)
            c.roundRect(gx0 + s * unit_w, y - row_h + 1.1 * mm, max(L * unit_w, 1.2), row_h - 2.2 * mm, 1, stroke=0, fill=1)
        y -= row_h
    # vertical grid
    c.setStrokeColor(RULE)
    c.setLineWidth(0.2)
    c.showPage()
    c.save()
    with open(out_pdf, "wb") as fh:
        fh.write(buf.getvalue())
    return {"pdf": out_pdf, "activities": len(acts), "duration": total}


# ------------------------------------------------------------------ schedules
def schedule(t: dict, prof: dict, title: str, intro: str, header: list[str], rows: list[list], out_docx: str,
             widths: list[float] | None = None, notes: list[str] | None = None, sign: bool = True) -> dict:
    doc = brand.new_document()
    _heading_block(doc, title, t)
    if intro:
        brand.para(doc, intro, size=10, space_after=8)
    brand.table(doc, header, rows, widths_in=widths, size=8.5)
    for n in notes or []:
        brand.para(doc, n, size=8.5, italic=True, space_after=2)
    if sign:
        brand.signature_block(doc, [(prof.get("signatory_name") or "").upper(), prof.get("signatory_capacity") or "Managing Director"])
    pdf = brand.save_docx_and_pdf(doc, out_docx)
    return {"docx": out_docx, "pdf": pdf}


def _money(v):
    try:
        return "R " + f"{float(v):,.0f}".replace(",", " ")
    except (TypeError, ValueError):
        return "-"


def experience_schedule(t: dict, prof: dict, projects: list[dict], out_docx: str) -> dict:
    rows = []
    for i, d in enumerate(projects, 1):
        rows.append([str(i), _clean(d.get("title")), _clean(d.get("client")) or "-", _money(d.get("project_value")),
                     (d.get("completed_on") or "")[:10] or "-", d.get("cidb_class") or "-"])
    return schedule(t, prof, "Schedule of completed projects",
                    "Projects completed by the company. Appointment letters and completion certificates or reference letters for each project follow this schedule.",
                    ["No.", "Project", "Client", "Value", "Completed", "Class"], rows, out_docx, widths=[0.4, 2.6, 1.3, 1.0, 0.8, 0.5],
                    notes=["Values as stated on the client's letters (some include VAT)."])


def personnel_schedule(t: dict, prof: dict, team: list[dict], out_docx: str) -> dict:
    rows = []
    for m in team:
        p = m.get("person") or {}
        quals = "; ".join(q.get("name", "") for q in (p.get("qualifications") or [])[:2]) or "-"
        from datetime import date as _d
        def _reg(r):
            txt = f"{r.get('body')} {r.get('number') or ''}".strip()
            vt = str(r.get("valid_to") or "")[:10]
            if vt and vt < _d.today().isoformat():
                txt += f" (validation expired {vt}; renewal to be submitted)"
            return txt
        regs = "; ".join(_reg(r) for r in (p.get("registrations") or [])) or "-"
        yrs = m.get("years")
        rows.append([m.get("role", ""), p.get("full_name", "") or "NOT YET ASSIGNED", quals, regs, f"{yrs}" if yrs is not None else "-"])
    return schedule(t, prof, "Schedule of key personnel",
                    "Key personnel proposed for this contract. A CV, certified qualifications, professional registration and a letter of appointment for each person follow this schedule.",
                    ["Position", "Name", "Qualifications", "Registration", "Years"], rows, out_docx, widths=[1.3, 1.5, 2.0, 1.3, 0.5])


def functionality_schedule(t: dict, prof: dict, results: list[dict], where: dict, out_docx: str) -> dict:
    """Evaluator's guide: each criterion, what is offered and where it is in the pack."""
    rows = []
    for r in results:
        ev = [x for x in r.get("evidence", []) if x]
        if r.get("person"):
            what = r["person"]
        elif r.get("kind") == "company_experience":
            what = f"{len(ev)} completed project{'s' if len(ev) != 1 else ''}: " + "; ".join(ev) if ev else "-"
        else:
            what = "; ".join(ev) or "-"
        rows.append([_clean(r.get("criterion")), str(r.get("max_points") or "-"), what, where.get(r.get("criterion"), "-")])
    return schedule(t, prof, "Functionality: response schedule",
                    "How this bid responds to each functionality criterion and where the evidence is in this submission.",
                    ["Criterion", "Max points", "Offered", "Section"], rows, out_docx, widths=[1.9, 0.7, 2.7, 0.8], sign=False)
