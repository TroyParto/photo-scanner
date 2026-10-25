/* Photo Scanner engine: finds every photo on a scanned page, fits its exact
 * rotated rectangle, straightens it and trims paper borders.
 * Works in the browser (window.PhotoEngine) and in Node (module.exports) so it can be tested.
 *
 * Input pixels: {data: Uint8Array|Uint8ClampedArray, width, height, channels: 3|4}
 */
(function (root) {
'use strict';

const DEG = Math.PI / 180;

/* ---------- helpers ---------- */
function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const m = a.length >> 1;
  return a.length & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function boxDownscale(src, f) {
  const { data, width: W, height: H, channels: C } = src;
  const w = Math.floor(W / f), h = Math.floor(H / f);
  const out = new Uint8Array(w * h * 3);
  const area = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let yy = 0; yy < f; yy++) {
        let i = ((y * f + yy) * W + x * f) * C;
        for (let xx = 0; xx < f; xx++, i += C) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      }
      const o = (y * w + x) * 3;
      out[o] = (r / area + 0.5) | 0; out[o + 1] = (g / area + 0.5) | 0; out[o + 2] = (b / area + 0.5) | 0;
    }
  }
  return { data: out, w, h };
}

/* ---------- background colour of the scanner bed ---------- */
function estimateBg(img) {
  const { data, w, h } = img;
  const hist = new Float32Array(32 * 32 * 32);
  const fx = Math.max(2, Math.round(w * 0.04)), fy = Math.max(2, Math.round(h * 0.04));
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 3;
      const frame = (x < fx || x >= w - fx || y < fy || y >= h - fy) ? 3 : 1;
      hist[((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)] += frame;
    }
  }
  // smooth over 3x3x3 neighbourhood to find the densest colour region
  let best = -1, bestV = -1, bright = -1, brightV = -1, total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    let s = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dg = -1; dg <= 1; dg++) for (let db = -1; db <= 1; db++) {
      const rr = r + dr, gg = g + dg, bb = b + db;
      if (rr < 0 || gg < 0 || bb < 0 || rr > 31 || gg > 31 || bb > 31) continue;
      s += hist[(rr << 10) | (gg << 5) | bb];
    }
    if (s > bestV) { bestV = s; best = (r << 10) | (g << 5) | b; }
    // the scanner lid is normally white: prefer a bright neutral colour if it covers a fair share of the page
    if (r >= 27 && g >= 27 && b >= 26 && Math.abs(r - g) <= 3 && Math.abs(g - b) <= 4 && s > brightV) { brightV = s; bright = (r << 10) | (g << 5) | b; }
  }
  if (bright >= 0 && brightV >= total * 0.04) best = bright;
  const cr = ((best >> 10) << 3) + 4, cg = (((best >> 5) & 31) << 3) + 4, cb = ((best & 31) << 3) + 4;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < w * h * 3; i += 6) {
    if (Math.abs(data[i] - cr) <= 14 && Math.abs(data[i + 1] - cg) <= 14 && Math.abs(data[i + 2] - cb) <= 14) {
      sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; n++;
    }
  }
  const bg = n ? [sr / n, sg / n, sb / n] : [cr, cg, cb];
  const ds = [];
  for (let i = 0; i < w * h * 3; i += 6) {
    const d = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2]));
    if (d <= 14) ds.push(d);
  }
  ds.sort((a, b) => a - b);
  const noise = ds.length ? ds[Math.floor(ds.length * 0.95)] : 4;
  return { color: bg, noise };
}

/* ---------- morphology (square window, separable, prefix sums) ---------- */
function windowPass(src, w, h, r, horizontal, mode) {
  const out = new Uint8Array(w * h);
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const pre = new Int32Array(len + 1);
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < len; i++) {
      const v = horizontal ? src[l * w + i] : src[i * w + l];
      pre[i + 1] = pre[i] + v;
    }
    for (let i = 0; i < len; i++) {
      const a = Math.max(0, i - r), b = Math.min(len, i + r + 1);
      const c = pre[b] - pre[a];
      const v = mode === 'dilate' ? (c > 0 ? 1 : 0) : (c === b - a ? 1 : 0);
      if (horizontal) out[l * w + i] = v; else out[i * w + l] = v;
    }
  }
  return out;
}
function dilate(m, w, h, r) { return windowPass(windowPass(m, w, h, r, true, 'dilate'), w, h, r, false, 'dilate'); }
function erode(m, w, h, r) { return windowPass(windowPass(m, w, h, r, true, 'erode'), w, h, r, false, 'erode'); }

/* ---------- connected components (8-neighbour) ---------- */
function label(mask, w, h) {
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let id = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s]) continue;
    id++;
    let sp = 0; stack[sp++] = s; lab[s] = id;
    const px = [];
    while (sp) {
      const p = stack[--sp]; px.push(p);
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push(Int32Array.from(px));
  }
  return comps;
}

