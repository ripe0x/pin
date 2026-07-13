"use client";

/**
 * Client-side canonical capture: renders a token document in a hidden,
 * sandboxed iframe and produces the spec frame as a PNG Blob
 * (docs/injection-convention.md § The canonical capture;
 * docs/pnd-collection-thumbnails.md §3.1).
 *
 * The preview sandbox deliberately lacks `allow-same-origin`, so the
 * parent page can never reach into the frame (untrusted artist code must
 * not script the studio origin). Capture therefore runs INSIDE the frame:
 * a small agent script is appended after the artist's code, waits out the
 * deterministic warm-up, draws the work's canvas onto an output canvas
 * sized to the spec (long edge at devicePixelRatio 1, flattened onto the
 * declared background), and posts the PNG bytes out via postMessage. The
 * sandbox posture is unchanged; the only new capability used is
 * messaging, which sandboxed frames already have.
 *
 * Determinism caveats live in the spec: pure 2D work reproduces
 * byte-for-byte in practice; WebGL needs preserveDrawingBuffer and is
 * only visually reproducible across GPUs.
 */

import { buildTokenHTML } from "./build";
import type { BuildOptions, ContentResolver, TokenData, WorkInput } from "./types";

export type CaptureOptions = {
  /** Output long edge in px at DPR 1 (spec default 1200). */
  longEdge?: number;
  /** Extra requestAnimationFrame ticks before the grab (default 2). */
  warmupFrames?: number;
  /** Extra settle time in ms after the frames (default 0). */
  warmupMs?: number;
  /** Flatten background (spec: no alpha). Default white. */
  background?: string;
  /** Layout size of the hidden frame the work renders into. */
  frameWidth?: number;
  frameHeight?: number;
  /** Give up after this long (default 30s). */
  timeoutMs?: number;
};

/** The agent injected after the artist's code. Runs inside the sandbox. */
function captureAgentJs(nonce: string, o: Required<Pick<CaptureOptions, "longEdge" | "warmupFrames" | "warmupMs" | "background">>): string {
  // NOTE: keep this dependency-free ES5-ish JS; it executes in the work's
  // document, after its libraries, and must never disturb the render.
  return (
    "(function(){" +
    `var NONCE=${JSON.stringify(nonce)};` +
    `var LONG=${o.longEdge},FRAMES=${o.warmupFrames},SETTLE=${o.warmupMs},BG=${JSON.stringify(o.background)};` +
    "function fail(msg){parent.postMessage({pndCapture:NONCE,ok:false,error:String(msg)},'*');}" +
    "function pick(){var cs=document.getElementsByTagName('canvas');var best=null,area=0;" +
    "for(var i=0;i<cs.length;i++){var a=cs[i].width*cs[i].height;if(a>area){area=a;best=cs[i];}}return best;}" +
    "function grab(){try{var src=pick();if(!src||!src.width||!src.height){return fail('no canvas to capture');}" +
    "var scale=LONG/Math.max(src.width,src.height);" +
    "var w=Math.round(src.width*Math.min(scale,1)),h=Math.round(src.height*Math.min(scale,1));" +
    "var out=document.createElement('canvas');out.width=w;out.height=h;" +
    "var ctx=out.getContext('2d');ctx.fillStyle=BG;ctx.fillRect(0,0,w,h);" +
    "ctx.drawImage(src,0,0,w,h);" +
    "out.toBlob(function(blob){if(!blob){return fail('toBlob returned null');}" +
    "blob.arrayBuffer().then(function(buf){" +
    "parent.postMessage({pndCapture:NONCE,ok:true,width:w,height:h,buf:buf},'*',[buf]);});},'image/png');}" +
    "catch(e){fail(e&&e.message?e.message:e);}}" +
    "function afterFrames(n,fn){if(n<=0){fn();return;}requestAnimationFrame(function(){afterFrames(n-1,fn);});}" +
    "function start(){afterFrames(FRAMES,function(){SETTLE>0?setTimeout(grab,SETTLE):grab();});}" +
    "if(document.readyState==='complete'){start();}else{window.addEventListener('load',start);}" +
    "})();"
  );
}

/** Append the agent to a built token document, just before </body>. */
function withAgent(doc: string, agent: string): string {
  const tag = "<script>" + agent + "</script>";
  const idx = doc.lastIndexOf("</body>");
  return idx === -1 ? doc + tag : doc.slice(0, idx) + tag + doc.slice(idx);
}

/**
 * Render the token in a hidden sandboxed iframe and resolve with the
 * canonical PNG frame. Throws on timeout, on a work with no canvas, and
 * on a tainted/unreadable canvas (WebGL without preserveDrawingBuffer).
 */
export async function captureTokenPNG(
  work: WorkInput,
  tokenData: TokenData,
  resolver: ContentResolver,
  gunzip: BuildOptions["gunzip"],
  opts: CaptureOptions = {},
): Promise<Blob> {
  const longEdge = opts.longEdge ?? 1200;
  const warmupFrames = opts.warmupFrames ?? 2;
  const warmupMs = opts.warmupMs ?? 0;
  const background = opts.background ?? "#ffffff";
  const frameWidth = opts.frameWidth ?? longEdge;
  const frameHeight = opts.frameHeight ?? longEdge;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const doc = await buildTokenHTML(work, tokenData, resolver, { gunzip });
  const nonce = `cap-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const framed = withAgent(doc, captureAgentJs(nonce, { longEdge, warmupFrames, warmupMs, background }));

  return new Promise<Blob>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    // Real layout (the work sizes its canvas from the viewport), but out of
    // sight and out of the way.
    Object.assign(iframe.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: `${frameWidth}px`,
      height: `${frameHeight}px`,
      opacity: "0",
      pointerEvents: "none",
      border: "0",
    });

    let settled = false;
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      iframe.remove();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { pndCapture?: string; ok?: boolean; error?: string; buf?: ArrayBuffer };
      if (!data || data.pndCapture !== nonce || settled) return;
      settled = true;
      cleanup();
      if (data.ok && data.buf) {
        resolve(new Blob([data.buf], { type: "image/png" }));
      } else {
        reject(new Error(data.error ?? "capture failed"));
      }
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    iframe.srcdoc = framed;
    document.body.appendChild(iframe);
  });
}
