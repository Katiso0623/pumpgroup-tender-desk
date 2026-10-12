"""Pump Group cost model workbook for one tender.

Sheets (all live formulas; yellow cells are inputs):
  Summary    measured work, provisional sums, P&G, contingency, escalation to mid-contract, VAT, tender sum
  BoQ        every BoQ line: library rate (already escalated to today's index), build-up rate, or your own rate
  P&G        time-related site team (from Resources) x contract months, plus fixed P&G inputs
  Build-ups  rate build-ups from resources (qty per unit x current resource rate, plus OH&P)
  Resources  labour, plant, materials: base rate x (index now / index at base date)
  Indices    latest value per index (type a new value to re-escalate everything) and history with sources
"""
from __future__ import annotations

import re
from datetime import date

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

F = Font(name="Arial", size=10)
FB = Font(name="Arial", size=10, bold=True)
FH = Font(name="Arial", size=10, bold=True, color="FFFFFF")
FBLUE = Font(name="Arial", size=10, color="0000FF")
FG = Font(name="Arial", size=10, color="008000")
FT = Font(name="Arial", size=13, bold=True, color="3D4045")
FN = Font(name="Arial", size=9, italic=True, color="5E6670")
YEL = PatternFill("solid", fgColor="FFFF00")
HEAD = PatternFill("solid", fgColor="3D4045")
BAND = PatternFill("solid", fgColor="E8F6FC")
THIN = Side(style="thin", color="C9D1D8")
NUM = '#,##0.00;(#,##0.00);"-"'
PCT = "0.0%"


def _hdr(ws, row, headers, widths=None):
    for i, h in enumerate(headers, 1):
        c = ws.cell(row, i, h)
        c.font = FH
        c.fill = HEAD
        c.alignment = Alignment(wrap_text=True, vertical="center")
    if widths:
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w


def _latest(indices: list[dict]) -> dict:
    out = {}
    for i in indices:
        k = i["key"]
        if k not in out or str(i["period"]) > str(out[k]["period"]):
            out[k] = i
    return out


def _yoy(indices: list[dict], key: str) -> float | None:
    rows = sorted([i for i in indices if i["key"] == key], key=lambda i: str(i["period"]))
    if len(rows) < 13:
        return None
    a, b = float(rows[-13]["value"]), float(rows[-1]["value"])
    return b / a - 1 if a else None


PG_RE = re.compile(r"preliminar|p\s*&\s*g\b|general (items|obligations)|establish|time.related|fixed.charge|contractual requirement", re.I)


def cpi_yoy(cost: dict) -> float | None:
    return _yoy(cost.get("indices") or [], "CPI")


def escalation_uplift(cost: dict, months: int | None, cpap: bool) -> float:
    """Escalation to build into fixed-price rates: CPI year on year compounded to mid-contract
    (two months to start plus half the contract period). Zero when the contract pays CPAP."""
    y = cpi_yoy(cost)
    if cpap or not y or not months:
        return 0.0
    return (1 + y) ** ((2 + months / 2) / 12) - 1