/* ---------- convex hull + minimum-area rectangle ---------- */
function hullOf(pts) { // pts: array of [x,y]
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

function normaliseRect(r) {
  let { cx, cy, w, h, theta } = r;
  while (theta > Math.PI / 4) { theta -= Math.PI / 2; const t = w; w = h; h = t; }
  while (theta <= -Math.PI / 4) { theta += Math.PI / 2; const t = w; w = h; h = t; }
  return { cx, cy, w, h, theta };
}

function pixelsToHull(px, W) {
  // row extremes are enough to build the exact convex hull
  const rows = new Map();
  for (let k = 0; k < px.length; k++) {
    const p = px[k], x = p % W, y = (p - x) / W;
    const e = rows.get(y);
    if (!e) rows.set(y, [x, x]); else { if (x < e[0]) e[0] = x; if (x > e[1]) e[1] = x; }
  }
  const pts = [];
  rows.forEach((e, y) => { pts.push([e[0], y], [e[0], y + 1], [e[1] + 1, y], [e[1] + 1, y + 1]); });
  return hullOf(pts);
}

function minAreaRect(hull) {
  let best = null;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy); if (L < 1e-9) continue;
    const ux = dx / L, uy = dy / L, vx = -uy, vy = ux;
    let u0 = 1e18, u1 = -1e18, v0 = 1e18, v1 = -1e18;
    for (let j = 0; j < n; j++) {
      const p = hull[j];
      const u = p[0] * ux + p[1] * uy, v = p[0] * vx + p[1] * vy;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { area, cx: cu * ux + cv * vx, cy: cu * uy + cv * vy, w: u1 - u0, h: v1 - v0, theta: Math.atan2(uy, ux) };
    }
  }
  if (!best) return null;
  return normaliseRect(best);
}

function fitRect(px, W) {
  const hull = pixelsToHull(px, W);
  if (hull.length < 3) return null;
  const r = minAreaRect(hull);
  if (!r) return null;
  r.fill = px.length / Math.max(1, r.w * r.h);
  return r;
}

/* ---------- splitting merged blobs ---------- */
function bboxOf(px, W) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let k = 0; k < px.length; k++) { const p = px[k], x = p % W, y = (p - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

// Persistence watershed on the distance transform: separates blobs joined by a narrow neck.
function watershedSplit(px, W, hThr) {
  const bb = bboxOf(px, W);
  const bw = bb.x1 - bb.x0 + 3, bh = bb.y1 - bb.y0 + 3;
  const inside = new Uint8Array(bw * bh);
  for (let k = 0; k < px.length; k++) { const p = px[k], x = p % W, y = (p - x) / W; inside[(y - bb.y0 + 1) * bw + (x - bb.x0 + 1)] = 1; }
  const dist = new Int32Array(bw * bh);
  const BIG = 1 << 28;
  for (let i = 0; i < dist.length; i++) dist[i] = inside[i] ? BIG : 0;
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x; if (!inside[i]) continue;
    let d = dist[i];
    d = Math.min(d, dist[i - 1] + 3, dist[i - bw] + 3, dist[i - bw - 1] + 4, dist[i - bw + 1] + 4);
    dist[i] = d;
  }
  for (let y = bh - 2; y >= 1; y--) for (let x = bw - 2; x >= 1; x--) {
    const i = y * bw + x; if (!inside[i]) continue;
    let d = dist[i];
    d = Math.min(d, dist[i + 1] + 3, dist[i + bw] + 3, dist[i + bw + 1] + 4, dist[i + bw - 1] + 4);
    dist[i] = d;
  }
  let maxd = 0; for (let i = 0; i < dist.length; i++) if (dist[i] > maxd) maxd = dist[i];
  const buckets = Array.from({ length: maxd + 1 }, () => []);
  for (let i = 0; i < dist.length; i++) if (inside[i]) buckets[dist[i]].push(i);
  const lab = new Int32Array(bw * bh);
  const parent = [0], peak = [0];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const thr = hThr * 3;
  let meetLevel = 0;
  for (let d = maxd; d >= 1; d--) {
    for (const i of buckets[d]) {
      const roots = [];
      for (const o of [-1, 1, -bw, bw, -bw - 1, -bw + 1, bw - 1, bw + 1]) {
        const l = lab[i + o]; if (!l) continue;
        const r = find(l); if (roots.indexOf(r) < 0) roots.push(r);
      }
      if (!roots.length) { const id = parent.length; parent.push(id); peak.push(d); lab[i] = id; continue; }
      roots.sort((a, b) => peak[b] - peak[a]);
      const r0 = roots[0];
      for (let k = 1; k < roots.length; k++) {
        const rk = roots[k];
        if (peak[rk] - d <= thr) parent[rk] = r0; else if (d > meetLevel) meetLevel = d;
      }
      lab[i] = r0;
    }
  }
  // surviving markers = pixels above the highest saddle that separates real blobs
  const coreLab = new Int32Array(bw * bh);
  const roots = new Set();
  for (let i = 0; i < lab.length; i++) if (inside[i] && dist[i] > meetLevel) { const r = find(lab[i]); coreLab[i] = r; roots.add(r); }
  if (roots.size < 2) return null;
  const q = [];
  for (let i = 0; i < coreLab.length; i++) if (coreLab[i]) q.push(i);
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    for (const o of [-1, 1, -bw, bw]) {
      const j = i + o;
      if (inside[j] && !coreLab[j]) { coreLab[j] = coreLab[i]; q.push(j); }
    }
  }
  const groups = new Map();
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x; if (!inside[i]) continue;
    const r = coreLab[i]; if (!r) continue;
    let g = groups.get(r); if (!g) { g = []; groups.set(r, g); }
    g.push((y + bb.y0 - 1) * W + (x + bb.x0 - 1));
  }
  const out = [];
  groups.forEach(g => out.push(Int32Array.from(g)));
  return out.length > 1 ? out : null;
}

