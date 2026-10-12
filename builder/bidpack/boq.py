"""Find the Bill of Quantities in a tender document, price it from the rates library,
write the rates and amounts back into the document, and produce a priced workbook.

Rates come only from the rates library. An item with no confident match is left
unpriced and highlighted, never guessed. Provisional sums and amounts already
printed in the document are kept as they are.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field, asdict
from difflib import SequenceMatcher

from .common import is_blank, money, norm, parse_number

HEAD = {
    "item": re.compile(r"^(item|no\.?|item no\.?|ref|pay ?item|clause)$|^item\b", re.I),
    "desc": re.compile(r"desc|particulars|work|activity", re.I),
    "unit": re.compile(r"^unit|^uom|measure", re.I),
    "qty": re.compile(r"qty|quant|^no\.? of|estimated", re.I),
    "rate": re.compile(r"rate|unit price|price per", re.I),
    "amount": re.compile(r"amount|total|price$|value|extension", re.I),
}
TOTAL_RE = re.compile(r"(sub-?total|total|carried (forward|to|over)|brought forward|to summary|c/f|b/f)", re.I)
PROV_RE = re.compile(r"provisional sum|prime cost|p\.?c\.? sum|prov\.? sum|contingenc", re.I)


@dataclass
class BoqRow:
    source: str               # file name
    ref: dict                 # where it lives: {"kind": "docx", "table": i, "row": r, "rate_col": c, "amount_col": c} or pdf bboxes
    item: str = ""
    description: str = ""
    unit: str = ""
    qty: float | None = None
    rate: float | None = None
    amount: float | None = None
    kind: str = "item"        # item | heading | total | provisional | rate_only
    section: str = ""
    rate_source: str = ""
    match_score: float = 0.0
    matched_description: str = ""
    preset_amount: float | None = None
    buildup_code: str = ""
    rate_basis: str = ""
    rate_today: float | None = None   # library rate before the escalation uplift

    def as_dict(self):
        return asdict(self)


def _map_header(cells: list[str]) -> dict | None:
    cols = {}
    for i, t in enumerate(cells):
        t = (t or "").strip().replace("\n", " ")
        for k, rx in HEAD.items():
            if k not in cols and rx.search(t):
                if k == "amount" and "rate" in cols and cols["rate"] == i:
                    continue
                if k == "item" and HEAD["desc"].search(t):
                    continue
                cols[k] = i
                break
    if {"desc", "unit", "qty", "rate"} <= cols.keys() or {"desc", "rate", "amount"} <= cols.keys():
        return cols
    return None


def _classify(r: BoqRow):
    d = r.description.strip()
    if r.preset_amount is not None and PROV_RE.search(d):
        r.kind = "provisional"
    elif TOTAL_RE.search(d) and r.qty is None and not r.unit:
        r.kind = "total"
    elif r.qty is None and not r.unit and d:
        r.kind = "heading"
    elif r.qty is None and r.unit:
        r.kind = "rate_only"


# ---------------------------------------------------------------- extraction
def extract_docx(path: str) -> list[BoqRow]:
    from docx import Document
    from .fill_docx import _unique_cells
    doc = Document(path)
    rows: list[BoqRow] = []
    cols = None
    section = ""
    for ti, table in enumerate(doc.tables):
        for ri, row in enumerate(table.rows):
            cells = [c.text.strip() for c in _unique_cells(row)]
            h = _map_header(cells)
            if h:
                cols = h
                continue
            if not cols or len(cells) <= max(cols.values()):
                continue
            g = lambda k: cells[cols[k]] if k in cols and cols[k] < len(cells) else ""
            desc = g("desc")
            if not desc and not g("item"):
                continue
            r = BoqRow(source=path, ref={"kind": "docx", "table": ti, "row": ri,
                                         "rate_col": cols.get("rate"), "amount_col": cols.get("amount")},
                       item=g("item"), description=desc, unit=g("unit"), qty=parse_number(g("qty")))
            pa = parse_number(g("amount")) if "amount" in cols else None
            r.preset_amount = pa
            pr = parse_number(g("rate")) if "rate" in cols else None
            if pr is not None:
                r.rate, r.rate_source = pr, "printed in document"
            _classify(r)
            if r.kind == "heading":
                section = desc[:80]
            r.section = section
            rows.append(r)
        # a new table without its own header keeps the previous column map (BoQ continued)
    return rows


def extract_pdf(path: str) -> list[BoqRow]:
    import pdfplumber
    rows: list[BoqRow] = []
    cols = None
    section = ""
    with pdfplumber.open(path) as pdf:
        for pno, page in enumerate(pdf.pages):
            try:
                tables = page.find_tables()
            except Exception:
                continue
            for tb in tables:
                for row in tb.rows:
                    boxes = row.cells
                    cells = [((page.crop(b).extract_text() or "").strip() if b else "") for b in boxes]
                    h = _map_header(cells)
                    if h:
                        cols = h
                        continue
                    if not cols or len(cells) <= max(cols.values()):
                        continue
                    g = lambda k: cells[cols[k]] if k in cols and cols[k] < len(cells) else ""
                    desc = g("desc").replace("\n", " ")
                    if not desc and not g("item"):
                        continue
                    r = BoqRow(source=path, ref={"kind": "pdf", "page": pno,
                                                 "rate_box": boxes[cols["rate"]] if "rate" in cols else None,
                                                 "amount_box": boxes[cols["amount"]] if "amount" in cols else None},
                               item=g("item"), description=desc, unit=g("unit"), qty=parse_number(g("qty")))
                    r.preset_amount = parse_number(g("amount")) if "amount" in cols else None
                    pr = parse_number(g("rate")) if "rate" in cols else None
                    if pr is not None:
                        r.rate, r.rate_source = pr, "printed in document"
                    _classify(r)
                    if r.kind == "heading":
                        section = desc[:80]
                    r.section = section
                    rows.append(r)
    return rows


def extract_xlsx(path: str) -> list[BoqRow]:
    from openpyxl import load_workbook
    wb = load_workbook(path, data_only=True)
    rows: list[BoqRow] = []
    for ws in wb.worksheets:
        cols = None
        section = ""
        for r_i, row in enumerate(ws.iter_rows(values_only=True), start=1):
            cells = ["" if v is None else str(v) for v in row]
            h = _map_header(cells)
            if h:
                cols = h
                continue
            if not cols or len(cells) <= max(cols.values()):
                continue
            g = lambda k: cells[cols[k]] if k in cols else ""
            if not g("desc") and not g("item"):
                continue
            r = BoqRow(source=path, ref={"kind": "xlsx", "sheet": ws.title, "row": r_i,
                                         "rate_col": (cols.get("rate") or 0) + 1, "amount_col": (cols.get("amount") or 0) + 1 if "amount" in cols else None},
                       item=g("item"), description=g("desc"), unit=g("unit"), qty=parse_number(g("qty")))
            r.preset_amount = parse_number(g("amount")) if "amount" in cols else None
            _classify(r)
            if r.kind == "heading":
                section = r.description[:80]
            r.section = section
            rows.append(r)
    return rows


def extract(path: str) -> list[BoqRow]:
    p = path.lower()
    if p.endswith(".docx"):
        return extract_docx(path)
    if p.endswith(".pdf"):
        return extract_pdf(path)
    if p.endswith((".xlsx", ".xlsm")):
        return extract_xlsx(path)
    return []


# ------------------------------------------------------------------- pricing
UNIT_ALIASES = {
    "m3": ["m3", "m³", "cu m", "cum", "cubic metre", "cubic meter"],
    "m2": ["m2", "m²", "sq m", "sqm", "square metre", "square meter"],
    "m": ["m", "lm", "metre", "meter", "lin m", "running metre"],
    "km": ["km"],
    "no": ["no", "nr", "no.", "each", "ea", "number", "item", "unit", "units"],
    "sum": ["sum", "ls", "lump sum", "l/s", "prov sum", "ps"],
    "t": ["t", "ton", "tonne", "tons", "tonnes"],
    "kg": ["kg"],
    "l": ["l", "litre", "liter", "kl"],
    "hr": ["hr", "hrs", "h", "hour", "hours"],
    "day": ["day", "days"],
    "week": ["week", "wk", "weeks"],
    "month": ["month", "months", "mo", "mth"],
    "%": ["%", "percent"],
    "m3km": ["m3-km", "m3.km", "m3km", "m³-km", "m³.km"],
}
_UNIT = {a: k for k, al in UNIT_ALIASES.items() for a in al}


def norm_unit(u: str) -> str:
    u = (u or "").strip().lower().replace(" ", " ")
    return _UNIT.get(u, _UNIT.get(u.rstrip("."), u))


STOP = set("of the and in to for a an with on at by from as or all be including incl complete m mm".split())


def _stem(t: str) -> str:
    for suf in ("ations", "ation", "ings", "ing", "ions", "ion", "ment", "ed", "es", "s", "e"):
        if len(t) > len(suf) + 3 and t.endswith(suf):
            return t[: -len(suf)]
    return t


def _tokens(s):
    return {_stem(t) for t in norm(s).split() if t not in STOP and len(t) > 1 and not t.replace(".", "").isdigit()}


def _numbers(s):
    return set(re.findall(r"\d+(?:[.,]\d+)?", s or ""))


def score(a: str, b: str) -> float:
    """0..1 similarity of two BoQ descriptions (word stems, word order, and the numbers in them)."""
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    contain = inter / min(len(ta), len(tb))
    jac = inter / len(ta | tb)
    s = 0.35 * SequenceMatcher(None, na, nb).ratio() + 0.35 * contain + 0.30 * jac
    na_, nb_ = _numbers(a), _numbers(b)
    if na_ and nb_ and na_ != nb_:
        s *= 0.5  # different diameters, depth ranges or classes are different items
    return s


def price(rows: list[BoqRow], rates: list[dict], threshold: float = 0.55, uplift: float = 0.0) -> dict:
    """Match unpriced items to the rates library. Library rates are today's (escalated) rates;
    uplift adds expected escalation to mid-contract for fixed-price contracts. Section totals are
    only filled when every item above them is priced."""
    lib = [r for r in rates if r.get("rate") not in (None, "")]
    for r in rows:
        if r.kind not in ("item", "rate_only") or r.rate is not None:
            continue
        u = norm_unit(r.unit)
        best, best_s = None, 0.0
        for cand in lib:
            cu = norm_unit(cand.get("unit") or "")
            if u and cu and u != cu:
                continue
            s = score(r.description, cand.get("description", ""))
            if cand.get("code") and r.item and str(cand["code"]).strip() == r.item.strip():
                s += 0.05
            if s > best_s:
                best, best_s = cand, s
        if best and best_s >= threshold:
            r.rate_today = float(best["rate"])
            r.rate = round(float(best["rate"]) * (1 + (uplift or 0)), 2)
            r.rate_source = best.get("source") or "rates library"
            r.match_score = round(best_s, 2)
            r.matched_description = best.get("description", "")
            r.buildup_code = best.get("buildup_code") or ""
            r.rate_basis = best.get("rate_basis") or ""
    # amounts and totals
    running = 0.0
    complete = True
    priced = unpriced = 0
    for r in rows:
        if r.kind == "item":
            if r.rate is not None and r.qty is not None:
                r.amount = round(r.rate * r.qty, 2)
                running += r.amount
                priced += 1
            else:
                r.amount = None
                complete = False
                unpriced += 1
        elif r.kind == "provisional":
            r.amount = r.preset_amount
            running += r.preset_amount or 0
        elif r.kind == "rate_only":
            if r.rate is None:
                unpriced += 1
            else:
                priced += 1
        elif r.kind == "total":
            r.amount = round(running, 2) if complete else None
            if re.search(r"carried|to summary|c/f", r.description, re.I):
                running = 0.0
                complete = True
    items = [r for r in rows if r.kind in ("item", "provisional")]
    return {
        "items": len([r for r in rows if r.kind in ("item", "rate_only")]),
        "priced": priced,
        "unpriced": unpriced,
        "subtotal": round(sum((r.amount or 0) for r in items), 2),
    }


# ---------------------------------------------------- write back into the doc
def write_docx(path: str, rows: list[BoqRow]):
    from docx import Document
    from docx.shared import Pt
    from .fill_docx import _unique_cells
    doc = Document(path)
    for r in rows:
        if r.ref.get("kind") != "docx":
            continue
        t = doc.tables[r.ref["table"]]
        cells = _unique_cells(t.rows[r.ref["row"]])

        def put(col, val):
            if col is None or col >= len(cells) or val is None:
                return
            if not is_blank(cells[col].text):
                return
            p = cells[col].paragraphs[0]
            run = p.add_run(money(val))
            run.font.size = Pt(9)
            from docx.shared import RGBColor
            run.font.color.rgb = RGBColor(0xC0, 0x00, 0x00)
            p.alignment = 2  # right
        if r.kind in ("item", "rate_only") and r.rate is not None and r.rate_source != "printed in document":
            put(r.ref.get("rate_col"), r.rate)
        if r.kind in ("item", "total") and r.amount is not None:
            put(r.ref.get("amount_col"), r.amount)
    doc.save(path)


def write_pdf(src: str, dst: str, rows: list[BoqRow]):
    from pypdf import PdfReader, PdfWriter
    from reportlab.pdfgen import canvas
    reader = PdfReader(src)
    writer = PdfWriter(clone_from=reader)
    by_page = {}
    for r in rows:
        if r.ref.get("kind") == "pdf":
            by_page.setdefault(r.ref["page"], []).append(r)
    for pno, rs in by_page.items():
        page = reader.pages[pno]
        W, H = float(page.mediabox.width), float(page.mediabox.height)
        buf = io.BytesIO()
        c = canvas.Canvas(buf, pagesize=(W, H))
        c.setFillColorRGB(0.75, 0.0, 0.0)
        c.setFont("Helvetica", 8)
        n = 0
        for r in rs:
            for box, val in ((r.ref.get("rate_box"), r.rate if r.kind in ("item", "rate_only") and r.rate_source != "printed in document" else None),
                             (r.ref.get("amount_box"), r.amount if r.kind in ("item", "total") else None)):
                if box is None or val is None:
                    continue
                x0, top, x1, bottom = box
                c.drawRightString(x1 - 3, H - (top + bottom) / 2 - 3, money(val))
                n += 1
        c.save()
        if n:
            writer.pages[pno].merge_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])
    with open(dst, "wb") as fh:
        writer.write(fh)


# --------------------------------------------------------- priced workbook
def write_workbook(rows: list[BoqRow], out: str, tender: dict, profile: dict, summary: dict, vat_rate: float | None = None):
    from openpyxl import Workbook
    from openpyxl.comments import Comment
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    if vat_rate is None:
        vat_rate = 0.15 if (profile.get("vat_number") or "").strip() and not re.search(r"not", profile.get("vat_number", ""), re.I) else 0.0
    wb = Workbook()
    ws = wb.active
    ws.title = "Priced BoQ"
    f = Font(name="Arial", size=10)
    fb = Font(name="Arial", size=10, bold=True)
    blue = Font(name="Arial", size=10, color="0000FF")
    yellow = PatternFill("solid", fgColor="FFFF00")
    head_fill = PatternFill("solid", fgColor="DDE3DD")
    thin = Side(style="thin", color="BBBBBB")
    ws["A1"] = f"{profile.get('legal_name') or 'Pump Group'}: priced Bill of Quantities"
    ws["A1"].font = Font(name="Arial", size=12, bold=True)
    desc = re.sub(r"\s+", " ", tender.get("description", "") or "")[:150]
    ws["A2"] = f"{tender.get('tender_no', '')}  {desc}"
    ws["A2"].font = f
    ws["A3"] = "Blue figures are rates from the rates library; yellow cells still need a rate. Amount = Qty x Rate. All amounts exclude VAT."
    ws["A3"].font = Font(name="Arial", size=9, italic=True)
    headers = ["Item", "Description", "Unit", "Qty", "Rate (R)", "Amount (R)", "Section", "Rate source", "Match", "Library description used"]
    hr = 5
    for i, h in enumerate(headers, 1):
        c = ws.cell(hr, i, h)
        c.font = fb
        c.fill = head_fill
        c.border = Border(bottom=thin)
    r_i = hr + 1
    first = r_i
    for r in rows:
        ws.cell(r_i, 1, r.item).font = f
        d = ws.cell(r_i, 2, r.description)
        d.font = fb if r.kind in ("heading", "total") else f
        d.alignment = Alignment(wrap_text=True, vertical="top")
        ws.cell(r_i, 3, r.unit).font = f
        if r.qty is not None:
            ws.cell(r_i, 4, r.qty).font = f
        if r.kind in ("item", "rate_only"):
            rc = ws.cell(r_i, 5, r.rate)
            rc.font = blue
            if r.rate is None:
                rc.fill = yellow
            ws.cell(r_i, 6, f'=IF(AND(ISNUMBER(D{r_i}),ISNUMBER(E{r_i})),D{r_i}*E{r_i},0)').font = f
        elif r.kind == "provisional":
            ws.cell(r_i, 6, r.preset_amount).font = blue
        elif r.kind == "total":
            # sum the amounts above, back to the previous total row
            ws.cell(r_i, 6, f"=SUMIFS(F{first}:F{r_i - 1},K{first}:K{r_i - 1},\"x\")").font = fb
        ws.cell(r_i, 7, r.section).font = f
        ws.cell(r_i, 8, r.rate_source).font = f
        if r.match_score:
            ws.cell(r_i, 9, r.match_score).font = f
        ws.cell(r_i, 10, r.matched_description).font = f
        ws.cell(r_i, 11, "x" if r.kind in ("item", "rate_only", "provisional") else "").font = Font(name="Arial", size=8, color="FFFFFF")
        if r.kind == "total" and re.search(r"carried|to summary|c/f", r.description, re.I):
            first = r_i + 1
        for col in (4, 5, 6):
            ws.cell(r_i, col).number_format = '#,##0.00;(#,##0.00);"-"'
        r_i += 1
    last = r_i - 1
    for col, w in zip("ABCDEFGHIJK", (9, 60, 8, 11, 13, 15, 26, 18, 7, 50, 3)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = ws.cell(hr + 1, 1)

    s = wb.create_sheet("Summary")
    s["A1"] = "Tender summary"
    s["A1"].font = Font(name="Arial", size=12, bold=True)
    lines = [
        ("Measured work and provisional sums", f"=SUMIFS('Priced BoQ'!F{hr + 1}:F{last},'Priced BoQ'!K{hr + 1}:K{last},\"x\")", None),
        ("Contingencies (%)", 0, "Enter the contingency percentage the tender prescribes, as a fraction (0.10 = 10%)."),
        ("Contingencies (R)", "=B3*B4", None),
        ("Escalation / other allowances (R)", 0, "Only if the BoQ summary asks for it."),
        ("Subtotal excluding VAT", "=B3+B5+B6", None),
        ("VAT rate", vat_rate, "15% applies only if the bidder is VAT registered; check the company details."),
        ("VAT (R)", "=B7*B8", None),
        ("Tender sum including VAT", "=B7+B9", None),
        ("Items in the BoQ", summary.get("items", 0), None),
        ("Items still without a rate", f"=COUNTIFS('Priced BoQ'!K{hr + 1}:K{last},\"x\",'Priced BoQ'!E{hr + 1}:E{last},\"\")", None),
    ]
    for i, (label, val, note) in enumerate(lines, start=3):
        s.cell(i, 1, label).font = f
        c = s.cell(i, 2, val)
        c.font = blue if note else fb if "Tender sum" in label else f
        c.number_format = '0%' if "rate" in label.lower() or "(%)" in label else '#,##0.00;(#,##0.00);"-"'
        if note:
            c.fill = yellow
            c.comment = Comment(note, "Bid pack")
    s["B11"].number_format = "0"
    s["B12"].number_format = "0"
    s.column_dimensions["A"].width = 40
    s.column_dimensions["B"].width = 20
    s["A15"] = "Yellow cells are inputs to confirm. The tender's own Summary of Bill of Quantities page is filled from these figures."
    s["A15"].font = Font(name="Arial", size=9, italic=True)
    wb.save(out)
