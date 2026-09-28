const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const { writeFileSync, readFileSync, mkdtempSync, rmSync } = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { getFfmpegPath } = require("./lib/ffmpeg");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// Sumber font sama seperti bratvid/bratvid2 (sudah terbukti jalan), dicoba berurutan.
const FONT_SOURCES = [
  { url: "https://cdn.jsdelivr.net/gh/Napoleon-Fibonacci/assets@main/font/impact.ttf", file: "wanz-bratvid3-impact.ttf" },
  { url: "https://raw.githubusercontent.com/Ditzzx-vibecoder/Assets/main/Font/ARIALN.ttf", file: "wanz-bratvid3-arialn.ttf" },
  { url: "https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf", file: "wanz-bratvid3-anton.ttf" }
];
const FONT_FAMILY = "BratVid3Font";

const fs = require("fs");
const axios = require("axios");

let fontReady = false;

async function ensureFont() {
  if (fontReady) return;
  let lastErr = null;
  for (const src of FONT_SOURCES) {
    const fontPath = path.join(os.tmpdir(), src.file);
    try {
      if (!fs.existsSync(fontPath) || fs.statSync(fontPath).size < 10000) {
        const res = await axios.get(src.url, {
          responseType: "arraybuffer",
          headers: { "User-Agent": "Mozilla/5.0" },
          timeout: 15000
        });
        fs.writeFileSync(fontPath, Buffer.from(res.data));
      }
      if (GlobalFonts.registerFromPath(fontPath, FONT_FAMILY)) {
        fontReady = true;
        return;
      }
      fs.rmSync(fontPath, { force: true });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("Font gagal dimuat: " + (lastErr ? lastErr.message : "semua sumber gagal"));
}


// ====== Konstanta hasil ukur video referensi (576x1024, 30fps) ======
const W = 576;
const H = 1024;
const FPS = 30;
const POP_FRAMES = 6;
const REF = { cap: 61, widest: 298, sample: "POKOKE KRIUK", gapRatio: 0.3, lineGap: 20, centerY: 0.453 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Sesuaikan font apa pun (Impact / Arial Narrow / Anton) ke proporsi video referensi.
function calibrate(ctx) {
  ctx.font = `100px ${FONT_FAMILY}`;
  const asc = ctx.measureText("H").actualBoundingBoxAscent;
  const capRatio = asc && asc > 20 ? asc / 100 : 0.75;
  const fontSize = REF.cap / capRatio;
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  const wSample = ctx.measureText(REF.sample).width;
  const xScale = Math.min(1, Math.max(0.45, REF.widest / wSample));
  return { capRatio, fontSize, xScale };
}

function buildLayout(ctx, words, cal) {
  const lines = [];
  for (let i = 0; i < words.length; i += 2) {
    lines.push(words.slice(i, i + 2).map((w, j) => ({ word: w, index: i + j })));
  }

  ctx.font = `${cal.fontSize}px ${FONT_FAMILY}`;
  const measure = (w) => ctx.measureText(w).width * cal.xScale;
  const baseGap = REF.cap * REF.gapRatio;
  const pitchBase = REF.cap + REF.lineGap;

  const widths = lines.map((l) => l.reduce((a, it) => a + measure(it.word), 0) + baseGap * (l.length - 1));
  const maxW = Math.max(...widths);
  const blockH = lines.length * pitchBase - REF.lineGap;

  const boost = 1 + (5 - Math.min(lines.length, 5)) * 0.12; // teks pendek sedikit lebih besar
  const s = Math.min(boost, (W * 0.88) / maxW, (H * 0.78) / blockH);

  const cap = REF.cap * s;
  const gap = baseGap * s;
  const pitch = pitchBase * s;
  const blockHs = lines.length * pitch - REF.lineGap * s;
  const top = H * REF.centerY - blockHs / 2;

  const items = [];
  lines.forEach((l, li) => {
    const ws = l.map((it) => measure(it.word) * s);
    const lw = ws.reduce((a, b) => a + b, 0) + gap * (l.length - 1);
    let x = W / 2 - lw / 2;
    l.forEach((it, j) => {
      items[it.index] = { word: it.word, cx: x + ws[j] / 2, cy: top + li * pitch + cap / 2, w: ws[j], size: cal.fontSize * s, cap };
      x += ws[j] + gap;
    });
  });

  return { items, box: { y0: top, y1: top + blockHs } };
}

const easeOutBack = (t) => 1 + 3.2 * Math.pow(t - 1, 3) + 2.2 * Math.pow(t - 1, 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// Animasi pop tiap kata: ganjil-genap beda gaya (pop dari kecil + overshoot / slam dari besar)
function popState(age, index) {
  if (age >= POP_FRAMES) return { scale: 1, alpha: 1 };
  const t = Math.max(0, age) / POP_FRAMES;
  const alpha = Math.min(1, (age + 1) / 2);
  if (index % 2 === 0) return { scale: 0.1 + 0.9 * easeOutBack(t), alpha };
  return { scale: 1 + 0.9 * (1 - easeOutCubic(t)), alpha };
}

function drawWord(ctx, it, cal, scale, alpha, color) {
  ctx.save();
  ctx.translate(it.cx, it.cy);
  ctx.scale(scale * cal.xScale, scale);
  ctx.font = `${it.size}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(it.word, 0, it.cap / 2);
  ctx.restore();
}

// Bintang lens-flare ala video referensi: inti putih padat + duri kecil + bloom kebiruan
// + streak horizontal tipis; opsi `band` = pita cahaya selebar layar.
function drawStar(ctx, x, y, R, alpha, streak, band) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  // bloom lebar
  const g = ctx.createRadialGradient(x, y, 0, x, y, R * 1.7);
  g.addColorStop(0, `rgba(255,255,255,${alpha})`);
  g.addColorStop(0.28, `rgba(255,255,255,${0.9 * alpha})`);
  g.addColorStop(0.5, `rgba(214,222,250,${0.42 * alpha})`);
  g.addColorStop(1, "rgba(200,208,240,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R * 1.7, 0, Math.PI * 2);
  ctx.fill();

  // pita cahaya horizontal selebar layar
  if (band) {
    const bh = R * 0.55;
    const bg = ctx.createLinearGradient(0, y - bh, 0, y + bh);
    bg.addColorStop(0, "rgba(200,210,245,0)");
    bg.addColorStop(0.5, `rgba(235,240,255,${0.85 * alpha})`);
    bg.addColorStop(1, "rgba(200,210,245,0)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, y - bh, W, bh * 2);
  }

  // streak anamorphic tipis
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, 0.05);
  const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, streak);
  sg.addColorStop(0, `rgba(255,255,255,${alpha})`);
  sg.addColorStop(0.35, `rgba(220,228,250,${0.5 * alpha})`);
  sg.addColorStop(1, "rgba(200,208,240,0)");
  ctx.fillStyle = sg;
  ctx.fillRect(-streak, -streak, streak * 2, streak * 2);
  ctx.restore();

  // inti bergerigi (duri kecil) — putih padat
  ctx.shadowColor = "rgba(255,255,255,0.95)";
  ctx.shadowBlur = R * 0.35;
  ctx.fillStyle = `rgba(255,255,255,${Math.min(1, alpha + 0.05)})`;
  const spikes = 14;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2;
    const rr = R * (i % 2 === 0 ? 0.46 : 0.34);
    const px = x + Math.cos(ang) * rr;
    const py = y + Math.sin(ang) * rr;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Cincin "ledakan" bergerigi abu-abu kebiruan pada frame putih
function drawRing(ctx, x, y, r, alpha, seed) {
  const rnd = mulberry32(seed);
  const N = 72;
  const phase = rnd() * Math.PI * 2;
  const f1 = 2 + Math.floor(rnd() * 3);
  const f2 = 4 + Math.floor(rnd() * 4);
  const a1 = 0.14 + rnd() * 0.1;
  const a2 = 0.07 + rnd() * 0.07;
  const spikeIdx = new Set();
  for (let k = 0; k < 7; k++) spikeIdx.add(Math.floor(rnd() * N));
  const pts = [];
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    let rad = 1 + a1 * Math.sin(f1 * ang + phase) + a2 * Math.sin(f2 * ang + phase * 1.7) + (rnd() - 0.5) * 0.08;
    if (spikeIdx.has(i)) rad *= 1.28 + rnd() * 0.3;
    pts.push([x + Math.cos(ang) * r * rad * 1.1, y + Math.sin(ang) * r * rad * 0.9]);
  }
  ctx.save();
  ctx.lineJoin = "round";
  ctx.shadowColor = "rgba(140,150,205,0.55)";
  ctx.shadowBlur = 14;
  const passes = [
    { w: r * 0.34, a: 0.09 },
    { w: r * 0.22, a: 0.16 },
    { w: r * 0.11, a: 0.34 }
  ];
  for (const p of passes) {
    ctx.strokeStyle = `rgba(150,156,196,${p.a * alpha})`;
    ctx.lineWidth = p.w;
    ctx.beginPath();
    pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

// Teks tampak abu-abu & terpotong pita miring (efek "flash negatif" di video referensi)
function drawFragments(ctx, layout, cal, reveal, frag) {
  ctx.save();
  const { y0, y1 } = layout.box;
  const bx = frag.x, bw = frag.w, sk = frag.skew;
  ctx.beginPath();
  ctx.moveTo(bx + sk, y0 - 10);
  ctx.lineTo(bx + bw + sk, y0 - 10);
  ctx.lineTo(bx + bw - sk, y1 + 10);
  ctx.lineTo(bx - sk, y1 + 10);
  ctx.closePath();
  ctx.clip();
  for (let i = 0; i < reveal; i++) drawWord(ctx, layout.items[i], cal, 1, 0.85, "#a4a6ad");
  ctx.restore();
}

const ANCHORS = [
  [0.2, 0.33], [0.86, 0.5], [0.5, 0.42], [0.14, 0.62], [0.78, 0.3], [0.9, 0.76], [0.3, 0.8], [0.62, 0.68]
];

// Jadwal frame: kata muncul satu per satu, diselingi flare hitam & strobe putih
function buildSchedule(n, rnd) {
  const frames = [];
  const revealAt = [];
  const anchor = () => {
    const a = ANCHORS[Math.floor(rnd() * ANCHORS.length)];
    return { x: a[0] * W, y: a[1] * H };
  };
  const ring = (a, prog) => ({ x: Math.round(a.x), y: Math.round(a.y), r: Math.round(150 + prog * 42), seed: Math.floor(rnd() * 1e6) });
  const frag = () => ({ x: Math.round(60 + rnd() * 300), w: Math.round(110 + rnd() * 160), skew: Math.round(25 + rnd() * 35) });

  for (let k = 0; k < n; k++) {
    revealAt[k] = frames.length;
    const tFrames = 3 + (k % 2);
    for (let i = 0; i < tFrames; i++) frames.push({ mode: "text", reveal: k + 1 });

    const pat = k % 3;
    const a = anchor();
    if (pat === 0 || pat === 2) {
      const R = 120 + rnd() * 70;
      const streak = 260 + rnd() * 300;
      const band = pat === 2;
      for (let i = 0; i < 2; i++) {
        frames.push({ mode: "flare", reveal: k + 1, star: { x: Math.round(a.x), y: Math.round(a.y), R: Math.round(R * (0.85 + 0.4 * i)), alpha: i ? 0.85 : 1, streak: Math.round(streak * (0.9 + 0.3 * i)), band } });
      }
    }
    if (pat === 0 || pat === 1) {
      const b = anchor();
      const fr = frag();
      for (let i = 0; i < 2; i++) frames.push({ mode: "white", reveal: k + 1, ring: ring(b, i), frag: fr });
    }
    if (k % 2 === 1) frames.push({ mode: "white", reveal: k + 1, blank: true });
  }

  for (let i = 0; i < 12; i++) frames.push({ mode: "text", reveal: n });
  for (let i = 0; i < 3; i++) {
    frames.push({ mode: "flare", reveal: n, star: { x: Math.round(W * 0.5), y: Math.round(H * REF.centerY), R: 230 + i * 50, alpha: 1, streak: 400 + i * 80, band: true } });
  }
  const fr = frag();
  for (let i = 0; i < 2; i++) frames.push({ mode: "white", reveal: n, ring: ring({ x: W * 0.5, y: H * REF.centerY }, i), frag: fr });
  return { frames, revealAt };
}

async function renderFrame(f, ctxInfo) {
  const { layout, cal, revealAt, invert } = ctxInfo;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = f.mode === "white" ? "#f6f6fb" : "#000000";
  ctx.fillRect(0, 0, W, H);

  if (f.mode === "white") {
    if (!f.blank) {
      drawRing(ctx, f.ring.x, f.ring.y, f.ring.r, 1, f.ring.seed);
      drawFragments(ctx, layout, cal, f.reveal, f.frag);
    }
  } else {
    for (let i = 0; i < f.reveal; i++) {
      const age = f.n - revealAt[i];
      const p = popState(age, i);
      drawWord(ctx, layout.items[i], cal, p.scale, p.alpha, "#ffffff");
    }
    if (f.mode === "flare") drawStar(ctx, f.star.x, f.star.y, f.star.R, f.star.alpha, f.star.streak, f.star.band);
  }

  if (invert) {
    ctx.globalCompositeOperation = "difference";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "saturation";
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }

  return canvas.encode("png");
}

async function generateBratVideo3({ text, holdDuration = 1.2, format = "mp4", bg = "black" }) {
  await ensureFont();

  const words = text.toUpperCase().split(/\s+/).filter(Boolean).slice(0, 30);
  if (!words.length) throw new Error("Teks kosong");

  const invert = bg === "white";
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "brat3-"));

  try {
    const probe = createCanvas(W, H).getContext("2d");
    const cal = calibrate(probe);
    const layout = buildLayout(probe, words, cal);

    const rnd = mulberry32(hashString(words.join(" ")));
    const { frames, revealAt } = buildSchedule(words.length, rnd);

    const extra = Math.max(0, Math.round(holdDuration * FPS) - 36);
    for (let i = 0; i < 36 + extra; i++) frames.push({ mode: "text", reveal: words.length });

    // render berurutan (paralel bisa segfault di beberapa versi @napi-rs/canvas), frame identik dipakai ulang
    const cache = new Map();
    const framePaths = [];
    for (let n = 0; n < frames.length; n++) {
      const f = { ...frames[n], n };
      const ages = [];
      for (let i = 0; i < words.length; i++) ages.push(i < f.reveal && f.mode !== "white" ? Math.min(POP_FRAMES, n - revealAt[i]) : -1);
      const key = JSON.stringify([f.mode, f.reveal, ages, f.star, f.ring, f.frag, f.blank]);
      if (!cache.has(key)) {
        const buffer = await renderFrame(f, { layout, cal, revealAt, invert });
        const framePath = path.join(tmpDir, `frame-${String(cache.size + 1).padStart(5, "0")}.png`);
        writeFileSync(framePath, buffer);
        cache.set(key, framePath);
      }
      framePaths.push(cache.get(key));
    }

    const frameTime = 1 / FPS;
    const manifest = [];
    for (const p of framePaths) {
      manifest.push(`file '${p.replace(/'/g, "'\\''")}'`);
      manifest.push(`duration ${frameTime}`);
    }
    manifest.push(`file '${framePaths[framePaths.length - 1].replace(/'/g, "'\\''")}'`);

    const concatPath = path.join(tmpDir, "concat.txt");
    writeFileSync(concatPath, manifest.join("\n"));

    const ext = format === "gif" ? "gif" : "mp4";
    const outPath = path.join(tmpDir, `bratvid3-${Date.now()}.${ext}`);

    if (format === "gif") {
      await execFileAsync(getFfmpegPath(), [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "fps=20,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer",
        "-loop", "0", outPath
      ]);
    } else {
      await execFileAsync(getFfmpegPath(), [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", `fps=${FPS},scale=${W}:${H}`, "-c:v", "libx264", "-preset", "fast",
        "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outPath
      ]);
    }

    return { buffer: readFileSync(outPath), ext };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = {
  name: "Brat Video V3 (Flash/Strobe)",
  desc: "Video 9:16 teks kapital tebal, muncul kata demi kata dengan pop/bounce ala brat v2, diiringi lens-flare, strobe putih, dan efek ledakan. Pilih latar hitam atau putih lewat bg (teks otomatis kontras). Cukup isi teksnya (maks 30 kata).",
  category: "Image Creator",
  path: "/api/canvas/bratvid3?apikey=&text=&bg=black",
  async run(req, res) {
    const { apikey, text, format, bg } = req.query;
    const bgChoice = String(bg || "black").toLowerCase() === "white" ? "white" : "black";

    if (!apikey || !global.apikey.includes(apikey)) {
      return res.status(401).json({ status: false, error: "Apikey invalid atau tidak terdaftar" });
    }
    if (!text) {
      return res.status(400).json({ status: false, error: "Parameter 'text' wajib diisi" });
    }

    try {
      const { buffer, ext } = await generateBratVideo3({
        text,
        format: format === "gif" ? "gif" : "mp4",
        bg: bgChoice
      });

      res.writeHead(200, {
        "Content-Type": ext === "gif" ? "image/gif" : "video/mp4",
        "Content-Length": buffer.length
      });
      return res.end(buffer);
    } catch (error) {
      console.error("Bratvid3 Error:", error.message);
      return res.status(500).json({
        status: false,
        error: "Gagal generate brat video v3: " + String(error.stderr || error.message || error).replace(/\s+/g, " ").slice(0, 300)
      });
    }
  }
};
