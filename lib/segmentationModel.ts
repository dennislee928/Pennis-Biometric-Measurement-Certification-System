import * as tf from '@tensorflow/tfjs';

export interface SegmentationResult {
  mask: ImageData | null;
  topY: number;
  bottomY: number;
  confidence: number;
  objectFound: boolean;
}

function getModelUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_MEASUREMENT_RECOGNITION_MODEL_URL) ||
    (window as unknown as { __MEASUREMENT_RECOGNITION_MODEL__?: string }).__MEASUREMENT_RECOGNITION_MODEL__
  );
}

let model: tf.GraphModel | null = null;

function toGrayscale(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const pi = i * 4;
    gray[i] = Math.round(0.299 * data[pi] + 0.587 * data[pi + 1] + 0.114 * data[pi + 2]);
  }
  return gray;
}

function computeIntegralImage(gray: Uint8Array, w: number, h: number): Int32Array {
  const integral = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < w; x++) {
      sum += gray[y * w + x];
      integral[(y + 1) * (w + 1) + (x + 1)] = sum + integral[y * (w + 1) + (x + 1)];
    }
  }
  return integral;
}

function adaptiveThreshold(gray: Uint8Array, w: number, h: number, blockSize: number, C: number): Uint8Array {
  const integral = computeIntegralImage(gray, w, h);
  const half = Math.floor(blockSize / 2);
  const result = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half);
      const y1 = Math.max(0, y - half);
      const x2 = Math.min(w - 1, x + half);
      const y2 = Math.min(h - 1, y + half);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * (w + 1) + (x2 + 1)]
                - integral[y1 * (w + 1) + (x2 + 1)]
                - integral[(y2 + 1) * (w + 1) + x1]
                + integral[y1 * (w + 1) + x1];
      const mean = sum / count;
      result[y * w + x] = gray[y * w + x] > (mean - C) ? 255 : 0;
    }
  }
  return result;
}

function findLargestComponentBounds(binary: Uint8Array, w: number, h: number): { topY: number; bottomY: number; area: number } | null {
  const visited = new Uint8Array(w * h);
  let bestArea = 0;
  let bestTopY = h;
  let bestBottomY = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x] === 0 || visited[y * w + x] === 1) continue;

      const stack: number[] = [y * w + x];
      visited[y * w + x] = 1;
      let area = 0;
      let minY = y;
      let maxY = y;

      while (stack.length > 0) {
        const idx = stack.pop()!;
        const py = Math.floor(idx / w);
        const px = idx % w;
        area++;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;

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

      if (area > bestArea) {
        bestArea = area;
        bestTopY = minY;
        bestBottomY = maxY;
      }
    }
  }

  if (bestArea === 0) return null;
  return { topY: bestTopY, bottomY: bestBottomY, area: bestArea };
}

function heuristicSegmentation(roiImageData: ImageData): SegmentationResult {
  const { width, height } = roiImageData;
  const gray = toGrayscale(roiImageData);
  const blockSize = Math.max(3, Math.min(width, height) / 8);
  const c = 10;
  const binary = adaptiveThreshold(gray, width, height, Math.round(blockSize) | 1, c);
  const bounds = findLargestComponentBounds(binary, width, height);

  if (!bounds || bounds.area < width * height * 0.01) {
    return {
      mask: null,
      topY: 0,
      bottomY: height,
      confidence: 0,
      objectFound: false,
    };
  }

  const solidity = bounds.area / ((bounds.bottomY - bounds.topY + 1) * width);
  const confidence = Math.min(1, solidity * 2) * Math.min(1, (bounds.bottomY - bounds.topY) / (height * 0.3));

  return {
    mask: null,
    topY: bounds.topY,
    bottomY: bounds.bottomY,
    confidence,
    objectFound: true,
  };
}

export async function runSegmentation(roiImageData: ImageData): Promise<SegmentationResult> {
  if (typeof window === 'undefined') {
    return { mask: null, topY: 0, bottomY: 0, confidence: 0, objectFound: false };
  }

  const modelUrl = getModelUrl();

  if (!modelUrl) {
    return heuristicSegmentation(roiImageData);
  }

  try {
    if (!model) {
      model = await tf.loadGraphModel(modelUrl);
    }

    const result = tf.tidy(() => {
      const tensor = tf.browser
        .fromPixels(roiImageData, 3)
        .resizeBilinear([224, 224])
        .expandDims(0)
        .toFloat()
        .div(255.0);
      const prediction = model!.predict(tensor) as tf.Tensor;
      return prediction.dataSync();
    });

    const maskSize = 224;
    const mask = new Uint8Array(maskSize * maskSize);
    let topY = maskSize;
    let bottomY = 0;
    const threshold = 0.5;

    for (let i = 0; i < result.length && i < maskSize * maskSize; i++) {
      const val = result[i] > threshold ? 255 : 0;
      mask[i] = val;
      if (val === 255) {
        const py = Math.floor(i / maskSize);
        if (py < topY) topY = py;
        if (py > bottomY) bottomY = py;
      }
    }

    if (bottomY < topY) {
      return heuristicSegmentation(roiImageData);
    }

    const scaleY = roiImageData.height / maskSize;
    const objectFound = true;
    const foregroundCount = mask.reduce((s, v) => s + (v === 255 ? 1 : 0), 0);
    const confidence = Math.min(1, foregroundCount / (maskSize * maskSize * 0.3));

    return {
      mask: null,
      topY: Math.round(topY * scaleY),
      bottomY: Math.round(bottomY * scaleY),
      confidence,
      objectFound,
    };
  } catch (error) {
    console.error('Segmentation model error, falling back to heuristic:', error);
    return heuristicSegmentation(roiImageData);
  }
}
