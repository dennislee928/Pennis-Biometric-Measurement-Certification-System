'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import type { Session } from '@supabase/supabase-js';

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'touchstart'] as const;

export function useAuth(timeoutMinutes = 30) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = getSupabase();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const resetTimer = useCallback(() => {
    clearTimer();
    if (!sessionRef.current) return;
    timerRef.current = setTimeout(async () => {
      try {
        await supabase.auth.signOut();
        alert('Session timed out due to inactivity.');
      } catch {
        alert('Session timed out due to inactivity.');
      }
    }, timeoutMinutes * 60 * 1000);
  }, [clearTimer, supabase.auth, timeoutMinutes]);

  const handleActivity = useCallback(() => {
    resetTimer();
  }, [resetTimer]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, [supabase.auth]);

  useEffect(() => {
    if (session) {
      resetTimer();
    } else {
      clearTimer();
    }
  }, [session, resetTimer, clearTimer]);

  useEffect(() => {
    ACTIVITY_EVENTS.forEach((event) => {
      window.addEventListener(event, handleActivity);
    });
    return () => {
      ACTIVITY_EVENTS.forEach((event) => {
        window.removeEventListener(event, handleActivity);
      });
      clearTimer();
    };
  }, [handleActivity, clearTimer]);

  return { session, loading, accessToken: session?.access_token ?? null };
}
