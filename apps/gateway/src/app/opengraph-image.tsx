import { ImageResponse } from 'next/og';
import { OgCard, OG_SIZE, OG_ALT, OG_CONTENT_TYPE } from '@/lib/og-card';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="WhatsApp Messaging Gateway"
        title="Send WhatsApp messages over a simple HTTP API"
        subtitle="Self-hosted, hardened messaging gateway for HMD Developments."
      />
    ),
    { ...size },
  );
}
