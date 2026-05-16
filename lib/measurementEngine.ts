/**
 * 測量引擎：參考物標定 (PPM)、幾何修正、物理單位轉換
 * 影像不離開裝置，僅在記憶體中處理
 */

export const REFERENCE_CARD_WIDTH_CM = 8.56; // 標準信用卡寬度 (cm)
/** 護照閉合時可見寬度約 88mm */
export const REFERENCE_PASSPORT_WIDTH_CM = 8.8;

/** 測量區（藍色框）與 CameraCapture overlay 一致：top 48%, height 35%, width 50% 置中 */
export const MEASUREMENT_ROI_TOP_RATIO = 0.48;
export const MEASUREMENT_ROI_HEIGHT_RATIO = 0.35;
export const MEASUREMENT_ROI_WIDTH_RATIO = 0.5;

export interface Point2D {
  x: number;
  y: number;
}

export interface MeasurementResult {
  lengthCm: number;
  circumferenceCm?: number;
  ppm: number;
  timestamp: number;
  /** 是否通過 liveness / 即時檢測 */
  liveCaptured: boolean;
}

/**
 * 從參考卡片四角計算 Pixels Per Metric (PPM)
 * 輸入為卡片在畫面上的四個角點 (順序: 左上、右上、右下、左下)
 */
export function computePPMFromCard(
  corners: [Point2D, Point2D, Point2D, Point2D],
  cardWidthCm: number = REFERENCE_CARD_WIDTH_CM
): number {
  const [tl, tr, br, bl] = corners;
  const topWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomWidth = Math.hypot(br.x - bl.x, br.y - bl.y);
  const avgWidthPx = (topWidth + bottomWidth) / 2;
  if (avgWidthPx <= 0) return 0;
  return avgWidthPx / cardWidthCm;
}

/**
 * 從護照（閉合）四角計算 PPM
 */
export function computePPMFromPassport(
  corners: [Point2D, Point2D, Point2D, Point2D]
): number {
  return computePPMFromCard(corners, REFERENCE_PASSPORT_WIDTH_CM);
}

/**
 * 透視變換：將四邊形區域映射到矩形，校正 Foreshortening
 * 使用 4-point perspective transform 的逆矩陣將「螢幕四邊形」轉為「正視矩形」
 */
export function buildPerspectiveMatrix(
  src: [Point2D, Point2D, Point2D, Point2D],
  dstWidth: number,
  dstHeight: number
): number[] {
  const [p0, p1, p2, p3] = src;
  const dst = [
    { x: 0, y: 0 },
    { x: dstWidth, y: 0 },
    { x: dstWidth, y: dstHeight },
    { x: 0, y: dstHeight },
  ];
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i];
    const d = dst[i];
    A.push(
      [s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y],
      [0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]
    );
    b.push(d.x, d.y);
  }
  const coef = solve8x8(A, b);
  if (!coef) return [];
  return [
    coef[0], coef[3], coef[6],
    coef[1], coef[4], coef[7],
    coef[2], coef[5], 1,
  ];
}

function solve8x8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const a = A.map((row) => [...row]);
  const c = [...b];
  for (let k = 0; k < n; k++) {
    let max = Math.abs(a[k][k]);
    let maxRow = k;
    for (let i = k + 1; i < n; i++) {
      if (Math.abs(a[i][k]) > max) {
        max = Math.abs(a[i][k]);
        maxRow = i;
      }
    }
    if (max < 1e-10) return null;
    [a[k], a[maxRow]] = [a[maxRow], a[k]];
    [c[k], c[maxRow]] = [c[maxRow], c[k]];
    for (let i = k + 1; i < n; i++) {
      const f = a[i][k] / a[k][k];
      for (let j = k; j < n; j++) a[i][j] -= f * a[k][j];
      c[i] -= f * c[k];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = c[i];
    for (let j = i + 1; j < n; j++) sum -= a[i][j] * x[j];
    x[i] = sum / a[i][i];
  }
  return x;
}

