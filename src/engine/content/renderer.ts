/**
 * Handlebars + MJML rendering. Ports the render half of `template-engine.ts`
 * (1,181 LOC, split here per the plan's 500-line rule).
 *
 * THREE CHANGES FROM THE SOURCE:
 *
 *  1. **An isolated Handlebars environment.** The source calls
 *     `Handlebars.registerHelper(...)` on the imported singleton
 *     (`template-engine.ts:163-253`), mutating global state shared by every
 *     consumer in the process. Two engines with different helpers silently
 *     fight, and test order starts to matter. `Handlebars.create()` gives this
 *     renderer its own environment.
 *
 *  2. **`formatDate` respects tenant locale and timezone.** The source calls
 *     `d.toLocaleDateString()` with no locale and no timezone
 *     (`template-engine.ts:174-189`), so every date renders in the *server's*
 *     locale and zone. For a multi-tenant service whose tenants carry `timezone`
 *     and `locale` columns, that is the same class of bug as storing naked
 *     `timestamp` — a New York clinic's 9am reads as 6am if the pod runs in UTC…
 *     or in whatever zone the node happens to have.
 *
 *  3. **Unknown variables render empty, never `undefined`.** Handlebars already
 *     does this for missing paths, but `strict: false` plus an explicit empty
 *     `helperMissing` makes it true for helper-shaped misses too. Nobody should
 *     ever receive an email containing the word "undefined".
 */
import Handlebars from 'handlebars';
import mjml2html from 'mjml';
import type { Logger } from 'winston';

import { ValidationError } from '../../platform/http/errors.js';
import { applyAliases, type AliasMap, type RenderContext } from './render-context.js';

export type TemplateFormat = 'TEXT' | 'HTML' | 'MARKDOWN' | 'MJML';

export interface RenderOptions {
  format?: TemplateFormat;
  /** MJML only. */
  minify?: boolean;
  validateMarkup?: boolean;
  aliases?: AliasMap;
}

export interface RenderResult {
  output: string;
  format: TemplateFormat;
  warnings: string[];
}

export interface RendererDeps {
  logger: Logger;
  /** Pack-level alias maps, keyed by pack id. Loaded once at boot. */
  aliases?: Record<string, AliasMap>;
}

export class Renderer {
  private readonly hbs: typeof Handlebars;
  private readonly compiled = new Map<string, HandlebarsTemplateDelegate>();
  private static readonly MAX_COMPILED = 500;

  constructor(private readonly deps: RendererDeps) {
    this.hbs = Handlebars.create();
    this.registerHelpers();
  }

  aliasesFor(packId?: string | null): AliasMap {
    if (!packId) return {};
    return this.deps.aliases?.[packId] ?? {};
  }

