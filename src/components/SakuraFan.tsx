import { useThumb } from "@/hooks/useThumb";

/* The folding fan on a sakura collection card: up to five pictures are its fields.
   Drawn in a 190 x 64 box, the pivot sits just below the bottom edge. */
const W = 190;
const H = 64;
const CX = 96;
const CY = 70;
const OUTER = 64;
const INNER = 24;
/** wider than high, the card is flat */
const STRETCH = 1.36;
const FROM = 188;
const TO = 352;

type Point = [number, number];

const at = (r: number, deg: number): Point => {
  const t = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(t) * STRETCH, CY + r * Math.sin(t)];
};
const line = (pts: Point[]) => pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join("L");

/** The fan's folds. Every second one stands out a bit, that makes the zigzag edge. */
function folds(count: number) {
  return Array.from({ length: count + 1 }, (_, i) => {
    const deg = FROM + ((TO - FROM) / count) * i;
    const ridge = i % 2 === 1;
    return { outer: at(ridge ? OUTER + 3 : OUTER, deg), inner: at(ridge ? INNER + 1 : INNER, deg) };
  });
}

export function SakuraFan({ paths }: { paths: string[] }) {
  // an even number of folds, so every picture gets whole ones
  const fields = Math.max(1, paths.length);
  const perField = fields === 1 ? 10 : fields === 2 ? 6 : fields === 3 ? 4 : 2;
  const f = folds(fields * perField);
  const outline: Point[] = [...f.map((p) => p.outer), ...f.map((p) => p.inner).reverse()];
  return (
    <span aria-hidden className="sak-fan" style={{ width: W, height: H }}>
      {paths.map((p, i) => {
        const part = f.slice(i * perField, (i + 1) * perField + 1);
        return (
          <FanField
            key={p}
            path={p}
            shape={[...part.map((q) => q.outer), ...part.map((q) => q.inner).reverse()]}
          />
        );
      })}
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="absolute inset-0">
        {/* bare paper when there is no picture */}
        {paths.length === 0 && <path d={`M${line(outline)}Z`} fill="rgba(249,168,212,0.14)" />}
        {/* the folds: one side lit, the other in shade */}
        {f.slice(0, -1).map((p, i) => (
          <path
            key={i}
            d={`M${line([p.outer, f[i + 1].outer, f[i + 1].inner, p.inner])}Z`}
            fill={i % 2 ? "rgba(40,8,26,0.16)" : "rgba(255,240,247,0.12)"}
          />
        ))}
        {/* ribs down to the pivot */}
        {f.map((p, i) => (
          <path key={i} d={`M${CX} ${CY}L${line([p.inner])}`} stroke="#d9a3b8" strokeWidth={1.5} />
        ))}
        {/* rim, and a line between two pictures */}
        <path d={`M${line(outline)}Z`} fill="none" stroke="#ffc4dd" strokeWidth={1.4} strokeLinejoin="round" />
        {paths.slice(1).map((p, i) => {
          const q = f[(i + 1) * perField];
          return <path key={p} d={`M${line([q.outer, q.inner])}`} stroke="#ffc4dd" strokeWidth={1.2} />;
        })}
        <circle cx={CX} cy={H} r={4} fill="#f472b6" stroke="#ffe1ee" />
      </svg>
    </span>
  );
}

/** One picture, cut to its field. Own component because it uses a hook per field. */
function FanField({ path, shape }: { path: string; shape: Point[] }) {
  const xs = shape.map((p) => p[0]);
  const ys = shape.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.min(H, Math.max(...ys)) - y;
  const src = useThumb(path, w > 80 ? 320 : 160);
  return (
    <span
      className="absolute bg-[#3a1c2c]"
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        clipPath: `polygon(${shape.map((p) => `${(p[0] - x).toFixed(1)}px ${(p[1] - y).toFixed(1)}px`).join(",")})`,
      }}
    >
      {src && <img src={src} alt="" decoding="async" className="h-full w-full object-cover object-[50%_25%]" />}
    </span>
  );
}