// Looks for a thin gap (seam) across the blob along any direction.
function valleySplit(px, W, rect, minPart, applyTo) {
  const stride = Math.max(1, Math.floor(px.length / 120000));
  const n = Math.ceil(px.length / stride);
  const xs = new Float32Array(n), ys = new Float32Array(n);
  for (let k = 0, j = 0; k < px.length; k += stride, j++) { const p = px[k], x = p % W; xs[j] = x + 0.5 - rect.cx; ys[j] = (p - x) / W + 0.5 - rect.cy; }
  const base = rect.theta / DEG;
  const cands = [];
  for (let a = -30; a <= 30; a += 2) { cands.push(base + a); cands.push(base + 90 + a); }
  let best = null;
  for (const deg of cands) {
    const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
    let lo = 1e9, hi = -1e9;
    const us = new Float32Array(n);
    for (let k = 0; k < n; k++) { const u = xs[k] * c + ys[k] * s; us[k] = u; if (u < lo) lo = u; if (u > hi) hi = u; }
    const nb = Math.ceil(hi - lo) + 1;
    if (nb < minPart * 2 + 3) continue;
    const prof = new Float32Array(nb);
    for (let k = 0; k < n; k++) prof[(us[k] - lo) | 0]++;
    // smooth over 2px so single-pixel noise does not matter
    const sm = new Float32Array(nb);
    for (let i = 0; i < nb; i++) { let t = 0, m = 0; for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < nb) { t += prof[j]; m++; } sm[i] = t / m; }
    // reference level: median of central 70% of the profile
    const centre = Array.from(sm.slice(Math.floor(nb * 0.15), Math.ceil(nb * 0.85)));
    const ref = median(centre);
    if (ref < 4) continue;
    for (let i = minPart; i < nb - minPart; i++) {
      if (sm[i] < ref * 0.18) {
        // find the valley extent
        let a0 = i, a1 = i;
        while (a0 > 0 && sm[a0 - 1] < ref * 0.45) a0--;
        while (a1 < nb - 1 && sm[a1 + 1] < ref * 0.45) a1++;
        if (a0 < minPart || a1 > nb - minPart) continue;
        // both sides need real mass
        let left = 0, right = 0;
        for (let j = 0; j < a0; j++) left += prof[j];
        for (let j = a1 + 1; j < nb; j++) right += prof[j];
        if (left < ref * minPart * 0.8 || right < ref * minPart * 0.8) continue;
        const depth = sm[i] / ref;
        if (!best || depth < best.depth) best = { depth, deg, cut: (a0 + a1) / 2 + lo, c, s };
      }
    }
  }
  if (!best) return null;
  const A = [], B = [];
  const tgt = applyTo || px;
  for (let k = 0; k < tgt.length; k++) { const p = tgt[k], x = p % W; const u = (x + 0.5 - rect.cx) * best.c + ((p - x) / W + 0.5 - rect.cy) * best.s; (u < best.cut ? A : B).push(p); }
  if (!A.length || !B.length) return null;
  return [Int32Array.from(A), Int32Array.from(B)];
}

// Two photos can touch through their pale paper borders, so the plain mask shows no gap.
// Remove pale, flat (paper-like) pixels and look for a seam in what is left.
function contentSplit(px, small, minPart, minArea) {
  const { data, w: W, h: H } = small;
  const lum = (i) => data[i * 3] * 0.3 + data[i * 3 + 1] * 0.59 + data[i * 3 + 2] * 0.11;
  const step = Math.max(1, Math.floor(px.length / 4000));
  const samp = [];
  for (let k = 0; k < px.length; k += step) samp.push(lum(px[k]));
  const M = median(samp);
  if (M >= 150) return null;
  const thr = Math.max(170, M + 45);
  const cm = new Uint8Array(W * H);
  for (let k = 0; k < px.length; k++) {
    const p = px[k], x = p % W, y = (p - x) / W;
    let paper = false;
    if (x > 0 && y > 0 && x < W - 1 && y < H - 1) {
      const l = lum(p);
      const r = data[p * 3], g = data[p * 3 + 1], b = data[p * 3 + 2];
      if (l >= thr && Math.max(r, g, b) - Math.min(r, g, b) <= 70 && r >= b - 4 &&
          Math.abs(lum(p + 1) - lum(p - 1)) <= 12 && Math.abs(lum(p + W) - lum(p - W)) <= 12) paper = true;
    }
    cm[p] = paper ? 0 : 1;
  }
  const opened = dilate(erode(cm, W, H, 2), W, H, 2);
  const closed = erode(dilate(opened, W, H, 2), W, H, 2);
  const cpx = [];
  for (let k = 0; k < px.length; k++) if (closed[px[k]]) cpx.push(px[k]);
  if (cpx.length < minArea * 2) return null;
  const cpxA = Int32Array.from(cpx);
  const rect = fitRect(cpxA, W);
  if (!rect) return null;
  const parts = valleySplit(cpxA, W, rect, minPart, px);
  if (!parts) return null;
  // both halves must look like real photos
  for (const p of parts) {
    if (p.length < minArea) return null;
    const r = fitRect(p, W);
    if (!r || Math.min(r.w, r.h) < minPart * 3 || r.fill < 0.88) return null;
  }
  return parts;
}

