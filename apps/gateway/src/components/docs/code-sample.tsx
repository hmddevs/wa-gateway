import { getSingletonHighlighter } from 'shiki';
import { CodeTabs } from './code-tabs';
import { CopyButton } from './copy-button';

interface SampleTab {
  label: string;
  lang: string;
  code: string;
}

interface CodeSampleProps {
  samples: SampleTab[];
}

const SUPPORTED_LANGS = ['bash', 'json', 'typescript', 'http'] as const;
type SupportedLang = (typeof SUPPORTED_LANGS)[number];

function resolvedLang(lang: string): SupportedLang {
  return (SUPPORTED_LANGS as readonly string[]).includes(lang) ? (lang as SupportedLang) : 'bash';
}

/**
 * Server component. Highlights each sample with shiki and feeds the rendered
 * HTML into the client CodeTabs component. Content pages use this, not CodeBlock
 * directly, when they need a tabbed multi-language example.
 */
export async function CodeSample({ samples }: CodeSampleProps) {
  const highlighter = await getSingletonHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: ['bash', 'json', 'typescript', 'http'],
  });

  const tabs = samples.map((s) => {
    const lang = resolvedLang(s.lang);

    const lightHtml = highlighter.codeToHtml(s.code, {
      lang,
      theme: 'github-light',
    });

    const darkHtml = highlighter.codeToHtml(s.code, {
      lang,
      theme: 'github-dark',
    });

    // Tag the <code> element with a `language-<lang>` class (the ORIGINAL
    // sample label, e.g. "curl", not the shiki-tokeniser fallback) so the
    // /docs/*.md Markdown export (lib/docs-markdown.ts) can fence this block
    // with the right language via turndown's default fencedCodeBlock rule.
    const taggedLightHtml = lightHtml.replace('<code>', `<code class="language-${s.lang}">`);

    const content = (
      <div className="relative overflow-hidden rounded-b-lg border border-t-0 border-border bg-card text-sm">
        <div className="absolute right-2 top-2 z-10">
          <CopyButton code={s.code} />
        </div>
        {/* Light theme */}
        <div
          className="block dark:hidden overflow-x-auto [&>pre]:p-4 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-relaxed [&>pre]:bg-transparent!"
          // shiki output, server-generated, not user input
          dangerouslySetInnerHTML={{ __html: taggedLightHtml }}
        />
        {/* Dark theme, excluded from the /docs/*.md Markdown export: it is a
            duplicate render of the same code, only the light variant above
            is converted. */}
        <div
          className="hidden dark:block overflow-x-auto [&>pre]:p-4 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-relaxed [&>pre]:bg-transparent!"
          data-md-skip="true"
          dangerouslySetInnerHTML={{ __html: darkHtml }}
        />
      </div>
    );

    return { label: s.label, content };
  });

  return <CodeTabs tabs={tabs} />;
}
