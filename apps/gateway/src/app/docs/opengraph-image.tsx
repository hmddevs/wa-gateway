import { ImageResponse } from 'next/og';
import { OgCard, OG_SIZE, OG_CONTENT_TYPE } from '@/lib/og-card';

export const alt = 'HMD WA Gateway API Documentation';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="API Documentation"
        title="HMD WA Gateway API reference"
        subtitle="Reference and integration guides for the HTTP API."
      />
    ),
    { ...size },
  );
}