/* ---------- finding photos on the page (working scale) ---------- */
function analysePage(src, opts) {
  opts = opts || {};
  const target = opts.workSize || 1000;
  const f = Math.max(1, Math.floor(Math.max(src.width, src.height) / target));
  const small = boxDownscale(src, f);
  const { w, h } = small;
  const bg = estimateBg(small);
  const T = Math.min(46, Math.max(opts.minThreshold || 16, bg.noise * 2.5 + 8));
  const mask = new Uint8Array(w * h);
  const d = small.data;
  for (let i = 0, p = 0; p < w * h; p++, i += 3) {
    const diff = Math.max(Math.abs(d[i] - bg.color[0]), Math.abs(d[i + 1] - bg.color[1]), Math.abs(d[i + 2] - bg.color[2]));
    mask[p] = diff > T ? 1 : 0;
  }
  const shortSide = Math.min(w, h);
  const rClose = 0;
  const rOpen = Math.max(2, Math.round(shortSide * 0.004));
  let m = rClose > 0 ? erode(dilate(mask, w, h, rClose), w, h, rClose) : mask;
  m = dilate(erode(m, w, h, rOpen), w, h, rOpen);

  const pageArea = w * h;
  const minArea = pageArea * 0.006;
  const minDim = shortSide * 0.05;
  const hThr = Math.max(4, shortSide * 0.02);
  const minPart = Math.max(6, Math.round(shortSide * 0.04));

  const queue = label(m, w, h).map(px => ({ px, depth: 0 }));
  const photos = [];
  while (queue.length) {
    const { px, depth } = queue.pop();
    if (px.length < minArea) continue;
    const rect = fitRect(px, w);
    if (!rect) continue;
    let parts = null;
    if (depth < 6) {
      if (rect.fill < 0.9) parts = watershedSplit(px, w, hThr);
      if (parts) {
        // accept only if every part is substantial and the shapes become more rectangular
        const rs = parts.map(p => (p.length >= minArea ? fitRect(p, w) : null));
        const ok = rs.every(Boolean) && (rs.reduce((s, r, i) => s + r.fill * parts[i].length, 0) / px.length) > rect.fill + 0.04;
        if (!ok) parts = null;
      }
      if (!parts) parts = valleySplit(px, w, rect, minPart);
      if (!parts) parts = contentSplit(px, small, minPart, minArea);
    }
    if (parts) { for (const p of parts) queue.push({ px: p, depth: depth + 1 }); continue; }
    const longS = Math.max(rect.w, rect.h), shortS = Math.min(rect.w, rect.h);
    if (shortS < minDim) continue;
    if (longS / shortS > 6) continue;
    if (rect.fill < 0.5) continue;
    photos.push({ px, rect, flags: rect.fill < 0.85 ? ['irregular'] : [] });
  }
  // drop fragments that sit inside another photo (pale areas of a photo that got detached from it)
  for (let i = photos.length - 1; i >= 0; i--) {
    const a = photos[i].rect;
    const inside = photos.some((p, j) => {
      if (j === i) return false;
      const b = p.rect;
      if (b.w * b.h <= a.w * a.h) return false;
      const c = Math.cos(b.theta), s = Math.sin(b.theta);
      const toLocal = (x, y) => [(x - b.cx) * c + (y - b.cy) * s, -(x - b.cx) * s + (y - b.cy) * c];
      const ac = Math.cos(a.theta), as = Math.sin(a.theta);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].every(([ux, uy]) => {
        const x = a.cx + ux * a.w / 2 * ac - uy * a.h / 2 * as, y = a.cy + ux * a.w / 2 * as + uy * a.h / 2 * ac;
        const [lx, ly] = toLocal(x, y);
        return Math.abs(lx) <= b.w / 2 * 1.03 && Math.abs(ly) <= b.h / 2 * 1.03;
      });
    });
    if (inside) photos.splice(i, 1);
  }
  // reading order: top-to-bottom rows, then left-to-right
  photos.sort((a, b) => {
    const dy = a.rect.cy - b.rect.cy;
    const rowTol = Math.min(a.rect.h, b.rect.h) * 0.5;
    return Math.abs(dy) > rowTol ? dy : a.rect.cx - b.rect.cx;
  });
  return { f, w, h, bg, threshold: T, mask: m, photos };
}

