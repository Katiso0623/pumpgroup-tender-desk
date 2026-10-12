"""Tailored CVs for key personnel, on the Pump Group letterhead.

A CV is tailored by choosing and ordering what is already on record for the
person: the qualifications, registrations and projects that answer the tender's
requirement for the role come first, and a compliance table shows the evaluator
how the person meets it. Nothing is added that is not in the personnel record;
gaps are reported, not hidden.
"""
from __future__ import annotations

import re
from datetime import date

from . import brand
from .common import parse_date

DEGREE = r"(bachelor|b\.?\s?tech|btech|b-tech|bsc|b\.?sc|beng|b\.?eng|baccalaureus|degree|honours|masters?|meng|msc)"
DIPLOMA = r"(national diploma|\bnd\b|diploma|n6|national higher certificate)"
REG_BODIES = {
    "ecsa": r"ecsa|engineering council|pr\.?\s?eng|pr\.?\s?tech|pr\.?\s?techni|professional engineer",
    "sacpcmp": r"sacpcmp|project and construction management|pr\.?\s?cm|pr\.?\s?cpm|chsa|chso|construction (health|manager)",
    "saiosh": r"saiosh",
}
EXPERIENCE_WORDS = ["water", "sewer", "sewage", "sanitation", "pipeline", "pipe", "pump", "pump station", "wwtw", "wastewater",
                    "treatment", "reservoir", "bulk", "reticulation", "road", "stormwater", "bridge", "civil", "mechanical",
                    "refurbish", "rehabilitat", "borehole", "rising main", "plant"]


def parse_requirement(text: str) -> dict:
    """Read a requirement like 'BTech/BSc Civil with ECSA Pr Tech Eng and 10 years in water pipelines'."""
    t = (text or "").lower()
    req = {"text": text or ""}
    m = re.search(r"(\d{1,2})\s*\+?\s*(?:or more\s*)?(?:years?|yrs)", t)
    if m:
        req["min_years"] = int(m.group(1))
    if re.search(DEGREE, t):
        req["qualification"] = "degree"
    elif re.search(DIPLOMA, t):
        req["qualification"] = "diploma"
    for body, rx in REG_BODIES.items():
        if re.search(rx, t):
            req["registration"] = body
            break
    req["keywords"] = [w for w in EXPERIENCE_WORDS if w in t]
    v = re.search(r"r\s?(\d+(?:[.,]\d+)?)\s*(m|million)", t)
    if v:
        req["min_project_value"] = float(v.group(1).replace(",", ".")) * 1e6
    return req


def years_experience(p: dict, today: date | None = None) -> int | None:
    today = today or date.today()
    if p.get("career_start_year"):
        return today.year - int(p["career_start_year"])
    return None


def _qual_level(q: dict) -> str:
    n = (q.get("name") or "").lower()
    if re.search(DEGREE, n):
        return "degree"
    if re.search(DIPLOMA, n):
        return "diploma"
    return "other"


def _reg_state(r: dict, today: date) -> tuple[bool, str]:
    vt = parse_date(r.get("valid_to"))
    if vt and vt < today:
        return False, f"validation expired {vt.strftime('%d %b %Y')}"
    return True, f"valid to {vt.strftime('%d %b %Y')}" if vt else "registered"


