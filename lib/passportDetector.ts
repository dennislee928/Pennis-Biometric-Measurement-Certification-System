export interface Point2D {
  x: number;
  y: number;
}

export interface PassportCorners {
  corners: [Point2D, Point2D, Point2D, Point2D];
  confidence: number;
}

function extractRegion(frame: ImageData, region: { left: number; top: number; width: number; height: number }): ImageData {
  const { data, width } = frame;
  const { left, top, width: rw, height: rh } = region;
  const out = new ImageData(rw, rh);
  const dst = out.data;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const si = ((top + y) * width + (left + x)) * 4;
      const di = (y * rw + x) * 4;
      dst[di] = data[si];
      dst[di + 1] = data[si + 1];
      dst[di + 2] = data[si + 2];
      dst[di + 3] = data[si + 3];
    }
  }
  return out;
}

function toGrayscale(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const pi = i * 4;
    gray[i] = Math.round(0.299 * data[pi] + 0.587 * data[pi + 1] + 0.114 * data[pi + 2]);
  }
  return gray;
}

function sobelMagnitude(gray: Uint8Array, w: number, h: number): Float64Array {
  const mag = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -1 * gray[(y - 1) * w + (x - 1)] + 1 * gray[(y - 1) * w + (x + 1)] +
        -2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)] +
        -1 * gray[(y + 1) * w + (x - 1)] + 1 * gray[(y + 1) * w + (x + 1)];
      const gy =
        -1 * gray[(y - 1) * w + (x - 1)] + -2 * gray[(y - 1) * w + x] + -1 * gray[(y - 1) * w + (x + 1)] +
        1 * gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + 1 * gray[(y + 1) * w + (x + 1)];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

function thresholdFromPercentile(mag: Float64Array, pct: number): number {
  const sorted = new Float64Array(mag);
  sorted.sort();
  const idx = Math.floor(sorted.length * pct);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function applyThreshold(mag: Float64Array, w: number, h: number, val: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = mag[i] > val ? 255 : 0;
  }
  return out;
}

function dilate(binary: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let src = binary;
  for (let iter = 0; iter < iterations; iter++) {
    const dst = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (src[y * w + x] === 255 ||
            src[(y - 1) * w + x] === 255 ||
            src[(y + 1) * w + x] === 255 ||
            src[y * w + (x - 1)] === 255 ||
            src[y * w + (x + 1)] === 255) {
          dst[y * w + x] = 255;
        }
      }
    }
    src = dst;
  }
  return src;
}

interface Component {
  points: Point2D[];
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function findComponents(binary: Uint8Array, w: number, h: number, minArea: number): Component[] {
  const visited = new Uint8Array(w * h);
  const components: Component[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x] === 0 || visited[y * w + x] === 1) continue;

      const points: Point2D[] = [];
      const stack: number[] = [y * w + x];
      visited[y * w + x] = 1;

      while (stack.length > 0) {
        const idx = stack.pop()!;
        const py = Math.floor(idx / w);
        const px = idx % w;
        points.push({ x: px, y: py });

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = py + dy;
            const nx = px + dx;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const nidx = ny * w + nx;
            if (binary[nidx] === 255 && visited[nidx] === 0) {
              visited[nidx] = 1;
              stack.push(nidx);
            }
          }
        }
      }

      if (points.length < minArea) continue;

      let minX = w, minY = h, maxX = 0, maxY = 0;
      for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }

      components.push({ points, area: points.length, minX, minY, maxX, maxY });
    }
  }

  return components;
}

function findCornersFromPoints(points: Point2D[]): [Point2D, Point2D, Point2D, Point2D] | null {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;

  const quadrants: { min: number; max: number }[] = [
    { min: -135, max: -45 },
    { min: -45, max: 45 },
    { min: 45, max: 135 },
    { min: 135, max: 225 },
  ];

  const candidates: Point2D[] = [];
  for (const q of quadrants) {
    let best: Point2D | null = null;
    let bestDist = -1;
    for (const p of points) {
      const angle = (Math.atan2(p.y - cy, p.x - cx) * 180) / Math.PI;
      let a = angle;
      if (q.min >= 135 && a < 0) a += 360;
      if (a >= q.min && a < q.max) {
        const dist = Math.hypot(p.x - cx, p.y - cy);
        if (dist > bestDist) {
          bestDist = dist;
          best = p;
        }
      }
    }
    if (best) candidates.push(best);
  }

  if (candidates.length < 4) return null;

  candidates.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = candidates[0];
  const br = candidates[candidates.length - 1];
  const rest = candidates.slice(1, -1);
  rest.sort((a, b) => a.x - b.x);
  const bl = rest[0];
  const tr = rest.length > 1 ? rest[rest.length - 1] : rest[0];

  return [tl, tr, br, bl];
}

