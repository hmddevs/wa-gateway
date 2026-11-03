import type { ReactNode } from 'react';
import { Info, AlertTriangle, ShieldCheck, Lightbulb } from 'lucide-react';
import { cn } from '@/lib/utils';

type CalloutType = 'note' | 'warning' | 'security' | 'tip';

interface CalloutProps {
  type: CalloutType;
  title?: string;
  children: ReactNode;
}

const config: Record<
  CalloutType,
  { icon: typeof Info; border: string; bg: string; iconColour: string; titleColour: string }
> = {
  note: {
    icon: Info,
    border: 'border-primary/40',
    bg: 'bg-primary/5',
    iconColour: 'text-primary',
    titleColour: 'text-primary',
  },
  warning: {
    icon: AlertTriangle,
    border: 'border-amber-500/40',
    bg: 'bg-amber-500/5',
    iconColour: 'text-amber-500',
    titleColour: 'text-amber-600 dark:text-amber-400',
  },
  security: {
    icon: ShieldCheck,
    border: 'border-destructive/40',
    bg: 'bg-destructive/5',
    iconColour: 'text-destructive',
    titleColour: 'text-destructive',
  },
  tip: {
    icon: Lightbulb,
    border: 'border-green-500/40',
    bg: 'bg-green-500/5',
    iconColour: 'text-green-600 dark:text-green-400',
    titleColour: 'text-green-700 dark:text-green-300',
  },
};

export function Callout({ type, title, children }: CalloutProps) {
  const { icon: Icon, border, bg, iconColour, titleColour } = config[type];

  return (
    <div
      className={cn('my-5 flex gap-3 rounded-r-lg border-l-4 px-4 py-3.5 text-sm', border, bg)}
      role="note"
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconColour)} aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className={cn('mb-1 font-semibold leading-snug', titleColour)}>{title}</p>}
        <div className="text-foreground/80 [&_a]:text-primary [&_a:hover]:underline [&_p]:mb-0">
          {children}
        </div>
      </div>
    </div>
  );
}
