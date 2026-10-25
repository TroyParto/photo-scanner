/* Background worker: decodes one scanned page, finds + crops every photo, returns JPEG bytes. */
importScripts('engine.js');

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
const MAX_PIXELS = 110e6;

async function jpeg(canvas, quality) {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return blob.arrayBuffer();
}

function shrink(source, sw, sh, maxSide) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  return { c, k };
}

self.onmessage = async (e) => {
  const { id, file, quality } = e.data;
  try {
    let bmp = await createImageBitmap(file);
    if (bmp.width * bmp.height > MAX_PIXELS) {
      const k = Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height));
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close(); bmp = small;
    }
    const W = bmp.width, H = bmp.height;
    const page = new OffscreenCanvas(W, H);
    const pg = page.getContext('2d', { willReadFrequently: true });
    pg.fillStyle = '#fff'; pg.fillRect(0, 0, W, H);
    pg.drawImage(bmp, 0, 0);
    bmp.close();
    let img = pg.getImageData(0, 0, W, H);
    const result = PhotoEngine.processPage({ data: img.data, width: W, height: H, channels: 4 });
    img = null;

    const photos = [];
    const transfer = [];
    for (let i = 0; i < result.photos.length; i++) {
      const p = result.photos[i];
      const oc = new OffscreenCanvas(p.width, p.height);
      oc.getContext('2d').putImageData(new ImageData(p.data, p.width, p.height), 0, 0);
      const bytes = await jpeg(oc, quality);
      const th = shrink(oc, p.width, p.height, 240);
      const thumb = await jpeg(th.c, 0.85);
      photos.push({ width: p.width, height: p.height, bytes, thumb, flags: p.flags, angle: p.rect.theta * 180 / Math.PI });
      transfer.push(bytes, thumb);
    }

    // preview of the page with every detected photo outlined
    const pv = shrink(page, W, H, 1100);
    const g = pv.c.getContext('2d');
    g.lineWidth = Math.max(2, 3);
    g.font = 'bold 22px sans-serif';
    result.photos.forEach((p, i) => {
      const cs = PhotoEngine.corners(p.rect).map(([x, y]) => [x * pv.k, y * pv.k]);
      g.strokeStyle = COLORS[i % COLORS.length];
      g.beginPath(); cs.forEach(([x, y], j) => (j ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke();
      const cx = (cs[0][0] + cs[2][0]) / 2, cy = (cs[0][1] + cs[2][1]) / 2;
      g.fillStyle = COLORS[i % COLORS.length];
      g.beginPath(); g.arc(cx, cy, 17, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), cx, cy + 1);
    });
    const preview = await jpeg(pv.c, 0.8);
    transfer.push(preview);
    self.postMessage({ id, ok: true, width: W, height: H, photos, preview }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
