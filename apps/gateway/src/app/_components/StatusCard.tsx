/**
 * Homepage status card: a grid card matching the navigation cards (icon +
 * title header, value in the body) that links through to the full /status
 * page. Server component; data comes from the shared public-status helper
 * (readPublicStatus, cached). Renders a safe "down" state if unreachable.
 */
import Link from 'next/link';
import { Gauge } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { overallState, STATE_DOT, STATE_LABEL, STATE_TEXT } from '@/lib/status-display';
import { readPublicStatus } from '@/lib/status-service';

export default async function StatusCard() {
  const overall = overallState(await readPublicStatus());

  return (
    <Link href="/status" className="group block outline-none" aria-label="View service status">
      <Card className="h-full transition-colors group-hover:border-primary/50 group-focus-visible:ring-2 group-focus-visible:ring-ring">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm">Service status</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-xs">
            {/* Live dot: a gentle pulse only when fully operational. */}
            <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
              {overall === 'operational' && (
                <span
                  className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${STATE_DOT[overall]}`}
                />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${STATE_DOT[overall]}`} />
            </span>
            <span className={`font-medium ${STATE_TEXT[overall]}`}>{STATE_LABEL[overall]}</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
