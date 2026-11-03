import { getSingletonHighlighter } from 'shiki';
import { cn } from '@/lib/utils';
import { CopyButton } from './copy-button';

interface CodeBlockProps {
  code: string;
  lang: string;
  title?: string;
  className?: string;
}

export async function CodeBlock({ code, lang, title, className }: CodeBlockProps) {
  const highlighter = await getSingletonHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: ['bash', 'json', 'typescript', 'http'],
  });

  // Normalise unknown langs to plaintext to avoid shiki errors
  const resolvedLang = (['bash', 'json', 'typescript', 'http'] as string[]).includes(lang)
    ? lang
    : 'bash';

  const lightHtml = highlighter.codeToHtml(code, {
    lang: resolvedLang,
    theme: 'github-light',
  });

  const darkHtml = highlighter.codeToHtml(code, {
    lang: resolvedLang,
    theme: 'github-dark',
  });

  // Tag the <code> element with a `language-<lang>` class (the original,
  // pre-fallback `lang` prop, e.g. "text", not shiki's "bash" tokeniser
  // fallback) so the /docs/*.md Markdown export (lib/docs-markdown.ts) can
  // fence this block with the right language. Turndown's default
  // fencedCodeBlock rule reads this class directly; purely additive, no
  // visual effect.
  const taggedLightHtml = lightHtml.replace('<code>', `<code class="language-${lang}">`);

  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-card text-sm',
        className,
      )}
    >
      {/* Optional title bar */}
      {title && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="font-mono text-xs text-muted-foreground">{title}</span>
          <CopyButton code={code} />
        </div>
      )}

      {/* Copy button when no title bar */}
      {!title && (
        <div className="absolute right-2 top-2 z-10">
          <CopyButton code={code} />
        </div>
      )}

      {/* Light theme, hidden in dark mode */}
      <div
        className="block dark:hidden overflow-x-auto [&>pre]:p-4 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-relaxed [&>pre]:bg-transparent!"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: taggedLightHtml }}
      />

      {/* Dark theme, shown in dark mode. Excluded from the /docs/*.md
          Markdown export: it is a duplicate render of the same code, only
          the light variant above is converted. */}
      <div
        className="hidden dark:block overflow-x-auto [&>pre]:p-4 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-relaxed [&>pre]:bg-transparent!"
        data-md-skip="true"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: darkHtml }}
      />
    </div>
  );
}
