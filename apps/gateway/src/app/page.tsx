import { LayoutDashboard, Activity, BookText } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import StatusCard from './_components/StatusCard';

// Render fresh so the status card reflects current state on every load;
// readPublicStatus has its own 15 s cache that keeps this cheap.
export const dynamic = 'force-dynamic';

const links = [
  {
    href: '/admin',
    icon: LayoutDashboard,
    title: 'Admin dashboard',
    description: 'Manage sessions, inspect message logs, and configure webhooks.',
  },
  {
    href: '/api/health',
    icon: Activity,
    title: 'Health check',
    description: 'Live status endpoint for the gateway and its upstream dependencies.',
  },
  {
    href: '/docs',
    icon: BookText,
    title: 'API documentation',
    description: 'Reference and integration guides for the HMD WA HTTP API.',
  },
];

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-20">
      <div className="w-full max-w-2xl space-y-10">
        {/* Wordmark */}
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-muted-foreground">
            HMD Developments
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">WA Gateway</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Self-hosted WhatsApp messaging gateway for HMD Developments.
          </p>
        </div>

        {/* Navigation cards (live status card sits alongside the rest) */}
        <div className="grid gap-3 sm:grid-cols-2">
          <StatusCard />
          {links.map(({ href, icon: Icon, title, description }) => (
            <a key={href} href={href} className="group block outline-none">
              <Card className="h-full transition-colors group-hover:border-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-primary" />
                    <CardTitle className="text-sm">{title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-xs">{description}</CardDescription>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>

        {/* Footer */}
        <p className="text-xs text-muted-foreground">Worldwide reach. Self-hosted core.</p>
      </div>
    </main>
  );
}
