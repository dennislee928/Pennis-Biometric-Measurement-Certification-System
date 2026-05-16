export interface DistortionParams {
  k1: number;
  k2: number;
}

const DEFAULT_PARAMS: DistortionParams = { k1: 0.15, k2: 0.05 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function bilinearSample(data: Uint8ClampedArray, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const ix0 = (y0 * width + x0) * 4;
  const ix1 = (y0 * width + x1) * 4;
  const iy0 = (y1 * width + x0) * 4;
  const iy1 = (y1 * width + x1) * 4;
  const r = (1 - fy) * ((1 - fx) * data[ix0] + fx * data[ix1]) + fy * ((1 - fx) * data[iy0] + fx * data[iy1]);
  const g = (1 - fy) * ((1 - fx) * data[ix0 + 1] + fx * data[ix1 + 1]) + fy * ((1 - fx) * data[iy0 + 1] + fx * data[iy1 + 1]);
  const b = (1 - fy) * ((1 - fx) * data[ix0 + 2] + fx * data[ix1 + 2]) + fy * ((1 - fx) * data[iy0 + 2] + fx * data[iy1 + 2]);
  const a = (1 - fy) * ((1 - fx) * data[ix0 + 3] + fx * data[ix1 + 3]) + fy * ((1 - fx) * data[iy0 + 3] + fx * data[iy1 + 3]);
  return [r, g, b, a];
}

export function correctDistortion(imageData: ImageData, params?: DistortionParams): ImageData {
  const { data, width, height } = imageData;
  const { k1, k2 } = params || DEFAULT_PARAMS;
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.sqrt(cx * cx + cy * cy);
  const output = new ImageData(new Uint8ClampedArray(data), width, height);
  const outData = output.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / maxRadius;
      const dy = (y - cy) / maxRadius;
      const r2 = dx * dx + dy * dy;
      const r4 = r2 * r2;
      const scale = 1 + k1 * r2 + k2 * r4;
      const srcX = cx + dx * maxRadius / scale;
      const srcY = cy + dy * maxRadius / scale;
      if (srcX < 0 || srcX >= width - 1 || srcY < 0 || srcY >= height - 1) {
        const di = (y * width + x) * 4;
        outData[di] = 0;
        outData[di + 1] = 0;
        outData[di + 2] = 0;
        outData[di + 3] = 255;
        continue;
      }
      const [r, g, b, a] = bilinearSample(data, width, height, srcX, srcY);
      const di = (y * width + x) * 4;
      outData[di] = clamp(Math.round(r), 0, 255);
      outData[di + 1] = clamp(Math.round(g), 0, 255);
      outData[di + 2] = clamp(Math.round(b), 0, 255);
      outData[di + 3] = clamp(Math.round(a), 0, 255);
    }
  }

  return output;
}
