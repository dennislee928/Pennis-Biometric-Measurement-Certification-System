'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAverageLuminance,
  getBlurScore,
  getMeasurementRoi,
  validateMeasurementRegion,
  type MeasurementResult,
} from '@/lib/measurementEngine';
import { RotationTracker, type RotationState } from '@/lib/rotationTracker';
import { RotationGuide } from '@/components/RotationGuide';
import { runRecognitionModel } from '@/lib/measurementVerification';
import { useI18n } from '@/lib/i18n/context';
import { Camera, AlertCircle, Loader2 } from 'lucide-react';

const ROTATION_TIMEOUT_MS = 5000;
const ROTATION_FRAME_INTERVAL_MS = 150;

export type CaptureState = 'idle' | 'live' | 'captured' | 'error';
export type LivenessPhase = 'idle' | 'rotating' | 'timeout';

export interface CameraCaptureProps {
  onCapture?: (imageData: ImageData, live: boolean) => void;
  onMeasurementReady?: (result: MeasurementResult) => void;
  referenceFrameWidthRatio?: number;
  passportAspect?: number;
  enableBlur?: boolean;
  minLuminance?: number;
  minBlurScore?: number;
}

const DEFAULT_MIN_LUMINANCE = 40;
const DEFAULT_MIN_BLUR_SCORE = 2;

