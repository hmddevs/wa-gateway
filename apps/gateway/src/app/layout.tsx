import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Toaster } from '@/components/ui/sonner';
import { env } from '@/lib/env';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(env.GATEWAY_PUBLIC_URL || 'https://wa.example.com'),
  title: 'HMD WA Gateway',
  description: 'Self-hosted WhatsApp messaging gateway for HMD Developments.',
  robots: { index: false, follow: false },
  // og:title / og:description are left unset so Next inherits each page's
  // own title and description; the image comes from opengraph-image.tsx.
  openGraph: {
    type: 'website',
    siteName: 'HMD WA Gateway',
    url: '/',
    locale: 'en_GB',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en-GB"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
