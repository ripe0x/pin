// The outward conveyor as one vanilla-JS string, ported from the Homage site's
// lib/homage/conveyorScript.ts. It reads the palette + ground from an inlined static homage SVG
// and rebuilds it into the conveyor pool. It autoplays on init; a click freezes mid-motion at the
// current phase, the next click resumes from there. Auto-detects the square (classic) vs circle
// (PFP) form from the inlined shapes, so one script animates both.
//
// It's JS, not SMIL: the conveyor reorders ring paint order every frame (largest at the back),
// which the DOM can do and SMIL can't. A continuous requestAnimationFrame loop re-positions every
// ring each frame from a time-based phase, so the shapes morph smoothly rather than snapping.

const LINES = [
  "window.__homageConveyorInit=function(root){",
  "  if(root.__conv)return root.__conv;",
  "  var svg=root.querySelector('svg');if(!svg)return null;",
  "  var NS='http://www.w3.org/2000/svg';",
  "  var shapes=[].slice.call(svg.querySelectorAll('rect,circle'));",
  "  var ground='#000000',fills=[],circle=false;",
  "  for(var i=0;i<shapes.length;i++){var e=shapes[i];if(e.tagName==='rect'&&e.getAttribute('x')===null){ground=e.getAttribute('fill');}else{fills.push(e.getAttribute('fill'));if(e.tagName==='circle')circle=true;}}",
  "  var n=fills.length;if(n<2)return null;",
  "  var WO=192,U=240,AN=6,BMIN=-2,PERIOD=1400;",
  "  function sz(b){if(b>=n)return 0;var w=WO*(n-b)/n;return w<0?0:w;}",
  "  function ax(s){return (U-s)/2;}",
  "  function ay(s){return AN*(U-s)/8;}",
  "  function mk(t){return document.createElementNS(NS,t);}",
  "  while(svg.firstChild)svg.removeChild(svg.firstChild);",
  "  var cid='hc'+(window.__homageConvSeq=(window.__homageConvSeq||0)+1);",
  "  var defs=mk('defs'),cp=mk('clipPath');cp.setAttribute('id',cid);var cs;",
  "  if(circle){cs=mk('circle');cs.setAttribute('cx',U/2);cs.setAttribute('cy',ay(WO)+WO/2);cs.setAttribute('r',WO/2);}",
  "  else{cs=mk('rect');cs.setAttribute('x',ax(WO));cs.setAttribute('y',ay(WO));cs.setAttribute('width',WO);cs.setAttribute('height',WO);}",
  "  cp.appendChild(cs);defs.appendChild(cp);svg.appendChild(defs);",
  "  var gr=mk('rect');gr.setAttribute('width',U);gr.setAttribute('height',U);gr.setAttribute('fill',ground);svg.appendChild(gr);",
  "  var g=mk('g');g.setAttribute('clip-path','url(#'+cid+')');svg.appendChild(g);",
  "  var pool={},playing=false,raf=null,t0=0,pausedP=0;",
  "  function shape(el,s){var x=ax(s),y=ay(s);if(circle){el.setAttribute('cx',x+s/2);el.setAttribute('cy',y+s/2);el.setAttribute('r',s<0?0:s/2);}else{el.setAttribute('x',x);el.setAttribute('y',y);el.setAttribute('width',s<0?0:s);el.setAttribute('height',s<0?0:s);}}",
  "  function render(p){",
  "    var seen={},arr=[],hi=Math.floor(p),lo=Math.ceil(p+BMIN-n);",
  "    for(var m=lo;m<=hi;m++){var b=m-p+n;if(b<BMIN||b>n)continue;var el=pool[m];",
  "      if(!el){el=mk(circle?'circle':'rect');el.setAttribute('fill',fills[((m%n)+n)%n]);if(!circle)el.setAttribute('shape-rendering','crispEdges');pool[m]=el;}",
  "      var s=sz(b);shape(el,s);el.__s=s;seen[m]=1;arr.push(el);}",
  "    arr.sort(function(a,b){return b.__s-a.__s;});",
  "    for(var i=0;i<arr.length;i++)g.appendChild(arr[i]);",
  "    for(var k in pool){if(!seen[k]){if(pool[k].parentNode)pool[k].parentNode.removeChild(pool[k]);delete pool[k];}}",
  "  }",
  "  function now(){return (window.performance&&performance.now)?performance.now():Date.now();}",
  "  function frame(t){if(!playing)return;render((t-t0)/PERIOD);raf=requestAnimationFrame(frame);}",
  "  function play(){if(playing)return;playing=true;t0=now()-pausedP*PERIOD;raf=requestAnimationFrame(frame);}",
  "  function pause(){if(!playing)return;playing=false;if(raf){cancelAnimationFrame(raf);raf=null;}pausedP=((now()-t0)/PERIOD)%n;render(pausedP);}",
  "  function toggle(){if(playing){pause();}else{play();}}",
  "  root.addEventListener('click',toggle);",
  "  play();",
  "  var api={toggle:toggle,play:play,pause:pause,get playing(){return playing;},destroy:function(){pause();root.removeEventListener('click',toggle);root.__conv=null;}};",
  "  root.__conv=api;return api;",
  "};",
  "(function(){var els=document.querySelectorAll('[data-homage-conveyor]');for(var i=0;i<els.length;i++){window.__homageConveyorInit(els[i]);}})();",
]

const CONVEYOR_JS = LINES.join("\n")

// Dark, centered, autoplay on load, click toggles pause/resume, NO hint text.
const PREFIX =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<style>html,body{margin:0;height:100%;background:#0b0b0e;display:flex;align-items:center;justify-content:center;overflow:hidden}" +
  "#stage{width:min(100vw,100vh);height:min(100vw,100vh);cursor:pointer}#stage svg{width:100%;height:100%;display:block}</style></head>" +
  '<body><div id="stage" data-homage-conveyor>'
const MID = "</div><script>"
const SUFFIX = "</script></body></html>"

/** Self-contained animation document: the static SVG inlined + the conveyor, autoplaying on
 *  load. Feed a classic (squares) or PFP (circles) SVG — the script detects the form. */
export function buildConveyorHtml(svg: string): string {
  return PREFIX + svg + MID + CONVEYOR_JS + SUFFIX
}
