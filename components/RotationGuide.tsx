'use client';

import type { RotationState } from '@/lib/rotationTracker';
import { useI18n } from '@/lib/i18n/context';
import { X } from 'lucide-react';

interface RotationGuideProps {
  state: RotationState;
  direction: 'cw' | 'ccw';
  targetAngle: number;
  onCancel: () => void;
}

export function RotationGuide({
  state,
  direction,
  targetAngle,
  onCancel,
}: RotationGuideProps) {
  const { t } = useI18n();
  const progress = Math.min(state.accumulatedAngle / targetAngle, 1);
  const circumference = 2 * Math.PI * 85;
  const dashOffset = circumference * (1 - progress);
  const isWrong = state.phase === 'rotating' && !state.directionCorrect;
  const accentColor = isWrong ? '#ef4444' : '#22c55e';
  const textColor = isWrong ? 'text-red-400' : 'text-green-400';
  const bgColor = isWrong ? 'bg-red-500/20' : 'bg-green-500/20';
  const cw = direction === 'cw';

  return (
    <div className="pointer-events-auto absolute inset-0 z-10 flex select-none flex-col items-center justify-center gap-3 bg-black/40">
      <style>{`
        @keyframes arrowbob {
          0%, 100% { transform: rotate(0deg); }
          50% { transform: rotate(${cw ? '8' : '-8'}deg); }
        }
        .arrow-anim {
          animation: arrowbob 1.2s ease-in-out infinite;
        }
        @keyframes ringpulse {
          0%, 100% { opacity: 0.15; }
          50% { opacity: 0.35; }
        }
        .ring-pulse {
          animation: ringpulse 1.5s ease-in-out infinite;
        }
      `}</style>

      <div className={`rounded-full px-4 py-1 text-sm font-medium ${bgColor} ${textColor}`}>
        {isWrong
          ? t('rotation.wrongDirection')
          : cw
            ? t('rotation.direction.cw')
            : t('rotation.direction.ccw')}
      </div>

      <div className="arrow-anim">
        <svg viewBox="0 0 100 60" className="h-14 w-24" fill="none">
          <defs>
            <marker id="arw" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill={accentColor} />
            </marker>
          </defs>
          <path
            d={cw ? 'M 10 50 A 40 40 0 0 1 90 50' : 'M 90 50 A 40 40 0 0 1 10 50'}
            stroke={accentColor}
            strokeWidth="4"
            strokeLinecap="round"
            markerEnd="url(#arw)"
          />
        </svg>
      </div>

      <div className="relative">
        <svg viewBox="0 0 200 200" className="h-44 w-44">
          <circle
            cx="100"
            cy="100"
            r="85"
            fill="none"
            stroke={accentColor}
            strokeWidth="8"
            className="ring-pulse"
          />
          <circle
            cx="100"
            cy="100"
            r="85"
            fill="none"
            stroke={accentColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            transform="rotate(-90 100 100)"
            style={{ transition: 'stroke-dashoffset 0.15s ease-out' }}
          />
          <text
            x="100"
            y="92"
            textAnchor="middle"
            fontSize="32"
            fontWeight="bold"
            fill="white"
            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}
          >
            {Math.round(state.accumulatedAngle)}°
          </text>
          <text
            x="100"
            y="120"
            textAnchor="middle"
            fontSize="16"
            fill="rgba(255,255,255,0.6)"
          >
            / {targetAngle}°
          </text>
        </svg>
      </div>

      <p className="px-6 text-center text-sm text-white/80" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
        {t('rotation.hint')}
      </p>

      <button
        type="button"
        onClick={onCancel}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/30 bg-white/10 px-5 py-2 text-sm text-white backdrop-blur-sm transition hover:bg-white/20"
      >
        <X className="h-4 w-4" />
        {t('rotation.cancel')}
      </button>
    </div>
  );
}
