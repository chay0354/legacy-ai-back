/**
 * Unwrap portraits that were saved as a small sharp photo inside a blurred square.
 * That layout came from the short-lived contain+78% inset pipeline.
 */
import sharp from 'sharp';

export const PORTRAIT_LAYOUT_FULLBLEED = 'fullbleed';
const PREVIEW = 200;
const SEAM_INSET = 0.11;
const CROP_SCALE = 0.78;
const TARGET_PX = 1536;

function px(data, size, x, y) {
  const i = (Math.max(0, Math.min(size - 1, y)) * size + Math.max(0, Math.min(size - 1, x))) * 3;
  return [data[i], data[i + 1], data[i + 2]];
}

function dist(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function ringContrast(data, size, insetRatio) {
  const inset = Math.round(size * insetRatio);
  const delta = 5;
  if (inset <= delta || inset >= size - delta) return 0;
  let sum = 0;
  let n = 0;
  for (let y = inset; y < size - inset; y += 2) {
    sum += dist(px(data, size, inset - delta, y), px(data, size, inset + delta, y));
    sum += dist(px(data, size, size - 1 - inset - delta, y), px(data, size, size - 1 - inset + delta, y));
    n += 2;
  }
  for (let x = inset; x < size - inset; x += 2) {
    sum += dist(px(data, size, x, inset - delta), px(data, size, x, inset + delta));
    sum += dist(px(data, size, x, size - 1 - inset - delta), px(data, size, x, size - 1 - inset + delta));
    n += 2;
  }
  return n ? sum / n : 0;
}

export async function looksPadded(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize(PREVIEW, PREVIEW, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const size = info.width;
  const atSeam = ringContrast(data, size, SEAM_INSET);
  const near = ringContrast(data, size, 0.06);
  const inner = ringContrast(data, size, 0.22);
  return {
    padded: atSeam > 14 && atSeam > near * 1.25 && atSeam > inner * 1.15,
    atSeam,
    near,
    inner,
  };
}

export async function cropPaddedPortrait(buffer) {
  const meta = await sharp(buffer).rotate().metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (width < 64 || height < 64) return buffer;

  const crop = Math.max(64, Math.round(Math.min(width, height) * CROP_SCALE));
  const left = Math.round((width - crop) / 2);
  const top = Math.round((height - crop) / 2);
  const out = Math.min(Math.max(crop, 1152), TARGET_PX);

  return sharp(buffer)
    .rotate()
    .extract({
      left: Math.max(0, left),
      top: Math.max(0, top),
      width: Math.min(crop, width),
      height: Math.min(crop, height),
    })
    .resize(out, out, { fit: 'cover' })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** Returns a full-bleed JPEG buffer when the stored file still has the inset frame. */
export async function unwrapPortraitIfPadded(buffer, { force = false } = {}) {
  if (!buffer?.length) return { buffer, changed: false };
  const check = force ? { padded: true } : await looksPadded(buffer);
  if (!check.padded) return { buffer, changed: false, check };
  const next = await cropPaddedPortrait(buffer);
  return { buffer: next, changed: true, check };
}