/**
 * 在已知 PPM 下，將像素長度轉為公分
 */
export function pixelsToCm(pixels: number, ppm: number): number {
  if (ppm <= 0) return 0;
  return pixels / ppm;
}

/**
 * 從目標區域的邊界框或輪廓計算長度（像素），再轉成公分
 * region 為 { top, left, width, height } 或 長度像素值
 */
export function measureLengthFromRegion(
  lengthPixels: number,
  ppm: number,
  liveCaptured: boolean
): MeasurementResult {
  const lengthCm = pixelsToCm(lengthPixels, ppm);
  return {
    lengthCm,
    ppm,
    timestamp: Date.now(),
    liveCaptured,
  };
}

/**
 * 環境光線檢測：從 ImageData 計算平均亮度
 */
export function getAverageLuminance(imageData: ImageData): number {
  const data = imageData.data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * 從全畫面 ImageData 裁出測量區 ROI（與藍色框比例一致）
 */
export function getMeasurementRoi(imageData: ImageData): ImageData {
  const { data, width, height } = imageData;
  const left = Math.floor((width - width * MEASUREMENT_ROI_WIDTH_RATIO) / 2);
  const top = Math.floor(height * MEASUREMENT_ROI_TOP_RATIO);
  const w = Math.floor(width * MEASUREMENT_ROI_WIDTH_RATIO);
  const h = Math.floor(height * MEASUREMENT_ROI_HEIGHT_RATIO);
  const roi = new ImageData(w, h);
  const src = data;
  const dst = roi.data;
  for (let y = 0; y < h; y++) {
    const srcRow = (top + y) * width * 4;
    const dstRow = y * w * 4;
    for (let x = 0; x < w; x++) {
      const si = srcRow + (left + x) * 4;
      const di = dstRow + x * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return roi;
}

/** 啟發式驗證門檻：灰階變異數低於此視為空白/單色 */
const DEFAULT_MIN_ROI_VARIANCE = 80;
/** 啟發式驗證門檻：邊緣強度低於此視為無輪廓 */
const DEFAULT_MIN_ROI_EDGE = 1.5;

export interface ValidateMeasurementRegionResult {
  valid: boolean;
  reason?: string;
}

export interface ValidateMeasurementRegionOptions {
  minVariance?: number;
  minEdgeScore?: number;
}

/**
 * 驗證測量區（藍色框）內是否有有效內容：灰階變異數 + 邊緣強度
 */
export function validateMeasurementRegion(
  imageData: ImageData,
  options: ValidateMeasurementRegionOptions = {}
): ValidateMeasurementRegionResult {
  const roi = getMeasurementRoi(imageData);
  const { data, width, height } = roi;
  const minVariance = options.minVariance ?? DEFAULT_MIN_ROI_VARIANCE;
  const minEdgeScore = options.minEdgeScore ?? DEFAULT_MIN_ROI_EDGE;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  const step = 2;
  for (let i = 0; i < data.length; i += 4 * step) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += g;
    sumSq += g * g;
    count++;
  }
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? sumSq / count - mean * mean : 0;
  if (variance < minVariance) {
    return { valid: false, reason: 'region_empty_or_flat' };
  }

  let edgeSum = 0;
  let edgeCount = 0;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = (y * width + x) * 4;
      const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const l = (data[((y - 1) * width + x) * 4] + data[((y - 1) * width + x) * 4 + 1] + data[((y - 1) * width + x) * 4 + 2]) / 3;
      const r = (data[((y + 1) * width + x) * 4] + data[((y + 1) * width + x) * 4 + 1] + data[((y + 1) * width + x) * 4 + 2]) / 3;
      edgeSum += Math.abs(-l + 2 * g - r);
      edgeCount++;
    }
  }
  const edgeScore = edgeCount > 0 ? edgeSum / edgeCount : 0;
  if (edgeScore < minEdgeScore) {
    return { valid: false, reason: 'region_no_contour' };
  }
  return { valid: true };
}

