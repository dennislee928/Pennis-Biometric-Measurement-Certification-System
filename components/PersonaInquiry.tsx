'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PersonaCallbacks {
  onComplete?: (payload: { inquiryId: string; status: string }) => void;
  onCancel?: (payload: { inquiryId?: string; sessionToken?: string }) => void;
  onError?: (error: unknown) => void;
}

declare global {
  interface Window {
    Persona?: {
      Client: new (config: {
        templateId: string;
        environment?: string;
        onReady?: () => void;
        onComplete?: (payload: { inquiryId: string; status: string }) => void;
        onCancel?: (payload: { inquiryId?: string; sessionToken?: string }) => void;
        onError?: (error: unknown) => void;
      }) => { open: () => void };
    };
  }
}

const PERSONA_SCRIPT = 'https://cdn.withpersona.com/dist/persona-v4.8.0.js';
// SRI hash for persona-v4.8.0.js — update when SDK version changes:
// integrity="sha256-..."

/**
 * Persona 身分驗證流程（Embedded Inquiry）
 * 載入 SDK 後回傳 open() 供按鈕觸發
 */
export function usePersonaInquiry(
  templateId: string,
  environment: 'sandbox' | 'production' = 'sandbox',
  callbacks: PersonaCallbacks = {}
) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<{ open: () => void } | null>(null);
  const { onComplete, onCancel, onError } = callbacks;

  const open = useCallback(() => {
    if (clientRef.current) clientRef.current.open();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !templateId) return;
    const existing = document.querySelector(`script[src="${PERSONA_SCRIPT}"]`);
    if (existing) {
      if (window.Persona?.Client) {
        try {
          const client = new window.Persona.Client({
            templateId,
            environment,
            onReady: () => setReady(true),
            onComplete: (p) => onComplete?.(p),
            onCancel: (p) => onCancel?.(p),
            onError: (e) => { setError(String(e)); onError?.(e); },
          });
          clientRef.current = client;
          setReady(true);
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Persona 初始化失敗');
        }
      }
      return;
    }
    const script = document.createElement('script');
    script.src = PERSONA_SCRIPT;
    script.async = true;
    script.crossOrigin = 'anonymous';
    // TODO: Replace with the actual SRI hash for persona-v4.8.0.js from
    //       https://cdn.withpersona.com/dist/persona-v4.8.0.js
    // script.integrity = 'sha256-...';
    script.onload = () => {
      if (!window.Persona?.Client) {
        setError('Persona SDK 載入失敗');
        return;
      }
      try {
        const client = new window.Persona.Client({
          templateId,
          environment,
          onReady: () => { setReady(true); setError(null); },
          onComplete: (p) => onComplete?.(p),
          onCancel: (p) => onCancel?.(p),
          onError: (e) => { setError(String(e)); onError?.(e); },
        });
        clientRef.current = client;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Persona 初始化失敗');
        onError?.(e);
      }
    };
    script.onerror = () => { setError('Persona 腳本載入失敗'); };
    document.body.appendChild(script);
    return () => {
      clientRef.current = null;
      setReady(false);
    };
  }, [templateId, environment, onComplete, onCancel, onError]);

  return { ready, error, open };
}
