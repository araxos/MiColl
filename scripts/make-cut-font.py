"""Builds MiCollCut.ttf, our own display font for cyberpunk template cards.
Inspired by rough cyberpunk lettering: every letter is a few lines on a grid, each line
becomes a thick stroke that runs out into a needle, some ends shoot out as long spikes,
then scratches, bites out of the edges and a slant are added.
The randomness is seeded per letter, so every run gives the same font.

    pip install fonttools shapely
    python scripts/make-cut-font.py src/assets/fonts/MiCollCut.ttf

After a rebuild, bump the ?v= number in index.css so the app loads the new file.
"""
import math
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from shapely.geometry import LineString, LinearRing, MultiPolygon, Polygon, box
from shapely.ops import unary_union
from shapely.geometry.polygon import orient
from shapely import affinity

UX, UY = 118, 100          # grid unit -> font units (x stretched = wide letters)
STROKE = 118               # stroke width in font units
SLANT = math.tan(math.radians(13))
GAP_Y, GAP_H = 440, 56     # the scanline cut
SIDE = 70                  # side bearing

o = [(1, 0), (5, 0), (6, 1), (6, 6), (5, 7), (1, 7), (0, 6), (0, 1), (1, 0)]
P_top = [(0, 0), (0, 7), (5, 7), (6, 6), (6, 4.5), (5, 3.5), (0, 3.5)]

G = {  # name: (width in units, [polylines])
    "A": (6, [[(0, 0), (0, 5), (2, 7), (6, 7), (6, 0)], [(0, 3), (6, 3)]]),
    "B": (6, [[(0, 0), (0, 7), (5, 7), (6, 6), (6, 4.5), (5, 3.5), (0, 3.5)],
              [(5, 3.5), (6, 2.5), (6, 1), (5, 0), (0, 0)]]),
    "C": (6, [[(6, 7), (1, 7), (0, 6), (0, 1), (1, 0), (6, 0)]]),
    "D": (6, [[(0, 0), (0, 7), (4.5, 7), (6, 5.5), (6, 1.5), (4.5, 0), (0, 0)]]),
    "E": (6, [[(6, 7), (0, 7), (0, 0), (6, 0)], [(0, 3.5), (4.5, 3.5)]]),
    "F": (6, [[(6, 7), (0, 7), (0, 0)], [(0, 3.5), (4.5, 3.5)]]),
    "G": (6, [[(6, 7), (1, 7), (0, 6), (0, 1), (1, 0), (6, 0), (6, 3.5), (3.5, 3.5)]]),
    "H": (6, [[(0, 0), (0, 7)], [(6, 0), (6, 7)], [(0, 3.5), (6, 3.5)]]),
    "I": (0, [[(0, 0), (0, 7)]]),
    "J": (6, [[(6, 7), (6, 1), (5, 0), (1, 0), (0, 1), (0, 2)]]),
    "K": (6, [[(0, 0), (0, 7)], [(0, 3.5), (3.5, 3.5), (6, 7)], [(3.5, 3.5), (6, 0)]]),
    "L": (6, [[(0, 7), (0, 0), (6, 0)]]),
    "M": (7, [[(0, 0), (0, 7), (3.5, 3.5), (7, 7), (7, 0)]]),
    "N": (6, [[(0, 0), (0, 7), (6, 0), (6, 7)]]),
    "O": (6, [o]),
    "P": (6, [P_top]),
    "Q": (6, [o, [(4, 2), (6.4, -0.4)]]),
    "R": (6, [P_top, [(3.5, 3.5), (6, 0)]]),
    "S": (6, [[(6, 7), (1, 7), (0, 6), (0, 4.5), (1, 3.5), (5, 3.5), (6, 2.5), (6, 1), (5, 0), (0, 0)]]),
    "T": (6, [[(0, 7), (6, 7)], [(3, 7), (3, 0)]]),
    "U": (6, [[(0, 7), (0, 1), (1, 0), (5, 0), (6, 1), (6, 7)]]),
    "V": (6, [[(0, 7), (0, 3), (3, 0), (6, 3), (6, 7)]]),
    "W": (7, [[(0, 7), (0, 0), (3.5, 3.5), (7, 0), (7, 7)]]),
    "X": (6, [[(0, 7), (6, 0)], [(0, 0), (6, 7)]]),
    "Y": (6, [[(0, 7), (0, 4.5), (1, 3.5), (5, 3.5), (6, 4.5), (6, 7)], [(3, 3.5), (3, 0)]]),
    "Z": (6, [[(0, 7), (6, 7), (0, 0), (6, 0)]]),
    "zero": (5, [[(1, 0), (4, 0), (5, 1), (5, 6), (4, 7), (1, 7), (0, 6), (0, 1), (1, 0)], [(1.2, 1.5), (3.8, 5.5)]]),
    "one": (2.5, [[(0.8, 5.5), (2.5, 7), (2.5, 0)]]),
    "two": (6, [[(0, 7), (5, 7), (6, 6), (6, 4.5), (5, 3.5), (1, 3.5), (0, 2.5), (0, 0), (6, 0)]]),
    "three": (6, [[(0, 7), (5, 7), (6, 6), (6, 1), (5, 0), (0, 0)], [(1.5, 3.5), (6, 3.5)]]),
    "four": (6, [[(0, 7), (0, 3), (6, 3)], [(4.5, 5), (4.5, 0)]]),
    "five": (6, [[(6, 7), (0, 7), (0, 3.5), (5, 3.5), (6, 2.5), (6, 1), (5, 0), (0, 0)]]),
    "six": (6, [[(5.5, 7), (1, 7), (0, 6), (0, 1), (1, 0), (5, 0), (6, 1), (6, 2.5), (5, 3.5), (0, 3.5)]]),
    "seven": (6, [[(0, 7), (6, 7), (6, 6), (2.5, 0)]]),
    "eight": (6, [o, [(0, 3.5), (6, 3.5)]]),
    "nine": (6, [[(6, 3.5), (1, 3.5), (0, 4.5), (0, 6), (1, 7), (5, 7), (6, 6), (6, 1), (5, 0), (0.5, 0)]]),
    "hyphen": (3, [[(0, 3.5), (3, 3.5)]]),
    "period": (0, [[(0, 0), (0, 0.4)]]),
    "comma": (0.5, [[(0.5, 0.4), (0, -1)]]),
    "colon": (0, [[(0, 0), (0, 0.4)], [(0, 4), (0, 4.4)]]),
    "quotesingle": (0, [[(0, 7), (0, 5.5)]]),
    "exclam": (0, [[(0, 7), (0, 2)], [(0, 0), (0, 0.4)]]),
    "question": (6, [[(0, 6), (1, 7), (5, 7), (6, 6), (6, 4.5), (5, 3.5), (3, 3.5), (3, 2)], [(3, 0), (3, 0.4)]]),
    "ampersand": (6, [[(6, 0), (1.5, 5), (1.5, 6), (2.5, 7), (4, 7), (5, 6), (5, 5.2), (1, 3), (0, 2), (0, 1), (1, 0), (4, 0), (6, 2)]]),
    "slash": (4, [[(0, 0), (4, 7)]]),
    "underscore": (6, [[(0, -0.8), (6, -0.8)]]),
}

