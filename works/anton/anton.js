// Onchain generative work. Composition is a pure function of the chosen params
// (palette, shape, tone); animation pace is a function of the current owner
// address. Reads its render context from window.tokenData (injected by the
// renderer). No Math.random, no wall-clock in the composition: the canonical
// still is a fixed frame, and identical params produce an identical image on
// any machine.
(function () {
  "use strict";

  // ── static configuration data ───────────────────────────────────────────────
  // Frame loop length. Bounds shader u_time for highp float trig precision while
  // staying shared across a wallet's tokens. 1 hour of frames at 60fps.
  var FRAME_WRAP = 60 * 3600;

  function hexToRgb01(hex) {
    var s = hex.replace("#", "");
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function hexList(arr) {
    return arr.map(hexToRgb01);
  }

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

  // Named shape presets map to lower-level warp settings. These are the minter's
  // shape choices.
  var SHAPE_PRESETS = {
    halo: { phase: 1, warp: 10, add: 0 },
    arch: { phase: 2, warp: 1, add: 0 },
    wide: { phase: 3, warp: 2, add: 3 },
    bloom: { phase: 4, warp: 0, add: 2 },
    opal: { phase: 1, warp: 0, add: 0 },
    "curved-circle": { phase: 2, warp: 1, add: 0 },
    "rounded-trapezoid": { phase: 3, warp: 2, add: 3 },
    arrow: { phase: 2, warp: 3, add: 4 },
    "opal-2": { phase: 1, warp: 4, add: 1 },
    droplet: { phase: 4, warp: 5, add: 2 },
    square: { phase: 3, warp: 6, add: 0 },
    "opal-3": { phase: 1, warp: 7, add: 0 },
    "rounded-triangle": { phase: 4, warp: 8, add: 3 },
    onyx: { phase: 2, warp: 9, add: 4 },
    "soft-oval": { phase: 1, warp: 10, add: 0 },
    "shard-x": { phase: 3, warp: 11, add: 1 },
    "shard-y": { phase: 3, warp: 12, add: 2 },
    "needle-veil": { phase: 2, warp: 13, add: 0 },
    beam: { phase: 4, warp: 14, add: 4 }
  };

  // Palette-A base pivot: the sun/moon mood toggle.
  var TONE_BASE = {
    sun: [0.6176, 0.478, 0.3157],
    moon: [0.376, 0.478, 0.6157]
  };

  // ── render context ────────────────────────────────────────────────────────
  // window.tokenData is injected before this script. params + owner are the
  // work-specific extension fields; hash/tokenId/collection/chainId/version/
  // context are the standard injection-convention fields. Defaults keep the
  // file runnable standalone for local inspection.
  var td = (typeof window !== "undefined" && window.tokenData) || {};
  var ctx = typeof td.context === "string" ? td.context : "token";
  var owner = (typeof td.owner === "string" ? td.owner : "0x0000000000000000000000000000000000000000").toLowerCase();
  var params = td.params || {};
  var paletteMode = normalizePalette(params.palette);
  var shapeMode = normalizeShape(params.shape);
  var toneMode = normalizeTone(params.tone);
  var backgroundOnly = params.bgOnly === true || params.bgOnly === 1 || params.bgOnly === "1";

  // ── deterministic randomness ────────────────────────────────────────────────
  // paramSeed keys every setup and per-spawn draw, so the entire composition is
  // reproducible from (palette, shape, tone) alone. keyed() gives an
  // independent draw per (slot, cycle, channel) without replaying a stream, so
  // any frame is reproducible without simulating the frames before it.
  var paramKey = paletteMode + "|" + shapeMode + "|" + toneMode;
  var paramSeed = xmur3(paramKey)();
  var setupRng = mulberry32(paramSeed);
  function keyed(slot, cycle, channel) {
    var a =
      (paramSeed ^
        Math.imul(slot + 1, 0x45d9f3b) ^
        Math.imul(cycle + 1, 0x119de1f3) ^
        Math.imul(channel + 1, 0x4f6cdd1d)) >>>
      0;
    return mulberry32(a)();
  }
  function keyedRange(slot, cycle, channel, lo, hi) {
    return lo + keyed(slot, cycle, channel) * (hi - lo);
  }

  // ── owner-derived pace ──────────────────────────────────────────────────────
  // rate scales playback speed, phaseFrames shifts the shared loop origin. Both
  // derive from the owner only, so every token a wallet holds advances through
  // the identical frame at the same wall-clock instant (true lockstep), and a
  // transfer inherits the new owner's pace on the next load.
  var ownerHash = xmur3(owner)();
  var paceRate = 0.6 + (ownerHash % 1000) / 1000 * 1.4; // 0.6 .. 2.0
  var paceFrames = xmur3(owner + ":phase")() % FRAME_WRAP;

  // A fixed frame for the canonical still. Composition at this frame is
  // owner-independent, so captures and thumbnails never churn on transfer.
  // ~47s in: every dynamic slot has spawned and drifted, so the still is a
  // full, settled composition rather than a sparse early frame.
  var CAPTURE_FRAME = 2800;

  function currentFrame() {
    if (ctx === "capture") return CAPTURE_FRAME;
    var t = Date.now() / 1000;
    var f = Math.floor(t * 60 * paceRate) + paceFrames;
    // Wrap keeps shader u_time small enough for highp float trig precision
    // while staying shared across a wallet's tokens.
    return ((f % FRAME_WRAP) + FRAME_WRAP) % FRAME_WRAP;
  }

  // ── palette + shape configuration ───────────────────────────────────────────
  var activePalette = PALETTES[paletteMode];
  var flowMode = setupRng() < 0.5 ? "downflow" : "upflow";
  var persistentColAALayerEnabled = setupRng() < 0.65;
  var MAX_LAYERS = persistentColAALayerEnabled ? 5 : 4;
  var DYNAMIC_LAYER_SLOTS = 4;

  var shapePreset = SHAPE_PRESETS[shapeMode];
  var colAAPhase = shapePreset.phase;
  var rxyWarpMode = shapePreset.warp;
  var rxyWarpAddMode = shapePreset.add;
  var paletteABase = TONE_BASE[toneMode].slice();

  var flowOffset = steppedFromRng(setupRng, 300, 650, 25);
  var modeTau = steppedFromRng(setupRng, 2.2, 3.8, 0.2);
  var modeMaxIter = steppedFromRng(setupRng, 4, 8, 1);
  var modeCX = 0.5;
  var modeCY = 1.0;

  // Static masses: a large diagonal wash and a smaller blue patch. Colors are
  // drawn once from the palette via a deck picker so no single color dominates.
  var staticShapeParams = new Float32Array([0.52, 0.18, 1.0, 0.4, 0.52, 0.32, 0.5, 0.31]);
  var STATIC_COLS_COUNT = 3;
  var staticCols = new Float32Array(STATIC_COLS_COUNT * 3);
  var pickStaticColor = createDeckPicker(activePalette, setupRng, 4);
  for (var si = 0; si < STATIC_COLS_COUNT; si++) {
    var sc = pickStaticColor();
    staticCols[si * 3] = sc[0];
    staticCols[si * 3 + 1] = sc[1];
    staticCols[si * 3 + 2] = sc[2];
  }

  // ── canvas + GL ─────────────────────────────────────────────────────────────
  var canvas = document.createElement("canvas");
  canvas.id = "gl";
  canvas.style.position = "fixed";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  document.body.appendChild(canvas);
  document.body.style.margin = "0";
  document.body.style.background = "#0f1534";

  // Capture reads the drawing buffer back (toDataURL / readPixels), which is
  // empty after compositing unless preserved. Live playback does not read back.
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

  var FIXED_DT = 1 / 60;

  // ── deterministic layer state ───────────────────────────────────────────────
  // Each dynamic slot spawns on a fixed cadence; a blob's whole lifecycle is a
  // closed-form function of the frame, so any frame renders without replaying
  // the ones before it. Per-spawn values are keyed by (slot, cycle).
  // A blob drifts slowly (y moves ~speed per second, speed ~0.016-0.031), so
  // crossing the composition takes ~40-90s. The spawn cadence must be that long
  // or a blob is recycled before it has travelled, which reads as a highlight
  // popping near the top on a short interval. SPAWN_END_FADE fades out any blob
  // still on screen at cycle end so the recycle is never a hard cut.
  var SPAWN_PERIOD = 3600; // frames (~60s at 60fps): a slot's spawn cadence
  var SPAWN_STAGGER = SPAWN_PERIOD / DYNAMIC_LAYER_SLOTS; // even temporal spacing
  var SPAWN_END_FADE = 150; // frames of graceful fade before recycle

  function dynamicLayerAt(slot, frame) {
    var base = slot * SPAWN_STAGGER;
    if (frame < base) return null;
    var cycle = Math.floor((frame - base) / SPAWN_PERIOD);
    var localFrame = frame - base - cycle * SPAWN_PERIOD;
    var age = localFrame * FIXED_DT;

    var sx, sy, yStart;
    if (flowMode === "upflow") {
      sx = keyedRange(slot, cycle, 0, 0.24, 0.4);
      sy = keyedRange(slot, cycle, 1, 0.12, 0.24);
      yStart = 0.24 + keyedRange(slot, cycle, 2, -0.03, 0.03);
    } else {
      sx = keyedRange(slot, cycle, 0, 0.28, 0.46);
      sy = keyedRange(slot, cycle, 1, 0.16, 0.34);
      yStart = 1.02 + keyedRange(slot, cycle, 2, -0.03, 0.03);
    }
    var x = keyedRange(slot, cycle, 4, 0.26, 0.74);
    var speed = flowMode === "upflow" ? keyedRange(slot, cycle, 5, 0.01, 0.021) : keyedRange(slot, cycle, 5, 0.016, 0.031);
    var k = keyedRange(slot, cycle, 6, 3.8, 6.2);
    var phase = keyed(slot, cycle, 7) * 10.0;
    var baseIntensity = keyedRange(slot, cycle, 8, 0.44, 0.82);
    var color = tintedColor(pickPaletteKeyed(slot, cycle, 9), keyed(slot, cycle, 10), keyed(slot, cycle, 11), keyed(slot, cycle, 12), 0.06);

    // Graceful fade over the last frames of the cycle, so a blob that has not
    // yet drifted off screen never disappears in a single frame.
    var endFade = 1.0 - smoothstep01(SPAWN_PERIOD - SPAWN_END_FADE, SPAWN_PERIOD, localFrame);

    var y, scale, intensity, active;
    if (flowMode === "upflow") {
      y = yStart + speed * age;
      var fadeInPos = smoothstep01(0.18, 0.44, y);
      var fadeInTime = smoothstep01(0.0, 6.0, age);
      var fadeOut = 1.0 - smoothstep01(1.08, 1.48, y);
      var shrinkNearTop = 1.0 - smoothstep01(1.04, 1.42, y);
      scale = Math.max(0.0, fadeInTime * shrinkNearTop);
      intensity = baseIntensity * fadeInPos * fadeInTime * fadeOut * endFade;
      active = !(y - sy > 1.55);
    } else {
      y = yStart - speed * age;
      scale = 1.0;
      var fadeIn = 1.0 - smoothstep01(0.9, 1.08, y);
      var fadeOut2 = smoothstep01(-0.02, 0.16, y + sy);
      intensity = baseIntensity * fadeIn * fadeOut2 * endFade;
      active = !(y + sy < -0.1);
    }
    if (!active) return null;
    return { x: x, y: y, sx: sx * scale, sy: sy * scale, k: k, phase: phase, intensity: intensity, color: color };
  }

  function persistentLayerAt(frame) {
    if (!persistentColAALayerEnabled) return null;
    var t = frame * FIXED_DT;
    var startY = keyedRange(99, 0, 0, 0.42, 0.74);
    var sx = keyedRange(99, 0, 1, 0.18, 0.28);
    var sy = keyedRange(99, 0, 2, 0.1, 0.18);
    var speed = keyedRange(99, 0, 3, 0.004, 0.008);
    var k = keyedRange(99, 0, 4, 4.2, 6.0);
    var phase = keyed(99, 0, 5) * 10.0;
    var baseIntensity = keyedRange(99, 0, 6, 0.4, 0.68);
    var xCenter = keyedRange(99, 0, 7, 0.24, 0.76);
    // x oscillates within bounds via a triangle wave; deterministic and seekable.
    var span = 0.68; // 0.84 - 0.16
    var amp = Math.min(0.34, xCenter - 0.16 < 0.84 - xCenter ? xCenter - 0.16 : 0.84 - xCenter);
    var xw = speed * 6.0;
    var x = xCenter + amp * triangle(t * xw + phase);

    // Color morphs on a fixed cadence, mixing between two keyed palette picks.
    var COLOR_PERIOD = 600; // frames
    var colorCycle = Math.floor(frame / COLOR_PERIOD);
    var localMix = smootherstep01(0.0, 1.0, Math.min(1.0, (frame - colorCycle * COLOR_PERIOD) / 300));
    var cFrom = tintedColor(pickPaletteKeyed(99, colorCycle, 0), keyed(99, colorCycle, 1), keyed(99, colorCycle, 2), keyed(99, colorCycle, 3), 0.06);
    var cTo = tintedColor(pickPaletteKeyed(99, colorCycle + 1, 0), keyed(99, colorCycle + 1, 1), keyed(99, colorCycle + 1, 2), keyed(99, colorCycle + 1, 3), 0.06);
    var color = [
      cFrom[0] * (1 - localMix) + cTo[0] * localMix,
      cFrom[1] * (1 - localMix) + cTo[1] * localMix,
      cFrom[2] * (1 - localMix) + cTo[2] * localMix
    ];
    return { x: x, y: startY, sx: sx, sy: sy, k: k, phase: phase, intensity: baseIntensity, color: color };
  }

  function pickPaletteKeyed(slot, cycle, channel) {
    var idx = Math.floor(keyed(slot, cycle, channel) * activePalette.length) % activePalette.length;
    return activePalette[idx];
  }

  // ── draw ────────────────────────────────────────────────────────────────────
  var layerData = new Float32Array(MAX_LAYERS * 4);
  var colorData = new Float32Array(MAX_LAYERS * 4);
  var paramData = new Float32Array(MAX_LAYERS * 2);

  function draw() {
    var frame = currentFrame();
    var uTime = (frame % FRAME_WRAP) * FIXED_DT;

    for (var i = 0; i < MAX_LAYERS; i++) {
      var st = i < DYNAMIC_LAYER_SLOTS ? dynamicLayerAt(i, frame) : persistentLayerAt(frame);
      var b4 = i * 4;
      var b2 = i * 2;
      if (st) {
        layerData[b4] = st.x;
        layerData[b4 + 1] = st.y;
        layerData[b4 + 2] = st.sx;
        layerData[b4 + 3] = st.sy;
        colorData[b4] = st.color[0];
        colorData[b4 + 1] = st.color[1];
        colorData[b4 + 2] = st.color[2];
        colorData[b4 + 3] = st.intensity;
        paramData[b2] = st.k;
        paramData[b2 + 1] = st.phase;
      } else {
        layerData[b4 + 2] = 0;
        layerData[b4 + 3] = 0;
        colorData[b4 + 3] = 0;
      }
    }

    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.floor(canvas.clientWidth * dpr);
    var h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.res, w, h);
    gl.uniform1f(u.time, uTime);
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
    gl.uniform1f(u.bgOnly, backgroundOnly ? 1.0 : 0.0);
    gl.uniform1i(u.colAAPhase, colAAPhase);
    gl.uniform1i(u.rxyWarpModeA, rxyWarpMode);
    gl.uniform1i(u.rxyWarpModeB, rxyWarpMode);
    gl.uniform1f(u.rxyWarpMix, 0.0);
    gl.uniform1i(u.rxyWarpAddMode, rxyWarpAddMode);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // The canonical still renders one deterministic frame and stops.
    if (ctx !== "capture") requestAnimationFrame(draw);
  }

  window.addEventListener("resize", draw);
  if (ctx === "capture") {
    // One deterministic frame, drawn synchronously. requestAnimationFrame is
    // throttled for offscreen/headless documents, so the still must not depend
    // on it.
    draw();
  } else {
    requestAnimationFrame(draw);
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
  function steppedFromRng(rng, min, max, step) {
    var count = Math.floor((max - min) / step) + 1;
    return min + Math.floor(rng() * count) * step;
  }
  function smoothstep01(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function smootherstep01(e0, e1, x) {
    var t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  function triangle(x) {
    var f = x - Math.floor(x); // 0..1
    return 2 * Math.abs(2 * f - 1) - 1; // -1..1, period 1
  }
  function tintedColor(base, r0, r1, r2, spread) {
    return [
      Math.min(1, Math.max(0, base[0] + (r0 * 2 - 1) * spread)),
      Math.min(1, Math.max(0, base[1] + (r1 * 2 - 1) * spread)),
      Math.min(1, Math.max(0, base[2] + (r2 * 2 - 1) * spread))
    ];
  }
  function createDeckPicker(colors, rng, maxRepeat) {
    var deck = [];
    function refill() {
      deck = [];
      for (var i = 0; i < colors.length; i++) for (var r = 0; r < maxRepeat; r++) deck.push(colors[i]);
    }
    refill();
    return function () {
      if (deck.length === 0) refill();
      var idx = Math.floor(rng() * deck.length);
      var c = deck[idx];
      deck.splice(idx, 1);
      return c;
    };
  }

  function normalizePalette(v) {
    var s = typeof v === "string" ? v.toUpperCase() : "";
    return PALETTES[s] ? s : "A";
  }
  function normalizeShape(v) {
    var s = typeof v === "string" ? v.toLowerCase() : "";
    return SHAPE_PRESETS[s] ? s : "halo";
  }
  function normalizeTone(v) {
    var s = typeof v === "string" ? v.toLowerCase() : "";
    return TONE_BASE[s] ? s : "moon";
  }
})();