  private registerHelpers(): void {
    const hbs = this.hbs;

    /**
     * `{{formatDate date "long" }}` — locale and zone come from the render
     * context (recipient first, then tenant), not from the server.
     */
    hbs.registerHelper(
      'formatDate',
      function (this: unknown, date: unknown, format: unknown): string {
        if (!date) return '';
        const d = date instanceof Date ? date : new Date(String(date));
        if (Number.isNaN(d.getTime())) return '';

        const root = (this ?? {}) as Partial<RenderContext>;
        const locale =
          root.recipient?.locale ?? root.tenant?.locale ?? undefined;
        const timeZone =
          root.recipient?.timezone ?? root.tenant?.timezone ?? undefined;
        const base: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
        const style = typeof format === 'string' ? format : 'default';

        switch (style) {
          case 'short':
            return d.toLocaleDateString(locale, base);
          case 'long':
            return d.toLocaleDateString(locale, {
              ...base,
              weekday: 'long',
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            });
          case 'time':
            return d.toLocaleTimeString(locale, base);
          case 'datetime':
            return d.toLocaleString(locale, base);
          case 'iso':
            return d.toISOString();
          default:
            return d.toLocaleString(locale, base);
        }
      },
    );

    // Ported verbatim — the medspa templates use every operator.
    hbs.registerHelper(
      'ifCond',
      function (this: unknown, v1: unknown, operator: unknown, v2: unknown, options: Handlebars.HelperOptions) {
        const truth = ((): boolean => {
          switch (operator) {
            /* eslint-disable eqeqeq */
            case '==': return v1 == v2;
            case '!=': return v1 != v2;
            /* eslint-enable eqeqeq */
            case '===': return v1 === v2;
            case '!==': return v1 !== v2;
            case '<': return (v1 as number) < (v2 as number);
            case '<=': return (v1 as number) <= (v2 as number);
            case '>': return (v1 as number) > (v2 as number);
            case '>=': return (v1 as number) >= (v2 as number);
            case '&&': return Boolean(v1 && v2);
            case '||': return Boolean(v1 || v2);
            default: return false;
          }
        })();
        return truth ? options.fn(this) : options.inverse(this);
      },
    );

    hbs.registerHelper('addTracking', (url: unknown, tracking: unknown): string => {
      const href = String(url ?? '');
      if (!tracking || typeof tracking !== 'object') return href;
      try {
        const parsed = new URL(href);
        const utm = tracking as Record<string, string | undefined>;
        const params: Array<[string, string | undefined]> = [
          ['utm_source', utm.utmSource],
          ['utm_medium', utm.utmMedium],
          ['utm_campaign', utm.utmCampaign],
          ['utm_content', utm.utmContent],
          ['utm_term', utm.utmTerm],
        ];
        for (const [key, value] of params) {
          if (value) parsed.searchParams.set(key, value);
        }
        return parsed.toString();
      } catch {
        // An un-parseable URL comes back untouched, as in the source.
        return href;
      }
    });

    hbs.registerHelper('json', (value: unknown): string => JSON.stringify(value));

    /**
     * `{{join list ". "}}` — flatten an array into a sentence.
     *
     * Added in P7 for parity: `enhanced-event-handler.ts:345-347` sends
     * `preparationSteps` as an array on email and `preparationSteps.join('. ')`
     * on SMS. Without this the two channels would need different payload
     * shapes, which is precisely the per-channel special-casing the playbook
     * runtime exists to remove. A non-array value passes through unchanged, so
     * a caller that already sent a string is unaffected.
     */
    hbs.registerHelper('join', (value: unknown, separator: unknown): string => {
      const sep = typeof separator === 'string' ? separator : ', ';
      if (Array.isArray(value)) return value.map((v) => String(v ?? '')).join(sep);
      return value === null || value === undefined ? '' : String(value);
    });

    hbs.registerHelper('substring', (text: unknown, start: unknown, length: unknown): string => {
      if (!text) return '';
      const s = Number(start) || 0;
      const l = Number(length) || 0;
      return String(text).substring(s, s + l);
    });

    // Never emit the literal string "undefined" into a message.
    hbs.registerHelper('helperMissing', () => '');
  }

  private compile(source: string, cacheKey?: string): HandlebarsTemplateDelegate {
    if (cacheKey) {
      const hit = this.compiled.get(cacheKey);
      if (hit) return hit;
    }
    let template: HandlebarsTemplateDelegate;
    try {
      template = this.hbs.compile(source, { strict: false, noEscape: false });
    } catch (error) {
      throw new ValidationError('Template failed to compile', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (cacheKey) {
      if (this.compiled.size >= Renderer.MAX_COMPILED) {
        const oldest = this.compiled.keys().next().value;
        if (oldest !== undefined) this.compiled.delete(oldest);
      }
      this.compiled.set(cacheKey, template);
    }
    return template;
  }

  /** Render a raw template body against a context. */
  async render(
    source: string,
    context: RenderContext,
    options: RenderOptions = {},
  ): Promise<RenderResult> {
    const format = options.format ?? 'TEXT';
    const warnings: string[] = [];

    const aliased = applyAliases(source, options.aliases ?? {});
    const template = this.compile(aliased);

    let output: string;
    try {
      output = template(context);
    } catch (error) {
      throw new ValidationError('Template failed to render', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (format === 'MJML') {
      const result = await mjml2html(output, {
        minify: options.minify ?? false,
        validationLevel: options.validateMarkup ? 'strict' : 'skip',
      });
      if (result.errors?.length) {
        for (const err of result.errors) warnings.push(err.message);
        this.deps.logger.warn('mjml validation warnings', {
          count: result.errors.length,
          first: result.errors[0]?.message,
        });
      }
      return { output: result.html, format, warnings };
    }

    return { output, format, warnings };
  }

  /** Which variables a template references — powers `templates.variables`. */
  extractVariables(source: string, aliases: AliasMap = {}): string[] {
    const aliased = applyAliases(source, aliases);
    const found = new Set<string>();
    const BLOCK_HELPERS = new Set(['if', 'unless', 'each', 'with', 'else', 'ifCond', 'log']);

    for (const match of aliased.matchAll(/\{\{\{?[#/]?\s*([^}\s]+)/g)) {
      const token = match[1];
      if (!token) continue;
      const name = token.replace(/^[#/>^]/, '');
      if (!name || BLOCK_HELPERS.has(name) || name.startsWith('@')) continue;
      found.add(name);
    }
    return [...found].sort();
  }
}
