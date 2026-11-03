import type { ReactElement } from 'react';

/**
 * Shared Open Graph card renderer for the dynamic opengraph-image routes.
 * Rendered by `next/og` (Satori), so styling must stay inline and flex-based:
 * every element holding more than one child needs an explicit `display: 'flex'`.
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';
export const OG_ALT = 'HMD WA Gateway';

type OgCardProps = {
  eyebrow: string;
  title: string;
  subtitle: string;
};

export function OgCard({ eyebrow, title, subtitle }: OgCardProps): ReactElement {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 80,
        backgroundColor: '#0a0a0a',
        backgroundImage:
          'radial-gradient(1200px 600px at 12% -15%, rgba(37,99,235,0.35), transparent 60%)',
        color: '#fafafa',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 72,
            height: 72,
            borderRadius: 20,
            backgroundColor: 'rgba(37,99,235,0.15)',
            border: '1px solid rgba(37,99,235,0.4)',
          }}
        >
          <svg
            width="38"
            height="38"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#60a5fa"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 22, letterSpacing: 8, fontWeight: 600, color: '#9ca3af' }}>
            HMD
          </span>
          <span style={{ fontSize: 30, fontWeight: 600, marginTop: 2 }}>WA Gateway</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontSize: 26,
            fontWeight: 600,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: '#60a5fa',
          }}
        >
          {eyebrow}
        </span>
        <span
          style={{
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: -1.5,
            marginTop: 22,
            maxWidth: 980,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 32,
            lineHeight: 1.35,
            marginTop: 24,
            maxWidth: 900,
            color: '#a1a1aa',
          }}
        >
          {subtitle}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 26,
          color: '#71717a',
        }}
      >
        <span>wa.example.com</span>
        <span>Self-hosted WhatsApp API</span>
      </div>
    </div>
  );
}
