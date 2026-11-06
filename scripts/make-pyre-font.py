"""Builds PyreDisplay, the title font of the Pyre theme.
A derivative of Italiana (SIL OFL 1.1, reserved name, so it goes under its own name).
Digits and signs are Italiana with heavier stems. The capitals are drawn here from
scratch out of a few parts: heavy stems, hairlines, blades that taper into a point and
stems that end in a dagger below the baseline. Only meant for capitals, the app sets it
in uppercase.

    pip install fonttools shapely brotli
    python scripts/make-pyre-font.py src/assets/fonts/PyreDisplay.woff2

After a rebuild, bump the ?v= number in index.css so the app loads the new file.
"""
import math
import sys
import unicodedata

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from shapely import affinity
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

SOURCE = "node_modules/@fontsource/italiana/files/italiana-latin-400-normal.woff2"
STEM = 30  # how much heavier the verticals of digits and signs get, in font units
STEPS = 6
HAIR = 9  # how much thicker their hairlines get, they have to survive 22 px
CURVE = 10  # points per curve when flattening

CAP = 700
S = 94  # heavy stem of the capitals
T = 30  # hairline of the capitals


def flatten(glyph_set, name):
    """The glyph as closed polylines."""
    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[name].draw(pen)
    contours, cur = [], []
    for op, args in pen.value:
        if op == "moveTo":
            cur = [args[0]]
        elif op == "lineTo":
            cur.append(args[0])
        elif op == "qCurveTo":
            pts = list(args)
            if pts[-1] is None:
                # a contour without on-curve points, like the dot of an O-shape
                pts.pop()
                start = ((pts[-1][0] + pts[0][0]) / 2, (pts[-1][1] + pts[0][1]) / 2)
                cur = [start]
                pts.append(start)
            p0 = cur[-1]
            # implied on-curve points between the off-curve ones
            for i, c in enumerate(pts[:-1]):
                end = pts[-1] if i == len(pts) - 2 else ((c[0] + pts[i + 1][0]) / 2, (c[1] + pts[i + 1][1]) / 2)
                for t in range(1, CURVE + 1):
                    u = t / CURVE
                    cur.append(
                        (
                            (1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * c[0] + u * u * end[0],
                            (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * c[1] + u * u * end[1],
                        )
                    )
                p0 = end
        elif op == "curveTo":
            p0, (a, b, c) = cur[-1], args
            for t in range(1, CURVE + 1):
                u = t / CURVE
                v = 1 - u
                cur.append(
                    (
                        v**3 * p0[0] + 3 * v * v * u * a[0] + 3 * v * u * u * b[0] + u**3 * c[0],
                        v**3 * p0[1] + 3 * v * v * u * a[1] + 3 * v * u * u * b[1] + u**3 * c[1],
                    )
                )
        elif op in ("closePath", "endPath"):
            if len(cur) > 2:
                contours.append(cur)
            cur = []
    return contours


def to_shape(contours):
    """Even-odd, so holes stay holes."""
    shape = None
    for c in contours:
        p = Polygon(c).buffer(0)
        shape = p if shape is None else shape.symmetric_difference(p)
    return shape


def path(start, *segs):
    """A polyline from a start point. A segment is a point (line) or three (cubic bezier)."""
    pts = [start]
    for seg in segs:
        p0 = pts[-1]
        if len(seg) == 3:
            a, b, c = seg
            for i in range(1, 41):
                u, v = i / 40, 1 - i / 40
                pts.append(
                    (
                        v**3 * p0[0] + 3 * v * v * u * a[0] + 3 * v * u * u * b[0] + u**3 * c[0],
                        v**3 * p0[1] + 3 * v * v * u * a[1] + 3 * v * u * u * b[1] + u**3 * c[1],
                    )
                )
        else:
            for i in range(1, 25):
                u = i / 24
                pts.append((p0[0] + (seg[0] - p0[0]) * u, p0[1] + (seg[1] - p0[1]) * u))
    return pts


def width_at(profile, t):
    for (t0, w0), (t1, w1) in zip(profile, profile[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0) if t1 > t0 else 1
            u = u * u * (3 - 2 * u)
            return w0 + (w1 - w0) * u
    return profile[-1][1]


def ribbon(pts, profile):
    """A pen stroke along a polyline, its width set by (position 0..1, width) keys."""
    lengths = [0.0]
    for a, b in zip(pts, pts[1:]):
        lengths.append(lengths[-1] + math.dist(a, b))
    total = lengths[-1]
    left, right = [], []
    for i, p in enumerate(pts):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        d = math.hypot(dx, dy) or 1
        w = width_at(profile, lengths[i] / total) / 2
        left.append((p[0] - dy / d * w, p[1] + dx / d * w))
        right.append((p[0] + dy / d * w, p[1] - dx / d * w))
    quads = []
    for i in range(len(pts) - 1):
        q = Polygon([left[i], right[i], right[i + 1], left[i + 1]]).convex_hull
        if q.area > 0:
            quads.append(q)
    return unary_union(quads)


def line(x0, y0, x1, y1, w=T):
    return ribbon([(x0, y0), (x1, y1)], [(0, w), (1, w)])


def stem(cx, y0=0, y1=CAP, w=S):
    return Polygon([(cx - w / 2, y0), (cx + w / 2, y0), (cx + w / 2, y1), (cx - w / 2, y1)])


def serif(cx, y, left, right, up=1, w=S):
    """A hairline foot that swells into its stem."""
    h = T * 0.62
    k = 58
    pts = [(cx - left, y), (cx + right, y), (cx + right, y + up * h)]
    pts += path(pts[-1], ((cx + w * 0.6, y + up * h), (cx + w / 2, y + up * h * 1.6), (cx + w / 2, y + up * k)))[1:]
    pts.append((cx - w / 2, y + up * k))
    pts += path(pts[-1], ((cx - w / 2, y + up * h * 1.6), (cx - w * 0.6, y + up * h), (cx - left, y + up * h)))[1:]
    return Polygon(pts).buffer(0)


def dagger(cx, tip=-120, w=S, top=CAP):
    """A stem that runs out below the baseline into a point, with a small guard."""
    body = Polygon([(cx - w / 2, top), (cx + w / 2, top), (cx + w / 2, 40), (cx, tip), (cx - w / 2, 40)])
    return unary_union([body, serif(cx, 0, 74, 74, up=1, w=w)])


def beak(x, y, down=True, length=118, w=38):
    """The hanging point at the end of a top or bottom arm."""
    d = -1 if down else 1
    pts = path((x, y), ((x, y + d * length * 0.4), (x + 8, y + d * length * 0.7), (x + 22, y + d * length)))
    return ribbon(pts, [(0, w), (1, 0)])


def tick(x, y, up=52, down=52):
    """The small upright end of a middle arm."""
    return ribbon([(x, y + up), (x, y), (x, y - down)], [(0, 0), (0.5, 40), (1, 0)])


def bow(*pts):
    """A stroke that is hairline at both ends and heavy in the middle."""
    return ribbon(path(*pts), [(0, T), (0.22, T), (0.5, S + 14), (0.78, T), (1, T)])


def blade_leg(start, *segs):
    """The sweeping leg of R and K, it ends in a point below the baseline."""
    return ribbon(path(start, *segs), [(0, T), (0.12, T + 6), (0.45, S + 12), (0.72, 58), (1, 0)])


def sweep(start, turn=350):
    """A bottom arm that swells at its end and flicks upwards into a point."""
    return ribbon(
        path((start, 15), (turn, 15), ((turn + 100, 15), (turn + 180, 70), (turn + 222, 214))),
        [(0, T), (0.55, T), (0.82, 48), (1, 0)],
    )


def ogive_side(sign, cx=384, wide=316):
    top, bottom, mid = 748, -48, 350
    x = cx + sign * wide
    pts = path((cx, top), ((cx + sign * 170, 640), (x, 500), (x, mid)), ((x, 200), (cx + sign * 170, 60), (cx, bottom)))
    return ribbon(pts, [(0, 0), (0.12, T), (0.5, S + 22), (0.88, T), (1, 0)])


def build_c():
    """The open round body of C and G, both ends run out in a point."""
    return ribbon(
        path(
            (606, 500),
            ((596, 640), (484, 712), (372, 712)),
            ((176, 712), (64, 530), (64, 350)),
            ((64, 170), (176, -12), (372, -12)),
            ((484, -12), (566, 46), (622, 176)),
        ),
        [(0, 0), (0.07, 40), (0.2, T), (0.5, S + 22), (0.8, T), (1, 0)],
    )


def build_a():
    tear = ribbon(
        path((356, 640), ((236, 420), (170, 150), (296, 108)), ((372, 84), (424, 170), (398, 318))),
        [(0, 8), (0.55, 42), (0.8, 20), (1, 0)],
    )
    return unary_union(
        [
            line(52, 0, 352, CAP + 26),
            Polygon([(322, CAP + 26), (372, CAP + 26), (640, 0), (500, 0)]),
            serif(52, 0, 66, 66, w=T),
            serif(566, 0, 112, 104, w=S + 30),
            tear,
        ]
    )


def build_b():
    return unary_union(
        [
            stem(122),
            serif(122, 0, 92, 40),
            serif(122, CAP, 92, 40, up=-1),
            bow((70, 685), ((370, 685), (476, 640), (476, 526)), ((476, 420), (380, 378), (160, 378))),
            bow((160, 378), ((450, 378), (552, 310), (552, 196)), ((552, 76), (420, 15), (70, 15))),
            ribbon([(390, 378), (566, 410)], [(0, T), (1, 0)]),
        ]
    )


def build_d():
    return unary_union(
        [
            stem(122),
            serif(122, 0, 104, 40),
            serif(122, CAP, 104, 40, up=-1),
            bow((70, 685), ((440, 685), (672, 610), (672, 350)), ((672, 90), (440, 15), (70, 15))),
        ]
    )


def build_e():
    return unary_union(
        [
            stem(122),
            serif(122, 0, 92, 40),
            serif(122, CAP, 92, 40, up=-1),
            line(120, 685, 540, 685),
            beak(528, 700),
            line(120, 372, 392, 372),
            tick(392, 372),
            sweep(120, 376),
        ]
    )


def build_f():
    return unary_union(
        [
            dagger(122),
            ribbon(path((-34, 742), ((30, 690), (70, 685), (130, 685)), (530, 685)), [(0, 0), (0.2, T), (1, T)]),
            beak(518, 700),
            line(120, 372, 392, 372),
            tick(392, 372),
        ]
    )


def build_g():
    return unary_union([build_c(), stem(590, 0, 300, 72), serif(590, 300, 96, 74, up=-1, w=72)])


def build_h():
    wave = ribbon(
        path((-6, 306), ((210, 420), (470, 282), (756, 392))),
        [(0, 0), (0.14, T), (0.86, T), (1, 0)],
    )
    return unary_union(
        [
            stem(126),
            stem(624),
            serif(126, 0, 96, 96),
            serif(126, CAP, 96, 96, up=-1),
            serif(624, 0, 96, 96),
            serif(624, CAP, 96, 96, up=-1),
            wave,
        ]
    )


def build_i():
    return unary_union([stem(150), serif(150, 0, 104, 104), serif(150, CAP, 104, 104, up=-1)])


def build_j():
    hook = ribbon(path((300, 700), (300, 60), ((300, -90), (190, -170), (40, -112))), [(0, S), (0.6, S), (1, 0)])
    return unary_union([hook, serif(300, CAP, 104, 104, up=-1)])


def build_k():
    return unary_union(
        [
            stem(122),
            serif(122, 0, 92, 92),
            serif(122, CAP, 92, 92, up=-1),
            line(160, 330, 520, 700),
            serif(520, CAP, 92, 92, up=-1, w=T),
            blade_leg((236, 448), ((340, 330), (396, 180), (470, 70)), ((512, 8), (580, -62), (690, -116))),
        ]
    )


def build_l():
    return unary_union([stem(122), serif(122, 0, 92, 40), serif(122, CAP, 92, 92, up=-1), sweep(120)])


def build_m():
    return unary_union(
        [
            line(116, 0, 150, CAP),
            serif(116, 0, 82, 82, w=T),
            Polygon([(92, CAP), (214, CAP), (486, -124), (450, -124)]),
            line(462, -84, 740, CAP),
            stem(748),
            serif(748, 0, 100, 96),
            serif(748, CAP, 72, 96, up=-1),
            serif(138, CAP, 80, 40, up=-1, w=T),
        ]
    )


def build_n():
    return unary_union(
        [
            line(100, 0, 100, CAP),
            serif(100, 0, 84, 84, w=T),
            serif(100, CAP, 84, 40, up=-1, w=T),
            Polygon([(72, CAP), (194, CAP), (664, -124), (630, -124)]),
            line(636, 40, 636, CAP),
            serif(636, CAP, 84, 84, up=-1, w=T),
        ]
    )


def build_o():
    return unary_union([ogive_side(-1), ogive_side(1)])


def build_p():
    return unary_union(
        [
            dagger(122),
            serif(122, CAP, 92, 40, up=-1),
            bow((70, 685), ((410, 685), (530, 620), (530, 492)), ((530, 364), (410, 300), (160, 300))),
        ]
    )


def build_q():
    tail = ribbon(path((372, 96), ((470, 40), (560, -40), (724, -128))), [(0, T), (0.45, 62), (1, 0)])
    return unary_union([build_o(), tail])


def build_r():
    return unary_union(
        [
            stem(122),
            serif(122, 0, 92, 92),
            serif(122, CAP, 92, 40, up=-1),
            bow((70, 685), ((370, 685), (494, 632), (494, 510)), ((494, 392), (380, 336), (160, 336))),
            blade_leg((256, 336), ((370, 326), (408, 230), (444, 130)), ((470, 56), (540, -48), (706, -118))),
        ]
    )


def build_s():
    return ribbon(
        path(
            (516, 500),
            ((506, 620), (420, 712), (300, 712)),
            ((176, 712), (96, 636), (96, 536)),
            ((96, 430), (196, 392), (296, 350)),
            ((412, 302), (510, 268), (510, 160)),
            ((510, 56), (416, -12), (296, -12)),
            ((176, -12), (86, 64), (62, 214)),
        ),
        [(0, 0), (0.08, 40), (0.2, T), (0.5, S + 22), (0.8, T), (0.92, 40), (1, 0)],
    )


def build_t():
    return unary_union([dagger(322), line(20, 685, 624, 685), beak(32, 700), beak(612, 700)])


def build_u():
    bowl = ribbon(
        path((122, 700), (122, 250), ((122, 90), (216, -12), (352, -12)), ((486, -12), (606, 90), (606, 250)), (606, 700)),
        [(0, S), (0.3, S), (0.5, 34), (0.62, T), (1, T)],
    )
    return unary_union([bowl, serif(122, CAP, 92, 92, up=-1), serif(606, CAP, 84, 84, up=-1, w=T)])


def build_v():
    return unary_union(
        [
            Polygon([(30, CAP), (160, CAP), (340, -124), (306, -124)]),
            line(320, -84, 618, CAP),
            serif(92, CAP, 100, 100, up=-1, w=S + 30),
            serif(618, CAP, 84, 84, up=-1, w=T),
        ]
    )


def build_w():
    return unary_union(
        [
            Polygon([(30, CAP), (156, CAP), (306, -124), (272, -124)]),
            line(286, -84, 500, CAP),
            Polygon([(440, CAP), (566, CAP), (716, -124), (682, -124)]),
            line(696, -84, 934, CAP),
            serif(92, CAP, 100, 100, up=-1, w=S + 30),
            serif(934, CAP, 84, 84, up=-1, w=T),
        ]
    )


def build_x():
    return unary_union(
        [
            Polygon([(30, CAP), (160, CAP), (676, -124), (640, -124)]),
            line(112, 0, 560, CAP),
            serif(92, CAP, 100, 100, up=-1, w=S + 30),
            serif(112, 0, 84, 84, w=T),
            serif(560, CAP, 84, 84, up=-1, w=T),
        ]
    )


def build_y():
    return unary_union(
        [
            dagger(322, top=330),
            Polygon([(30, CAP), (160, CAP), (372, 300), (272, 300)]),
            line(322, 320, 612, CAP),
            serif(92, CAP, 100, 100, up=-1, w=S + 30),
            serif(612, CAP, 84, 84, up=-1, w=T),
        ]
    )


def build_z():
    return unary_union(
        [
            Polygon([(442, CAP), (572, CAP), (150, 0), (24, 0)]),
            line(60, 685, 540, 685),
            beak(72, 700),
            sweep(40),
        ]
    )


# letter: (drawing, advance width)
LETTERS = {
    "A": (build_a, 690),
    "B": (build_b, 620),
    "C": (build_c, 660),
    "D": (build_d, 740),
    "E": (build_e, 620),
    "F": (build_f, 570),
    "G": (build_g, 700),
    "H": (build_h, 750),
    "I": (build_i, 300),
    "J": (build_j, 440),
    "K": (build_k, 660),
    "L": (build_l, 590),
    "M": (build_m, 890),
    "N": (build_n, 736),
    "O": (build_o, 768),
    "P": (build_p, 580),
    "Q": (build_q, 768),
    "R": (build_r, 640),
    "S": (build_s, 590),
    "T": (build_t, 644),
    "U": (build_u, 728),
    "V": (build_v, 640),
    "W": (build_w, 950),
    "X": (build_x, 680),
    "Y": (build_y, 640),
    "Z": (build_z, 610),
}


def draw(shape, glyph_set):
    pen = TTGlyphPen(glyph_set)
    polys = list(shape.geoms) if hasattr(shape, "geoms") else [shape]
    for poly in polys:
        if poly.is_empty or poly.geom_type != "Polygon":
            continue
        # TrueType: outer clockwise, holes counter-clockwise
        poly = orient(poly, sign=-1.0)
        for ring in [poly.exterior, *poly.interiors]:
            pts = [(round(x), round(y)) for x, y in ring.coords[:-1]]
            clean = [p for i, p in enumerate(pts) if p != pts[i - 1]]
            if len(clean) < 3:
                continue
            pen.moveTo(clean[0])
            for p in clean[1:]:
                pen.lineTo(p)
            pen.closePath()
    return pen.glyph()


def main(out):
    font = TTFont(SOURCE)
    glyph_set = font.getGlyphSet()
    cmap = font.getBestCmap()
    reverse = {}
    for code, name in cmap.items():
        reverse.setdefault(name, code)
    capitals = {ch: (build(), adv) for ch, (build, adv) in LETTERS.items()}
    glyf, hmtx = font["glyf"], font["hmtx"]
    built = {}
    for name in font.getGlyphOrder():
        adv, lsb = hmtx[name]
        contours = flatten(glyph_set, name)
        if not contours:
            built[name] = (None, adv + STEM // 2)
            continue
        code = reverse.get(name)
        ch = chr(code) if code else ""
        base = unicodedata.normalize("NFD", ch)[0] if ch else ""
        if base in capitals:
            shape, new_adv = capitals[base]
            if ch != base:
                # keep the accent of Á, Ü ... and centre it on our letter
                marks = [c for c in contours if min(p[1] for p in c) > CAP or max(p[1] for p in c) < -10]
                if marks:
                    mark = to_shape(marks)
                    left, low, right, _ = mark.bounds
                    moved = affinity.translate(mark, xoff=new_adv / 2 - (left + right) / 2, yoff=26 if low > 0 else 0)
                    shape = unary_union([shape, moved])
            built[name] = (shape.simplify(0.6), new_adv)
            continue
        shape = to_shape(contours).simplify(0.4)
        smeared = unary_union([affinity.translate(shape, xoff=STEM * i / STEPS) for i in range(STEPS + 1)])
        raised = unary_union([affinity.translate(smeared, yoff=HAIR * (i / 3 - 0.5)) for i in range(4)])
        built[name] = (raised.simplify(0.5), adv + STEM)
    for name, (shape, adv) in built.items():
        if shape is not None:
            glyph = draw(shape, glyph_set)
            glyf[name] = glyph
            glyph.recalcBounds(glyf)
            hmtx[name] = (adv, glyph.xMin if hasattr(glyph, "xMin") else 0)
        else:
            hmtx[name] = (adv, 0)
    for table in ("prep", "gasp", "fpgm", "cvt "):
        if table in font:
            del font[table]
    for rec in font["name"].names:
        if rec.nameID in (1, 4, 16):
            rec.string = "Pyre Display"
        elif rec.nameID == 6:
            rec.string = "PyreDisplay-Regular"
        elif rec.nameID == 3:
            rec.string = "MiColl:PyreDisplay"
    font.flavor = "woff2" if out.endswith(".woff2") else None
    font.save(out)
    print("wrote", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "PyreDisplay.woff2")