/* ---------- exact extraction ---------- */
function sampleCrop(src, bgColor, cx, cy, theta, outW, outH) {
  const { data, width: W, height: H, channels: C } = src;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const c = Math.cos(theta), s = Math.sin(theta);
  const hw = outW / 2, hh = outH / 2;
  const br = bgColor[0], bgc = bgColor[1], bb = bgColor[2];
  for (let j = 0; j < outH; j++) {
    const v = j + 0.5 - hh;
    for (let i = 0; i < outW; i++) {
      const u = i + 0.5 - hw;
      const sx = cx + u * c - v * s - 0.5, sy = cy + u * s + v * c - 0.5;
      const o = (j * outW + i) * 4;
      if (sx < -1 || sy < -1 || sx > W || sy > H) { out[o] = br; out[o + 1] = bgc; out[o + 2] = bb; out[o + 3] = 255; continue; }
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const xa = x0 < 0 ? 0 : (x0 >= W ? W - 1 : x0), xb = x0 + 1 < 0 ? 0 : (x0 + 1 >= W ? W - 1 : x0 + 1);
      const ya = y0 < 0 ? 0 : (y0 >= H ? H - 1 : y0), yb = y0 + 1 < 0 ? 0 : (y0 + 1 >= H ? H - 1 : y0 + 1);
      const i00 = (ya * W + xa) * C, i10 = (ya * W + xb) * C, i01 = (yb * W + xa) * C, i11 = (yb * W + xb) * C;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11;
      out[o + 1] = data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11;
      out[o + 2] = data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return out;
}

// Estimate the colour of the white paper border (if there is one) from thin bands just inside and
// just outside the rough rectangle. A border exists when three or more sides agree on a flat colour.
function flatColour(px) {
  if (px.length < 30) return null;
  const hist = new Map();
  for (const p of px) { const k = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); }
  let bk = -1, bv = 0; hist.forEach((v, k) => { if (v > bv) { bv = v; bk = k; } });
  const c0 = [((bk >> 10) << 3) + 4, (((bk >> 5) & 31) << 3) + 4, ((bk & 31) << 3) + 4];
  const cl = px.filter(p => Math.abs(p[0] - c0[0]) <= 10 && Math.abs(p[1] - c0[1]) <= 10 && Math.abs(p[2] - c0[2]) <= 10);
  if (cl.length / px.length < 0.55) return null;
  const med = [0, 1, 2].map(c => median(cl.map(p => p[c])));
  const sd = Math.max(...[0, 1, 2].map(c => median(cl.map(p => Math.abs(p[c] - med[c]))) * 1.4826));
  return { med, sd };
}

function estimatePaper(crop, cw, ch, margin, off, bgColor) {
  const grab = (x0, y0, x1, y1) => {
    const px = [];
    for (let y = Math.max(0, y0 | 0); y < Math.min(ch, y1 | 0); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(cw, x1 | 0); x++) {
      const o = (y * cw + x) * 4; px.push([crop[o], crop[o + 1], crop[o + 2]]);
    }
    return px;
  };
  const ax0 = margin + (cw - 2 * margin) * 0.15, ax1 = cw - margin - (cw - 2 * margin) * 0.15;
  const ay0 = margin + (ch - 2 * margin) * 0.15, ay1 = ch - margin - (ch - 2 * margin) * 0.15;
  // band between distances d0..d1 from the rectangle edge; dir +1 inside, -1 outside
  const bands = (dir, d0, d1) => {
    const o0 = dir > 0 ? d0 : -d1, o1 = dir > 0 ? d1 : -d0;
    return [
      [ax0, margin + o0, ax1, margin + o1],
      [ax0, ch - margin - o1, ax1, ch - margin - o0],
      [margin + o0, ay0, margin + o1, ay1],
      [cw - margin - o1, ay0, cw - margin - o0, ay1]
    ];
  };
  // collect, for every side, the first flat colour found just inside and just outside the rough edge
  const cands = []; // {side, med, sd}
  for (const dir of [1, -1]) {
    const ts = [6, 10, 16, 24, 40].filter(t => dir > 0 || off + t < margin - 2);
    for (let side = 0; side < 4; side++) {
      for (const t of ts) {
        const b = bands(dir, off, off + t)[side];
        const fc = flatColour(grab(b[0], b[1], b[2], b[3]));
        if (fc && fc.sd <= 7) { cands.push({ side, med: fc.med, sd: fc.sd }); break; }
      }
    }
  }
  let bestG = [];
  for (const s0 of cands) {
    const g = cands.filter(s1 => Math.max(Math.abs(s1.med[0] - s0.med[0]), Math.abs(s1.med[1] - s0.med[1]), Math.abs(s1.med[2] - s0.med[2])) <= 10);
    if (new Set(g.map(x => x.side)).size > new Set(bestG.map(x => x.side)).size || (new Set(g.map(x => x.side)).size === new Set(bestG.map(x => x.side)).size && g.length > bestG.length)) bestG = g;
  }
  if (new Set(bestG.map(x => x.side)).size < 3) return [];
  const med = [0, 1, 2].map(c => median(bestG.map(g => g.med[c])));
  const lum = (med[0] + med[1] + med[2]) / 3, chroma = Math.max(...med) - Math.min(...med);
  if (lum < 160 || chroma > 60) return [];
  const sd = Math.max(...bestG.map(g => g.sd));
  return [{ med, tol: Math.max(7, sd * 3 + 3) }];
}

// 1 = "not photo content" (scanner bed, white paper border, or another photo)
function junkMap(crop, outW, outH, bgColor, tol, papers, cx, cy, theta, ownMask, f, mw, mh) {
  const J = new Uint8Array(outW * outH);
  const c = Math.cos(theta), s = Math.sin(theta);
  const hw = outW / 2, hh = outH / 2;
  for (let j = 0; j < outH; j++) {
    const v = j + 0.5 - hh;
    for (let i = 0; i < outW; i++) {
      const o = (j * outW + i) * 4;
      const r = crop[o], g = crop[o + 1], b = crop[o + 2];
      let junk = Math.max(Math.abs(r - bgColor[0]), Math.abs(g - bgColor[1]), Math.abs(b - bgColor[2])) <= tol;
      if (!junk) for (let k = 0; k < papers.length; k++) {
        const P = papers[k];
        if (Math.max(Math.abs(r - P.med[0]), Math.abs(g - P.med[1]), Math.abs(b - P.med[2])) <= P.tol) { junk = true; break; }
      }
      if (!junk && ownMask) {
        const u = i + 0.5 - hw;
        const sx = (cx + u * c - v * s) / f, sy = (cy + u * s + v * c) / f;
        const ix = Math.floor(sx), iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix >= mw || iy >= mh || !ownMask[iy * mw + ix]) junk = true;
      }
      J[j * outW + i] = junk ? 1 : 0;
    }
  }
  return J;
}

function robustLine(ts, es) { // e = a*t + b, Theil-Sen then inlier refit
  const n = ts.length; if (n < 25) return null;
  const step = Math.max(1, Math.floor(n / 120));
  const T = [], E = [];
  for (let i = 0; i < n; i += step) { T.push(ts[i]); E.push(es[i]); }
  const slopes = [];
  for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) if (Math.abs(T[j] - T[i]) > 8) slopes.push((E[j] - E[i]) / (T[j] - T[i]));
  if (slopes.length < 10) return null;
  let a = median(slopes);
  let b = median(E.map((e, i) => e - a * T[i]));
  let inl = 0;
  for (let it = 0; it < 2; it++) {
    let st = 0, se = 0, stt = 0, ste = 0, m = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(es[i] - (a * ts[i] + b)) <= 2.5) { st += ts[i]; se += es[i]; stt += ts[i] * ts[i]; ste += ts[i] * es[i]; m++; }
    }
    inl = m / n;
    if (m < 10) return null;
    const den = m * stt - st * st;
    if (Math.abs(den) > 1e-9) { a = (m * ste - st * se) / den; b = (se - a * st) / m; }
  }
  return { a, b, inl, n };
}