function validateQuadrilateral(
  corners: [Point2D, Point2D, Point2D, Point2D],
  totalArea: number
): { valid: boolean; score: number } {
  const [tl, tr, br, bl] = corners;

  const widthTop = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const widthBottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const heightLeft = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const heightRight = Math.hypot(br.x - tr.x, br.y - tr.y);

  const aspect1 = heightLeft / (widthTop || 1);
  const aspect2 = heightRight / (widthBottom || 1);
  const expectedAspect = 125 / 88;
  const aspectRatioOk1 = Math.abs(aspect1 - expectedAspect) / expectedAspect < 0.15;
  const aspectRatioOk2 = Math.abs(aspect2 - expectedAspect) / expectedAspect < 0.15;

  function angle(p1: Point2D, p2: Point2D, p3: Point2D): number {
    const dx1 = p1.x - p2.x, dy1 = p1.y - p2.y;
    const dx2 = p3.x - p2.x, dy2 = p3.y - p2.y;
    const dot = dx1 * dx2 + dy1 * dy2;
    const mag = Math.sqrt((dx1 * dx1 + dy1 * dy1) * (dx2 * dx2 + dy2 * dy2));
    if (mag < 1e-6) return 0;
    return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * (180 / Math.PI);
  }

  const angles = [
    angle(bl, tl, tr),
    angle(tl, tr, br),
    angle(tr, br, bl),
    angle(br, bl, tl),
  ];

  const angleOk = angles.every(a => Math.abs(a - 90) < 25);
  const avgAngleDev = angles.reduce((s, a) => s + Math.abs(a - 90), 0) / angles.length;

  const quadArea = 0.5 * Math.abs(
    (tl.x * tr.y + tr.x * br.y + br.x * bl.y + bl.x * tl.y) -
    (tr.x * tl.y + br.x * tr.y + bl.x * br.y + tl.x * bl.y)
  );

  const areaRatio = quadArea / totalArea;
  const areaOk = areaRatio > 0.02;

  const score = Math.max(0, 1 - avgAngleDev / 90) * (areaOk ? 1 : 0.3) * (aspectRatioOk1 || aspectRatioOk2 ? 1 : 0.5);

  const valid = (aspectRatioOk1 || aspectRatioOk2) && angleOk && areaOk;

  return { valid, score };
}

export function detectPassportCorners(
  frame: ImageData,
  searchRegion: { left: number; top: number; width: number; height: number }
): PassportCorners | null {
  const region = extractRegion(frame, searchRegion);
  const gray = toGrayscale(region);
  const mag = sobelMagnitude(gray, region.width, region.height);
  const threshVal = thresholdFromPercentile(mag, 0.82);
  const binary = applyThreshold(mag, region.width, region.height, threshVal);
  const closed = dilate(binary, region.width, region.height, 2);
  const minArea = Math.max(50, region.width * region.height * 0.005);
  const components = findComponents(closed, region.width, region.height, minArea);

  components.sort((a, b) => b.area - a.area);

  let bestCorners: [Point2D, Point2D, Point2D, Point2D] | null = null;
  let bestScore = 0;

  for (const comp of components.slice(0, 5)) {
    const corners = findCornersFromPoints(comp.points);
    if (!corners) continue;

    const regionArea = region.width * region.height;
    const result = validateQuadrilateral(corners, regionArea);
    if (!result.valid) continue;

    const mapped: [Point2D, Point2D, Point2D, Point2D] = corners.map(c => ({
      x: c.x + searchRegion.left,
      y: c.y + searchRegion.top,
    })) as [Point2D, Point2D, Point2D, Point2D];

    if (result.score > bestScore) {
      bestScore = result.score;
      bestCorners = mapped;
    }
  }

  if (bestCorners && bestScore > 0.3) {
    return { corners: bestCorners, confidence: bestScore };
  }

  return null;
}
