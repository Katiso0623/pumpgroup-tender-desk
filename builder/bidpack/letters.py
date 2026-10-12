"""Letters Pump Group issues itself, generated on the company letterhead for each tender.
Every letter is left unsigned: signature lines only. Letters from third parties
(clients, banks, insurers, plant hire firms) are never generated: those must be
requested from the issuer."""
from __future__ import annotations

import re
from datetime import date

from . import brand


def _clean(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def _date(d: date | None = None) -> str:
    d = d or date.today()
    return d.strftime("%d %B %Y").lstrip("0").upper()


def authority_letter(t: dict, prof: dict, out_docx: str, signatory: dict | None = None, resolution_date: date | None = None) -> dict:
    """Board resolution / letter of authority in Pump Group's own wording."""
    name = (signatory or {}).get("full_name") or prof.get("signatory_name") or ""
    idno = (signatory or {}).get("id_number") or prof.get("signatory_id") or ""
    cap = prof.get("signatory_capacity") or "Managing Director"
    d = _date(resolution_date) if resolution_date else "____________________"
    doc = brand.new_document()
    brand.para(doc, f"Date: {d}", size=10.5, bold=True, align="right", space_after=14)
    p = brand.para(doc, "", align="center", space_after=14)
    brand.runs(p, [("Resolution of the board of Directors taken on the ", False), (f"{d}.", True)])
    brand.para(doc, f"Mr. {name.upper()} (ID: {idno})", bold=True, align="center", space_after=14)
    brand.para(doc, "Has been authorized to sign all documents in connection with", align="center", space_after=14)
    p = brand.para(doc, "", align="center", space_after=2)
    brand.runs(p, [("CONTRACT NO: ", True), (_clean(t.get("tender_no")).upper(), True)])
    p = brand.para(doc, "", align="center", space_after=14)
    brand.runs(p, [("CONTRACT NAME: ", True), (_clean(t.get("description")).upper(), True)])
    brand.para(doc, "Which may arise there from OR on behalf of", align="center", space_after=14)
    brand.para(doc, (prof.get("legal_name") or "PUMP GROUP SA PTY LTD").upper(), bold=True, align="center", space_after=14)
    brand.para(doc, "SIGNED ON BEHALF OF THE COMPANY", align="center", space_after=40)
    brand.para(doc, "_________________________", align="center", space_after=0)
    brand.para(doc, name.upper(), align="center", space_after=0)
    brand.para(doc, cap.upper(), bold=True, align="center", space_after=0)
    pdf = brand.save_docx_and_pdf(doc, out_docx)
    return {"docx": out_docx, "pdf": pdf}


def key_personnel_appointment(t: dict, prof: dict, person: dict, role: str, out_docx: str, months: int | None = None) -> dict:
    """Letter appointing a staff member (or committed associate) to a key position on this contract,
    subject to award. Signed by the MD and accepted by the person."""
    employed = any("pump group" in (e.get("employer") or "").lower() and (e.get("to") or "").lower() in ("present", "current", "")
                   for e in (person.get("employment") or []))
    doc = brand.new_document()
    brand.para(doc, "Date: ____________________", size=10.5, bold=True, align="right", space_after=10)
    brand.para(doc, "LETTER OF APPOINTMENT: KEY PERSONNEL", size=14, bold=True, color=brand.DOCX_CHARCOAL, space_after=8)
    p = brand.para(doc, "", space_after=2)
    brand.runs(p, [("Contract: ", True), (_clean(t.get("tender_no")), False)])
    p = brand.para(doc, "", space_after=2)
    brand.runs(p, [("Project: ", True), (_clean(t.get("description")), False)])
    p = brand.para(doc, "", space_after=12)
    brand.runs(p, [("Employer: ", True), (_clean(t.get("organ_of_state")), False)])
    idtxt = f" (ID No: {person['id_number']})" if person.get("id_number") else ""
    brand.para(doc, f"Dear {person.get('full_name')}{idtxt}", space_after=8)
    brand.para(doc, f"Appointment as {role}", bold=True, space_after=8)
    if employed:
        lead = (f"{prof.get('legal_name') or 'Pump Group SA (Pty) Ltd'} confirms that you are employed by the company as "
                f"{person.get('current_position') or role}, and appoints you as {role} for the contract above, should the contract be awarded to the company.")
    else:
        lead = (f"{prof.get('legal_name') or 'Pump Group SA (Pty) Ltd'} appoints you as {role} for the contract above, should the contract be awarded "
                f"to the company. This appointment is made on the basis of your written commitment below and becomes a contract of employment on award.")
    brand.para(doc, lead, space_after=8)
    dur = f" for the full contract period ({months} months) and any extension" if months else " for the full contract period and any extension"
    brand.para(doc, f"You will be available full time{dur}, and will not be replaced without the Employer's written approval "
                    f"by a person with equal or better qualifications and experience.", space_after=8)
    brand.para(doc, "Your responsibilities will include the duties of this position described in the tender document.", space_after=14)
    brand.para(doc, "Yours faithfully", space_after=30)
    brand.para(doc, "_________________________", space_after=0)
    brand.para(doc, (prof.get("signatory_name") or "").upper(), space_after=0)
    brand.para(doc, (prof.get("signatory_capacity") or "MANAGING DIRECTOR").upper(), bold=True, space_after=18)
    brand.para(doc, "ACCEPTANCE", bold=True, color=brand.DOCX_CHARCOAL, space_after=4)
    brand.para(doc, f"I, {person.get('full_name')}, accept this appointment as {role} and confirm that I will be available as set out above.", space_after=30)
    brand.para(doc, "_________________________                    ____________________", space_after=0)
    brand.para(doc, "Signature                                                      Date", space_after=0)
    pdf = brand.save_docx_and_pdf(doc, out_docx)
    return {"docx": out_docx, "pdf": pdf, "employed": employed}