function findEdges(J, outW, outH) {
  const out = { top: [[], []], bottom: [[], []], left: [[], []], right: [[], []] };
  const x0 = Math.floor(outW * 0.12), x1 = Math.ceil(outW * 0.88);
  const y0 = Math.floor(outH * 0.12), y1 = Math.ceil(outH * 0.88);
  const run = Math.max(6, Math.min(14, Math.round(Math.min(outW, outH) * 0.007)));
  const limY = Math.floor(outH * 0.48), limX = Math.floor(outW * 0.48);
  for (let x = x0; x < x1; x += 2) {
    for (let y = 0; y < limY; y++) { // top
      let ok = true; for (let k = 0; k < run; k++) if (J[(y + k) * outW + x]) { ok = false; break; }
      if (ok) { out.top[0].push(x + 0.5); out.top[1].push(y); break; }
    }
    for (let y = outH - 1; y > outH - 1 - limY; y--) { // bottom
      let ok = true; for (let k = 0; k < run; k++) if (J[(y - k) * outW + x]) { ok = false; break; }
      if (ok) { out.bottom[0].push(x + 0.5); out.bottom[1].push(y + 1); break; }
    }
  }
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < limX; x++) { // left
      let ok = true; for (let k = 0; k < run; k++) if (J[y * outW + x + k]) { ok = false; break; }
      if (ok) { out.left[0].push(y + 0.5); out.left[1].push(x); break; }
    }
    for (let x = outW - 1; x > outW - 1 - limX; x--) { // right
      let ok = true; for (let k = 0; k < run; k++) if (J[y * outW + x - k]) { ok = false; break; }
      if (ok) { out.right[0].push(y + 0.5); out.right[1].push(x + 1); break; }
    }
  }
  return {
    top: robustLine(out.top[0], out.top[1]), bottom: robustLine(out.bottom[0], out.bottom[1]),
    left: robustLine(out.left[0], out.left[1]), right: robustLine(out.right[0], out.right[1])
  };
}