def checks(p: dict, req: dict, today: date | None = None) -> list[dict]:
    """Requirement vs person, line by line: [{requirement, evidence, complies: Yes|Partly|No}]"""
    today = today or date.today()
    out = []
    quals = p.get("qualifications") or []
    if req.get("qualification"):
        want = req["qualification"]
        best = [q for q in quals if _qual_level(q) == want] or ([q for q in quals if _qual_level(q) == "degree"] if want == "diploma" else [])
        if best:
            q = best[0]
            out.append({"requirement": "Degree in the required field" if want == "degree" else "Diploma in the required field",
                        "evidence": f"{q.get('name')} ({q.get('institution', '')}, {q.get('year', '')})".replace(", )", ")"), "complies": "Yes"})
        else:
            have = "; ".join(q.get("name", "") for q in quals) or "No qualification on record"
            out.append({"requirement": "Degree in the required field" if want == "degree" else "Diploma in the required field",
                        "evidence": have, "complies": "Partly" if quals else "No"})
    if req.get("registration"):
        rx = REG_BODIES[req["registration"]]
        regs = [r for r in (p.get("registrations") or []) if re.search(rx, f"{r.get('body', '')} {r.get('category', '')}", re.I)]
        if regs:
            r = regs[0]
            ok, state = _reg_state(r, today)
            out.append({"requirement": f"Professional registration ({req['registration'].upper()})",
                        "evidence": f"{r.get('body')} {r.get('category')}, no. {r.get('number')} ({state})", "complies": "Yes" if ok else "Partly"})
        else:
            out.append({"requirement": f"Professional registration ({req['registration'].upper()})", "evidence": "Not registered on record", "complies": "No"})
    if req.get("min_years"):
        y = years_experience(p, today)
        out.append({"requirement": f"At least {req['min_years']} years' relevant experience",
                    "evidence": f"{y} years (since {p.get('career_start_year')})" if y is not None else "Not on record",
                    "complies": "Yes" if y is not None and y >= req["min_years"] else ("Partly" if y else "No")})
    kws = req.get("keywords") or []
    if kws or req.get("min_project_value"):
        rel = relevant_projects(p, req)
        good = [x for x in rel if x["_score"] > 0 and (not req.get("min_project_value") or (x.get("value") or 0) >= req["min_project_value"])]
        out.append({"requirement": "Experience on similar projects" + (f" of at least R{req['min_project_value'] / 1e6:.0f} million" if req.get("min_project_value") else ""),
                    "evidence": f"{len(good)} similar project(s) on record" + (f", e.g. {good[0].get('project')}" if good else ""),
                    "complies": "Yes" if len(good) >= 2 else ("Partly" if good else "No")})
    return out


def relevant_projects(p: dict, req: dict) -> list[dict]:
    kws = req.get("keywords") or EXPERIENCE_WORDS
    out = []
    for pr in p.get("projects") or []:
        text = f"{pr.get('project', '')} {pr.get('scope', '')}".lower()
        s = sum(2 for k in kws if k in text)
        x = dict(pr)
        x["_score"] = s
        out.append(x)
    out.sort(key=lambda x: (x["_score"], x.get("value") or 0), reverse=True)
    return out


def _money(v):
    if not v:
        return "-"
    return "R " + f"{float(v):,.2f}".replace(",", " ")


def _period(pr):
    a, b = pr.get("from") or "", pr.get("to") or ""
    return f"{a} to {b}".strip(" to") if a or b else ""


