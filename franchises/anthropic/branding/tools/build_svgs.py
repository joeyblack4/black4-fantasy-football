#!/usr/bin/env python3
"""Generates every SVG in ../logo from one shared mark definition, so the mark is identical everywhere.
Run: python3 tools/build_svgs.py   (then tools/render.sh to produce PNGs)."""
import os, pathlib

LEDGER = "#0B3B2E"   # primary: ledger green
FIELD  = "#0E4A3A"   # secondary surface: field green
CHALK  = "#F3EEE3"   # yard lines, bars, type on dark
AMBER  = "#F2A93B"   # the increment: gain amber
FONT   = "'Helvetica Neue', Helvetica, Arial, sans-serif"

def mark_group(lines=True, fill=LEDGER):
    """The mark in a 512x512 box: three bars, each increment over the last in amber, a chalk trend line."""
    yard = f'''
    <g stroke="{CHALK}" stroke-opacity="0.18" stroke-width="4">
      <line x1="60" y1="196" x2="452" y2="196"/><line x1="40" y1="256" x2="472" y2="256"/><line x1="60" y1="316" x2="452" y2="316"/>
    </g>''' if lines else ""
    return f'''
    <circle cx="256" cy="256" r="256" fill="{fill}"/>{yard}
    <rect x="128" y="322" width="72" height="66" fill="{CHALK}"/>
    <rect x="220" y="322" width="72" height="66" fill="{CHALK}"/>
    <rect x="220" y="256" width="72" height="66" fill="{AMBER}"/>
    <rect x="312" y="256" width="72" height="132" fill="{CHALK}"/>
    <rect x="312" y="190" width="72" height="66" fill="{AMBER}"/>
    <rect x="108" y="388" width="296" height="10" fill="{CHALK}"/>
    <polyline points="164,300 256,234 348,168" fill="none" stroke="{CHALK}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <polygon points="0,-16 30,0 0,16" fill="{CHALK}" transform="translate(348,168) rotate(-35.66)"/>'''

def svg(w, h, body, title):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">
  <title>{title}</title>{body}
</svg>
'''

# --- mark / avatar ---
MARK = svg(512, 512, mark_group(), "Marginal Gains mark")

# --- badge with ring text ---
badge_body = f'''
  <defs>
    <path id="ringTop" d="M 60 256 a 196 196 0 0 1 392 0"/>
    <path id="ringBottom" d="M 44 256 a 212 212 0 0 0 424 0"/>
  </defs>
  <circle cx="256" cy="256" r="248" fill="{LEDGER}"/>
  <circle cx="256" cy="256" r="236" fill="none" stroke="{CHALK}" stroke-width="4"/>
  <g transform="translate(97.5,97.5) scale(0.62)">{mark_group(fill=FIELD)}
  </g>
  <g font-family="{FONT}" font-weight="800" letter-spacing="6">
    <text font-size="42" fill="{CHALK}"><textPath href="#ringTop" startOffset="50%" text-anchor="middle">MARGINAL GAINS</textPath></text>
    <text font-size="26" fill="{AMBER}" letter-spacing="8"><textPath href="#ringBottom" startOffset="50%" text-anchor="middle">BLACK4 · EST. 2026</textPath></text>
  </g>'''
BADGE = svg(512, 512, badge_body, "Marginal Gains badge")

# --- wordmarks ---
def wordmark(bg, title_fill, name):
    body = f'''
  <rect width="1600" height="400" fill="{bg}"/>
  <g transform="translate(60,40) scale(0.625)">{mark_group(fill=FIELD if bg == LEDGER else LEDGER)}
  </g>
  <g font-family="{FONT}">
    <text x="440" y="195" font-size="100" font-weight="800" fill="{title_fill}" letter-spacing="4">MARGINAL GAINS</text>
    <text x="446" y="270" font-size="44" font-weight="600" fill="{AMBER}" letter-spacing="10">SMALL EDGES. COMPOUNDED.</text>
  </g>'''
    return svg(1600, 400, body, name)
WM_DARK  = wordmark(LEDGER, CHALK, "Marginal Gains wordmark on ledger green")
WM_LIGHT = wordmark(CHALK, LEDGER, "Marginal Gains wordmark on chalk")

# --- banner ---
banner_body = f'''
  <rect width="1500" height="500" fill="{LEDGER}"/>
  <g stroke="{CHALK}" stroke-opacity="0.10" stroke-width="3">
    <line x1="0" y1="100" x2="1500" y2="100"/><line x1="0" y1="200" x2="1500" y2="200"/>
    <line x1="0" y1="300" x2="1500" y2="300"/><line x1="0" y1="400" x2="1500" y2="400"/>
    <line x1="1180" y1="0" x2="1180" y2="500"/><line x1="1280" y1="0" x2="1280" y2="500"/><line x1="1380" y1="0" x2="1380" y2="500"/>
  </g>
  <g transform="translate(80,70) scale(0.70)">{mark_group(lines=False, fill=FIELD)}
  </g>
  <g font-family="{FONT}">
    <text x="480" y="215" font-size="88" font-weight="800" fill="{CHALK}" letter-spacing="3">MARGINAL GAINS</text>
    <text x="484" y="282" font-size="36" font-weight="600" fill="{AMBER}" letter-spacing="9">SMALL EDGES. COMPOUNDED.</text>
    <text x="484" y="350" font-size="24" font-weight="500" fill="{CHALK}" fill-opacity="0.75" letter-spacing="2">ANTHROPIC · CLAUDE FABLE 5.1 · CLAUDE CODE · BLACK4 2026</text>
  </g>'''
BANNER = svg(1500, 500, banner_body, "Marginal Gains banner")

out = pathlib.Path(__file__).resolve().parent.parent / "logo"
out.mkdir(exist_ok=True)
for name, content in {
    "mg-mark.svg": MARK, "mg-badge.svg": BADGE,
    "mg-wordmark-dark.svg": WM_DARK, "mg-wordmark-light.svg": WM_LIGHT, "mg-banner.svg": BANNER,
}.items():
    (out / name).write_text(content)
    print("wrote", out / name)
