"""Functionality: match each evaluation criterion to Pump Group's evidence, estimate the
score, and list what is missing.

plan["functionality"] is written by the Tender Desk after reading the tender's evaluation
criteria, one entry per criterion:
  {"criterion": "Key personnel: Contracts Manager", "max_points": 15, "kind": "personnel",
   "role": "Contracts Manager", "requirement": "BTech/BSc Civil, ECSA Pr Tech Eng, 10 years on water pipelines",
   "person": "Kabelo Lincoln Mark Rasmeni" (optional: who to propose),
   "scoring": [{"points": 15, "rule": "meets all"}, {"points": 8, "rule": "partly"}]}
  {"criterion": "Company experience", "max_points": 30, "kind": "company_experience",
   "requirement": "Completed water/sewer projects of R10m or more", "min_value": 10000000, "classes": ["CE"],
   "keywords": ["water", "sewer", "pipeline"],
   "scoring": [{"points": 30, "min_projects": 5}, {"points": 20, "min_projects": 3}, {"points": 10, "min_projects": 1}]}
  {"criterion": "Methodology", "max_points": 20, "kind": "methodology"}
  kinds: personnel, company_experience, plant, methodology, programme, financial, quality, other
"""
from __future__ import annotations

import re

from .cv import checks, parse_requirement

EXP_CATS = ("completion_certificate", "reference_letter", "appointment_letter")


def _pick_person(c: dict, people: list[dict]) -> dict | None:
    if c.get("person"):
        for p in people:
            if p["full_name"].lower() == c["person"].lower() or (p.get("known_as") or "").lower() == c["person"].lower():
                return p
    role = (c.get("role") or "").lower()
    req = parse_requirement(c.get("requirement") or "")
    best, best_s = None, -1
    for p in people:
        rs = [r.lower() for r in (p.get("roles") or [])]
        s = 3 if any(role and (role in r or r in role) for r in rs) else 0
        s += sum(2 if x["complies"] == "Yes" else 1 if x["complies"] == "Partly" else 0 for x in checks(p, req))
        if s > best_s:
            best, best_s = p, s
    return best


FLAG_RE = re.compile(r"\bcheck\b", re.I)


def company_projects(library: list[dict], c: dict, flagged: bool = False) -> list[dict]:
    """Completed projects that meet the criterion. Projects whose library notes say "Check"
    (doubtful dates, addressee or scope) are left out unless flagged=True (then only those)."""
    kws = [k.lower() for k in (c.get("keywords") or [])]
    classes = c.get("classes") or []
    seen, out = set(), []
    for d in library:
        if d.get("category") not in EXP_CATS or not d.get("active", True):
            continue
        if classes and d.get("cidb_class") and d["cidb_class"] not in classes:
            continue
        text = f"{d.get('title', '')} {d.get('notes', '')}".lower()
        if kws and not any(k in text for k in kws):
            continue
        if c.get("min_value") and float(d.get("project_value") or 0) < float(c["min_value"]):
            continue
        if bool(FLAG_RE.search(d.get("notes") or "")) != flagged and not c.get("include_flagged"):
            continue
        # the tender wants experience as main contractor: subcontract work does not count
        if (c.get("main_contractor_only") or re.search(r"main contractor|principal contractor", c.get("requirement") or "", re.I)) \
                and re.search(r"sub-?contract", f"{d.get('title', '')} {d.get('notes', '')}", re.I):
            continue
        key = re.sub(r"\W+", "", (d.get("title") or "").lower())[:40]
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    out.sort(key=lambda d: float(d.get("project_value") or 0), reverse=True)
    return out


def _score_from_rules(c: dict, n_projects: int | None = None, level: str | None = None) -> float | None:
    rules = c.get("scoring") or []
    mx = float(c.get("max_points") or 0)
    if n_projects is not None:
        pts = [float(r["points"]) for r in rules if "min_projects" in r and n_projects >= int(r["min_projects"])]
        return max(pts) if pts else (0.0 if rules else None)
    if level is not None:
        if level == "Yes":
            return mx or None
        if level == "Partly":
            part = [float(r["points"]) for r in rules if re.search(r"part", str(r.get("rule", "")), re.I)]
            return part[0] if part else (round(mx / 2, 1) if mx else None)
        return 0.0
    return None


_RAND = re.compile(r"R\s*([0-9][0-9\s,]*(?:\.[0-9]+)?)\s*(m|million|k)?", re.I)


def _amount(txt: str, unit: str | None) -> float:
    v = float(re.sub(r"[\s,]", "", txt))
    u = (unit or "").lower()
    return v * 1_000_000 if u in ("m", "million") else v * 1000 if u == "k" else v


