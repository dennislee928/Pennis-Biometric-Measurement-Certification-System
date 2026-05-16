'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { initTfBackend } from '@/lib/tfBackend';
import {
  computePPMFromPassport,
  getMeasurementRoi,
  measureLengthFromRegion,
  perspectiveWarp,
  sleep,
  type MeasurementResult,
  type Point2D,
} from '@/lib/measurementEngine';
import { detectPassportCorners } from '@/lib/passportDetector';
import { runSegmentation } from '@/lib/segmentationModel';
import { downloadCertificateAsJson, type CertificatePayload } from '@/lib/certificationProvider';
import { downloadCertificatePng } from '@/lib/certificateImage';
import { generateCertificatePdf } from '@/lib/certificatePdf';
import { issueCertificate, submitCollection } from '@/lib/api';
import { useAuth } from '@/lib/useAuth';
import { getSupabase } from '@/lib/supabase';
import { useI18n } from '@/lib/i18n/context';
import { CameraCapture } from '@/components/CameraCapture';
import { usePersonaInquiry } from '@/components/PersonaInquiry';
import { Shield, Download, Loader2, CheckCircle, Menu, X } from 'lucide-react';
import Link from 'next/link';

const REFERENCE_FRAME_WIDTH_RATIO = 0.25;
/** Passport closed: 88mm x 125mm → height/width = 125/88 */
const PASSPORT_ASPECT = 125 / 88;

function getPassportCornersFromOverlay(videoWidth: number, videoHeight: number): [Point2D, Point2D, Point2D, Point2D] {
  const refW = videoWidth * REFERENCE_FRAME_WIDTH_RATIO;
  const refLeft = (videoWidth - refW) / 2;
  const refTop = videoHeight * 0.15;
  const refH = refW * PASSPORT_ASPECT;
  return [
    { x: refLeft, y: refTop },
    { x: refLeft + refW, y: refTop },
    { x: refLeft + refW, y: refTop + refH },
    { x: refLeft, y: refTop + refH },
  ];
}

async function runMeasurement(
  imageData: ImageData,
  liveCaptured: boolean,
  captureAdditionalFrame?: () => ImageData | null
): Promise<MeasurementResult | null> {
  const { width, height } = imageData;

  const refW = width * REFERENCE_FRAME_WIDTH_RATIO;
  const refLeft = (width - refW) / 2;
  const refTop = height * 0.15;
  const refH = refW * PASSPORT_ASPECT;
  const searchRegion = {
    left: Math.floor(refLeft),
    top: Math.floor(refTop),
    width: Math.floor(refW),
    height: Math.floor(refH),
  };

  const passport = detectPassportCorners(imageData, searchRegion);

  if (passport && passport.confidence > 0.5) {
    const ppm = computePPMFromPassport(passport.corners);

    if (ppm > 0) {
      const frames: ImageData[] = [imageData];
      for (let i = 0; i < 4; i++) {
        await sleep(100);
        const frame = captureAdditionalFrame?.();
        if (frame) frames.push(frame);
      }

      const lengths: number[] = [];
      for (const frame of frames) {
        const warped = perspectiveWarp(frame, passport.corners);
        const roi = getMeasurementRoi(warped);
        const seg = await runSegmentation(roi);
        if (seg.objectFound) {
          const lengthCm = (seg.bottomY - seg.topY) / ppm;
          lengths.push(lengthCm);
        }
      }

      if (lengths.length >= 3) {
        lengths.sort((a, b) => a - b);
        lengths.shift();
        lengths.pop();
        const avg = lengths.reduce((s, v) => s + v, 0) / lengths.length;
        const std = Math.sqrt(lengths.reduce((s, v) => s + (v - avg) ** 2, 0) / lengths.length);

        if (std > 0.5) {
          console.warn('Measurement unstable, std > 0.5cm');
          return null;
        }

        return {
          lengthCm: avg,
          ppm,
          timestamp: Date.now(),
          liveCaptured,
        };
      }
    }
  }

  console.warn('No passport detected, using fallback measurement');
  const fallbackCorners = getPassportCornersFromOverlay(width, height);
  const fallbackPpm = computePPMFromPassport(fallbackCorners);
  if (fallbackPpm <= 0) return null;
  const targetRegionHeightPx = height * 0.35;
  return measureLengthFromRegion(targetRegionHeightPx, fallbackPpm, liveCaptured);
}

