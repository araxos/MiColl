/**
 * Which renderer WebView2 uses for WebGL.
 * If there's no GPU it falls back to SwiftShader (software), then the premium
 * themes run on the CPU and use a lot more of it. Settings -> Performance shows this.
 */

export interface GpuInfo {
  /** Renderer name, e.g. "ANGLE (NVIDIA GeForce RTX 4070 ...)". */
  renderer: string;
  /** True if it's a software renderer (no GPU). */
  software: boolean;
  /** True if there's no WebGL at all. */
  unavailable: boolean;
}

const SOFTWARE = ["swiftshader", "software", "llvmpipe", "basic render", "microsoft basic"];

let cached: GpuInfo | null = null;

/** Read the renderer once (uses a small 1x1 context). */
export function gpuInfo(): GpuInfo {
  if (cached) return cached;
  let info: GpuInfo = { renderer: "unknown", software: false, unavailable: false };
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    const gl = c.getContext("webgl");
    if (!gl) {
      info = { renderer: "no WebGL", software: false, unavailable: true };
    } else {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const name = dbg
        ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? "")
        : String(gl.getParameter(gl.RENDERER) ?? "");
      const lower = name.toLowerCase();
      info = {
        renderer: name || "unknown",
        software: SOFTWARE.some((s) => lower.includes(s)),
        unavailable: false,
      };
      // free the context right away, WebView2 only allows a few at once
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    /* just keep "unknown" */
  }
  cached = info;
  return info;
}
