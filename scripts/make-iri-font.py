"""Makes the narrow Unbounded used on iridescent (src/assets/fonts/iri/).
Unbounded only comes in one width, so this squeezes every letter to NARROW of its width
(outlines, advances, kerning and mark positions). Unbounded is OFL with no reserved
font name, so a changed copy is fine. The files get their own family name.

    pip install fonttools brotli
    python scripts/make-iri-font.py

After a rebuild, bump the ?v= numbers in index.css so the app loads the new files.
"""
from pathlib import Path

from fontTools.ttLib import TTFont

NARROW = 0.86
WEIGHTS = [200, 300, 400, 500, 600, 700]
SRC = Path("node_modules/@fontsource/unbounded/files")
OUT = Path("src/assets/fonts/iri")


def scale_x(obj, seen):
    # walk the GPOS tables and scale every horizontal value
    if id(obj) in seen or obj is None or isinstance(obj, (int, float, str, bytes)):
        return
    seen.add(id(obj))
    if isinstance(obj, (list, tuple)):
        for item in obj:
            scale_x(item, seen)
        return
    for name in ("XAdvance", "XPlacement", "XCoordinate"):
        if isinstance(getattr(obj, name, None), (int, float)):
            setattr(obj, name, round(getattr(obj, name) * NARROW))
    for value in list(getattr(obj, "__dict__", {}).values()):
        scale_x(value, seen)


def squeeze(src, dst):
    font = TTFont(src)
    glyf, hmtx = font["glyf"], font["hmtx"]
    for name in font.getGlyphOrder():
        g = glyf[name]
        if g.numberOfContours != 0 and not g.isComposite():
            coords = g.coordinates
            for i, (x, y) in enumerate(coords):
                coords[i] = (round(x * NARROW), y)
        elif g.isComposite():
            for comp in g.components:
                comp.x = round(comp.x * NARROW)
        adv, lsb = hmtx[name]
        hmtx[name] = (round(adv * NARROW), round(lsb * NARROW))
    glyf.recalcBBoxes = True
    for name in font.getGlyphOrder():
        glyf[name].recalcBounds(glyf)
    if "GPOS" in font:
        scale_x(font["GPOS"].table, set())
    # own name, so it's clear this is a changed copy
    for rec in font["name"].names:
        if rec.nameID in (1, 3, 4, 6, 16):
            rec.string = str(rec.toUnicode()).replace("Unbounded", "Iri Unbounded Narrow")
    font.flavor = "woff2"
    font.save(dst)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for w in WEIGHTS:
        dst = OUT / f"iri-unbounded-narrow-{w}.woff2"
        squeeze(SRC / f"unbounded-latin-{w}-normal.woff2", dst)
        print("wrote", dst)
