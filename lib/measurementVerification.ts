import * as tf from '@tensorflow/tfjs';

const MODEL_INPUT_SIZE = 224;
const RECOGNITION_CONFIDENCE_THRESHOLD = 0.8;

export interface RecognitionResult {
  recognized: boolean;
  confidence?: number;
}

function getModelUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return (
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_MEASUREMENT_RECOGNITION_MODEL_URL) ||
    (window as unknown as { __MEASUREMENT_RECOGNITION_MODEL__?: string }).__MEASUREMENT_RECOGNITION_MODEL__
  );
}

let model: tf.GraphModel | null = null;
let inferenceWorker: Worker | null = null;

function createInferenceWorker(): Worker | null {
  if (typeof window === 'undefined') return null;
  try {
    const worker = new Worker(new URL('./workers/inference.worker.ts', import.meta.url));
    return worker;
  } catch {
    return null;
  }
}

export async function runRecognitionModelInWorker(roiImageData: ImageData): Promise<RecognitionResult> {
  if (!inferenceWorker) {
    inferenceWorker = createInferenceWorker();
  }
  if (!inferenceWorker) {
    return runRecognitionModel(roiImageData);
  }

  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      inferenceWorker!.removeEventListener('message', handler);
      if (e.data.error) {
        console.error('Worker inference error:', e.data.error);
        resolve(runRecognitionModel(roiImageData));
        return;
      }
      resolve(e.data.result as RecognitionResult);
    };
    inferenceWorker.addEventListener('message', handler);
    inferenceWorker.postMessage({ imageData: roiImageData, type: 'recognition' }, [roiImageData.data.buffer]);
    setTimeout(() => {
      inferenceWorker.removeEventListener('message', handler);
      resolve(runRecognitionModel(roiImageData));
    }, 10000);
  });
}

export async function runRecognitionModel(roiImageData: ImageData): Promise<RecognitionResult> {
  if (typeof window === 'undefined') {
    return { recognized: true };
  }

  const modelUrl = getModelUrl();
  if (!modelUrl) {
    return { recognized: true };
  }

  try {
    if (!model) {
      model = await tf.loadGraphModel(modelUrl);
    }

    const result = tf.tidy(() => {
      const tensor = tf.browser
        .fromPixels(roiImageData, 3)
        .resizeBilinear([MODEL_INPUT_SIZE, MODEL_INPUT_SIZE])
        .expandDims(0)
        .toFloat()
        .div(255.0);
      const prediction = model!.predict(tensor) as tf.Tensor;
      return prediction.dataSync();
    });

    const confidence = result.length > 1 ? result[1] : result[0];
    const recognized = confidence > RECOGNITION_CONFIDENCE_THRESHOLD;

    return {
      recognized,
      confidence: Number(confidence),
    };
  } catch (error) {
    console.error('ML Inference Error:', error);
    return { recognized: false };
  }
}