function roiImageDataToPngBlob(roi: ImageData): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = roi.width;
    canvas.height = roi.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas context unavailable'));
      return;
    }
    ctx.putImageData(roi, 0, 0);
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

export default function MeasurePage() {
  const { t, locale } = useI18n();
  const [ageVerified, setAgeVerified] = useState(() => {
    if (typeof window === 'undefined') return false;
    return sessionStorage.getItem('age_verified') === 'true';
  });
  const [ageCheckbox, setAgeCheckbox] = useState(false);
  const [contentCheckbox, setContentCheckbox] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [step, setStep] = useState<'camera' | 'measure' | 'verify' | 'cert'>('camera');
  const [measurement, setMeasurement] = useState<MeasurementResult | null>(null);
  const [certificate, setCertificate] = useState<CertificatePayload | null>(null);
  const [inquiryId, setInquiryId] = useState<string | null>(null);
  const [holderName, setHolderName] = useState('');
  const [collectionConsent, setCollectionConsent] = useState(false);
  const [collectionSending, setCollectionSending] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);
  const [collectionDone, setCollectionDone] = useState(false);
  const lastCapturedRef = useRef<ImageData | null>(null);

  useEffect(() => {
    initTfBackend().catch(() => {});
  }, []);

  const handleCapture = useCallback(async (imageData: ImageData, live: boolean) => {
    lastCapturedRef.current = new ImageData(
      new Uint8ClampedArray(imageData.data),
      imageData.width,
      imageData.height
    );

    const tempCanvas = document.createElement('canvas');
    const videoEl = document.querySelector('video');
    const captureFrame = (): ImageData | null => {
      if (!videoEl || videoEl.readyState < 2) return null;
      tempCanvas.width = videoEl.videoWidth;
      tempCanvas.height = videoEl.videoHeight;
      const ctx = tempCanvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(videoEl, 0, 0);
      return ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    };

    const result = await runMeasurement(imageData, live, captureFrame);
    if (result) {
      setMeasurement(result);
      setStep('measure');
      setCollectionDone(false);
      setCollectionError(null);
    }
  }, []);

  const { ready: personaReady, error: personaError, open: openPersona } = usePersonaInquiry(
    process.env.NEXT_PUBLIC_PERSONA_TEMPLATE_ID || 'itmpl_placeholder',
    (process.env.NEXT_PUBLIC_PERSONA_ENV as 'sandbox' | 'production') || 'sandbox',
    {
      onComplete: ({ inquiryId: id }) => {
        setInquiryId(id);
        setStep('cert');
      },
      onError: () => {},
    }
  );

  const { session, accessToken } = useAuth();
  const [certError, setCertError] = useState<string | null>(null);

  const handleStartVerification = useCallback(() => {
    setStep('verify');
    openPersona();
  }, [openPersona]);

  const handleDownloadCert = useCallback(async () => {
    if (!inquiryId || !measurement) return;
    if (!accessToken) return;
    setCertError(null);
    try {
      const cert = await issueCertificate(accessToken, inquiryId, measurement);
      setCertificate(cert);
      downloadCertificateAsJson(cert as CertificatePayload);
      confetti({ particleCount: 80, spread: 60 });
    } catch (e) {
      setCertError(e instanceof Error ? e.message : t('error.issueFailed'));
    }
  }, [inquiryId, measurement, accessToken, t]);

  const certData = measurement
    ? {
        holderName,
        lengthCm: measurement.lengthCm,
        issuedAt: certificate?.issuedAt ?? new Date().toISOString(),
        inquiryId: inquiryId ?? undefined,
      }
    : null;

  const handleDownloadPng = useCallback(() => {
    if (!certData) return;
    downloadCertificatePng(certData, locale);
  }, [certData, locale]);

  const handleDownloadPdf = useCallback(() => {
    if (!certData) return;
    generateCertificatePdf(certData, locale);
  }, [certData, locale]);

  const handleSubmitCollection = useCallback(
    async (label: 'recognized' | 'not_recognized') => {
      const full = lastCapturedRef.current;
      if (!full) return;
      setCollectionSending(true);
      setCollectionError(null);
      try {
        const roi = getMeasurementRoi(full);
        const blob = await roiImageDataToPngBlob(roi);
        await submitCollection(blob, label);
        setCollectionDone(true);
      } catch (e) {
        setCollectionError(e instanceof Error ? e.message : 'Upload failed');
      } finally {
        setCollectionSending(false);
      }
    },
    []
  );

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
      <nav className="mx-auto mb-6 flex max-w-2xl items-center justify-between text-sm">
        <Link href="/" className="text-slate-600 hover:text-slate-900">{t('nav.home')}</Link>
        <button
          type="button"
          className="md:hidden p-1 text-slate-600 hover:text-slate-900"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        >
          {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <div className="hidden md:flex items-center gap-4">
          <Link href="/verify" className="text-slate-600 hover:text-slate-900">{t('nav.verify')}</Link>
          <Link href="/certificates" className="text-slate-600 hover:text-slate-900">{t('nav.myCerts')}</Link>
          {session ? (
            <>
              <span className="text-slate-500">{session.user?.email}</span>
              <button type="button" onClick={() => getSupabase().auth.signOut()} className="text-slate-600 hover:text-slate-900">{t('nav.logout')}</button>
            </>
          ) : (
            <Link href="/login" className="rounded bg-slate-800 px-3 py-1.5 text-white hover:bg-slate-700">{t('nav.login')}</Link>
          )}
        </div>
      </nav>
      {mobileMenuOpen && (
        <div className="mx-auto mb-4 max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:hidden">
          <div className="flex flex-col gap-3 text-sm">
            <Link href="/verify" className="text-slate-600 hover:text-slate-900" onClick={() => setMobileMenuOpen(false)}>{t('nav.verify')}</Link>
            <Link href="/certificates" className="text-slate-600 hover:text-slate-900" onClick={() => setMobileMenuOpen(false)}>{t('nav.myCerts')}</Link>
            {session ? (
              <>
                <span className="text-slate-500">{session.user?.email}</span>
                <button type="button" onClick={() => { getSupabase().auth.signOut(); setMobileMenuOpen(false); }} className="text-left text-slate-600 hover:text-slate-900">{t('nav.logout')}</button>
              </>
            ) : (
              <Link href="/login" className="rounded bg-slate-800 px-3 py-1.5 text-center text-white hover:bg-slate-700" onClick={() => setMobileMenuOpen(false)}>{t('nav.login')}</Link>
            )}
          </div>
        </div>
      )}
      <div className="mx-auto max-w-2xl space-y-8">
        <header className="text-center">
          <h1 className="text-2xl font-bold text-slate-900">{t('welcome.title')}</h1>
          <p className="mt-2 text-sm text-slate-600">{t('welcome.subtitle')}</p>
        </header>

        {!ageVerified && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Age Verification</h2>
            <p className="mb-4 text-sm text-slate-600">This application contains sensitive content and is intended for adults only.</p>
            <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={ageCheckbox} onChange={(e) => setAgeCheckbox(e.target.checked)} className="rounded border-slate-300" />
              I am 18 years or older
            </label>
            <label className="mb-4 flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={contentCheckbox} onChange={(e) => setContentCheckbox(e.target.checked)} className="rounded border-slate-300" />
              I understand this contains sensitive content
            </label>
            <button
              type="button"
              disabled={!ageCheckbox || !contentCheckbox}
              onClick={() => {
                sessionStorage.setItem('age_verified', 'true');
                setAgeVerified(true);
              }}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Continue
            </button>
          </section>
        )}

        {ageVerified && step === 'camera' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('step1.title')}</h2>
            <p className="mb-4 text-sm text-slate-600">{t('step1.hint')}</p>
            <CameraCapture
              onCapture={handleCapture}
              referenceFrameWidthRatio={REFERENCE_FRAME_WIDTH_RATIO}
              passportAspect={PASSPORT_ASPECT}
              enableBlur={true}
            />
          </section>
        )}

        {step === 'measure' && measurement && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('step2.title')}</h2>
            <div className="mb-4 rounded-lg bg-slate-100 p-4">
              <p className="text-sm text-slate-600">{t('step2.length')}</p>
              <p className="text-2xl font-bold text-slate-900">
                {measurement.lengthCm.toFixed(2)} cm
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {t('step2.live')}: {measurement.liveCaptured ? t('step2.yes') : t('step2.no')} · PPM: {measurement.ppm.toFixed(1)}
              </p>
            </div>

            {/* 資料收集（選填）：參與改進辨識模型 */}
            <div className="mb-4 border-t border-slate-200 pt-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-800">協助改進辨識（選填）</h3>
              <p className="mb-3 text-xs text-slate-500">
                僅上傳當前擷取的測量區 ROI 圖與您選擇的標籤，用於改進「是否為真實目標」的辨識模型。可隨時略過。
              </p>
              <label className="mb-3 flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={collectionConsent}
                  onChange={(e) => setCollectionConsent(e.target.checked)}
                  className="rounded border-slate-300"
                />
                我同意將此張 ROI 圖與標籤用於模型改進（僅儲存於後端指定路徑，不另作他用）
              </label>
              {collectionConsent && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={collectionSending || collectionDone}
                    onClick={() => handleSubmitCollection('recognized')}
                    className="rounded border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    {collectionSending ? '上傳中…' : collectionDone ? '已送出' : '此張為真實'}
                  </button>
                  <button
                    type="button"
                    disabled={collectionSending || collectionDone}
                    onClick={() => handleSubmitCollection('not_recognized')}
                    className="rounded border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                  >
                    {collectionSending ? '上傳中…' : collectionDone ? '已送出' : '此張為非真實'}
                  </button>
                </div>
              )}
              {collectionError && <p className="mt-2 text-xs text-red-600">{collectionError}</p>}
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep('camera')}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                {t('step2.retake')}
              </button>
              <button
                type="button"
                onClick={handleStartVerification}
                disabled={!personaReady}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {personaReady ? (
                  <>
                    <Shield className="h-4 w-4" />
                    {t('step2.verify')}
                  </>
                ) : (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('step2.loading')}
                  </>
                )}
              </button>
            </div>
            {personaError && <p className="mt-2 text-sm text-amber-600">{personaError}</p>}
          </section>
        )}

        {step === 'verify' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('step3.title')}</h2>
            <p className="mb-4 text-sm text-slate-600">{t('step3.hint')}</p>
            <button
              type="button"
              onClick={openPersona}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
            >
              {t('step3.openAgain')}
            </button>
          </section>
        )}

        {step === 'cert' && measurement && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">{t('step4.title')}</h2>
            {inquiryId && (
              <p className="mb-4 text-sm text-slate-600">
                {t('step4.inquiryId')}: <code className="rounded bg-slate-100 px-1">{inquiryId}</code>
              </p>
            )}
            {accessToken && (
              <div className="mb-4 rounded-lg bg-emerald-50 p-4">
                <p className="flex items-center gap-2 text-emerald-800">
                  <CheckCircle className="h-5 w-5" />
                  {t('step4.certReady')}
                </p>
              </div>
            )}
            <div className="mb-4">
              <label htmlFor="holder-name" className="mb-1 block text-sm font-medium text-slate-700">
                {t('step4.holderName')}
              </label>
              <input
                id="holder-name"
                type="text"
                value={holderName}
                onChange={(e) => setHolderName(e.target.value)}
                placeholder={t('step4.holderNamePlaceholder')}
                className="w-full rounded border border-slate-300 px-3 py-2 text-slate-900 placeholder:text-slate-400"
              />
            </div>
            <div className="mb-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleDownloadPng}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-white hover:bg-slate-800"
              >
                <Download className="h-4 w-4" />
                {t('step4.downloadPng')}
              </button>
              <button
                type="button"
                onClick={handleDownloadPdf}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-white hover:bg-slate-800"
              >
                <Download className="h-4 w-4" />
                {t('step4.downloadPdf')}
              </button>
            </div>
            {accessToken ? (
              <>
                {certError && <p className="mb-2 text-sm text-red-600">{certError}</p>}
                <button
                  type="button"
                  onClick={handleDownloadCert}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
                >
                  <Download className="h-4 w-4" />
                  {t('step4.downloadJson')}
                </button>
              </>
            ) : (
              <div className="rounded-lg bg-amber-50 p-4 text-amber-800">
                <p className="mb-2">{t('step4.loginRequiredJson')}</p>
                <Link href="/login" className="text-sm font-medium underline">{t('step4.goLogin')}</Link>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