def build(out: str, tender: dict, profile: dict, cost: dict, boq_rows: list, months: int | None = None,
          contingency: float = 0.0, vat_registered: bool | None = None, cpap: bool | None = None,
          team_roles: list[str] | None = None):
    indices = cost.get("indices") or []
    defs = {d["key"]: d for d in (cost.get("index_defs") or [])}
    resources = cost.get("resources") or []
    buildups = cost.get("buildups") or []
    latest = _latest(indices)
    if vat_registered is None:
        vat_registered = bool(re.search(r"\d{10}", profile.get("vat_number") or ""))
    cpi_y = _yoy(indices, "CPI")
    if cpap is None:
        cpap = bool(months and months > 12)
    roles = [r.lower() for r in (team_roles or []) if r]

    wb = Workbook()
    S = wb.active
    S.title = "Summary"
    B = wb.create_sheet("BoQ")
    PG = wb.create_sheet("P&G")
    BU = wb.create_sheet("Build-ups")
    R = wb.create_sheet("Resources")
    I = wb.create_sheet("Indices")

    # ------------------------------------------------------------ Indices
    I["A1"] = "Cost indices (type a newer value in column D to re-escalate every rate)"
    I["A1"].font = FT
    _hdr(I, 3, ["Key", "Index", "Latest period", "Latest value", "Unit", "Source"], [13, 52, 13, 13, 10, 70])
    keys = sorted(set(list(defs.keys()) + list(latest.keys())))
    for r, k in enumerate(keys, start=4):
        lt = latest.get(k)
        I.cell(r, 1, k).font = FB
        I.cell(r, 2, defs.get(k, {}).get("label", k)).font = F
        I.cell(r, 3, str(lt["period"])[:7] if lt else "").font = F
        c = I.cell(r, 4, float(lt["value"]) if lt else None)
        c.font = FBLUE
        c.fill = YEL if not lt else PatternFill()
        I.cell(r, 5, defs.get(k, {}).get("unit", "")).font = F
        I.cell(r, 6, (lt or {}).get("source") or "No value yet: add one").font = FN
    idx_last = 3 + len(keys)
    hr = idx_last + 3
    I.cell(hr - 1, 1, "History").font = FB
    _hdr(I, hr, ["Key", "Period", "Value", "", "", "Source"])
    for r, row in enumerate(sorted(indices, key=lambda i: (i["key"], str(i["period"]))), start=hr + 1):
        I.cell(r, 1, row["key"]).font = F
        I.cell(r, 2, str(row["period"])[:7]).font = F
        I.cell(r, 3, float(row["value"])).font = F
        I.cell(r, 6, row.get("source") or "").font = FN
    IDX = f"Indices!$A$4:$A${idx_last}"
    IDXV = f"Indices!$D$4:$D${idx_last}"

    # ---------------------------------------------------------- Resources
    R["A1"] = "Resources: base rate x (index now / index at base date). Yellow rows are for your own quotes."
    R["A1"].font = FT
    _hdr(R, 3, ["Code", "Type", "Description", "Unit", "Base rate (R)", "Base date", "Index", "Index at base date",
                "Index now", "Current rate (R)", "Source"], [10, 11, 46, 8, 13, 11, 11, 12, 12, 14, 48])
    r = 4
    for res in resources:
        R.cell(r, 1, res.get("code")).font = FB
        R.cell(r, 2, res.get("type")).font = F
        R.cell(r, 3, res.get("description")).font = F
        R.cell(r, 4, res.get("unit")).font = F
        R.cell(r, 5, float(res.get("base_rate") or 0)).font = FBLUE
        R.cell(r, 6, str(res.get("base_date") or "")[:10]).font = F
        R.cell(r, 7, res.get("index_key") or "").font = F
        if res.get("index_base") not in (None, ""):
            R.cell(r, 8, float(res["index_base"])).font = FBLUE
        R.cell(r, 9, f'=IF(G{r}="","",IFERROR(INDEX({IDXV},MATCH(G{r},{IDX},0)),H{r}))').font = FG
        R.cell(r, 10, f'=IF(OR(G{r}="",H{r}="",I{r}=""),E{r},ROUND(E{r}*I{r}/H{r},2))').font = F
        R.cell(r, 11, res.get("source") or "").font = FN
        r += 1
    for _ in range(15):  # space for plant, material and subcontract quotes
        for col in (1, 2, 3, 4, 5, 6, 7, 8):
            R.cell(r, col).fill = YEL
        R.cell(r, 9, f'=IF(G{r}="","",IFERROR(INDEX({IDXV},MATCH(G{r},{IDX},0)),H{r}))').font = FG
        R.cell(r, 10, f'=IF(E{r}="","",IF(OR(G{r}="",H{r}="",I{r}=""),E{r},ROUND(E{r}*I{r}/H{r},2)))').font = F
        r += 1
    res_last = r - 1
    for row in R.iter_rows(min_row=4, max_row=res_last, min_col=5, max_col=10):
        for c in row:
            if c.column in (5, 10):
                c.number_format = NUM
    RC = f"Resources!$A$4:$A${res_last}"
    RV = f"Resources!$J$4:$J${res_last}"
    RD = f"Resources!$C$4:$C${res_last}"

    # ---------------------------------------------------------- Build-ups
    BU["A1"] = "Rate build-ups: quantity of each resource per unit of work, waste, and overheads and profit"
    BU["A1"].font = FT
    _hdr(BU, 3, ["Build-up", "Resource", "Description", "Qty per unit", "Waste %", "Current rate (R)", "Cost (R)"], [12, 11, 46, 12, 9, 15, 15])
    blocks = buildups or [{"code": "BU-001", "description": "Your first build-up (fill in the yellow cells)", "unit": "", "components": [{}, {}, {}], "ohp_pct": 0.15}]
    r = 4
    bu_rate_cells = {}
    for b in blocks:
        BU.cell(r, 1, b.get("code")).font = FB
        BU.cell(r, 3, f"{b.get('description')}  [{b.get('unit') or 'unit'}]").font = FB
        for col in range(1, 8):
            BU.cell(r, col).fill = BAND
        r += 1
        first = r
        comps = (b.get("components") or []) + [{}] * 2
        for comp in comps:
            BU.cell(r, 2, comp.get("resource")).font = FBLUE
            BU.cell(r, 4, comp.get("qty")).font = FBLUE
            BU.cell(r, 5, comp.get("waste_pct") or 0).font = FBLUE
            if not comp:
                for col in (2, 4, 5):
                    BU.cell(r, col).fill = YEL
            BU.cell(r, 3, f'=IF(B{r}="","",IFERROR(INDEX({RD},MATCH(B{r},{RC},0)),"Resource code not found"))').font = FG
            BU.cell(r, 6, f'=IF(B{r}="","",IFERROR(INDEX({RV},MATCH(B{r},{RC},0)),0))').font = FG
            BU.cell(r, 7, f'=IF(OR(B{r}="",D{r}=""),0,D{r}*(1+E{r})*F{r})').font = F
            BU.cell(r, 5).number_format = PCT
            for col in (6, 7):
                BU.cell(r, col).number_format = NUM
            r += 1
        BU.cell(r, 3, "Direct cost").font = FB
        BU.cell(r, 7, f"=SUM(G{first}:G{r - 1})").font = FB
        BU.cell(r, 7).number_format = NUM
        r += 1
        BU.cell(r, 3, "Overheads and profit").font = F
        c = BU.cell(r, 5, float(b.get("ohp_pct") or 0.15))
        c.font = FBLUE
        c.fill = YEL
        c.number_format = PCT
        BU.cell(r, 7, f"=G{r - 1}*E{r}").font = F
        BU.cell(r, 7).number_format = NUM
        r += 1
        BU.cell(r, 3, f"Rate per {b.get('unit') or 'unit'}").font = FB
        BU.cell(r, 7, f"=G{r - 2}+G{r - 1}").font = FB
        BU.cell(r, 7).number_format = NUM
        bu_rate_cells[b.get("code")] = f"'Build-ups'!$G${r}"
        r += 2

    # ---------------------------------------------------------------- P&G
    PG["A1"] = "Preliminary and general (P&G)"
    PG["A1"].font = FT
    PG["A3"] = "Contract period (months)"
    PG["A3"].font = FB
    c = PG["C3"]
    c.value = months
    c.font = FBLUE
    c.fill = YEL
    PG["D3"] = "From the tender's contract data" if months else "Enter the contract period from the tender"
    PG["D3"].font = FN
    _hdr(PG, 5, ["Item", "Resource", "Qty", "Unit", "Rate (R)", "Amount (R)", "Note"], [46, 11, 9, 9, 14, 16, 46])
    r = 6
    PG.cell(r, 1, "Time-related: site team").font = FB
    r += 1
    first = r
    for res in resources:
        if res.get("type") == "labour" and (res.get("unit") or "").lower().startswith("month"):
            desc = (res.get("description") or "").lower()
            on_team = any(rl in desc for rl in roles) if roles else True
            crew = bool(re.search(r"general workers|crew|labourers", desc))
            PG.cell(r, 1, res.get("description")).font = F
            PG.cell(r, 2, res.get("code")).font = F
            q = PG.cell(r, 3, "=$C$3" if on_team and not crew else 0)
            q.font = FG if on_team and not crew else FBLUE
            if not on_team or crew:
                q.fill = YEL
            PG.cell(r, 4, "month").font = F
            PG.cell(r, 5, f'=IFERROR(INDEX({RV},MATCH(B{r},{RC},0)),0)').font = FG
            PG.cell(r, 6, f"=C{r}*E{r}").font = F
            PG.cell(r, 7, "On this tender's team" if on_team and not crew else
                    ("Usually already in the BoQ rates: enter months only if not" if crew else "Not proposed for this tender: enter months if needed")).font = FN
            r += 1
    for label, unit, note in [("Site office, stores and ablutions", "month", "Hire quote"), ("Site vehicles", "month", ""),
                              ("Security", "month", ""), ("Site establishment", "sum", ""), ("De-establishment", "sum", ""),
                              ("Health and safety file and compliance", "sum", ""), ("Insurances and guarantee costs", "sum", "From insurer / bank"),
                              ("Setting out, testing and as-built survey", "sum", ""), ("Other", "sum", "")]:
        PG.cell(r, 1, label).font = F
        PG.cell(r, 3, "=$C$3" if unit == "month" else 1).font = FG if unit == "month" else F
        PG.cell(r, 4, unit).font = F
        PG.cell(r, 5).fill = YEL
        PG.cell(r, 5).font = FBLUE
        PG.cell(r, 6, f'=IF(E{r}="",0,C{r}*E{r})').font = F
        PG.cell(r, 7, note).font = FN
        r += 1
    for row in PG.iter_rows(min_row=first, max_row=r - 1, min_col=5, max_col=6):
        for c in row:
            c.number_format = NUM
    PG.cell(r, 1, "Total P&G").font = FB
    PG.cell(r, 6, f"=SUM(F{first}:F{r - 1})").font = FB
    PG.cell(r, 6).number_format = NUM
    PG_TOTAL = f"'P&G'!$F${r}"

    # ---------------------------------------------------------------- BoQ
    B["A1"] = f"Bill of Quantities: {tender.get('tender_no', '')}"
    B["A1"].font = FT
    B["A2"].font = FN
    UP = "Summary!$B$18"
    B["A2"] = ("Rate used = your rate (yellow) if entered, else the build-up or library rate (escalated to today's index) "
               "plus the escalation to mid-contract on the Summary, rounded to cents. Amounts are what the tender's BoQ will show.")
    _hdr(B, 4, ["Item", "Description", "Unit", "Qty", "Library rate today (R)", "Build-up", "Your rate (R)", "Rate used (R)",
                "Amount (R)", "Rate basis", "Kind", "Match", "Library item used", "P&G item"], [8, 56, 7, 10, 14, 10, 13, 13, 16, 14, 11, 7, 42, 9])
    r = 5
    b_first = r
    section_pg = False
    for row in boq_rows:
        g = row if isinstance(row, dict) else row.as_dict()
        kind = g.get("kind")
        if kind == "heading":
            section_pg = bool(PG_RE.search(g.get("description") or ""))
        if kind in ("item", "rate_only") and (section_pg or PG_RE.search(g.get("description") or "")):
            B.cell(r, 14, "P&G").font = FN
        B.cell(r, 1, g.get("item")).font = F
        d = B.cell(r, 2, g.get("description"))
        d.font = FB if kind in ("heading", "total") else F
        d.alignment = Alignment(wrap_text=True, vertical="top")
        B.cell(r, 3, g.get("unit")).font = F
        if g.get("qty") is not None:
            B.cell(r, 4, g.get("qty")).font = F
        B.cell(r, 11, kind).font = FN
        if kind in ("item", "rate_only"):
            lib_rate = g.get("rate_today") if g.get("rate_today") is not None else g.get("rate")
            if lib_rate is not None and g.get("rate_source") != "printed in document":
                B.cell(r, 5, lib_rate).font = FBLUE
            bu = g.get("buildup_code")
            if bu and bu in bu_rate_cells:
                B.cell(r, 6, bu).font = F
            y = B.cell(r, 7, g.get("rate") if g.get("rate_source") == "printed in document" else None)
            y.fill = YEL
            y.font = FBLUE
            bu_ref = bu_rate_cells.get(bu) if bu else None
            B.cell(r, 8, f'=IF(ISNUMBER(G{r}),ROUND(G{r},2),' + (f"ROUND(ROUND({bu_ref},2)*(1+{UP}),2)" if bu_ref else f'IF(ISNUMBER(E{r}),ROUND(E{r}*(1+{UP}),2),"")') + ")").font = F
            B.cell(r, 9, f'=IF(AND(ISNUMBER(D{r}),ISNUMBER(H{r})),ROUND(D{r}*H{r},2),0)' if kind == "item" else "=0").font = F
            B.cell(r, 10, f'=IF(ISNUMBER(G{r}),"Your rate",' + ('"Build-up"' if bu_ref else f'IF(ISNUMBER(E{r}),"Library (escalated)","NO RATE")') + ")").font = FN
            if g.get("match_score"):
                B.cell(r, 12, g["match_score"]).font = F
            B.cell(r, 13, g.get("matched_description") or "").font = FN
        elif kind == "provisional":
            c = B.cell(r, 7, g.get("preset_amount"))
            c.font = FBLUE
            B.cell(r, 9, f"=IF(ISNUMBER(G{r}),G{r},0)").font = F
            B.cell(r, 10, "Provisional sum").font = FN
        for col in (5, 7, 8, 9):
            B.cell(r, col).number_format = NUM
        r += 1
    b_last = max(r - 1, b_first)

    # ------------------------------------------------------------- Summary
    S["A1"] = f"{profile.get('legal_name') or 'Pump Group SA'}: tender cost model"
    S["A1"].font = FT
    S["A2"] = f"{tender.get('tender_no', '')}  {re.sub(r'\s+', ' ', tender.get('description') or '')[:140]}"
    S["A2"].font = F
    S["A3"] = f"Built {date.today().isoformat()}. Yellow cells are inputs. Library rates are escalated to the latest index values on the Indices sheet."
    S["A3"].font = FN
    pg_rows = f'BoQ!$N${b_first}:$N${b_last}'
    has_pg_items = any((B.cell(rr, 14).value == "P&G") for rr in range(b_first, b_last + 1))
    lines = [
        ("Measured work (BoQ items)", f'=SUMIFS(BoQ!$I${b_first}:$I${b_last},BoQ!$K${b_first}:$K${b_last},"item")', None, NUM),
        ("Provisional sums", f'=SUMIFS(BoQ!$I${b_first}:$I${b_last},BoQ!$K${b_first}:$K${b_last},"provisional")', None, NUM),
        ("BoQ total as it will be printed", "=B5+B6", None, NUM),
        ("P&G worked out on the P&G sheet", f"={PG_TOTAL}", None, NUM),
        ("P&G priced in the BoQ's own P&G items", f'=SUMIFS(BoQ!$I${b_first}:$I${b_last},{pg_rows},"P&G")', None, NUM),
        ("Add the P&G sheet to the tender sum? (1 = yes, 0 = no)", 0 if has_pg_items else 1,
         "0 when the BoQ has its own P&G items: price those items from the P&G sheet instead (compare B8 and B9)." if has_pg_items
         else "1 because the BoQ has no P&G items of its own.", "0"),
        ("P&G added", "=B8*B10", None, NUM),
        ("Contingencies (%)", contingency or 0,
         "Only when the tender's BoQ summary has a contingency line: enter its percentage. Leave 0 otherwise.", PCT),
        ("Contingencies (R)", "=(B7+B11)*B12", None, NUM),
        ("Subtotal", "=B7+B11+B13", None, NUM),
        ("Contract price adjustment (CPAP) applies? (1 = yes, 0 = fixed price)", 1 if cpap else 0,
         "From the contract data. With CPAP the Employer pays escalation, so none is built into the rates.", "0"),
        ("Expected annual escalation", cpi_y if cpi_y is not None else 0,
         "CPI year on year from the Indices sheet.", PCT),
        ("Months from tender to mid-contract", "=2+'P&G'!$C$3/2", "Two months to start plus half the contract period.", "0.0"),
        ("Escalation built into every rate", '=IF(B15=1,0,(1+B16)^(B17/12)-1)', None, PCT),
        ("Tender sum excluding VAT", "=B14", None, NUM),
        ("VAT rate", 0.15 if vat_registered else 0.0, f"VAT vendor (VAT {profile.get('vat_number')})." if vat_registered else "Not VAT registered on the company details.", PCT),
        ("VAT (R)", "=ROUND(B19*B20,2)", None, NUM),
        ("Tender sum including VAT", "=B19+B21", None, NUM),
        ("BoQ items without a rate", f'=COUNTIFS(BoQ!$K${b_first}:$K${b_last},"item",BoQ!$J${b_first}:$J${b_last},"NO RATE")', None, "0"),
    ]
    for i, (label, val, note, fmt) in enumerate(lines, start=5):
        S.cell(i, 1, label).font = FB if label.startswith(("Subtotal", "Tender sum")) else F
        c = S.cell(i, 2, val)
        c.number_format = fmt
        if note:
            c.fill = YEL
            c.font = FBLUE
            c.comment = Comment(note, "Cost model")
            S.cell(i, 3, note).font = FN
        else:
            c.font = FB if label.startswith(("Subtotal", "Tender sum")) else F
    S.column_dimensions["A"].width = 58
    S.column_dimensions["B"].width = 20
    S.column_dimensions["C"].width = 80
    for ws in (B, PG, BU, R, I):
        ws.freeze_panes = ws.cell(4 if ws is not PG else 6, 1)
    wb.save(out)
    S["A25"] = ("Write the BoQ total (B7, plus contingencies if the BoQ summary has that line) and the VAT exactly as the tender's "
                "summary page asks, and the same amount on the Form of Offer. Every rate in the BoQ sheet's column H is the rate to print.")
    S["A25"].font = FN
    return {"boq_rows": b_last - b_first + 1, "resources": len(resources), "buildups": len(buildups), "cpi_yoy": cpi_y, "cpap": cpap}