def build_cv(p: dict, role: str, requirement: str, tender: dict, out_docx: str, show_id: bool = True) -> dict:
    """Write a tailored CV (Word + PDF). Returns {docx, pdf, checks, issues}."""
    req = parse_requirement(requirement)
    today = date.today()
    rows = checks(p, req, today)
    issues = []
    for r in p.get("registrations") or []:
        ok, state = _reg_state(r, today)
        if not ok:
            issues.append(f"{p['full_name']}: {r.get('body')} {r.get('category')} {state}: upload the current validation.")
    for r in rows:
        if r["complies"] != "Yes":
            issues.append(f"{p['full_name']} as {role}: {r['requirement']}: {r['evidence']}")
    if p.get("notes") and re.search(r"check", p["notes"], re.I):
        issues.append(f"{p['full_name']}: {p['notes']}")

    doc = brand.new_document()
    brand.para(doc, "CURRICULUM VITAE", size=20, bold=True, color=brand.DOCX_CHARCOAL, space_after=2)
    brand.para(doc, p["full_name"].upper(), size=14, bold=True, color=brand.DOCX_BLUE, space_after=2)
    pp = brand.para(doc, "", space_after=2)
    brand.runs(pp, [("Proposed position: ", True), (role, False)])
    pp = brand.para(doc, "", space_after=12)
    tdesc = re.sub(r"\s+", " ", tender.get("description") or "")[:120]
    brand.runs(pp, [("Contract: ", True), (f"{tender.get('tender_no', '')}  {tdesc}", False)], size=9.5)

    if rows:
        brand.para(doc, "1. COMPLIANCE WITH THE TENDER REQUIREMENT", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4)
        if requirement:
            brand.para(doc, f"Requirement: {requirement}", size=9.5, italic=True, space_after=4)
        brand.table(doc, ["Requirement", p.get("known_as") or p["full_name"], "Complies"],
                    [[r["requirement"], r["evidence"], r["complies"]] for r in rows], widths_in=[2.0, 3.3, 0.8])
        brand.para(doc, "", space_after=6)

    n = 2 if rows else 1
    brand.para(doc, f"{n}. PERSONAL DETAILS", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4); n += 1
    y = years_experience(p, today)
    details = [["Full name", p["full_name"]]] + ([["Nationality", p["nationality"]]] if p.get("nationality") else [])
    if show_id and p.get("id_number"):
        details.append(["ID number", p["id_number"]])
    details += [["Current position", p.get("current_position") or "-"],
                ["Years of experience", f"{y} years" if y is not None else "-"]]
    if p.get("languages"):
        details.append(["Languages", p["languages"]])
    brand.table(doc, ["", ""], details, widths_in=[1.8, 4.3], header_fill="FFFFFF")
    brand.para(doc, "", space_after=6)

    quals = sorted(p.get("qualifications") or [], key=lambda q: (_qual_level(q) == (req.get("qualification") or "degree"), q.get("year") or 0), reverse=True)
    if quals:
        brand.para(doc, f"{n}. QUALIFICATIONS", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4); n += 1
        brand.table(doc, ["Qualification", "Institution", "Year"], [[q.get("name", ""), q.get("institution", ""), str(q.get("year", "") or "")] for q in quals], widths_in=[3.0, 2.4, 0.7])
        brand.para(doc, "", space_after=6)
    regs = p.get("registrations") or []
    brand.para(doc, f"{n}. PROFESSIONAL REGISTRATION", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4); n += 1
    if regs:
        brand.table(doc, ["Body", "Category", "Number", "Status"],
                    [[r.get("body", ""), r.get("category", ""), r.get("number", ""), _reg_state(r, today)[1]] for r in regs], widths_in=[0.9, 2.7, 1.3, 1.2])
    else:
        brand.para(doc, "None on record.", size=10)
    brand.para(doc, "", space_after=6)
    emp = p.get("employment") or []
    if emp:
        brand.para(doc, f"{n}. EMPLOYMENT RECORD", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4); n += 1
        brand.table(doc, ["Period", "Employer", "Position"], [[f"{e.get('from', '')} to {e.get('to', '')}", e.get("employer", ""), e.get("position", "")] for e in emp], widths_in=[1.3, 2.4, 2.4])
        brand.para(doc, "", space_after=6)
    projects = relevant_projects(p, req)
    if projects:
        brand.para(doc, f"{n}. PROJECT EXPERIENCE RELEVANT TO THIS CONTRACT", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4); n += 1
        brand.table(doc, ["Project and scope", "Client", "Role", "Value", "Period"],
                    [[x.get("project", ""), x.get("client", "") or "-", x.get("role", ""), _money(x.get("value")), _period(x)] for x in projects],
                    widths_in=[2.3, 1.3, 1.0, 1.0, 0.9], size=9)
        brand.para(doc, "", space_after=6)
    if p.get("skills"):
        brand.para(doc, f"{n}. SKILLS", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4); n += 1
        brand.para(doc, p["skills"], size=10)
    brand.para(doc, f"{n}. DECLARATION", size=11, bold=True, color=brand.DOCX_CHARCOAL, space_after=4)
    brand.para(doc, f"I, {p['full_name']}, certify that this CV correctly describes my qualifications, my experience and me, "
                    f"and that I am available to serve as {role} on this contract if it is awarded to {('Pump Group SA (Pty) Ltd')}.", size=10)
    brand.signature_block(doc, [p["full_name"], "Signature                                   Date"])
    pdf = brand.save_docx_and_pdf(doc, out_docx)
    return {"docx": out_docx, "pdf": pdf, "checks": rows, "issues": issues}
