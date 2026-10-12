"""Demonstration placeholders.

A demo bid pack (plan "demo": true, or a tender whose source is "demo") puts one clearly marked placeholder page
wherever a document is not on the Tender Desk yet, so the pack shows its full structure. The pages are never
look-alikes of official documents: no logos, no layouts of SARS, CSD, CIDB, banks or insurers, no numbers.
They are plain pages that say DEMO PLACEHOLDER, which document belongs there and what it must show.
"""
from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

RED = colors.HexColor("#B02A20")
INK = colors.HexColor("#22262A")
GREY = colors.HexColor("#5B636B")


def placeholder(out: str, heading: str, kind_line: str, lines: list[str]) -> str:
    """Write a one-page A4 placeholder PDF and return its path."""
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    W, H = A4
    c = canvas.Canvas(out, pagesize=A4)
    c.setTitle(f"DEMO PLACEHOLDER: {heading}")

    # diagonal watermark
    c.saveState()
    c.setFillColor(colors.Color(0.69, 0.16, 0.13, alpha=0.10))
    c.translate(W / 2, H / 2)
    c.rotate(35)
    c.setFont("Helvetica-Bold", 60)
    c.drawCentredString(0, 0, "DEMO PLACEHOLDER")
    c.restoreState()

    # dashed frame
    c.setStrokeColor(RED)
    c.setLineWidth(1.2)
    c.setDash(6, 4)
    c.rect(48, 96, W - 96, H - 190)
    c.setDash()

    x, w = 72, W - 144
    y = H - 130
    c.setFillColor(RED)
    c.setFont("Helvetica-Bold", 10.5)
    c.drawString(x, y, "DEMONSTRATION ONLY  ·  NOT A REAL DOCUMENT")
    y -= 30

    def para(text: str, size: float, color, bold: bool = False, gap: float = 8) -> None:
        nonlocal y
        style = ParagraphStyle("p", fontName="Helvetica-Bold" if bold else "Helvetica", fontSize=size, leading=size * 1.35, textColor=color)
        p = Paragraph(text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), style)
        _, h = p.wrap(w, y)
        p.drawOn(c, x, y - h)
        y -= h + gap

    para(heading, 18, INK, bold=True, gap=6)
    para(kind_line, 11, GREY, gap=16)
    for line in lines:
        if line:
            para(line, 11, INK)
    y -= 6
    para("In a real bid this page is replaced by the document itself. Upload it on the Tender Desk "
         "(Uploads needed tab) and press Build the pack again.", 10, GREY)

    c.setFillColor(RED)
    c.setFont("Helvetica", 9)
    c.drawCentredString(W / 2, 70, "Pump Group Tender Desk  ·  demonstration pack")
    c.showPage()
    c.save()
    return out
