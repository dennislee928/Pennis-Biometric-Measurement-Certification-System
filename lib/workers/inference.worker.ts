let model: any = null;
let modelUrl: string | undefined;

function getModelUrl(): string | undefined {
  return (
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_MEASUREMENT_RECOGNITION_MODEL_URL) ||
    (typeof self !== 'undefined' &&
      (self as any).__MEASUREMENT_RECOGNITION_MODEL__)
  );
}

async function loadModel(): Promise<any> {
  const tf = await import('@tensorflow/tfjs');
  const url = modelUrl || getModelUrl();
  if (!url) return null;
  model = await tf.loadGraphModel(url);
  return model;
}

async function runSegmentation(imageData: ImageData): Promise<any> {
  const tf = await import('@tensorflow/tfjs');
  const tensor = tf.tidy(() => {
    return tf.browser
      .fromPixels(imageData, 3)
      .resizeBilinear([224, 224])
      .expandDims(0)
      .toFloat()
      .div(255.0);
  });
  const prediction = model!.predict(tensor) as any;
  const result = await prediction.data();
  tensor.dispose();
  prediction.dispose();
  return { segmentation: Array.from(result) };
}

async function runRecognition(imageData: ImageData): Promise<any> {
  const tf = await import('@tensorflow/tfjs');
  const tensor = tf.tidy(() => {
    return tf.browser
      .fromPixels(imageData, 3)
      .resizeBilinear([224, 224])
      .expandDims(0)
      .toFloat()
      .div(255.0);
  });
  const prediction = model!.predict(tensor) as any;
  const result = await prediction.data();
  tensor.dispose();
  prediction.dispose();
  const confidence = result.length > 1 ? result[1] : result[0];
  return {
    recognized: confidence > 0.8,
    confidence: Number(confidence),
  };
}

self.onmessage = async (e: MessageEvent<{ imageData: ImageData; type: 'segmentation' | 'recognition' }>) => {
  const { imageData, type } = e.data;
  try {
    if (!model) {
      await loadModel();
    }
    if (!model) {
      self.postMessage({ error: 'No model URL configured' });
      return;
    }
    let result: any;
    if (type === 'segmentation') {
      result = await runSegmentation(imageData);
    } else {
      result = await runRecognition(imageData);
    }
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : 'Unknown inference error' });
  }
};
