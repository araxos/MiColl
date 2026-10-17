import { useLayoutEffect, useRef, useState } from "react";

/**
 * Cyberpunk animated backgrounds (01 "Data tear" = the default, 03 "Horizon").
 * Each is drawn at 2560x1440 like its static picture (wallpaperPresets) and scaled to
 * cover the window, so the moving version lines up with the still one. The markup
 * comes straight from the designs, as a bundled string. Only CSS animations (sweep,
 * tear, pulse/blink), which pause with the rest of the wallpaper when the app is idle.
 * The old glitch background (CyberpunkFx) is kept but no longer mounted.
 */

export type CyberAnimatedId = "data-tear" | "horizon";

const W = 2560;
const H = 1440;

const MARKUP: Record<CyberAnimatedId, string> = {
  "data-tear": `<style>@keyframes cpDTSweep { 0% { transform: translateY(-180px); } 100% { transform: translateY(1620px); } }
@keyframes cpDTTear {
0%,64%,100% { opacity:0; transform: translate(0, 300px); }
66% { opacity:1; transform: translate(-40px, 620px); }
68% { opacity:1; transform: translate(28px, 900px); }
70% { opacity:0; transform: translate(0, 1100px); }
88% { opacity:1; transform: translate(34px, 380px); }
90% { opacity:0; transform: translate(0, 760px); }
}
@keyframes cpDTPulse { 0%,100% { opacity:.55; } 50% { opacity:1; } }</style><div style="font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; position:relative; width:2560px; height:1440px; overflow:hidden; background:#07070a; background-image: radial-gradient(70% 90% at 88% 8%, rgba(255,0,60,0.20) 0%, transparent 58%), radial-gradient(80% 80% at 6% 92%, rgba(0,240,255,0.18) 0%, transparent 62%), linear-gradient(160deg, #0b0910 0%, #07070a 60%, #05050a 100%);">
<div style="position:absolute; inset:0; background:repeating-linear-gradient(180deg, rgba(255,255,255,0.028) 0px, rgba(255,255,255,0.028) 1px, transparent 1px, transparent 6px);"></div>
<div style="position:absolute; inset:0; background:linear-gradient(28deg, transparent 46%, rgba(0,240,255,0.14) 46%, rgba(0,240,255,0.14) 46.35%, transparent 46.35%), linear-gradient(28deg, transparent 47.4%, rgba(255,0,60,0.16) 47.4%, rgba(255,0,60,0.16) 47.7%, transparent 47.7%);"></div>
<div style="position:absolute; inset:0; background:linear-gradient(28deg, transparent 50%, rgba(252,238,10,0.045) 50%);"></div>
<div style="position:absolute; inset:0; background:linear-gradient(28deg, transparent 49.85%, rgba(252,238,10,0.7) 49.85%, rgba(252,238,10,0.7) 50.05%, transparent 50.05%);"></div>
<svg width="2560" height="1440" viewBox="0 0 2560 1440" style="position:absolute; inset:0;" aria-hidden="true">
<g stroke="#00F0FF" stroke-width="2" fill="none" opacity="0.32">
<path d="M2560,300 L2180,300 L2100,380 L1720,380"></path>
<path d="M2560,372 L2246,372 L2186,432 L1900,432"></path>
<path d="M2560,444 L2300,444 L2258,486 L2060,486"></path>
</g>
<g stroke="#FF003C" stroke-width="2" fill="none" opacity="0.3">
<path d="M0,1080 L360,1080 L438,1002 L800,1002"></path>
<path d="M0,1152 L300,1152 L356,1096 L620,1096"></path>
</g>
<g fill="#00F0FF" opacity="0.5">
<rect x="2380" y="620" width="60" height="6"></rect>
<rect x="2380" y="644" width="120" height="6"></rect>
<rect x="2380" y="668" width="40" height="6"></rect>
<rect x="2380" y="692" width="96" height="6"></rect>
</g>
<g fill="#FCEE0A" opacity="0.55">
<rect x="120" y="700" width="96" height="6"></rect>
<rect x="120" y="724" width="44" height="6"></rect>
<rect x="120" y="748" width="132" height="6"></rect>
</g>
<g fill="none" stroke="#FCEE0A" stroke-width="3" opacity="0.75">
<path d="M80,80 L80,150 M80,80 L150,80"></path>
<path d="M2480,1360 L2480,1290 M2480,1360 L2410,1360"></path>
</g>
</svg>
<div style="position:absolute; right:0; top:0; bottom:0; width:280px; display:flex; flex-direction:column; justify-content:space-between; padding:120px 0; box-sizing:border-box; align-items:flex-end;">
<div style="width:220px; height:2px; background:rgba(0,240,255,0.3);"></div>
<div style="width:150px; height:2px; background:rgba(255,0,60,0.35);"></div>
<div style="width:260px; height:2px; background:rgba(0,240,255,0.22);"></div>
<div style="width:110px; height:2px; background:rgba(252,238,10,0.3);"></div>
</div>
<div style="position:absolute; left:900px; top:1120px; width:760px; height:6px; background:linear-gradient(90deg, transparent, rgba(255,0,60,0.6), transparent); animation:cpDTPulse 4s ease-in-out infinite;"></div>
<span style="position:absolute; left:150px; bottom:120px; font-size:20px; font-weight:800; letter-spacing:0.38em; color:rgba(0,240,255,0.42); text-transform:uppercase;">0x6C4A 70 71 C3</span>
<span style="position:absolute; right:150px; top:130px; writing-mode:vertical-rl; font-size:20px; font-weight:700; letter-spacing:0.34em; color:rgba(255,0,60,0.45); text-transform:uppercase;">9E 54 FD 4F // 2018</span>
<div style="position:absolute; left:0; top:0; width:100%; height:180px; background:linear-gradient(180deg, transparent, rgba(255,0,60,0.10), transparent); animation:cpDTSweep 13s linear infinite;"></div>
<div style="position:absolute; left:0; top:0; width:100%; height:8px; background:rgba(0,240,255,0.45); mix-blend-mode:screen; animation:cpDTTear 9s steps(1,end) infinite;"></div>
<div style="position:absolute; inset:0; background:radial-gradient(85% 75% at 46% 52%, transparent 36%, rgba(5,5,10,0.6) 100%);"></div>
</div>`,
  horizon: `<style>@keyframes cpHZSweep { 0% { transform: translateY(-120px); } 100% { transform: translateY(1560px); } }
@keyframes cpHZTear {
0%,64%,100% { opacity:0; transform: translate(0, 300px); }
66% { opacity:1; transform: translate(-40px, 620px); }
68% { opacity:1; transform: translate(28px, 900px); }
70% { opacity:0; transform: translate(0, 1100px); }
88% { opacity:1; transform: translate(34px, 380px); }
90% { opacity:0; transform: translate(0, 760px); }
}
@keyframes cpHZBlink { 0%,60%,100% { opacity:1; } 70%,90% { opacity:.15; } }</style><div style="font-family:'Helvetica Neue', Helvetica, Arial, sans-serif; position:relative; width:2560px; height:1440px; overflow:hidden; background:#07070a; background-image: radial-gradient(120% 90% at 50% 118%, rgba(252,238,10,0.20) 0%, rgba(252,238,10,0.05) 34%, transparent 62%), radial-gradient(90% 70% at 12% -10%, rgba(0,240,255,0.16) 0%, transparent 60%), linear-gradient(180deg, #0a0a12 0%, #07070a 55%, #05050a 100%);">
<div style="position:absolute; inset:0; background:repeating-linear-gradient(180deg, rgba(0,240,255,0.05) 0px, rgba(0,240,255,0.05) 1px, transparent 1px, transparent 5px);"></div>
<svg width="2560" height="1440" viewBox="0 0 2560 1440" style="position:absolute; inset:0;" aria-hidden="true">
<defs>
<linearGradient id="cpbFade" x1="0" y1="1" x2="0" y2="0">
<stop offset="0" stop-color="#FCEE0A" stop-opacity="0.55"></stop>
<stop offset="0.7" stop-color="#FCEE0A" stop-opacity="0.06"></stop>
<stop offset="1" stop-color="#FCEE0A" stop-opacity="0"></stop>
</linearGradient>
<linearGradient id="cpbCyan" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#00F0FF" stop-opacity="0.5"></stop>
<stop offset="1" stop-color="#00F0FF" stop-opacity="0.05"></stop>
</linearGradient>
</defs>
<g stroke="url(#cpbFade)" fill="none" stroke-width="2">
<path d="M1280,1010 L-340,1440"></path>
<path d="M1280,1010 L120,1440"></path>
<path d="M1280,1010 L620,1440"></path>
<path d="M1280,1010 L1020,1440"></path>
<path d="M1280,1010 L1280,1440"></path>
<path d="M1280,1010 L1540,1440"></path>
<path d="M1280,1010 L1940,1440"></path>
<path d="M1280,1010 L2440,1440"></path>
<path d="M1280,1010 L2900,1440"></path>
<path d="M0,1046 H2560" opacity="0.35"></path>
<path d="M0,1092 H2560" opacity="0.45"></path>
<path d="M0,1162 H2560" opacity="0.6"></path>
<path d="M0,1264 H2560" opacity="0.75"></path>
<path d="M0,1412 H2560"></path>
</g>
<path d="M0,1006 H2560" stroke="#FCEE0A" stroke-width="3" opacity="0.9"></path>
<path d="M0,1000 H2560" stroke="#00F0FF" stroke-width="1.5" opacity="0.4"></path>
<g fill="none" stroke="url(#cpbCyan)" stroke-width="3">
<path d="M0,120 L180,120 L232,68 L520,68"></path>
<path d="M0,196 L96,196 L134,158 L380,158"></path>
<path d="M2560,132 L2320,132 L2262,190 L1990,190"></path>
</g>
<g fill="#FCEE0A" opacity="0.85">
<rect x="80" y="76" width="46" height="6"></rect>
<rect x="80" y="76" width="6" height="46"></rect>
<rect x="2434" y="1358" width="46" height="6"></rect>
<rect x="2474" y="1318" width="6" height="46"></rect>
</g>
<g fill="#00F0FF" opacity="0.7">
<rect x="2434" y="76" width="46" height="6"></rect>
<rect x="2474" y="76" width="6" height="46"></rect>
<rect x="80" y="1358" width="46" height="6"></rect>
<rect x="80" y="1318" width="6" height="46"></rect>
</g>
</svg>
<div style="position:absolute; left:0; bottom:0; width:640px; height:520px; background:linear-gradient(135deg, rgba(252,238,10,0.13), rgba(252,238,10,0.02) 60%, transparent); clip-path: polygon(0 120px, 120px 0, 640px 0, 640px 520px, 0 520px); border-top:2px solid rgba(252,238,10,0.35);"></div>
<div style="position:absolute; right:0; top:0; width:520px; height:420px; background:linear-gradient(225deg, rgba(0,240,255,0.10), transparent 65%); clip-path: polygon(0 0, 520px 0, 520px 300px, 400px 420px, 0 420px);"></div>
<div style="position:absolute; right:148px; top:520px; display:flex; flex-direction:column; gap:14px; align-items:flex-end;">
<div style="width:180px; height:4px; background:#FF003C; opacity:0.8;"></div>
<div style="width:96px; height:4px; background:rgba(252,238,10,0.5);"></div>
<div style="width:220px; height:4px; background:rgba(0,240,255,0.45);"></div>
</div>
<div style="position:absolute; left:152px; top:640px; width:16px; height:16px; background:#FF003C; animation:cpHZBlink 2.4s steps(1,end) infinite;"></div>
<span style="position:absolute; left:150px; bottom:120px; writing-mode:vertical-rl; font-size:20px; font-weight:700; letter-spacing:0.34em; color:rgba(252,238,10,0.4); text-transform:uppercase;">0x05CE 68 BE AD</span>
<span style="position:absolute; right:150px; bottom:118px; font-size:20px; font-weight:800; letter-spacing:0.38em; color:rgba(0,240,255,0.42); text-transform:uppercase;">35 40 88 F7 // 4799</span>
<div style="position:absolute; left:0; top:0; width:100%; height:140px; background:linear-gradient(180deg, transparent, rgba(0,240,255,0.13), transparent); animation:cpHZSweep 9s linear infinite;"></div>
<div style="position:absolute; left:0; top:0; width:100%; height:10px; background:rgba(255,0,60,0.4); mix-blend-mode:screen; animation:cpHZTear 11s steps(1,end) infinite;"></div>
<div style="position:absolute; inset:0; background:radial-gradient(90% 80% at 50% 48%, transparent 40%, rgba(5,5,10,0.55) 100%);"></div>
</div>`,
};

export function CyberpunkAnimated({ variant }: { variant: CyberAnimatedId }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.max(el.clientWidth / W, el.clientHeight / H));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute left-1/2 top-1/2"
        style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})` }}
        dangerouslySetInnerHTML={{ __html: MARKUP[variant] }}
      />
    </div>
  );
}
