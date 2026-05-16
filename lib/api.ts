const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export async function issueCertificate(
  accessToken: string,
  inquiryId: string,
  measurement: { lengthCm: number; circumferenceCm?: number; ppm: number; timestamp: number; liveCaptured: boolean }
) {
  const res = await fetch(`${API_URL}/api/certificates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ inquiryId, measurement }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return res.json();
}

export async function listCertificates(accessToken: string) {
  const res = await fetch(`${API_URL}/api/certificates`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function getCertificate(accessToken: string, id: string) {
  const res = await fetch(`${API_URL}/api/certificates/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function deleteCertificate(accessToken: string, id: string) {
  const res = await fetch(`${API_URL}/api/certificates/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return res.json();
}

export async function verifyCertificate(cert: {
  inquiryId: string;
  measurement: { lengthCm: number; ppm: number; timestamp: number; liveCaptured: boolean };
  issuedAt: string;
  nonce: string;
  signature: string;
}) {
  const res = await fetch(`${API_URL}/api/certificates/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cert),
  });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

/** 上傳 ROI 圖與標籤至資料收集 API（需後端設定 COLLECTION_STORAGE_PATH） */
export async function submitCollection(
  imageBlob: Blob,
  label: 'recognized' | 'not_recognized'
): Promise<{ ok: boolean; path?: string }> {
  const form = new FormData();
  form.append('image', imageBlob, 'roi.png');
  form.append('label', label);
  const res = await fetch(`${API_URL}/api/collection`, {
    method: 'POST',
    body: form,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; ok?: boolean; path?: string };
  if (!res.ok) throw new Error(data.error || res.statusText);
  return { ok: data.ok ?? true, path: data.path };
}