CHARS = {chr(c): chr(c) for c in range(ord("A"), ord("Z") + 1)}
CHARS.update({str(i): n for i, n in enumerate(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"])})
CHARS.update({"-": "hyphen", ".": "period", ",": "comma", ":": "colon", "'": "quotesingle",
              "!": "exclam", "?": "question", "&": "ampersand", "/": "slash", "_": "underscore"})


import random

BODY = 0.8        # letters are 80% of the grid height, spikes go above/below


def nib(x, y, r):
    # diamond pen tip, wider than tall
    return Polygon([(x - r * 1.25, y), (x, y + r * 0.9), (x + r * 1.25, y), (x, y - r * 0.9)])


def stroke(pts, rng, closed):
    # thick blunt body, the last part runs out into a needle
    if closed:
        pts = pts + [pts[0]]
    parts = []
    n = len(pts) - 1
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        r = STROKE / 2 * rng.uniform(0.85, 1.15)
        r1 = r if (i < n - 1 or closed) else STROKE / 2 * rng.uniform(0.1, 0.35)
        parts.append(MultiPolygon([nib(*a, r), nib(*b, r1)]).convex_hull)
    return unary_union(parts)


def needle(a, b, r0):
    # long thin spike from a to b
    return MultiPolygon([nib(*a, r0), nib(*b, 3)]).convex_hull


def outline(width, lines, name="x"):
    rng = random.Random("micoll-cut-" + name)
    jit = lambda v: v + rng.uniform(-0.32, 0.32)
    shapes, spikes = [], []
    for pl in lines:
        closed = pl[0] == pl[-1] and len(pl) > 3
        if len(pl) == 2 and pl[0][0] == pl[1][0] and abs(pl[0][1] - pl[1][1]) <= 0.4:
            x, y = pl[0][0] * UX, pl[0][1] * UY * BODY
            shapes.append(nib(x, y + 25, STROKE * 0.7))  # dots
            continue
        src = pl[:-1] if closed else pl
        pts = [(jit(x) * UX, jit(y) * UY * BODY) for x, y in src]
        shapes.append(stroke(pts, rng, closed))
        if closed:
            continue
        # spikes: a vertical or diagonal end may shoot out as a long needle
        for (a, b) in ((pts[1], pts[0]), (pts[-2], pts[-1])):
            dx, dy = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(dx, dy) or 1
            steep = abs(dy) > abs(dx) * 0.8
            if (steep and rng.random() < 0.72) or rng.random() < 0.26:
                k = rng.uniform(2.6, 5.0) * UY / ln
                spikes.append(needle(b, (b[0] + dx * k, b[1] + dy * k), STROKE * 0.24))
    body = unary_union(shapes)
    g = unary_union(shapes + spikes)
    x0, y0, x1, y1 = g.bounds
    # scratches: thin slivers cut across the strokes
    for _ in range(rng.randint(5, 8)):
        y = rng.uniform(40, 7 * UY * BODY - 40)
        x = rng.uniform(x0, x1)
        g = g.difference(affinity.rotate(box(x, y, x + rng.uniform(100, 360), y + rng.uniform(32, 48)), rng.uniform(-7, 7)))
    # rough edges: small bites out of the outline
    edge = g.boundary
    for _ in range(rng.randint(9, 15)):
        pt = edge.interpolate(rng.uniform(0, edge.length))
        r = rng.uniform(12, 28)
        g = g.difference(Polygon([(pt.x - r, pt.y), (pt.x + r * 0.4, pt.y + r), (pt.x + r, pt.y - r * 0.3)]))
    g = g.buffer(0)
    # own random for size and slant, so changing scratches or spikes doesn't change the widths
    shape = random.Random("micoll-cut-shape-" + name)
    sx, sy, sk, dy = shape.uniform(0.88, 1.12), shape.uniform(0.86, 1.14), shape.uniform(9, 20), shape.uniform(-28, 28)
    def place(shape):
        shape = affinity.scale(shape, xfact=sx, yfact=sy, origin=(0, 0))
        shape = affinity.skew(shape, xs=sk, origin=(0, 0))
        return affinity.translate(shape, yoff=dy)
    # the width comes from the body only, needles may reach into the next letter
    return place(g), place(body).bounds


def draw(geom, shift):
    pen = TTGlyphPen(None)
    polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    for poly in polys:
        poly = orient(poly, sign=-1.0)  # TrueType: outer contours clockwise
        for ring in [poly.exterior, *poly.interiors]:
            pts = [(round(x + shift), round(y)) for x, y in list(ring.coords)[:-1]]
            pen.moveTo(pts[0])
            for p in pts[1:]:
                pen.lineTo(p)
            pen.closePath()
    return pen.glyph()


def build(path):
    names = [".notdef", "space"] + sorted(G)
    glyphs, metrics = {}, {}
    empty = TTGlyphPen(None).glyph()
    glyphs[".notdef"], metrics[".notdef"] = empty, (500, 0)
    glyphs["space"], metrics["space"] = empty, (360, 0)
    for name, (w, lines) in G.items():
        geom, (minx, _, maxx, _) = outline(w, lines, name)
        glyphs[name] = draw(geom, SIDE - minx)
        adv = round(maxx - minx + 2 * SIDE)
        metrics[name] = (adv, SIDE)
    cmap = {ord(" "): "space"}
    for ch, n in CHARS.items():
        cmap[ord(ch)] = n
        if ch.isalpha():
            cmap[ord(ch.lower())] = n  # lowercase shows the capitals
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=900, descent=-200)
    fb.setupOS2(sTypoAscender=900, sTypoDescender=-200, usWinAscent=900, usWinDescent=200,
                sCapHeight=700, sxHeight=700, fsSelection=0x40)
    fb.setupNameTable({
        "familyName": "MiColl Cut", "styleName": "Regular",
        "copyright": "Copyright (c) 2026 araxos. Made for MiColl.",
        "version": "Version 1.000", "psName": "MiCollCut-Regular",
    })
    fb.setupPost(italicAngle=-13)
    fb.save(path)


if __name__ == "__main__":
    build(sys.argv[1])
    print("wrote", sys.argv[1])
