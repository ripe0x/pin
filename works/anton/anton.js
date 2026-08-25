// Onchain generative work.
//
// Fully generative: everything (palette, tone, blob layout, flow, proportions)
// derives from the token seed (window.tokenData.hash), so every token is its own
// piece. Nothing is chosen or stored. The persistent and generative layers move
// organically at their natural speed, per token, exactly as in the source.
//
// Wallet-synced TIMING: the shape-morph and background-shift CADENCE is a
// function of the owner + a shared wall-clock, so every token a wallet holds
// changes on the same beat (even if each started at a different time), and a
// transfer inherits the new owner's rhythm. The shape SEQUENCE and the colours
// themselves are per-token (from the seed) — synced in when they change, not in
// what they change to. The blobs are deliberately not synced at all.
//
// The canonical still (context "capture") is an owner-independent representative
// frame — deterministic from the seed + palette + tone — so marketplace
// thumbnails stay stable across transfers.
(function () {
  "use strict";

  function hexToRgb01(hex) {
    var s = hex.replace("#", "");
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function hexList(arr) { return arr.map(hexToRgb01); }

  var PALETTES = {
    A: hexList(["#070a25", "#0b0b37", "#17123d", "#151947", "#878cd1", "#1e1f31", "#3d8ffa", "#a3ebc7", "#0dd1eb", "#0dd6c7", "#d1dbf2", "#dbd825"]),
    B: hexList(["#080f3b", "#140d47", "#33054d", "#551146", "#227086", "#9e1c59", "#142673", "#72126d", "#5766d4", "#e55d48", "#d65cc7", "#14c2e6", "#dee6ed"]),
    C: [[0.11, 0.2, 0.56], [0.44, 0.18, 0.72], [0.05, 0.06, 0.42], [0.06, 0.22, 0.74], [0.06, 0.2, 0.72], [0.7, 0.78, 0.92], [0.74, 0.66, 0.82], [0.86, 0.72, 0.8], [0.95, 0.52, 0.33], [0.92, 0.66, 0.54], [0.12, 0.9, 0.9], [0.1, 0.89, 0.88]],
    D: hexList(["#11122d", "#0b1338", "#1b1f61", "#171e7c", "#3843d6", "#e3442b", "#309edd", "#8eedf7", "#2cb7e6", "#1668e2", "#0b5aba", "#bf2180"]),
    E: hexList(["#15020b", "#c13d11", "#10052B", "#3a0515", "#060c30", "#041810", "#a2a19e", "#9c1051", "#ac3811", "#c04b15", "#BAB2AD", "#3247c9", "#48b98a", "#e4ad21", "#E0E012"]),
    F: hexList(["#d5d6d7", "#c1c5c7", "#889196", "#6a757d", "#5f6f7a", "#333f48", "#1a1f23", "#081b2e", "#27a6e6", "#e88311", "#22cd63", "#e0e9ee", "#6919e9", "#e41111", "#16DCB8"]),
    G: hexList(["#050e3b", "#081c44", "#092861", "#083c4f", "#092b2d", "#163658", "#061f39", "#D7DFE6", "#E26EB5", "#e9b814", "#d48d24", "#225bab", "#1171d9", "#a6ceeb", "#28a7a3", "#3cb07e"]),
    H: hexList(["#589cd0", "#dc7955", "#0a1e39", "#0f1c1d", "#7a322d", "#4a2727", "#331d1d", "#2b1c1c", "#4f9cc2", "#eb8c60", "#cbbbc0", "#efd4c9", "#e08d87", "#c66061", "#ab323a"]),
    I: hexList(["#211F50", "#372F69", "#48307F", "#044B85", "#1E6BA2", "#41716A", "#796C74", "#9A6C9A", "#C66D7A", "#F15E57", "#ED8737", "#D759A8"]),
    J: hexList(["#004DDB", "#0085E3", "#00A7D9", "#81A5DB", "#E78FD5", "#D954E5", "#9A6EEE", "#8E3EE1", "#6238D8", "#003D9E", "#282D62", "#1B1C31"])
  };
  var PALETTE_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

  // Palette-A base pivot: the sun/moon mood toggle.
  var TONE_BASE = { sun: [0.6176, 0.478, 0.3157], moon: [0.376, 0.478, 0.6157] };

  var RXY_WARP_MODE_COUNT = 15;
  var RXY_WARP_ADD_MODE_COUNT = 5;
  // Shape-morph cadence (source values): hold, then a short blend to the next
  // warp mode. Synced across a wallet.
  var WARP_INTERVAL = 10.0;
  var WARP_DURATION = 2.0;
  var WARP_PERIOD = WARP_INTERVAL + WARP_DURATION;
  // Background colour drift (source values): one mass at a time, cycling.
  var BG_SHIFT_DELAY = 60.0;
  var BG_SHIFT_DUR = 20.0;
  var BG_SHIFT_STEP = BG_SHIFT_DELAY + BG_SHIFT_DUR;

  // ── render context ──────────────────────────────────────────────────────────
  var td = (typeof window !== "undefined" && window.tokenData) || {};
  var ctx = typeof td.context === "string" ? td.context : "token";
  var owner = (typeof td.owner === "string" ? td.owner : "0x0000000000000000000000000000000000000000").toLowerCase();
  var params = td.params || {};
  var backgroundOnly = params.bgOnly === true || params.bgOnly === 1 || params.bgOnly === "1";

  // ── seeds ─────────────────────────────────────────────────────────────────
  // Everything about a token comes from its seed. Palette + tone are derived
  // from the seed the SAME way the renderer derives them for onchain traits:
  // palette = seed % 10, tone = (seed >> 8) % 2. Keep this in lockstep with
  // AntonRenderer.
  var seedHash = typeof td.hash === "string" ? td.hash : "0x0";
  var seedBig;
  try { seedBig = BigInt(seedHash); } catch (e) { seedBig = 0n; }
  var TONE_KEYS = ["sun", "moon"];
  var paletteMode = PALETTE_KEYS[Number(seedBig % BigInt(PALETTE_KEYS.length))];
  var toneMode = TONE_KEYS[Number((seedBig >> 8n) % 2n)];
  var rng = mulberry32(xmur3(seedHash)());
  function rand(min, max) { return min + rng() * (max - min); }
  function pickStepped(min, max, step) {
    var count = Math.floor((max - min) / step) + 1;
    return min + Math.floor(rng() * count) * step;
  }

  // ── configuration (per token, from the seed) ────────────────────────────────
  var activePalette = PALETTES[paletteMode];
  var paletteABase = TONE_BASE[toneMode].slice();
  var flowMode = rng() < 0.5 ? "downflow" : "upflow";
  var persistentColAALayerEnabled = rng() < 0.65;
  var MAX_LAYERS = persistentColAALayerEnabled ? 5 : 4;
  var DYNAMIC_LAYER_SLOTS = 4;
  var flowOffset = pickStepped(300, 650, 25);
  var modeTau = pickStepped(2.2, 3.8, 0.2);
  var modeMaxIter = pickStepped(4, 8, 1);
  var modeCX = 0.5;
  var modeCY = 1.0;
  var colAAPhase = Math.floor(rng() * 4) + 1;
  var rxyWarpAddMode = Math.floor(rng() * RXY_WARP_ADD_MODE_COUNT);
  var seedWarpMode = Math.floor(rng() * RXY_WARP_MODE_COUNT); // pre-morph shape + capture still

  var staticShapeParams = new Float32Array([0.52, 0.18, 1.0, 0.4, 0.52, 0.32, 0.5, 0.31]);
  var STATIC_COLS_COUNT = 3;
  var staticCols = new Float32Array(STATIC_COLS_COUNT * 3);
  // Owner-independent representative static colours for the canonical still.
  var pickStaticColor = createDeckPicker(activePalette, rng, 4);
  var captureStatic = [];
  for (var si = 0; si < STATIC_COLS_COUNT; si++) captureStatic.push(pickStaticColor().slice());

  var pickDynamicColor = createDeckPicker(activePalette, rng, 4);

  // Owner-derived offset so each wallet has its own rhythm; within a wallet all
  // tokens share it, so they stay in sync.
  var ownerPhaseSec = (xmur3(owner + ":phase")() % 100000) / 100000 * WARP_PERIOD;

  // ── canvas + GL ─────────────────────────────────────────────────────────────
  var canvas = document.createElement("canvas");
  canvas.id = "gl";
  canvas.style.position = "fixed";
  canvas.style.left = "50%";
  canvas.style.top = "50%";
  canvas.style.transform = "translate(-50%, -50%)";
  canvas.style.display = "block";
  document.body.appendChild(canvas);
  document.body.style.margin = "0";
  document.body.style.background = "#0f1534";

  var glOpts = { preserveDrawingBuffer: ctx === "capture" };
  var gl = canvas.getContext("webgl2", glOpts) || canvas.getContext("webgl", glOpts);
  if (!gl) throw new Error("WebGL not supported");
  if ("drawingBufferColorSpace" in gl) gl.drawingBufferColorSpace = "display-p3";

  var vs =
    "attribute vec2 a_pos;" +
    "void main(){gl_Position=vec4(a_pos,0.0,1.0);}";

  var fs =
    "precision highp float;" +
    "uniform vec2 u_res;" +
    "uniform float u_time;" +
    "uniform float u_TAU;" +
    "uniform int u_MAX_ITER;" +
    "uniform float u_cX;" +
    "uniform float u_cY;" +
    "uniform float u_flowOffset;" +
    "uniform int u_colAAPhase;" +
    "uniform int u_rxyWarpModeA;" +
    "uniform int u_rxyWarpModeB;" +
    "uniform float u_rxyWarpMix;" +
    "uniform int u_rxyWarpAddMode;" +
    "const int MAX_LAYERS = " + MAX_LAYERS + ";" +
    "uniform vec4 u_layers[MAX_LAYERS];" +
    "uniform vec4 u_layerColors[MAX_LAYERS];" +
    "uniform vec2 u_layerParams[MAX_LAYERS];" +
    "uniform vec4 u_staticShapeParams[2];" +
    "uniform vec3 u_staticCols[3];" +
    "uniform vec3 u_paletteA;" +
    "uniform float u_bgOnly;" +
    "vec3 palette(in float t){" +
    "vec3 a=u_paletteA;" +
    "vec3 b=vec3(0.151,0.1349,0.255);" +
    "vec3 c=vec3(0.8471,0.7176,0.9882);" +
    "vec3 d=vec3(.642,0.442,0.667);" +
    "return a+b*cos(6.28318*(c*t+d));}" +
    "float blob(vec2 uv,vec2 c,vec2 r,float k){vec2 p=(uv-c)/r;return exp(-dot(p,p)*k);}" +
    "vec2 warpOffset(int mode,vec2 p){vec2 offset=vec2(0.0);" +
    "if(mode==0){offset.y+=.02*cos(p.x*15.2);}" +
    "else if(mode==1){offset.x+=.05*cos(p.x*5.2);}" +
    "else if(mode==2){offset.y+=.05*cos(p.y*15.2);}" +
    "else if(mode==3){offset.x+=.05*cos(p.y*12.8);}" +
    "else if(mode==4){offset.x+=.05*cos(p.y*8.8);}" +
    "else if(mode==5){offset.y+=.05*cos(p.y*6.8);}" +
    "else if(mode==6){offset.x+=.04*cos(p.x*15.8);}" +
    "else if(mode==7){offset.y+=.02*cos(p.x*15.8);}" +
    "else if(mode==8){offset.y+=.04*cos(p.x*6.5);}" +
    "else if(mode==9){offset.x+=.025*cos(p.x*7.5);}" +
    "else if(mode==10){offset.y+=.05*cos(p.y*2.5);}" +
    "else if(mode==11){offset.x+=.025*cos(p.y*18.5);}" +
    "else if(mode==12){offset.y+=.025*cos(p.y*18.5);}" +
    "else if(mode==13){offset.y+=.015*cos(p.x*22.5);}" +
    "else{offset.x+=.025*cos(p.x*15.5);}" +
    "return offset;}" +
    "vec2 additiveWarpOffset(int mode,vec2 p,float time){vec2 offset=vec2(0.0);" +
    "if(mode==0){offset+=vec2(0.0);}" +
    "else if(mode==1){offset.x+=.05*cos(p.y*2.5+time*0.15);}" +
    "else if(mode==2){offset.y+=.05*cos(p.y*2.5+time*0.15);}" +
    "else if(mode==3){offset.y+=.05*cos(p.y*10.5+time*0.15);}" +
    "else{offset.x+=.05*cos(p.x*10.5+time*0.15);}" +
    "return offset;}" +
    "void main(){" +
    "vec2 uv=gl_FragCoord.xy/u_res.xy;" +
    "vec2 xy=uv;vec2 xy2=uv;vec2 uvDiag=uv;" +
    "uvDiag.y+=sin(uv.x*5.6+0.8)*0.020;" +
    "float time=u_time*0.05+10.0;" +
    "vec2 uvs=uv;" +
    "vec2 p=mod(uvs*u_TAU,u_TAU)-u_flowOffset;" +
    "vec2 i=vec2(p);" +
    "float c=1.0;float inten=0.005;" +
    "float cX=u_cX;float cY=u_cY;" +
    "for(int n=0;n<8;n++){" +
    "if(n>=u_MAX_ITER)break;" +
    "float t=time*(1.0-(0.5/float(n+1)));" +
    "i=p+vec2(cos(t-i.x)+sin(t+i.y*cX),sin(t-i.y)+cos(t+i.x*cY));" +
    "c+=1.0/length(vec2(p.x/(sin(i.x+t)/inten),p.y/(cos(i.y+t)/inten)));}" +
    "c/=float(u_MAX_ITER);" +
    "c=1.17-pow(c,1.4);" +
    "vec3 c1=vec3(0.01071,0.086,0.0109);" +
    "vec3 c2=palette(xy.y+u_time*0.05);" +
    "vec3 c22=palette(0.015);" +
    "vec3 c3=vec3(0.412,0.235,0.63);" +
    "c22=mix(c22,c2,sin(xy.y+u_time*0.25));" +
    "vec3 bg1=c1;vec3 cd=c2;vec3 cm=c22;" +
    "float delta=sin(u_time*0.015)+1.0/2.0;" +
    "float h00=.25;" +
    "vec2 rxy=xy2;" +
    "vec2 randomCosWarpA=warpOffset(u_rxyWarpModeA,xy2);" +
    "vec2 randomCosWarpB=warpOffset(u_rxyWarpModeB,xy2);" +
    "vec2 randomCosWarp=mix(randomCosWarpA,randomCosWarpB,u_rxyWarpMix);" +
    "rxy+=randomCosWarp;" +
    "rxy+=additiveWarpOffset(u_rxyWarpAddMode,xy2,u_time);" +
    "vec2 center=vec2(0.5,0.6);" +
    "float r=length(rxy-center);" +
    "float h0r=cos((3.2)*r);" +
    "h00=h0r;" +
    "float h=0.085;" +
    "vec3 cmix=mix(bg1,cm,xy.x/h);" +
    "vec3 cmixA=mix(cd,bg1,xy.x);" +
    "vec3 cmix0=mix(cmix,cmixA,(xy.x-h)/(1.0-h));" +
    "vec3 colAA=mix(mix(c3,cmix0,xy.y/h00),mix(cmix0,c1,(xy.y-h00)/(1.0-h00)),step(h00,xy.y));" +
    "vec3 col=u_staticCols[0];" +
    "vec4 diagonalShape=u_staticShapeParams[0];" +
    "vec4 midBlueShape=u_staticShapeParams[1];" +
    "float diagonalViolet=blob(uvDiag,diagonalShape.xy,diagonalShape.zw,.6);" +
    "col=mix(col,u_staticCols[1],diagonalViolet*0.78);" +
    "float dynamicLayerInfluence=0.0;" +
    "vec3 dynamicLayerColorSum=vec3(0.0);" +
    "vec2 dynamicLayerCenterSum=vec2(0.0);" +
    "for(int i=0;i<MAX_LAYERS;i++){" +
    "vec4 L=u_layers[i];" +
    "if(L.z<=0.0||L.w<=0.0)continue;" +
    "vec2 luv=uvDiag;" +
    "float ph=u_layerParams[i].y;" +
    "luv.y+=sin((uv.x+ph)*8.8)*0.010+sin((uv.x*1.9-ph)*13.0)*0.004;" +
    "float m=blob(luv,L.xy,L.zw,u_layerParams[i].x);" +
    "float a=clamp(m*u_layerColors[i].a,0.0,1.0);" +
    "col=mix(col,u_layerColors[i].rgb,a*0.84);" +
    "float link=m*u_layerColors[i].a;" +
    "dynamicLayerInfluence+=link;" +
    "dynamicLayerColorSum+=u_layerColors[i].rgb*link;" +
    "dynamicLayerCenterSum+=L.xy*link;}" +
    "float dynamicLinkN=smoothstep(0.02,0.75,dynamicLayerInfluence);" +
    "vec3 dynamicLayerColor=dynamicLayerColorSum/(dynamicLayerInfluence+0.0001);" +
    "vec2 dynamicLayerCenter=dynamicLayerCenterSum/(dynamicLayerInfluence+0.0001);" +
    "vec3 dynamicColAA=mix(colAA,dynamicLayerColor,0.12*dynamicLinkN);" +
    "float phaseT=(sin(u_time*0.16)+1.0)*0.5;" +
    "float colAAW=mix(0.72,0.48,phaseT);" +
    "float colAAH=mix(0.34,0.22,phaseT);" +
    "if(u_colAAPhase==2){colAAW=mix(0.64,0.44,phaseT);colAAH=mix(0.38,0.24,phaseT);}" +
    "else if(u_colAAPhase==3){colAAW=mix(0.80,0.56,phaseT);colAAH=mix(0.28,0.18,phaseT);}" +
    "else if(u_colAAPhase==4){colAAW=mix(0.58,0.40,phaseT);colAAH=mix(0.42,0.28,phaseT);}" +
    "vec2 baseColAACenter=vec2(0.52,0.26+delta*0.08);" +
    "vec2 colAACenter=mix(baseColAACenter,dynamicLayerCenter,0.16*dynamicLinkN);" +
    "float colAAMask=blob(uv,colAACenter,vec2(colAAW,colAAH),2.6);" +
    "vec2 bridgeCenter=vec2(mix(0.52,colAACenter.x,0.5),mix(0.38,colAACenter.y,0.55));" +
    "float colAAStem=blob(uv,bridgeCenter,vec2(0.20,0.28),1.8);" +
    "float dynamicPenetration=smoothstep(0.08,0.90,colAAMask*0.65);" +
    "float midBlueLag=0.10+0.04*sin(u_time*0.11-1.1);" +
    "vec2 midBlueTarget=mix(midBlueShape.xy,colAACenter,0.40);" +
    "vec2 midBlueCenter=mix(midBlueShape.xy,midBlueTarget,0.78-midBlueLag);" +
    "midBlueCenter+=vec2(0.015*sin(u_time*0.17-0.8),-0.012*cos(u_time*0.13-1.4));" +
    "float midBluePatch=blob(uv,midBlueCenter,midBlueShape.zw,3.6);" +
    "col=mix(col,u_staticCols[2],midBluePatch*.48);" +
    "if(u_bgOnly<0.5){" +
    "col=mix(col,dynamicColAA,0.28+colAAMask*0.52);" +
    "vec3 fusedColAA=dynamicColAA*0.68;" +
    "col=mix(col,fusedColAA,dynamicPenetration*0.62);}" +
    "float centerSat=blob(uv,vec2(0.50,0.47),vec2(0.44,0.24),1.8);" +
    "float satLuma=dot(col,vec3(0.2126,0.7152,0.0722));" +
    "col=mix(vec3(satLuma),col,1.10+centerSat*0.18);" +
    "col=pow(clamp(col,0.0,1.0),vec3(.93));" +
    "gl_FragColor=vec4(col,1.0);}";

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  }

  var prg = gl.createProgram();
  gl.attachShader(prg, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prg, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prg);
  if (!gl.getProgramParameter(prg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prg));
  gl.useProgram(prg);

  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(prg, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  var u = {
    res: gl.getUniformLocation(prg, "u_res"),
    time: gl.getUniformLocation(prg, "u_time"),
    tau: gl.getUniformLocation(prg, "u_TAU"),
    maxIter: gl.getUniformLocation(prg, "u_MAX_ITER"),
    cX: gl.getUniformLocation(prg, "u_cX"),
    cY: gl.getUniformLocation(prg, "u_cY"),
    flowOffset: gl.getUniformLocation(prg, "u_flowOffset"),
    layers: gl.getUniformLocation(prg, "u_layers"),
    layerColors: gl.getUniformLocation(prg, "u_layerColors"),
    layerParams: gl.getUniformLocation(prg, "u_layerParams"),
    staticShapeParams: gl.getUniformLocation(prg, "u_staticShapeParams"),
    staticCols: gl.getUniformLocation(prg, "u_staticCols[0]"),
    paletteA: gl.getUniformLocation(prg, "u_paletteA"),
    bgOnly: gl.getUniformLocation(prg, "u_bgOnly"),
    colAAPhase: gl.getUniformLocation(prg, "u_colAAPhase"),
    rxyWarpModeA: gl.getUniformLocation(prg, "u_rxyWarpModeA"),
    rxyWarpModeB: gl.getUniformLocation(prg, "u_rxyWarpModeB"),
    rxyWarpMix: gl.getUniformLocation(prg, "u_rxyWarpMix"),
    rxyWarpAddMode: gl.getUniformLocation(prg, "u_rxyWarpAddMode")
  };

  // ── layer simulation (ported from the source: stateful, organic) ────────────
  function tintedColor(base, spread) {
    return [
      Math.min(1, Math.max(0, base[0] + rand(-spread, spread))),
      Math.min(1, Math.max(0, base[1] + rand(-spread, spread))),
      Math.min(1, Math.max(0, base[2] + rand(-spread, spread)))
    ];
  }
  function pickDynamicColorRandom() { return tintedColor(pickDynamicColor(), 0.06); }

  var layers = [];
  for (var li = 0; li < MAX_LAYERS; li++) {
    layers.push({ active: false, x: 0, y: 0, age: 0, scale: 1, sx: 0, sy: 0, speed: 0, k: 2, phase: 0, baseIntensity: 0.6, intensity: 0, color: [1, 1, 1], dirX: 1, nextDirChange: 0, nextColorChange: 0, colorMix: 1, fromColor: [1, 1, 1], toColor: [1, 1, 1] });
  }
  var persistentLayer = layers[MAX_LAYERS - 1];

  function spawnLayer(index, immediate) {
    var sx = flowMode === "upflow" ? rand(0.24, 0.4) : rand(0.28, 0.46);
    var sy = flowMode === "upflow" ? rand(0.12, 0.24) : rand(0.16, 0.34);
    var yJitter = rand(-0.03, 0.03);
    var yStart = flowMode === "upflow" ? 0.24 + yJitter : (immediate ? 1.02 + yJitter : 1.0 + sy + rand(0.04, 0.24));
    var l = layers[index];
    l.active = true;
    l.sx = sx; l.sy = sy;
    l.x = rand(0.26, 0.74);
    l.y = yStart;
    l.age = 0;
    l.scale = flowMode === "upflow" ? 0 : 1;
    l.speed = flowMode === "upflow" ? rand(0.01, 0.021) : rand(0.016, 0.031);
    l.k = rand(3.8, 6.2);
    l.phase = rng() * 10;
    l.baseIntensity = rand(0.44, 0.82);
    l.intensity = 0;
    l.color = pickDynamicColorRandom();
  }

  function setupPersistentColAALayer() {
    if (!persistentColAALayerEnabled) { persistentLayer.active = false; return; }
    persistentLayer.active = true;
    persistentLayer.x = rand(0.24, 0.76);
    persistentLayer.y = rand(0.42, 0.74);
    persistentLayer.age = 0;
    persistentLayer.scale = 1;
    persistentLayer.sx = rand(0.18, 0.28);
    persistentLayer.sy = rand(0.1, 0.18);
    persistentLayer.speed = rand(0.004, 0.008);
    persistentLayer.k = rand(4.2, 6.0);
    persistentLayer.phase = rng() * 10;
    persistentLayer.baseIntensity = rand(0.4, 0.68);
    persistentLayer.intensity = persistentLayer.baseIntensity;
    persistentLayer.color = pickDynamicColorRandom();
    persistentLayer.dirX = rng() < 0.5 ? -1 : 1;
    persistentLayer.nextDirChange = rand(5, 12);
    persistentLayer.nextColorChange = rand(6, 14);
    persistentLayer.colorMix = 1;
    persistentLayer.fromColor = persistentLayer.color.slice();
    persistentLayer.toColor = persistentLayer.color.slice();
  }

  var spawnAccum = 0;
  var SPAWN_EVERY = 2.8; // seconds, matching the source's setInterval(2800)
  function initSim() {
    for (var i = 0; i < MAX_LAYERS; i++) layers[i].active = false;
    for (var s = 0; s < 2; s++) { spawnLayer(s, true); layers[s].x += s * 0.1; }
    setupPersistentColAALayer();
    spawnAccum = 0;
  }

  function trySpawn() {
    if (flowMode === "upflow") {
      var activeCount = 0;
      for (var a = 0; a < DYNAMIC_LAYER_SLOTS; a++) if (layers[a].active) activeCount++;
      if (activeCount >= 3) return;
    }
    for (var idx = 0; idx < DYNAMIC_LAYER_SLOTS; idx++) {
      if (!layers[idx].active) { spawnLayer(idx, false); return; }
    }
  }

  function stepSim(dt) {
    spawnAccum += dt;
    while (spawnAccum >= SPAWN_EVERY) { spawnAccum -= SPAWN_EVERY; trySpawn(); }

    for (var i = 0; i < DYNAMIC_LAYER_SLOTS; i++) {
      var l = layers[i];
      if (!l.active) continue;
      if (flowMode === "upflow") {
        l.age += dt; l.y += l.speed * dt;
        var fadeInPos = smoothstep01(0.18, 0.44, l.y);
        var fadeInTime = smoothstep01(0, 6, l.age);
        var fadeOut = 1 - smoothstep01(1.08, 1.48, l.y);
        var shrinkNearTop = 1 - smoothstep01(1.04, 1.42, l.y);
        l.scale = Math.max(0, fadeInTime * shrinkNearTop);
        l.intensity = l.baseIntensity * fadeInPos * fadeInTime * fadeOut;
        if (l.y - l.sy > 1.55) l.active = false;
      } else {
        l.y -= l.speed * dt;
        l.scale = 1;
        var fIn = 1 - smoothstep01(0.9, 1.08, l.y);
        var fOut = smoothstep01(-0.02, 0.16, l.y + l.sy);
        l.intensity = l.baseIntensity * fIn * fOut;
        if (l.y + l.sy < -0.1) l.active = false;
      }
    }

    if (persistentColAALayerEnabled && persistentLayer.active) {
      var pl = persistentLayer;
      pl.age += dt;
      pl.x += pl.dirX * pl.speed * dt;
      pl.intensity = pl.baseIntensity;
      if (pl.x < 0.16) { pl.x = 0.16; pl.dirX = 1; }
      else if (pl.x > 0.84) { pl.x = 0.84; pl.dirX = -1; }
      pl.nextDirChange -= dt;
      if (pl.nextDirChange <= 0) { pl.dirX *= rng() < 0.5 ? 1 : -1; pl.nextDirChange = rand(5, 12); }
      pl.nextColorChange -= dt;
      if (pl.nextColorChange <= 0) {
        pl.fromColor = pl.color.slice(); pl.toColor = pickDynamicColorRandom(); pl.colorMix = 0; pl.nextColorChange = rand(6, 14);
      }
      if (pl.colorMix < 1) {
        pl.colorMix = Math.min(1, pl.colorMix + dt / 5);
        for (var c = 0; c < 3; c++) pl.color[c] = pl.fromColor[c] * (1 - pl.colorMix) + pl.toColor[c] * pl.colorMix;
      }
    }
  }

  // ── wallet-synced shape morph ───────────────────────────────────────────────
  // A precomputed owner-specific ring of warp modes with NO equal-adjacent
  // members (including the wrap seam), so every cycle morphs to a different
  // shape, matching the source's do/while "never the same twice in a row",
  // while staying O(1) per frame and jump-free over unbounded wall-clock time.
  var WARP_SEQ_LEN = 512;
  var warpSeq = (function () {
    var seq = new Array(WARP_SEQ_LEN);
    seq[0] = seedWarpMode;
    for (var i = 1; i < WARP_SEQ_LEN; i++) {
      // Sequence is per-token (from the seed): a wallet's tokens morph on the
      // same TIMING (shared clock + owner phase, in shapeAt) but to DIFFERENT
      // shapes.
      var step = 1 + (xmur3(seedHash + "|warp|" + i)() % (RXY_WARP_MODE_COUNT - 1));
      seq[i] = (seq[i - 1] + step) % RXY_WARP_MODE_COUNT; // step >= 1 => != previous
    }
    // Close the ring: the last element must differ from both its neighbour and
    // the first, so index (k % LEN) never repeats across the wrap.
    var last = seq[WARP_SEQ_LEN - 1];
    if (last === seq[0] || last === seq[WARP_SEQ_LEN - 2]) {
      for (var v = 0; v < RXY_WARP_MODE_COUNT; v++) {
        if (v !== seq[0] && v !== seq[WARP_SEQ_LEN - 2]) { seq[WARP_SEQ_LEN - 1] = v; break; }
      }
    }
    return seq;
  })();

  // Returns { a, b, mix } at sync time ts: TIMING is wallet-synced (ts carries the
  // owner phase), the shape SEQUENCE is per-token (warpSeq from the seed).
  function shapeAt(ts) {
    if (ts < WARP_INTERVAL) return { a: warpSeq[0], b: warpSeq[0], mix: 0 };
    var k = Math.floor((ts - WARP_INTERVAL) / WARP_PERIOD);
    var local = (ts - WARP_INTERVAL) - k * WARP_PERIOD;
    var from = warpSeq[k % WARP_SEQ_LEN];
    var to = warpSeq[(k + 1) % WARP_SEQ_LEN]; // always != from (ring property)
    if (local < WARP_DURATION) return { a: from, b: to, mix: smootherstep01(0, 1, local / WARP_DURATION) };
    return { a: to, b: to, mix: 0 };
  }

  // ── background colour drift: wallet-synced TIMING, per-token colours ─────────
  function seedPaletteColor(index, j) {
    return activePalette[xmur3(seedHash + "|bg|" + index + "|" + j)() % activePalette.length];
  }
  function bgColorAt(index, ts) {
    var first = BG_SHIFT_DELAY + index * BG_SHIFT_STEP;
    var base = seedPaletteColor(index, 0);
    if (ts < first) return base;
    var j = Math.floor((ts - BG_SHIFT_DELAY) / BG_SHIFT_STEP / 3 - index / 3 + 1e-9);
    if (j < 0) return base;
    var s = BG_SHIFT_DELAY + (index + 3 * j) * BG_SHIFT_STEP;
    var to = seedPaletteColor(index, j + 1);
    var from = j === 0 ? base : seedPaletteColor(index, j);
    var prog = (ts - s) / BG_SHIFT_DUR;
    if (prog >= 1) return to;
    var m = smootherstep01(0, 1, prog);
    return [from[0] * (1 - m) + to[0] * m, from[1] * (1 - m) + to[1] * m, from[2] * (1 - m) + to[2] * m];
  }

  // ── draw ────────────────────────────────────────────────────────────────────
  var layerData = new Float32Array(MAX_LAYERS * 4);
  var colorData = new Float32Array(MAX_LAYERS * 4);
  var paramData = new Float32Array(MAX_LAYERS * 2);
  var FIXED_DT = 1 / 60;
  var CAPTURE_SECONDS = 20; // representative settled still
  var animTime = 0;
  var lastMs = 0;
  var isCapture = ctx === "capture";

  function uploadLayers() {
    for (var i = 0; i < MAX_LAYERS; i++) {
      var l = layers[i];
      var b4 = i * 4, b2 = i * 2;
      layerData[b4] = l.x;
      layerData[b4 + 1] = l.y;
      layerData[b4 + 2] = l.active ? l.sx * l.scale : 0;
      layerData[b4 + 3] = l.active ? l.sy * l.scale : 0;
      colorData[b4] = l.color[0];
      colorData[b4 + 1] = l.color[1];
      colorData[b4 + 2] = l.color[2];
      colorData[b4 + 3] = l.active ? l.intensity : 0;
      paramData[b2] = l.k;
      paramData[b2 + 1] = l.phase;
    }
  }

  function render() {
    // shape + background: owner-synced live; owner-independent representative
    // for the canonical still.
    var warp, i;
    if (isCapture) {
      warp = { a: seedWarpMode, b: seedWarpMode, mix: 0 };
      for (i = 0; i < STATIC_COLS_COUNT; i++) { staticCols[i * 3] = captureStatic[i][0]; staticCols[i * 3 + 1] = captureStatic[i][1]; staticCols[i * 3 + 2] = captureStatic[i][2]; }
    } else {
      var syncTime = Date.now() / 1000 + ownerPhaseSec;
      warp = shapeAt(syncTime);
      for (i = 0; i < STATIC_COLS_COUNT; i++) { var col = bgColorAt(i, syncTime); staticCols[i * 3] = col[0]; staticCols[i * 3 + 1] = col[1]; staticCols[i * 3 + 2] = col[2]; }
    }

    uploadLayers();

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var side = Math.min(window.innerWidth, window.innerHeight) || 512;
    canvas.style.width = side + "px";
    canvas.style.height = side + "px";
    var px = Math.max(1, Math.floor(side * dpr));
    if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }
    gl.viewport(0, 0, px, px);
    gl.uniform2f(u.res, px, px);
    gl.uniform1f(u.time, animTime);
    gl.uniform1f(u.tau, modeTau);
    gl.uniform1i(u.maxIter, modeMaxIter);
    gl.uniform1f(u.cX, modeCX);
    gl.uniform1f(u.cY, modeCY);
    gl.uniform1f(u.flowOffset, flowOffset);
    gl.uniform4fv(u.layers, layerData);
    gl.uniform4fv(u.layerColors, colorData);
    gl.uniform2fv(u.layerParams, paramData);
    gl.uniform4fv(u.staticShapeParams, staticShapeParams);
    gl.uniform3fv(u.staticCols, staticCols);
    gl.uniform3fv(u.paletteA, new Float32Array(paletteABase));
    gl.uniform1f(u.bgOnly, backgroundOnly ? 1 : 0);
    gl.uniform1i(u.colAAPhase, colAAPhase);
    gl.uniform1i(u.rxyWarpModeA, warp.a);
    gl.uniform1i(u.rxyWarpModeB, warp.b);
    gl.uniform1f(u.rxyWarpMix, warp.mix);
    gl.uniform1i(u.rxyWarpAddMode, rxyWarpAddMode);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function frame(nowMs) {
    var now = nowMs * 0.001;
    var dt = Math.min(0.05, Math.max(0, now - lastMs));
    lastMs = now;
    animTime += dt;
    stepSim(dt);
    render();
    requestAnimationFrame(frame);
  }

  initSim();
  if (isCapture) {
    // Deterministic still: step the sim with a fixed timestep to a settled
    // frame, then render once. requestAnimationFrame is throttled offscreen.
    var steps = Math.round(CAPTURE_SECONDS / FIXED_DT);
    for (var f = 0; f < steps; f++) { animTime += FIXED_DT; stepSim(FIXED_DT); }
    render();
  } else {
    window.addEventListener("resize", render);
    requestAnimationFrame(frame);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function smoothstep01(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function smootherstep01(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  function createDeckPicker(colors, r, maxRepeat) {
    var deck = [];
    function refill() { deck = []; for (var i = 0; i < colors.length; i++) for (var k = 0; k < maxRepeat; k++) deck.push(colors[i]); }
    refill();
    return function () {
      if (deck.length === 0) refill();
      var idx = Math.floor(r() * deck.length);
      var c = deck[idx];
      deck.splice(idx, 1);
      return c;
    };
  }
})();
