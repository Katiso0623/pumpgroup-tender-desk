"""Shared helpers for the Pump Group bid pack toolkit.

bid_data.json is the output of the database function public.bid_pack_data(<tender id>):
{
  "tender":   {... one row of public.tenders ...},
  "profile":  {"legal_name": "...", "csd_number": "...", ...},
  "library":  [{"id","category","title","asset_id","file_name","issued_on","expires_on","client","project_value","completed_on","cidb_class"}, ...],
  "categories": [{"key","group","label","hint","max_age_days"}, ...],
  "rates":    [{"code","description","unit","rate","category","source"}, ...]
}
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SAST = timezone(timedelta(hours=2))


def load_data(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    prof = data.get("profile") or {}
    if isinstance(prof, list):  # list of {key, value}
        prof = {r["key"]: r.get("value") for r in prof}
    data["profile"] = {k: (v or "").strip() for k, v in prof.items()}
    data.setdefault("library", [])
    data.setdefault("rates", [])
    data.setdefault("categories", [])
    data.setdefault("tender", {})
    return data


def parse_dt(s) -> datetime | None:
    if not s:
        return None
    if isinstance(s, datetime):
        return s
    s = str(s).replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=SAST)
    return d.astimezone(SAST)


def fmt_dt(s, with_time=True) -> str:
    d = parse_dt(s)
    if not d:
        return "-"
    return d.strftime("%d %B %Y at %H:%M") if with_time else d.strftime("%d %B %Y")


def parse_date(s) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def money(v, blank="") -> str:
    """South African style: 1 234 567.89"""
    if v is None or v == "":
        return blank
    try:
        v = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = f"{abs(v):,.2f}".replace(",", " ")
    return ("-" if v < 0 else "") + s


def parse_number(s) -> float | None:
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = str(s).strip()
    if not t:
        return None
    t = t.replace("R", "").replace(" ", " ").replace(" ", "")
    # 1,234.56 or 1 234,56 or 1234,5
    if t.count(",") == 1 and t.count(".") == 0:
        t = t.replace(",", ".")
    else:
        t = t.replace(",", "")
    try:
        return float(t)
    except ValueError:
        return None


def norm(s: str) -> str:
    s = (s or "").lower()
    s = s.replace("’", "'").replace("–", "-").replace("—", "-")
    s = re.sub(r"[^a-z0-9%/&+ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


BLANK_RE = re.compile(r"^[\s_.…:\-|]*$")


def is_blank(text: str) -> bool:
    return bool(BLANK_RE.match(text or ""))


# ---------------------------------------------------------------------------
# Form labels found in South African bid documents (SBD / MBD forms, Form of
# Offer, CIDB returnable schedules) mapped to company profile keys.
# Order matters: the first matching pattern wins.
# ---------------------------------------------------------------------------
FIELD_MAP: list[tuple[str, str]] = [
    (r"(csd|central supplier database).{0,40}(number|no\b|reference|maaa)|^supplier (number|no)\b|\bmaaa\b", "csd_number"),
    (r"tax compliance (status )?(system )?pin|\btcs pin\b|\bsars pin\b", "tcs_pin"),
    (r"(income )?tax reference (number|no)|tax (number|no)\b", "tax_number"),
    (r"vat (registration )?(number|no)", "vat_number"),
    (r"cidb.{0,30}(registration|crs|contractor).{0,15}(number|no)|\bcrs (number|no)", "cidb_crs"),
    (r"cidb.{0,20}grad|grading designation|contractor grading|class of construction works", "cidb_grading"),
    (r"(company|enterprise|business|cipc|close corporation|cc|entity) registration (number|no)|^registration (number|no) of (the )?(company|enterprise|business)", "reg_number"),
    (r"b-?bbee.{0,20}(status )?level|bbbee.{0,20}level|level of contribution", "bbbee_level"),
    (r"^trading (name|as)", "trading_name"),
    (r"^full name of (the )?(bidder or his or her |tenderer'?s? )?(authori[sz]ed )?representative|^name of (the )?(authori[sz]ed )?(signatory|representative)|^(authori[sz]ed )?signatory'?s? (full )?name|^name of person signing", "signatory_name"),
    (r"^(full |registered )?name of (the )?(bidder|tenderer|company|firm|supplier|service provider|enterprise|entity|business|contractor)|^(registered )?(company|business|firm) name|^name of bidding (entity|company)", "legal_name"),
    (r"^(bidder|tenderer)'?s? name$", "legal_name"),
    (r"^postal address", "postal_address"),
    (r"^(physical|street|business|residential|domicilium|registered) address|address of (the )?(bidder|tenderer|business)", "physical_address"),
    (r"^(telephone|tel|landline|office)( number| no)?\b", "telephone"),
    (r"^(cellphone|cell phone|cell|mobile)( number| no)?\b", "cellphone"),
    (r"^e-?mail( address)?\b", "email"),
    (r"^contact person|^name of contact person|^contact name", "contact_person"),
    (r"^position occupied in the (company|enterprise)|director, trustee, shareholder", "position_in_company"),
    (r"^(position|capacity|designation)( occupied)?( in the (company|enterprise))?|^in (his|her|my) capacity as", "signatory_capacity"),
    (r"^identity (number|no)|^id (number|no)", "signatory_id"),
    (r"coida|compensation fund.{0,30}(number|no)|workmen'?s compensation.{0,20}(number|no)", "coida_number"),
    (r"\buif\b.{0,20}(number|no)", "uif_number"),
    (r"^(name of )?bank$|^bank( name)?\b(?!.*(account|branch))", "bank_name"),
    (r"branch (name|code)|^branch\b", "bank_branch"),
    (r"account (holder|name)", "bank_account_name"),
    (r"account (number|no)", "bank_account_number"),
    (r"number of (permanent )?(employees|staff)", "employees"),
    (r"years (of experience|in business|in operation|in construction)", "years_experience"),
    (r"(annual )?turnover", "annual_turnover"),
    (r"local municipality (where|in which).{0,40}(business|enterprise)|municipality of (business|enterprise)", "municipality"),
]
_COMPILED = [(re.compile(p, re.I), k) for p, k in FIELD_MAP]

# Never auto-filled: signatures, declarations, dates of signing, witnesses
SKIP_RE = re.compile(
    r"signature|signed|sign here|witness|commissioner|deponent|\bdate\b|initial|stamp|thumb|place\b|"
    r"yes\s*/\s*no|\(yes|declar|state employee|in the service of|past practice|conflict",
    re.I,
)


def match_field(label: str) -> str | None:
    lab = re.sub(r"\s+", " ", (label or "").strip(" :.-_\t…|*")).strip()
    if len(lab) < 3 or len(lab) > 140:
        return None
    if SKIP_RE.search(lab):
        return None
    for rx, key in _COMPILED:
        if rx.search(lab):
            return key
    return None


def field_value(profile: dict, key: str) -> str:
    if key == "position_in_company" and not (profile.get(key) or "").strip():
        # from the directors line on the company details, e.g. "Isaac Moreki Mosenohi, <id>, 100%"
        name = (profile.get("signatory_name") or "").strip().lower()
        for line in (profile.get("directors") or "").splitlines():
            if name and name in line.lower():
                pct = re.search(r"(\d{1,3}(?:[.,]\d+)?)\s*%", line)
                return f"Director and shareholder ({pct.group(1)}%)" if pct else "Director"
        return (profile.get("signatory_capacity") or "").strip()
    v = (profile.get(key) or "").strip()
    if key in ("physical_address", "postal_address"):
        v = ", ".join(x.strip() for x in v.splitlines() if x.strip())
    return v