/**
 * 兩幀 ROI 的幀間差異（灰階絕對差平均值），用於動態活體檢測
 */
export function computeFrameDifference(roi1: ImageData, roi2: ImageData): number {
  if (roi1.width !== roi2.width || roi1.height !== roi2.height) return 0;
  const d1 = roi1.data;
  const d2 = roi2.data;
  let sum = 0;
  let count = 0;
  const step = 4;
  for (let i = 0; i < d1.length; i += step) {
    const g1 = 0.299 * d1[i] + 0.587 * d1[i + 1] + 0.114 * d1[i + 2];
    const g2 = 0.299 * d2[i] + 0.587 * d2[i + 1] + 0.114 * d2[i + 2];
    sum += Math.abs(g1 - g2);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/**
 * 模糊檢測：Laplacian 變異數近似
 */
export function getBlurScore(imageData: ImageData): number {
  const { data, width, height } = imageData;
  let sum = 0;
  let count = 0;
  const step = 4;
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = (y * width + x) * 4;
      const g = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const l = (data[((y - 1) * width + x) * 4] + data[((y - 1) * width + x) * 4 + 1] + data[((y - 1) * width + x) * 4 + 2]) / 3;
      const r = (data[((y + 1) * width + x) * 4] + data[((y + 1) * width + x) * 4 + 1] + data[((y + 1) * width + x) * 4 + 2]) / 3;
      const laplacian = Math.abs(-l + 2 * g - r);
      sum += laplacian;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function invert3x3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) return null;
  const invDet = 1 / det;
  return [
    (e * i - f * h) * invDet,
    (c * h - b * i) * invDet,
    (b * f - c * e) * invDet,
    (f * g - d * i) * invDet,
    (a * i - c * g) * invDet,
    (c * d - a * f) * invDet,
    (d * h - e * g) * invDet,
    (b * g - a * h) * invDet,
    (a * e - b * d) * invDet,
  ];
}

export function perspectiveWarp(
  imageData: ImageData,
  srcCorners: [Point2D, Point2D, Point2D, Point2D],
  dstWidth?: number,
  dstHeight?: number
): ImageData {
  const passportAspect = 125 / 88;
  const dw = dstWidth ?? Math.min(imageData.width, 400);
  const dh = dstHeight ?? Math.round(dw * passportAspect);

  const matrix = buildPerspectiveMatrix(srcCorners, dw, dh);
  if (matrix.length === 0) return new ImageData(dw, dh);

  const inv = invert3x3(matrix);
  if (!inv) return new ImageData(dw, dh);

  const src = imageData.data;
  const sw = imageData.width;
  const sh = imageData.height;
  const dstImageData = new ImageData(dw, dh);
  const dst = dstImageData.data;

  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const w = inv[6] * x + inv[7] * y + inv[8];
      if (Math.abs(w) < 1e-10) continue;
      const sx = (inv[0] * x + inv[1] * y + inv[2]) / w;
      const sy = (inv[3] * x + inv[4] * y + inv[5]) / w;

      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix < 0 || ix >= sw - 1 || iy < 0 || iy >= sh - 1) continue;

      const fx = sx - ix;
      const fy = sy - iy;
      const si = (iy * sw + ix) * 4;
      const di = (y * dw + x) * 4;

      for (let c = 0; c < 4; c++) {
        const p00 = src[si + c];
        const p10 = src[si + 4 + c];
        const p01 = src[si + sw * 4 + c];
        const p11 = src[si + sw * 4 + 4 + c];
        dst[di + c] = Math.round(
          (1 - fx) * (1 - fy) * p00 +
          fx * (1 - fy) * p10 +
          (1 - fx) * fy * p01 +
          fx * fy * p11
        );
      }
    }
  }

  return dstImageData;
}
