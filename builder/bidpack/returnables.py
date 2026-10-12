"""Work out which returnable documents a tender asks for, in its order, and which
library documents answer each one."""
from __future__ import annotations

import re
from datetime import date

from .common import parse_date

# keyword -> library categories that answer it (first match wins; order matters)
CATEGORY_RULES: list[tuple[str, list[str]]] = [
    (r"joint venture|\bjv\b|consortium", ["jv"]),
    (r"central supplier database|\bcsd\b", ["csd"]),
    (r"tax (compliance|clearance)|\bsars\b|tcs pin", ["tax"]),
    (r"b-?bbee|bbbee|broad[- ]based|sworn affidavit|verification certificate", ["bbbee"]),
    (r"\bcidb\b|construction industry development", ["cidb"]),
    (r"coida|compensation (fund|for occupational)|letter of good standing|workmen", ["coida"]),
    (r"\buif\b|unemployment insurance", ["uif"]),
    (r"municipal (rates|account|services)|rates and taxes|lease agreement|not in arrears|municipal statement", ["municipal_account"]),
    (r"proof of (residence|address)|residential address", ["proof_of_address"]),
    (r"bank(ing)? (rating|confirmation|letter|details)|stamped bank", ["bank_letter"]),
    (r"financial statement|audited|annual financial|management accounts", ["financials"]),
    (r"guarantee|surety|security facility", ["surety"]),
    (r"insurance|public liability|contractors'? all risk", ["insurance"]),
    (r"(company|cipc|cc|enterprise) registration|registration certificate|cor ?14|ck ?1|founding", ["cipc"]),
    (r"share ?(certificate|holding|register)|shareholding", ["shareholding"]),
    (r"certified (cop(y|ies) of )?(the )?id|identity document|copies of id", ["director_ids"]),
    (r"reference letter|letters? of reference|testimonial", ["reference_letter"]),
    (r"completion certificate|certificate of completion|practical completion", ["completion_certificate"]),
    (r"appointment letter|letters? of appointment|award letter", ["appointment_letter"]),
    (r"experience|previous (projects|work|contracts)|track record|similar (projects|work)|list of projects", ["appointment_letter", "completion_certificate", "reference_letter"]),
    (r"\bcvs?\b|curricul|key personnel|key staff|resume", ["cv", "qualification"]),
    (r"qualification|ecsa|sacpcmp|professional registration|certified cop(y|ies) of (degree|diploma)", ["qualification"]),
    (r"plant|equipment|machinery", ["plant"]),
    (r"health and safety|\bohs\b|she (policy|plan)|safety (plan|policy|officer)", ["health_safety"]),
    (r"quality (management|plan|policy|assurance)|iso ?9001", ["quality"]),
    (r"company profile", ["company_profile"]),
]

# Forms that are part of the tender document itself (completed in place)
FORM_RE = re.compile(r"\b(sbd|mbd)\s?\d|form of offer|offer and acceptance|declaration|certificate of (independent|authority)|"
                     r"record of addenda|authority (for|of) signatory|resolution|schedule of (deviations|proposed)|"
                     r"pricing (schedule|data)|bill of quantities|\bboq\b|returnable schedule|t2\.2|preference points|specific goals|"
                     r"contract data|compulsory enterprise", re.I)

LIST_START = re.compile(r"(list of )?returnable (documents|schedules)|t2\.1|documents to be (submitted|returned)|"
                        r"checklist of (returnable )?documents|mandatory (returnable )?documents|submission (checklist|requirements)", re.I)
ITEM_LINE = re.compile(r"^\s*((?:t2\.2-?\d+|[a-z]?\d{1,2}(?:\.\d{1,2})?[.)]?|\(?[a-z]\)|[ivx]+[.)]|[•\-●▪✓]|schedule\s+\w+|annex(?:ure)?\s+\w+|form\s+\w+|sbd\s?\d+(?:\.\d)?|mbd\s?\d+(?:\.\d)?))\s+(.{6,160})$", re.I)


