import { CandidateAppHostDisplayInfo } from './appHostDiscovery';

/**
 * Coarse AppHost language classification used for telemetry. We deliberately
 * collapse the per-AppHost language strings emitted by `aspire ls` (which can
 * include forms like `typescript/nodejs`) into a small, stable set so the
 * telemetry dimension is meaningful for cohorts without enumerating every
 * runtime variant.
 *
 *  - `csharp`     : every detected AppHost reports a C# variant.
 *  - `typescript` : every detected AppHost reports a TypeScript / Node variant.
 *  - `polyglot`   : at least one AppHost of each language family is present,
 *                   or an unknown language is mixed with a known one. This is
 *                   the headline signal Damian asked us to capture.
 *  - `unknown`    : we found AppHosts but couldn't classify any of them.
 *  - `none`       : no AppHosts were detected at all.
 */
export type AppHostLanguageSummary = 'csharp' | 'typescript' | 'polyglot' | 'unknown' | 'none';

/**
 * Normalizes a language string from `aspire ls --format json` to a coarse
 * family. Keep this list narrow — adding noisy buckets defeats the purpose of
 * the summary. Anything we don't recognize is grouped as `'other'` so that a
 * mixed workspace still reports `polyglot` rather than hiding the diversity.
 */
function languageFamily(raw: string | null | undefined): 'csharp' | 'typescript' | 'other' | undefined {
    if (!raw) {
        return undefined;
    }
    const value = raw.toLowerCase();
    if (value === 'csharp' || value === 'c#') {
        return 'csharp';
    }
    if (value === 'typescript' || value.startsWith('typescript/') || value === 'javascript' || value.startsWith('javascript/')) {
        return 'typescript';
    }
    return 'other';
}

export function summarizeAppHostLanguages(candidates: readonly CandidateAppHostDisplayInfo[]): AppHostLanguageSummary {
    if (candidates.length === 0) {
        return 'none';
    }

    let sawCsharp = false;
    let sawTypescript = false;
    let sawOther = false;
    let sawAny = false;

    for (const candidate of candidates) {
        const family = languageFamily(candidate.language);
        if (family === undefined) {
            continue;
        }
        sawAny = true;
        if (family === 'csharp') {
            sawCsharp = true;
        }
        else if (family === 'typescript') {
            sawTypescript = true;
        }
        else {
            sawOther = true;
        }
    }

    if (!sawAny) {
        return 'unknown';
    }

    const distinctFamilies = Number(sawCsharp) + Number(sawTypescript) + Number(sawOther);
    if (distinctFamilies > 1) {
        return 'polyglot';
    }
    if (sawCsharp) {
        return 'csharp';
    }
    if (sawTypescript) {
        return 'typescript';
    }
    return 'unknown';
}

/**
 * Coarse single-AppHost classification used by the debug-session telemetry path
 * where we have a concrete program/project path but no `aspire ls` candidate.
 * Mirrors {@link summarizeAppHostLanguages} categories so dashboard cohorts can
 * combine the two signals.
 */
export function classifyAppHostPath(appHostPath: string | undefined): 'csharp' | 'typescript' | 'unknown' {
    if (!appHostPath) {
        return 'unknown';
    }
    const lower = appHostPath.toLowerCase();
    if (lower.endsWith('.csproj') || lower.endsWith('.cs')) {
        return 'csharp';
    }
    if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts') ||
        lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
        return 'typescript';
    }
    return 'unknown';
}