def _value_bands(c: dict) -> list[dict]:
    """Scoring by contract value ("R8 000 001 and above: 100 points per project (max 1 project)").
    Rules may give min_value / max_value / max_projects directly, or say it in words."""
    bands = []
    for r in c.get("scoring") or []:
        pts = float(r.get("points") or 0)
        lo, hi = r.get("min_value"), r.get("max_value")
        text = str(r.get("rule") or "")
        if lo is None and hi is None and text:
            amts = [_amount(a, u) for a, u in _RAND.findall(text)]
            if len(amts) >= 2:
                lo, hi = min(amts[:2]), max(amts[:2])
            elif len(amts) == 1:
                if re.search(r"(below|less than|under|up to|not exceeding)", text, re.I):
                    lo, hi = 0, amts[0]
                else:
                    lo, hi = amts[0], None
        if lo is None and hi is None:
            continue
        m = re.search(r"max(?:imum)?\.?\s*(?:of\s*)?(\d+)\s*project", text, re.I)
        bands.append({"points": pts, "min": float(lo or 0), "max": float(hi) if hi is not None else None,
                      "max_projects": int(r.get("max_projects") or (m.group(1) if m else 0) or 0) or None,
                      "per_project": bool(r.get("per_project", re.search(r"per project", text, re.I)))})
    return bands


def _score_bands(bands: list[dict], projs: list[dict], cap: float) -> tuple[float, list[str]]:
    used_in, total, used = {}, 0.0, []
    for d in sorted(projs, key=lambda x: float(x.get("project_value") or 0), reverse=True):
        v = float(d.get("project_value") or 0)
        for i, b in enumerate(bands):
            if v >= b["min"] and (b["max"] is None or v <= b["max"]):
                if b["max_projects"] and used_in.get(i, 0) >= b["max_projects"]:
                    break
                used_in[i] = used_in.get(i, 0) + 1
                total += b["points"] if b["per_project"] or used_in[i] == 1 else 0
                used.append(d.get("title"))
                break
    return (min(total, cap) if cap else total), used


def evaluate(plan: dict, data: dict) -> list[dict]:
    people = data.get("personnel") or []
    library = data.get("library") or []
    results = []
    for c in plan.get("functionality") or []:
        kind = c.get("kind", "other")
        r = {"criterion": c.get("criterion"), "max_points": c.get("max_points"), "kind": kind, "requirement": c.get("requirement", ""),
             "evidence": [], "gaps": [], "est_points": None, "person": None, "role": c.get("role")}
        if kind == "personnel":
            p = _pick_person(c, people)
            if p:
                ch = checks(p, parse_requirement(c.get("requirement") or ""))
                level = "Yes" if ch and all(x["complies"] == "Yes" for x in ch) else ("No" if ch and all(x["complies"] == "No" for x in ch) else "Partly")
                r.update(person=p["full_name"], checks=ch, est_points=_score_from_rules(c, level=level))
                r["evidence"].append(f"{p['full_name']}: tailored CV, qualifications, registration")
                r["gaps"] += [f"{x['requirement']}: {x['evidence']}" for x in ch if x["complies"] != "Yes"]
                if not any(d.get("person_id") == p.get("id") and d.get("category") == "qualification" for d in library):
                    r["gaps"].append(f"No certified qualifications for {p['full_name']} in the library")
            else:
                r["gaps"].append(f"No one on record for {c.get('role')}: add the person under Personnel")
                r["est_points"] = 0.0
        elif kind == "company_experience":
            projs = company_projects(library, c)
            r["projects"] = [{"title": d.get("title"), "client": d.get("client"), "value": d.get("project_value"), "id": d.get("id")} for d in projs]
            r["evidence"] += [d.get("title") for d in projs]
            bands = _value_bands(c)
            if bands:
                mx = float(c.get("max_points") or 0)
                r["est_points"], r["scored_projects"] = _score_bands(bands, projs, mx)
                if mx and r["est_points"] < mx:
                    r["gaps"].append(f"Projects on file earn an estimated {r['est_points']:g} of {mx:g}: upload appointment letters and "
                                     "completion certificates for larger projects to score more.")
            else:
                r["est_points"] = _score_from_rules(c, n_projects=len(projs))
            need = 0 if bands else max([int(x.get("min_projects", 0)) for x in (c.get("scoring") or [])] or [0])
            if need and len(projs) < need:
                r["gaps"].append(f"{len(projs)} qualifying project(s) on file; top score needs {need}. Upload more completion certificates.")
            held = [] if c.get("include_flagged") else company_projects(library, c, flagged=True)
            if held:
                r["held_back"] = [d.get("title") for d in held]
                r["gaps"].append(f"Left out until you confirm them ({len(held)}): " + "; ".join(d.get("title") for d in held)
                                 + ". Add \"include_flagged\": true to the criterion once confirmed.")
        elif kind in ("methodology", "programme"):
            r["evidence"].append("Method statement and construction programme for this contract")
            r["gaps"].append("Read the method statement and programme against the scope and edit the Word files before printing")
        else:
            cats = {"plant": ["plant"], "financial": ["financials", "bank_letter"], "quality": ["quality"], "other": []}.get(kind, [])
            docs = [d for d in library if d.get("category") in cats and d.get("active", True)]
            r["evidence"] += [d.get("title") for d in docs]
            if cats and not docs:
                r["gaps"].append(f"Nothing on file for {kind}")
        results.append(r)
    return results
