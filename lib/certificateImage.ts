import type { Locale } from '@/lib/i18n/types';
import { messages } from '@/lib/i18n/messages';

export interface CertificateImageData {
  holderName: string;
  lengthCm: number;
  issuedAt: string;
  inquiryId?: string;
}

const W = 600;
const H = 400;
const PAD = 40;
const LINE = 28;

/** Draw official seal/badge (circle with checkmark) on canvas context */
function drawSeal(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  ctx.save();
  ctx.strokeStyle = '#0d9488';
  ctx.fillStyle = 'rgba(13, 148, 136, 0.08)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#0f766e';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 4, 0, Math.PI * 2);
  ctx.stroke();
  // Checkmark
  const r = radius * 0.45;
  ctx.strokeStyle = '#0d9488';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.9, cy);
  ctx.lineTo(cx - r * 0.2, cy + r * 0.7);
  ctx.lineTo(cx + r * 0.85, cy - r * 0.7);
  ctx.stroke();
  ctx.restore();
}

/** Draw decorative certificate border (double frame) */
function drawCertificateBorder(ctx: CanvasRenderingContext2D): void {
  const inset = 8;
  const innerInset = 14;
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 3;
  ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(innerInset, innerInset, W - innerInset * 2, H - innerInset * 2);
}

export function generateCertificatePng(data: CertificateImageData, locale: Locale): string {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const dict = messages[locale];

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  drawCertificateBorder(ctx);

  // Subtle "OFFICIAL" watermark behind content (low opacity)
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 72px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(dict['cert.watermark'] ?? 'Dick Size Verified', W / 2, H / 2);
  ctx.restore();

  // Title area with underline
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(dict['cert.title'] ?? 'Biometric Measurement Certificate', W / 2, PAD + LINE);
  ctx.strokeStyle = '#0d9488';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W * 0.2, PAD + LINE + 14);
  ctx.lineTo(W * 0.8, PAD + LINE + 14);
  ctx.stroke();

  // Official seal (top-right)
  drawSeal(ctx, W - 70, 72, 36);

  ctx.font = '16px system-ui, sans-serif';
  ctx.textAlign = 'left';
  let y = PAD + LINE * 2.8;
  ctx.fillStyle = '#0f172a';
  ctx.fillText(`${dict['cert.holder'] ?? 'Holder'}: ${data.holderName || '—'}`, PAD, y);
  y += LINE;
  ctx.fillText(`${dict['cert.length'] ?? 'Length'}: ${data.lengthCm.toFixed(2)} cm`, PAD, y);
  y += LINE;
  ctx.fillText(`${dict['cert.issuedAt'] ?? 'Issued at'}: ${data.issuedAt}`, PAD, y);
  if (data.inquiryId) {
    y += LINE;
    ctx.fillText(`${dict['cert.inquiryId'] ?? 'Inquiry ID'}: ${data.inquiryId}`, PAD, y);
  }
  y = H - PAD - LINE;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  ctx.fillText(dict['cert.footer'] ?? 'On-device measurement. Identity verified via Persona.', W / 2, y);

  return canvas.toDataURL('image/png');
}

export function downloadCertificatePng(data: CertificateImageData, locale: Locale): void {
  const dataUrl = generateCertificatePng(data, locale);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `certificate-${Date.now()}.png`;
  a.click();
}
