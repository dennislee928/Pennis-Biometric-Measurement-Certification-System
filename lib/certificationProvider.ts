/**
 * 認證提供者：數位簽名與證書生成
 * 將 inquiry_id + measurement_result + timestamp 做 HMAC-SHA256 簽名
 */

import type { MeasurementResult } from './measurementEngine';

export interface CertificatePayload {
  inquiryId: string;
  measurement: MeasurementResult;
  issuedAt: string; // ISO8601
  nonce: string;
  signature: string;
}

/**
 * 使用 Web Crypto 做 HMAC-SHA256
 * 注意：前端僅用於「模擬/展示」；正式環境應由後端持密鑰簽名
 */
export async function signPayload(
  payload: string,
  secretKey: string
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(payload)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成認證證書 JSON
 * secretKey 實務上應由後端提供或透過安全通道取得，此處為示範用
 * @deprecated This function signs certificates on the frontend using HMAC-SHA256 and is
 *             for development/demonstration only. In production, all signing must happen
 *             server-side via POST /api/certificates.
 */
export async function createCertificate(
  inquiryId: string,
  measurement: MeasurementResult,
  secretKey: string
): Promise<CertificatePayload> {
  const issuedAt = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const payloadStr = [
    inquiryId,
    measurement.lengthCm.toFixed(2),
    measurement.timestamp.toString(),
    issuedAt,
    nonce,
  ].join('|');
  const signature = await signPayload(payloadStr, secretKey);
  return {
    inquiryId,
    measurement,
    issuedAt,
    nonce,
    signature,
  };
}

/**
 * 將證書轉為可下載的 JSON 檔案
 */
export function downloadCertificateAsJson(cert: CertificatePayload): void {
  if (process.env.NODE_ENV === 'development') {
    console.warn(
      '[certificationProvider] downloadCertificateAsJson: frontend certificate creation is for development only. ' +
        'In production, signatures must be created server-side.'
    );
  }
  const { signature: _sig, nonce: _nonce, ...rest } = cert;
  const blob = new Blob([JSON.stringify(rest, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `certification-${cert.inquiryId}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