def extract_list(text: str, limit: int = 60) -> list[dict]:
    """Best-effort read of the 'list of returnable documents' section."""
    lines = [l.strip() for l in (text or "").splitlines()]
    out: list[dict] = []
    seen = set()
    for i, l in enumerate(lines):
        if not LIST_START.search(l):
            continue
        for j in range(i + 1, min(i + 120, len(lines))):
            s = lines[j]
            if not s:
                continue
            if out and re.match(r"^(t2\.2|c1\.1|part [a-z0-9]|section \d+\b|the contract|conditions of tender)", s, re.I) and len(out) > 4:
                break
            m = ITEM_LINE.match(s)
            if not m:
                continue
            ref, title = m.group(1).strip(), m.group(2).strip(" .:\t")
            if re.fullmatch(r"[\d .]+", title) or len(title) < 6:
                continue
            k = title.lower()[:60]
            if k in seen:
                continue
            seen.add(k)
            out.append({"ref": ref, "title": title})
            if len(out) >= limit:
                break
        if len(out) >= 4:
            break
    return out


def categories_for(title: str) -> list[str]:
    for rx, cats in CATEGORY_RULES:
        if re.search(rx, title, re.I):
            return cats
    return []


def _valid(doc: dict, cat: dict | None, today: date) -> tuple[bool, str]:
    exp = parse_date(doc.get("expires_on"))
    if exp and exp < today:
        return False, f"expired {exp.isoformat()}"
    if cat and cat.get("max_age_days") and doc.get("issued_on"):
        iss = parse_date(doc["issued_on"])
        if iss and (today - iss).days > int(cat["max_age_days"]):
            return False, f"{(today - iss).days} days old (limit {cat['max_age_days']})"
    return True, ""


def pick_documents(categories: list[str], library: list[dict], cat_info: dict, classes: list[str] | None = None,
                   today: date | None = None, max_experience: int = 6) -> tuple[list[dict], list[str]]:
    """Return (documents to attach, problems) for the given categories."""
    today = today or date.today()
    picked, problems = [], []
    for c in categories:
        docs = [d for d in library if d.get("category") == c and d.get("active", True)]
        if not docs:
            problems.append(f"No '{cat_info.get(c, {}).get('label', c)}' in the library")
            continue
        good = []
        for d in docs:
            ok, why = _valid(d, cat_info.get(c), today)
            if ok:
                good.append(d)
            else:
                problems.append(f"{d.get('title')}: {why}")
        if not good:
            continue
        if c in ("appointment_letter", "completion_certificate", "reference_letter"):
            if classes:
                pref = [d for d in good if (d.get("cidb_class") or "") in classes] or good
            else:
                pref = good
            pref.sort(key=lambda d: float(d.get("project_value") or 0), reverse=True)
            picked.extend(pref[:max_experience])
        elif c in ("director_ids", "cv", "qualification", "plant", "health_safety", "jv", "financials", "insurance"):
            picked.extend(sorted(good, key=lambda d: d.get("uploaded_at") or "", reverse=True))
        else:
            picked.append(sorted(good, key=lambda d: (d.get("issued_on") or "", d.get("uploaded_at") or ""), reverse=True)[0])
    return picked, problems


def default_list() -> list[dict]:
    """Used when the tender's own list cannot be read: the usual municipal order."""
    return [
        {"ref": "1", "title": "Completed and signed tender document (all forms and schedules)", "kind": "tender_document"},
        {"ref": "2", "title": "Central Supplier Database (CSD) registration report"},
        {"ref": "3", "title": "Tax compliance status PIN"},
        {"ref": "4", "title": "CIDB registration certificate"},
        {"ref": "5", "title": "Company registration documents (CIPC)"},
        {"ref": "6", "title": "Certified copies of ID documents of directors"},
        {"ref": "7", "title": "B-BBEE certificate or sworn affidavit"},
        {"ref": "8", "title": "Municipal rates statement or lease agreement (not in arrears)"},
        {"ref": "9", "title": "COIDA letter of good standing"},
        {"ref": "10", "title": "Bank confirmation letter"},
        {"ref": "11", "title": "Experience: appointment letters, completion certificates and reference letters"},
        {"ref": "12", "title": "CVs and qualifications of key personnel"},
        {"ref": "13", "title": "Plant and equipment"},
        {"ref": "14", "title": "Health and safety"},
    ]
