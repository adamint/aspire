import * as assert from 'assert';
import { summarizeAppHostLanguages, classifyAppHostPath } from '../utils/appHostLanguage';
import type { CandidateAppHostDisplayInfo } from '../utils/appHostDiscovery';

function c(language: string | null): CandidateAppHostDisplayInfo {
    return { path: '/x', language, status: null };
}

suite('appHostLanguage.summarizeAppHostLanguages', () => {
    test('returns none for empty candidate list', () => {
        assert.strictEqual(summarizeAppHostLanguages([]), 'none');
    });

    test('returns csharp when every candidate is C#', () => {
        assert.strictEqual(summarizeAppHostLanguages([c('csharp'), c('C#')]), 'csharp');
    });

    test('returns typescript for typescript variants', () => {
        assert.strictEqual(summarizeAppHostLanguages([c('typescript'), c('typescript/nodejs')]), 'typescript');
        assert.strictEqual(summarizeAppHostLanguages([c('javascript')]), 'typescript');
    });

    test('returns polyglot for a mix of csharp and typescript', () => {
        assert.strictEqual(summarizeAppHostLanguages([c('csharp'), c('typescript')]), 'polyglot');
    });

    test('returns polyglot when an unknown language is mixed with a known one', () => {
        assert.strictEqual(summarizeAppHostLanguages([c('csharp'), c('python')]), 'polyglot');
    });

    test('returns unknown when no candidate has a recognizable language', () => {
        assert.strictEqual(summarizeAppHostLanguages([c(null), c(null)]), 'unknown');
    });

    test('treats only-other as unknown rather than polyglot', () => {
        // A single non-csharp / non-typescript family with no known sibling
        // should collapse to "unknown" to avoid polluting the polyglot bucket
        // with single-language workspaces we just don't classify yet.
        const result = summarizeAppHostLanguages([c('rust'), c('rust')]);
        // Behavior: rust collapses to 'other', sawOther = true; sawAny = true;
        // distinctFamilies = 1 (just other); falls through to final 'unknown'.
        assert.strictEqual(result, 'unknown');
    });
});

suite('appHostLanguage.classifyAppHostPath', () => {
    test('returns unknown for undefined / empty path', () => {
        assert.strictEqual(classifyAppHostPath(undefined), 'unknown');
        assert.strictEqual(classifyAppHostPath(''), 'unknown');
    });

    test('classifies .csproj and .cs as csharp', () => {
        assert.strictEqual(classifyAppHostPath('/abs/path/AppHost.csproj'), 'csharp');
        assert.strictEqual(classifyAppHostPath('AppHost.cs'), 'csharp');
        assert.strictEqual(classifyAppHostPath('C:\\repos\\My.AppHost.csproj'), 'csharp');
    });

    test('classifies typescript / javascript module variants', () => {
        assert.strictEqual(classifyAppHostPath('apphost.ts'), 'typescript');
        assert.strictEqual(classifyAppHostPath('apphost.mts'), 'typescript');
        assert.strictEqual(classifyAppHostPath('apphost.cts'), 'typescript');
        assert.strictEqual(classifyAppHostPath('apphost.js'), 'typescript');
        assert.strictEqual(classifyAppHostPath('apphost.mjs'), 'typescript');
        assert.strictEqual(classifyAppHostPath('apphost.cjs'), 'typescript');
    });

    test('returns unknown for unrecognized file extensions and directories', () => {
        assert.strictEqual(classifyAppHostPath('/repo/apphost.py'), 'unknown');
        assert.strictEqual(classifyAppHostPath('/repo/apphost'), 'unknown');
    });

    test('classification is case-insensitive', () => {
        assert.strictEqual(classifyAppHostPath('APPHOST.CSPROJ'), 'csharp');
        assert.strictEqual(classifyAppHostPath('AppHost.TS'), 'typescript');
    });
});