function extractPhoto(src, analysis, photo, opts) {
  opts = opts || {};
  const inset = opts.inset == null ? 3 : opts.inset;
  const f = analysis.f;
  const bgc = analysis.bg.color;
  const tol = Math.max(8, analysis.bg.noise * 3 + 3);
  // own mask, slightly grown so exact edges are decided by colour not by the coarse mask
  const own = new Uint8Array(analysis.w * analysis.h);
  for (let k = 0; k < photo.px.length; k++) own[photo.px[k]] = 1;
  const ownD = dilate(own, analysis.w, analysis.h, 3);

  let r = photo.rect;
  let cx = r.cx * f, cy = r.cy * f, theta = r.theta;
  let pw = r.w * f, ph = r.h * f;
  const flags = photo.flags.slice();
  const weak = [false, false, false, false];
  let fitOk = false;
  let cropW = 0, cropH = 0, crop = null, J = null, papers = [];

  for (let iter = 0; iter < 4; iter++) {
    const off = 2;
    const margin = Math.max(off + 14, Math.round(Math.max(pw, ph) * 0.05));
    cropW = Math.round(pw + margin * 2); cropH = Math.round(ph + margin * 2);
    crop = sampleCrop(src, bgc, cx, cy, theta, cropW, cropH);
    if (iter === 0) { papers = estimatePaper(crop, cropW, cropH, margin, off, bgc); if (typeof process !== "undefined" && process.env.PE_DEBUG) console.log("papers", JSON.stringify(papers), "bg", bgc, "tol", tol, "f", f); }
    J = junkMap(crop, cropW, cropH, bgc, tol, papers, cx, cy, theta, ownD, f, analysis.w, analysis.h);
    const L = findEdges(J, cropW, cropH);
    const ds = [];
    const good = l => l && l.inl >= 0.45;
    if (good(L.top)) ds.push(Math.atan(L.top.a));
    if (good(L.bottom)) ds.push(Math.atan(L.bottom.a));
    if (good(L.left)) ds.push(-Math.atan(L.left.a));
    if (good(L.right)) ds.push(-Math.atan(L.right.a));
    if (ds.length < 2) break;
    let delta = median(ds);
    delta = Math.max(-6 * DEG, Math.min(6 * DEG, delta));
    // re-centre on the fitted box, still in the old frame
    const t = good(L.top) ? L.top : null, bt = good(L.bottom) ? L.bottom : null, lf = good(L.left) ? L.left : null, rt = good(L.right) ? L.right : null;
    const yTop = t ? t.a * (cropW / 2) + t.b : margin, yBot = bt ? bt.a * (cropW / 2) + bt.b : cropH - margin;
    const xLeft = lf ? lf.a * (cropH / 2) + lf.b : margin, xRight = rt ? rt.a * (cropH / 2) + rt.b : cropW - margin;
    const ncu = (xLeft + xRight) / 2 - cropW / 2, ncv = (yTop + yBot) / 2 - cropH / 2;
    const c0 = Math.cos(theta), s0 = Math.sin(theta);
    cx += ncu * c0 - ncv * s0; cy += ncu * s0 + ncv * c0;
    pw = Math.max(8, xRight - xLeft); ph = Math.max(8, yBot - yTop);
    theta += delta;
    fitOk = true;
    if (Math.abs(delta) < 0.02 * DEG && iter > 0) break;
  }

  if (fitOk) {
    // final pass in the corrected frame with exact positions
    const margin = Math.max(10, Math.round(Math.max(pw, ph) * 0.03));
    cropW = Math.round(pw + margin * 2); cropH = Math.round(ph + margin * 2);
    crop = sampleCrop(src, bgc, cx, cy, theta, cropW, cropH);
    J = junkMap(crop, cropW, cropH, bgc, tol, papers, cx, cy, theta, ownD, f, analysis.w, analysis.h);
    const L = findEdges(J, cropW, cropH);
    if (typeof process !== 'undefined' && process.env.PE_DEBUG) console.log('final L', JSON.stringify(L), cropW, cropH, 'pw', pw, 'ph', ph);
    const ok = l => l && l.inl >= 0.45;
    // each side that has a trustworthy line uses it; a side that does not keeps the rough edge
    const topY = (ok(L.top) ? Math.max(L.top.a * cropW * 0.1 + L.top.b, L.top.a * cropW * 0.9 + L.top.b) : margin) + inset;
    const botY = (ok(L.bottom) ? Math.min(L.bottom.a * cropW * 0.1 + L.bottom.b, L.bottom.a * cropW * 0.9 + L.bottom.b) : cropH - margin) - inset;
    const lefX = (ok(L.left) ? Math.max(L.left.a * cropH * 0.1 + L.left.b, L.left.a * cropH * 0.9 + L.left.b) : margin) + inset;
    const rigX = (ok(L.right) ? Math.min(L.right.a * cropH * 0.1 + L.right.b, L.right.a * cropH * 0.9 + L.right.b) : cropW - margin) - inset;
    [L.top, L.bottom, L.left, L.right].forEach((l, i) => { if (!ok(l)) weak[i] = true; });
    if (weak.some(Boolean)) flags.push('edges-unclear');
    const nw = rigX - lefX, nh = botY - topY;
    if (nw > 16 && nh > 16 && nw > pw * 0.5 && nh > ph * 0.5) {
      const ncu = (lefX + rigX) / 2 - cropW / 2, ncv = (topY + botY) / 2 - cropH / 2;
      const c0 = Math.cos(theta), s0 = Math.sin(theta);
      cx += ncu * c0 - ncv * s0; cy += ncu * s0 + ncv * c0;
      pw = nw; ph = nh;
    } else { flags.push('fit-rejected'); }
  } else {
    flags.push('fallback');
    pw = Math.max(8, pw - inset * 2 - 4); ph = Math.max(8, ph - inset * 2 - 4);
  }
  let outW = Math.max(1, Math.round(pw)), outH = Math.max(1, Math.round(ph));
  let final = sampleCrop(src, bgc, cx, cy, theta, outW, outH);
  // last safety net: shave any outermost line that still looks like scanner bed / paper
  const wideBed = Math.max(14, tol * 1.6);
  const isJunk = (o) => {
    const r = final[o], g = final[o + 1], b = final[o + 2];
    if (Math.max(Math.abs(r - bgc[0]), Math.abs(g - bgc[1]), Math.abs(b - bgc[2])) <= wideBed) return true;
    for (const P of papers) if (Math.max(Math.abs(r - P.med[0]), Math.abs(g - P.med[1]), Math.abs(b - P.med[2])) <= P.tol + 6) return true;
    return false;
  };
  const lineJunk = (side) => {
    let n = 0, c = 0;
    if (side === 0 || side === 1) { const y = side === 0 ? 0 : outH - 1; for (let x = 0; x < outW; x += 2, c++) if (isJunk((y * outW + x) * 4)) n++; }
    else { const x = side === 2 ? 0 : outW - 1; for (let y = 0; y < outH; y += 2, c++) if (isJunk((y * outW + x) * 4)) n++; }
    return c && n / c > 0.2;
  };
  const trim = [0, 0, 0, 0];
  for (let guard = 0; guard < 3; guard++) {
    let changed = false;
    for (let side = 0; side < 4; side++) {
      if (outW - trim[2] - trim[3] < 20 || outH - trim[0] - trim[1] < 20) continue;
      // evaluate on the already-trimmed window
      const y0 = trim[0], y1 = outH - 1 - trim[1], x0 = trim[2], x1 = outW - 1 - trim[3];
      let n = 0, c = 0;
      if (side < 2) { const y = side === 0 ? y0 : y1; for (let x = x0; x <= x1; x += 2, c++) if (isJunk((y * outW + x) * 4)) n++; }
      else { const x = side === 2 ? x0 : x1; for (let y = y0; y <= y1; y += 2, c++) if (isJunk((y * outW + x) * 4)) n++; }
      if (c && n / c > 0.6) { trim[side]++; changed = true; }
    }
    if (!changed) break;
  }
  // white slivers (scanner bed or a neighbour's border) that survive on a rough edge: shave a few pixels while the line is nearly pure white
  {
    const capPx = Math.max(4, Math.round(Math.min(outW, outH) * 0.015));
    const isWhite = (o) => {
      const r = final[o], g = final[o + 1], b = final[o + 2];
      return (r + g + b) / 3 >= 222 && Math.max(Math.abs(r - bgc[0]), Math.abs(g - bgc[1]), Math.abs(b - bgc[2])) <= 34 && Math.max(r, g, b) - Math.min(r, g, b) <= 26;
    };
    for (let side = 0; side < 4; side++) {
      if (!weak[side]) continue;
      const base = trim[side];
      let last = -1, miss = 0;
      for (let k = base; k < base + capPx; k++) {
        const y0 = trim[0], y1 = outH - 1 - trim[1], x0 = trim[2], x1 = outW - 1 - trim[3];
        let n = 0, c = 0;
        if (side < 2) { const y = side === 0 ? k : outH - 1 - k; for (let x = x0 + 4; x <= x1 - 4; x += 2, c++) if (isWhite((y * outW + x) * 4)) n++; }
        else { const x = side === 2 ? k : outW - 1 - k; for (let y = y0 + 4; y <= y1 - 4; y += 2, c++) if (isWhite((y * outW + x) * 4)) n++; }
        if (c && n / c >= 0.7) { last = k; miss = 0; } else if (++miss >= 2) break;
      }
      if (last >= base) trim[side] = last + 1 + 2;
    }
  }
  // bright, flat paper border that was not recognised earlier (aged prints, torn or creased edges):
  // trim lines near the edge that are mostly much lighter than the photo itself
  {
    const lum = (o) => (final[o] * 0.3 + final[o + 1] * 0.59 + final[o + 2] * 0.11);
    const samples = [];
    for (let y = Math.floor(outH * 0.2); y < outH * 0.8; y += 7) for (let x = Math.floor(outW * 0.2); x < outW * 0.8; x += 7) samples.push(lum((y * outW + x) * 4));
    const M = median(samples);
    const thr = Math.max(160, M + 42);
    if (M < 175) {
      let warmMin = 6;
      const light = (o) => {
        if (lum(o) < thr) return false;
        const r = final[o], g = final[o + 1], b = final[o + 2];
        return Math.max(r, g, b) - Math.min(r, g, b) <= 90 && r - b >= warmMin;
      };
      const lineFrac = (side, k) => {
        let n = 0, c = 0;
        if (side < 2) { const y = side === 0 ? k : outH - 1 - k; for (let x = Math.floor(outW * 0.1); x < outW * 0.9; x += 2, c++) if (light((y * outW + x) * 4)) n++; }
        else { const x = side === 2 ? k : outW - 1 - k; for (let y = Math.floor(outH * 0.1); y < outH * 0.9; y += 2, c++) if (light((y * outW + x) * 4)) n++; }
        return c ? n / c : 0;
      };
      for (let side = 0; side < 4; side++) {
        let lim = Math.floor((side < 2 ? outH : outW) * 0.06);
        let edge = -1, miss = 0;
        for (const pass of [0, 1]) {
          // pass 0: warm cream/sepia borders up to 6% wide; pass 1: very thin neutral white slivers (up to 8px)
          warmMin = pass === 0 ? 6 : -4;
          const L = pass === 0 ? lim : Math.min(lim, 8);
          edge = -1; miss = 0;
          for (let k = 0; k < L; k++) {
            if (lineFrac(side, k) >= (pass === 0 ? 0.5 : 0.3)) { edge = k; miss = 0; }
            else if (++miss >= 3) break;
          }
          if (edge >= 0) break;
        }
        if (edge >= 0) {
          // torn or wavy borders leave ragged remnants: keep trimming while a noticeable share of the line is still pale
          for (let k = edge + 1; k < Math.floor((side < 2 ? outH : outW) * 0.08) && lineFrac(side, k) >= 0.12; k++) edge = k;
          // only trust it if the border ends in a crisp step into darker picture content
          const meanLum = (k0, k1) => {
            let t = 0, c = 0;
            for (let k = k0; k <= k1; k++) {
              if (side < 2) { const y = side === 0 ? k : outH - 1 - k; for (let x = Math.floor(outW * 0.1); x < outW * 0.9; x += 4, c++) t += lum((y * outW + x) * 4); }
              else { const x = side === 2 ? k : outW - 1 - k; for (let y = Math.floor(outH * 0.1); y < outH * 0.9; y += 4, c++) t += lum((y * outW + x) * 4); }
            }
            return c ? t / c : 0;
          };
          if (meanLum(0, Math.min(6, edge)) - meanLum(edge + 6, edge + 30) >= 50) trim[side] = Math.max(trim[side], edge + 1 + 2);
        }
      }
    }
  }
  // ragged slivers left along a dark photo's edge: shave while the outer line is noticeably paler than the inside
  {
    const lum2 = (o) => (final[o] * 0.3 + final[o + 1] * 0.59 + final[o + 2] * 0.11);
    const smp = [];
    for (let y = Math.floor(outH * 0.2); y < outH * 0.8; y += 7) for (let x = Math.floor(outW * 0.2); x < outW * 0.8; x += 7) smp.push(lum2((y * outW + x) * 4));
    const M2 = median(smp);
    if (M2 < 140) {
      const thr2 = Math.max(150, M2 + 60);
      const frac = (side, k) => {
        let n = 0, c = 0;
        if (side < 2) { const y = side === 0 ? k : outH - 1 - k; for (let x = Math.floor(outW * 0.1); x < outW * 0.9; x += 2, c++) if (lum2((y * outW + x) * 4) >= thr2) n++; }
        else { const x = side === 2 ? k : outW - 1 - k; for (let y = Math.floor(outH * 0.1); y < outH * 0.9; y += 2, c++) if (lum2((y * outW + x) * 4) >= thr2) n++; }
        return c ? n / c : 0;
      };
      for (let side = 0; side < 4; side++) {
        const base = trim[side];
        let k = base;
        while (k < base + 8 && frac(side, k) >= 0.15 && frac(side, k + 10) < 0.06) k++;
        if (k > base) trim[side] = k + 1;
      }
    }
  }
  if (trim.some(t => t > 0)) {
    const nw = outW - trim[2] - trim[3], nh = outH - trim[0] - trim[1];
    const nd = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) nd.set(final.subarray(((y + trim[0]) * outW + trim[2]) * 4, ((y + trim[0]) * outW + trim[2] + nw) * 4), y * nw * 4);
    final = nd; outW = nw; outH = nh;
  }
  return {
    debug: opts.debug ? { J, cropW, cropH, crop, papers } : undefined,
    width: outW, height: outH, data: final,
    rect: { cx, cy, w: outW, h: outH, theta },
    flags
  };
}

function corners(rect) {
  const c = Math.cos(rect.theta), s = Math.sin(rect.theta);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const u = a * rect.w / 2, v = b * rect.h / 2;
    return [rect.cx + u * c - v * s, rect.cy + u * s + v * c];
  });
}

function processPage(src, opts) {
  const analysis = analysePage(src, opts);
  const photos = analysis.photos.map(p => extractPhoto(src, analysis, p, opts));
  return { photos, analysis };
}

const api = { processPage, analysePage, extractPhoto, corners, estimateBg, _internals: { watershedSplit, fitRect, valleySplit, label, dilate, erode } };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PhotoEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