export function CameraCapture({
  onCapture,
  onMeasurementReady,
  referenceFrameWidthRatio = 0.25,
  passportAspect,
  enableBlur = true,
  minLuminance = DEFAULT_MIN_LUMINANCE,
  minBlurScore = DEFAULT_MIN_BLUR_SCORE,
}: CameraCaptureProps) {
  const { t } = useI18n();
  const frameAspect = passportAspect ?? 85.6 / 53.98;
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CaptureState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [envOk, setEnvOk] = useState<{ light: boolean; sharp: boolean }>({
    light: true,
    sharp: true,
  });
  const lastCheckRef = useRef<number>(0);
  const [livenessPhase, setLivenessPhase] = useState<LivenessPhase>('idle');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [rotationState, setRotationState] = useState<RotationState | null>(null);
  const [rotationDirection, setRotationDirection] = useState<'cw' | 'ccw'>('cw');
  const rotationTrackerRef = useRef<RotationTracker | null>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    setState('idle');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: 1280, height: 720 },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState('live');
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('camera.error');
      setError(msg);
      setState('error');
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      stopStream();
    };
  }, [startCamera, stopStream]);

  const checkEnvironment = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const luminance = getAverageLuminance(imageData);
    const blur = getBlurScore(imageData);
    setEnvOk({
      light: luminance >= minLuminance,
      sharp: blur >= minBlurScore,
    });
  }, [minLuminance, minBlurScore]);

  useEffect(() => {
    if (state !== 'live') return;
    const interval = setInterval(() => {
      if (Date.now() - lastCheckRef.current < 500) return;
      lastCheckRef.current = Date.now();
      checkEnvironment();
    }, 800);
    return () => clearInterval(interval);
  }, [state, checkEnvironment]);

  const startRotationChallenge = useCallback(() => {
    const direction = Math.random() > 0.5 ? 'cw' : 'ccw';
    setRotationDirection(direction);
    const tracker = new RotationTracker({
      direction,
      targetAngleDeg: 30,
      toleranceDeg: 10,
      timeoutMs: ROTATION_TIMEOUT_MS,
    });
    tracker.start();
    rotationTrackerRef.current = tracker;
    setRotationState(tracker.getState());
    setLivenessPhase('rotating');
    setValidationError(null);
  }, []);

  useEffect(() => {
    if (livenessPhase !== 'rotating') return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frameId: number;
    const startTime = Date.now();
    let lastProcessTime = 0;

    const tick = () => {
      if (!video || !canvas || video.readyState < 2) {
        frameId = requestAnimationFrame(tick);
        return;
      }

      const now = Date.now();
      if (now - lastProcessTime < ROTATION_FRAME_INTERVAL_MS) {
        frameId = requestAnimationFrame(tick);
        return;
      }
      lastProcessTime = now;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0);
      const fullImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const roi = getMeasurementRoi(fullImageData);

      if (now - startTime > ROTATION_TIMEOUT_MS) {
        setLivenessPhase('timeout');
        rotationTrackerRef.current?.reset();
        return;
      }

      const tracker = rotationTrackerRef.current;
      if (!tracker) return;

      const s = tracker.track(roi);
      setRotationState(s);

      if (s.phase === 'complete') {
        const validation = validateMeasurementRegion(fullImageData);
        if (!validation.valid) {
          setValidationError(t('validation.regionInvalid'));
          setLivenessPhase('idle');
          rotationTrackerRef.current?.reset();
          return;
        }
        runRecognitionModel(getMeasurementRoi(fullImageData)).then((result) => {
          if (!result.recognized) {
            setValidationError(t('validation.regionInvalid'));
            setLivenessPhase('idle');
            rotationTrackerRef.current?.reset();
            return;
          }
          onCapture?.(fullImageData, true);
          setState('captured');
          setLivenessPhase('idle');
          rotationTrackerRef.current?.reset();
        });
        return;
      }

      if (s.phase === 'failed') {
        setLivenessPhase('timeout');
        rotationTrackerRef.current?.reset();
        return;
      }

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [livenessPhase, onCapture, t]);

  const handleCancelRotation = useCallback(() => {
    rotationTrackerRef.current?.reset();
    setRotationState(null);
    setLivenessPhase('idle');
  }, []);

  const handleLivenessRetry = useCallback(() => {
    setLivenessPhase('idle');
    setValidationError(null);
    setRotationState(null);
  }, []);

  const capture = useCallback(() => {
    startRotationChallenge();
  }, [startRotationChallenge]);

  const reset = useCallback(() => {
    setState('live');
    setLivenessPhase('idle');
    setValidationError(null);
    setRotationState(null);
  }, []);

  const w = 640;
  const h = 480;
  const refW = w * referenceFrameWidthRatio;
  const refLeft = (w - refW) / 2;
  const refTop = h * 0.15;
  const refBottom = refTop + refW * frameAspect;

  const measurementTopRatio = 0.48;
  const measurementHeightRatio = 0.35;
  const measurementWidthRatio = 0.5;
  const measurementLeft = (w - w * measurementWidthRatio) / 2;
  const measurementTop = h * measurementTopRatio;
  const measurementWidth = w * measurementWidthRatio;
  const measurementHeight = h * measurementHeightRatio;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative overflow-hidden rounded-xl bg-black" style={{ width: w, height: h }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${enableBlur ? 'sensitive-blur' : ''}`}
          style={{ transform: 'scaleX(-1)' }}
        />
        <canvas ref={canvasRef} className="hidden" />
        {state === 'live' && (
          <div className="camera-overlay">
            <div
              className="camera-overlay__frame"
              style={{
                left: refLeft,
                top: refTop,
                width: refW,
                height: refBottom - refTop,
              }}
            />
            <div
              className="camera-overlay__frame-measurement"
              style={{
                left: measurementLeft,
                top: measurementTop,
                width: measurementWidth,
                height: measurementHeight,
              }}
            />
            <div
              className="pointer-events-auto absolute left-2 top-2 flex gap-3 rounded-md bg-black/50 px-2.5 py-1 text-xs"
            >
              <span className={envOk.light ? 'text-green-400' : 'text-amber-400'}>
                {envOk.light ? t('camera.bright') : t('camera.dark')}
              </span>
              <span className={envOk.sharp ? 'text-green-400' : 'text-amber-400'}>
                {envOk.sharp ? t('camera.sharp') : t('camera.blur')}
              </span>
            </div>
            {livenessPhase !== 'rotating' && (
              <>
                <div
                  className="camera-overlay__hint"
                  style={{ left: 0, right: 0, top: refTop - 28 }}
                >
                  {t('reference.passportHint')}
                </div>
                <div
                  className="camera-overlay__hint"
                  style={{ left: 0, right: 0, top: measurementTop - 24 }}
                >
                  {t('reference.measurementFrameHint')}
                </div>
                <div
                  className="camera-overlay__hint"
                  style={{ left: 0, right: 0, bottom: 24 }}
                >
                  {t('reference.captureHint')}
                </div>
              </>
            )}
            {livenessPhase === 'rotating' && rotationState && (
              <RotationGuide
                state={rotationState}
                direction={rotationDirection}
                targetAngle={30}
                onCancel={handleCancelRotation}
              />
            )}
          </div>
        )}
      </div>

      {validationError && (
        <div className="w-full rounded-lg bg-amber-50 p-4 text-amber-900 text-sm">
          {validationError}
          <button
            type="button"
            onClick={() => setValidationError(null)}
            className="mt-2 block text-amber-700 underline"
          >
            {t('liveness.retry')}
          </button>
        </div>
      )}

      {state === 'live' && livenessPhase === 'idle' && !validationError && (
        <button
          type="button"
          onClick={capture}
          disabled={!envOk.light || !envOk.sharp}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-6 py-3 text-white transition hover:bg-emerald-700 disabled:opacity-50"
        >
          <Camera className="h-5 w-5" />
          {t('camera.capture')}
        </button>
      )}

      {state === 'live' && livenessPhase === 'rotating' && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="h-5 w-5 animate-spin" />
          {rotationState?.phase === 'complete'
            ? t('liveness.detected')
            : t('liveness.prompt')}
        </div>
      )}

      {state === 'live' && livenessPhase === 'timeout' && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-amber-700">{t('liveness.timeout')}</p>
          <button
            type="button"
            onClick={handleLivenessRetry}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            {t('liveness.retry')}
          </button>
        </div>
      )}

      {state === 'captured' && (
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-50"
        >
          {t('camera.retake')}
        </button>
      )}

      {state === 'error' && (
        <div className="flex items-center gap-2 rounded-lg bg-red-50 p-4 text-red-800">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <span>{error}</span>
          <button
            type="button"
            onClick={startCamera}
            className="ml-2 rounded bg-red-100 px-3 py-1 text-sm hover:bg-red-200"
          >
            {t('camera.retry')}
          </button>
        </div>
      )}

      {state === 'idle' && (
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t('camera.starting')}
        </div>
      )}
    </div>
  );
}
