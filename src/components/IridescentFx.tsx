import { useEffect, useRef } from "react";
import { setIridSnapshot } from "@/lib/iridSnapshot";
import { isFxIdle, onFxIdle } from "@/lib/fx";

/**
 * Iridescent animated background: a fullscreen WebGL fluid shader that looks like a
 * pearl thin film, flowing slowly ("Rainbow oil" palette), with film grain on top.
 */

/** Tiling noise (SVG data URI) for the film grain. */
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const VERT = `
  attribute vec2 p;
  void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
  precision highp float;
  uniform vec2 uRes;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uVisc;
  uniform float uPalette;

  float hash(vec2 p){
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  // 4 octaves, the 5th was too small to see and cost a lot
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for(int i = 0; i < 4; i++){
      v += a * noise(p);
      p = m * p;
      a *= 0.5;
    }
    return v;
  }

  vec3 irid(float t, float sel){
    vec3 a = vec3(0.5);
    vec3 b = vec3(0.5);
    vec3 cA = vec3(1.0, 1.0, 1.0);
    vec3 dA;
    if(sel < 0.5)        dA = vec3(0.95, 0.62, 0.40);
    else if(sel < 1.5)   dA = vec3(0.55, 0.45, 0.85);
    else if(sel < 2.5)   dA = vec3(0.30, 0.20, 0.20);
    else                 dA = vec3(0.80, 0.90, 0.30);
    return a + b * cos(6.28318 * (cA * t + dA));
  }

  void main(){
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
    float t = uTime * uSpeed;

    vec2 q;
    q.x = fbm(uv * 1.15 + vec2(0.0, t * 0.12));
    q.y = fbm(uv * 1.15 + vec2(5.2, -t * 0.10) + 1.7);

    vec2 r;
    float warp = mix(1.8, 4.2, uVisc);
    r.x = fbm(uv * 1.15 + warp * q + vec2(1.7, 9.2) + t * 0.08);
    r.y = fbm(uv * 1.15 + warp * q + vec2(8.3, 2.8) - t * 0.10);

    float f = fbm(uv * 1.15 + warp * r);

    // normal from forward differences: 2 fbm calls instead of 4
    float e = 0.0035;
    float fx = fbm((uv + vec2(e,0.0)) * 1.15 + warp * r) - f;
    float fy = fbm((uv + vec2(0.0,e)) * 1.15 + warp * r) - f;
    vec3 n = normalize(vec3(-fx, -fy, 0.01));

    vec3 viewd = normalize(vec3(0.0, 0.0, 1.0));
    float fres = pow(1.0 - max(dot(n, viewd), 0.0), 3.0);

    float idx = f * 1.0 + length(r) * 0.45 + fres * 0.45 + n.x * 0.6 + n.y * 0.4 + t * 0.025;
    vec3 tint  = irid(idx, uPalette);
    vec3 tint2 = irid(idx + 0.28, uPalette);

    vec3 pearl = vec3(0.91, 0.91, 0.94);

    float shade = smoothstep(0.0, 1.0, f);
    vec3 col = pearl * (0.86 + 0.14 * shade);

    vec3 pastel = mix(vec3(1.0), tint, 0.46);
    col *= mix(vec3(1.0), pastel, 0.47);
    col += (tint - 0.5) * 0.11;

    col += (tint2 - 0.5) * fres * 0.48;

    vec3 lightd = normalize(vec3(0.35, 0.55, 0.78));
    float spec = pow(max(dot(reflect(-lightd, n), viewd), 0.0), 9.0);
    col += spec * 0.22 * mix(vec3(1.0), pastel, 0.55);

    col = clamp(col, 0.0, 1.0);
    col = pow(col, vec3(0.95));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// default values ("Rainbow oil")
const SPEED = 0.2;
const VISCOSITY = 0.7;
const PALETTE = 0;

/**
 * Max shader pixels, no matter the window size. A big window just gets
 * stretched more (the shader has no sharp edges), the grain stays sharp.
 */
const MAX_PIXELS = 520_000;

/** ...and never more than this part of the real screen pixels. */
const MAX_SCALE = 0.55;

// log the renderer only once per app run
let loggedRenderer = false;

export function IridescentFx() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();

    // rebuilt by setup() on mount and after the GPU restores a lost context
    let gl: WebGLRenderingContext | null = null;
    let u: Record<string, WebGLUniformLocation | null> | null = null;
    let raf = 0;

    const setup = (): boolean => {
      const ctx = canvas.getContext("webgl", { antialias: true, premultipliedAlpha: false });
      if (!ctx) return false; // no WebGL → the dark wallpaper layers below show as fallback
      gl = ctx;
      // log which renderer is used (SwiftShader/Software/llvmpipe = CPU, slow)
      if (!loggedRenderer) {
        loggedRenderer = true;
        const dbg = ctx.getExtension("WEBGL_debug_renderer_info");
        const name = dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown";
        console.info(`[MiColl] iridescent WebGL renderer: ${name}`);
      }
      const compile = (type: number, src: string) => {
        const s = ctx.createShader(type)!;
        ctx.shaderSource(s, src);
        ctx.compileShader(s);
        if (!ctx.getShaderParameter(s, ctx.COMPILE_STATUS)) console.error(ctx.getShaderInfoLog(s));
        return s;
      };
      const prog = ctx.createProgram()!;
      ctx.attachShader(prog, compile(ctx.VERTEX_SHADER, VERT));
      ctx.attachShader(prog, compile(ctx.FRAGMENT_SHADER, FRAG));
      ctx.linkProgram(prog);
      ctx.useProgram(prog);
      const buf = ctx.createBuffer();
      ctx.bindBuffer(ctx.ARRAY_BUFFER, buf);
      ctx.bufferData(ctx.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), ctx.STATIC_DRAW);
      const loc = ctx.getAttribLocation(prog, "p");
      ctx.enableVertexAttribArray(loc);
      ctx.vertexAttribPointer(loc, 2, ctx.FLOAT, false, 0, 0);
      u = {
        res: ctx.getUniformLocation(prog, "uRes"),
        time: ctx.getUniformLocation(prog, "uTime"),
        speed: ctx.getUniformLocation(prog, "uSpeed"),
        visc: ctx.getUniformLocation(prog, "uVisc"),
        palette: ctx.getUniformLocation(prog, "uPalette"),
      };
      return true;
    };

    // reads the layout, so only called on resize (not every frame)
    const resize = () => {
      if (!gl) return;
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw <= 0 || ch <= 0) return;
      // count real pixels (clientWidth is CSS pixels)
      const dpr = window.devicePixelRatio || 1;
      const scale =
        dpr * Math.min(MAX_SCALE, Math.sqrt(MAX_PIXELS / (cw * ch * dpr * dpr)));
      const w = Math.max(1, Math.round(cw * scale));
      const h = Math.max(1, Math.round(ch * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };

    const draw = (t: number) => {
      if (!gl || !u) return;
      gl.uniform2f(u.res, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(u.time, t);
      gl.uniform1f(u.speed, SPEED);
      gl.uniform1f(u.visc, VISCOSITY);
      gl.uniform1f(u.palette, PALETTE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // save a small still of the current frame for when the animation is off
    // (see iridSnapshot). Has to run right after draw().
    let snapped = false;
    const captureSnapshot = () => {
      if (snapped || !canvas || canvas.width === 0) return;
      snapped = true;
      try {
        const scale = Math.min(1, 1600 / canvas.width);
        const sc = document.createElement("canvas");
        sc.width = Math.max(1, Math.round(canvas.width * scale));
        sc.height = Math.max(1, Math.round(canvas.height * scale));
        const c2d = sc.getContext("2d");
        if (c2d) {
          c2d.drawImage(canvas, 0, 0, sc.width, sc.height);
          setIridSnapshot(sc.toDataURL("image/jpeg", 0.82));
        }
      } catch {
        /* failed, the gradient fallback still works */
      }
    };

    // max 12 fps, woken by a timer (the fluid moves slowly, more isn't visible)
    const FRAME_MS = 1000 / 12;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;

    const tick = () => {
      raf = 0;
      draw((performance.now() - start) / 1000);
      // take the snapshot once after a few seconds
      if (!snapped && performance.now() - start >= 3000) captureSnapshot();
      schedule();
    };

    const schedule = () => {
      if (!running) return;
      timer = setTimeout(() => {
        timer = undefined;
        raf = requestAnimationFrame(tick);
      }, FRAME_MS);
    };

    const stopLoop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    const startLoop = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    const startRender = () => {
      resize();
      if (reduce) {
        draw(0);
        captureSnapshot();
      } else {
        stopLoop();
        // don't start the loop if the window is in the background at start
        if (!isFxIdle()) startLoop();
      }
    };

    // if the GPU loses the context, let it restore and rebuild (no black screen)
    const onLost = (e: Event) => {
      e.preventDefault();
      stopLoop();
    };
    const onRestored = () => {
      if (setup()) startRender();
    };
    canvas.addEventListener("webglcontextlost", onLost as EventListener, false);
    canvas.addEventListener("webglcontextrestored", onRestored, false);

    // stop the shader when nobody is looking, the last frame stays visible
    const stopIdle = onFxIdle((idle) => {
      if (reduce) return; // never looping anyway
      if (idle) stopLoop();
      else startLoop();
    });

    // resizing clears the canvas, so redraw right away (no flash)
    const onResize = () => {
      resize();
      if (gl && u) draw((performance.now() - start) / 1000);
    };
    window.addEventListener("resize", onResize);

    if (setup()) startRender();

    return () => {
      stopLoop();
      stopIdle();
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("webglcontextlost", onLost as EventListener);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      // don't call loseContext here, StrictMode mounts twice on the same canvas
    };
  }, []);

  return (
    <div aria-hidden className="iri-fx pointer-events-none absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {/* film grain */}
      <div className="iri-grain" style={{ backgroundImage: NOISE }} />
    </div>
  );
}
