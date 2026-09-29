/**
 * Shared holo renderer for iridescent cards. One hidden WebGL canvas renders the
 * plasma shader, every card copies the frame into its own small 2D canvas.
 * One WebGL context for all cards, because browsers only allow ~16 of them.
 * Each card crops a random part so they don't all look the same.
 * The loop only runs while at least one card is subscribed.
 */

import { onFxIdle } from "@/lib/fx";

// size of the shared frame (4:5 like the cards)
const GLW = 512;
const GLH = 640;

const VERT = `
  attribute vec2 p;
  void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
  precision highp float;
  uniform float u_time;
  uniform vec2 u_res;
  #define TAU 6.28318530718
  #define ITER 5
  void main(){
    vec2 uv = gl_FragCoord.xy / u_res.xy;
    vec2 sc = uv;
    sc.x *= u_res.x / u_res.y;
    float t = u_time * 0.5 + 23.0;
    vec2 p = mod(sc * TAU * 1.5, TAU) - 250.0;
    vec2 i = vec2(p);
    float c = 1.0;
    float inten = 0.005;
    for (int n = 0; n < ITER; n++) {
      float tt = t * (1.0 - (3.5 / float(n + 1)));
      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
      c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
    }
    c /= float(ITER);
    c = 1.17 - pow(c, 1.4);
    float bright = pow(abs(c), 8.0);
    bright = clamp(bright * 0.85, 0.0, 1.0);
    float ph = uv.x * 0.55 + uv.y * 0.35 + u_time * 0.04 + bright * 0.45;
    vec3 pal = 0.66 + 0.30 * cos(TAU * (vec3(0.0, 0.33, 0.66) + ph));
    vec3 col = min(pal + bright * 0.55, vec3(1.0));
    // the cards control how strong it looks with their own globalAlpha
    float a = clamp(bright * 1.0 + 0.12, 0.0, 0.92);
    gl_FragColor = vec4(col, a);
  }
`;

export type HoloDraw = (frame: HTMLCanvasElement) => void;

let idle = false;

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let unavailable = false;
let raf = 0;
let holoTimer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let startT = 0;
// max ~30 fps, lower on the quiet holo frequency levels (see holoFreq.ts)
let frameMs = 1000 / 30;

/** Set the frame rate (fps). */
export function setHoloFrameRate(fps: number): void {
  frameMs = 1000 / Math.min(60, Math.max(10, fps));
}
let uTime: WebGLUniformLocation | null = null;
let uRes: WebGLUniformLocation | null = null;
const subs = new Set<HoloDraw>();

// stop the loop when nobody is looking (onFxIdle asks the window, see fx.ts).
// subscribed down here because onFxIdle fires right away and the lets above must exist.
if (typeof window !== "undefined") {
  onFxIdle((v) => {
    idle = v;
    if (idle) stopLoop();
    else if (subs.size) startLoop();
  });
}

function init(): boolean {
  if (gl) return true;
  if (unavailable) return false;
  canvas = document.createElement("canvas");
  canvas.width = GLW;
  canvas.height = GLH;
  const ctx = canvas.getContext("webgl", {
    antialias: true,
    premultipliedAlpha: false,
    // needed so drawImage can read the pixels after the frame
    preserveDrawingBuffer: true,
  });
  if (!ctx) {
    unavailable = true;
    return false;
  }
  gl = ctx;

  const compile = (type: number, src: string) => {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, src);
    gl!.compileShader(s);
    if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) console.error(gl!.getShaderInfoLog(s));
    return s;
  };

  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  uTime = gl.getUniformLocation(prog, "u_time");
  uRes = gl.getUniformLocation(prog, "u_res");
  gl.viewport(0, 0, GLW, GLH);
  return true;
}

function render() {
  if (!gl) return;
  gl.uniform1f(uTime, (performance.now() - startT) / 1000);
  gl.uniform2f(uRes, GLW, GLH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// use a timer instead of skipping rAF frames, otherwise the browser still runs all 60
function loop() {
  raf = 0;
  render();
  if (canvas) for (const fn of subs) fn(canvas);
  schedule();
}

function schedule() {
  if (!running) return;
  holoTimer = setTimeout(() => {
    holoTimer = undefined;
    raf = requestAnimationFrame(loop);
  }, frameMs);
}

function startLoop() {
  if (running) return;
  running = true;
  raf = requestAnimationFrame(loop);
}

function stopLoop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (holoTimer) clearTimeout(holoTimer);
  holoTimer = undefined;
}

/**
 * Subscribe a card's draw function. Returns unsubscribe.
 * The loop only runs while someone is subscribed. No-op if there's no WebGL.
 */
export function subscribeHolo(fn: HoloDraw): () => void {
  if (!init()) return () => {};
  subs.add(fn);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    // one static frame, no animation
    startT = performance.now();
    render();
    if (canvas) fn(canvas);
    return () => {
      subs.delete(fn);
    };
  }
  if (!running && !idle) {
    // don't reset the shader clock on stop/start, otherwise every burst looks the same
    if (!startT) startT = performance.now();
    startLoop();
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0) stopLoop();
  };
}

export const HOLO = { GLW, GLH };
