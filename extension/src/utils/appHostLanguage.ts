import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
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
function languageFamily(raw: string | null | undefined): 'csharp' | 'typescript' | 'other' {
    if (!raw) {
        return 'other';
    }
    const value = raw.toLowerCase();
    if (value === 'csharp' || value === 'c#' || value === 'fsharp' || value === 'f#' || value === 'visualbasic' || value === 'visual basic' || value === 'vb') {
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

    for (const candidate of candidates) {
        const family = languageFamily(candidate.language);
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
 *
 * When `appHostPath` points at a directory (rather than a file), callers should
 * use {@link classifyAppHostDirectory} which peeks for marker files. This entry
 * point only looks at the file extension.
 */
export function classifyAppHostPath(appHostPath: string | undefined): 'csharp' | 'typescript' | 'unknown' {
    if (!appHostPath) {
        return 'unknown';
    }
    const lower = appHostPath.toLowerCase();
    if (lower.endsWith('.csproj') || lower.endsWith('.fsproj') || lower.endsWith('.vbproj') || lower.endsWith('.cs')) {
        return 'csharp';
    }
    if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts') ||
        lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
        return 'typescript';
    }
    return 'unknown';
}

/**
 * Directory variant of {@link classifyAppHostPath}. The Aspire CLI commonly
 * launches AppHosts as a directory (e.g. `aspire run` without `--apphost`)
 * because the entry file lives next to `package.json` / `*.csproj` and is
 * discovered at runtime. Looking only at the directory name itself loses the
 * language signal entirely, so we enumerate the directory and match well-known
 * AppHost file names.
 *
 * Directory reads are O(entries), small for typical AppHost roots; any failure
 * (permissions, missing directory) returns `'unknown'` rather than throwing.
 */
export async function classifyAppHostDirectory(directoryPath: string | undefined): Promise<'csharp' | 'typescript' | 'unknown'> {
    if (!directoryPath) {
        return 'unknown';
    }
    let entries: string[];
    try {
        entries = await fs.readdir(directoryPath);
    }
    catch {
        return 'unknown';
    }
    let sawCsharp = false;
    let sawTypescript = false;
    for (const entry of entries) {
        if (await isCsharpAppHostMarker(directoryPath, entry)) {
            sawCsharp = true;
        }
        else if (isTypescriptAppHostMarker(entry)) {
            sawTypescript = true;
        }
    }
    if (sawCsharp && sawTypescript) {
        // Highly unusual; prefer csharp because Aspire's reference AppHost
        // implementation is csproj-based. Either signal is fine here — the
        // telemetry value is "we recognized it", not "we picked the right one".
        return 'csharp';
    }
    if (sawCsharp) {
        return 'csharp';
    }
    if (sawTypescript) {
        return 'typescript';
    }
    return 'unknown';
}

async function isCsharpAppHostMarker(directoryPath: string, entry: string): Promise<boolean> {
    const lower = entry.toLowerCase();
    if (lower === 'apphost.cs') {
        return true;
    }

    if (!lower.endsWith('.csproj') && !lower.endsWith('.fsproj') && !lower.endsWith('.vbproj')) {
        return false;
    }

    if (projectFileNameLooksLikeAppHost(lower)) {
        return true;
    }

    return await projectFileReferencesAspireAppHost(directoryPath, entry);
}

function projectFileNameLooksLikeAppHost(fileName: string): boolean {
    const nameWithoutExtension = fileName.replace(/\.[^.]+$/, '');
    return nameWithoutExtension === 'apphost'
        || nameWithoutExtension.endsWith('.apphost');
}

async function projectFileReferencesAspireAppHost(directoryPath: string, entry: string): Promise<boolean> {
    let contents: string;
    try {
        contents = await fs.readFile(join(directoryPath, entry), 'utf8');
    }
    catch {
        return false;
    }

    return projectContentsReferencesAspireAppHost(contents);
}

export function projectContentsReferencesAspireAppHost(contents: string): boolean {
    const uncommentedContents = contents.replace(/<!--[\s\S]*?-->/g, '');
    // C# AppHost project files can advertise Aspire through SDK, package, or evaluated properties:
    //   <Project Sdk="Aspire.AppHost.Sdk/13.5.0">
    //   <Sdk Name="Aspire.AppHost.Sdk" Version="13.5.0" />
    //   <PackageReference Include="Aspire.Hosting.AppHost" />
    //   <IsAspireHost>true</IsAspireHost>
    // Classification also accepts plain Aspire.Hosting references because projects
    // can still be AppHosts without using the AppHost-specific package shape.
    return projectContentsReferencesRunnableAspireAppHost(uncommentedContents)
        || /<(?:PackageReference|AspireProjectOrPackageReference)\b(?=[^>]*\bInclude\s*=\s*["']Aspire\.Hosting["'])[^>]*>/is.test(uncommentedContents);
}

export function projectContentsReferencesRunnableAspireAppHost(contents: string): boolean {
    const uncommentedContents = contents.replace(/<!--[\s\S]*?-->/g, '');
    return projectSdkReferencesAspireAppHost(uncommentedContents)
        || /<Sdk\b(?=[^>]*\bName\s*=\s*(["'])Aspire\.AppHost\.Sdk\1)[^>]*>/is.test(uncommentedContents)
        || /<(?:PackageReference|AspireProjectOrPackageReference)\b(?=[^>]*\bInclude\s*=\s*["']Aspire\.Hosting\.AppHost["'])[^>]*>/is.test(uncommentedContents)
        || /<IsAspireHost>\s*true\s*<\/IsAspireHost>/i.test(uncommentedContents);
}

/** File extensions that can address an AppHost directly: project files plus parser-backed source files. */
const appHostProjectFileExtensions = ['.csproj', '.fsproj', '.vbproj'];
const appHostCSharpSourceExtensions = ['.cs'];
const appHostJsTsSourceExtensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Whether a path has an extension that can name an AppHost. Callers still need
 * {@link isRunnableAppHostFileContents} to confirm the file really is one.
 */
export function isSupportedAppHostFileExtension(filePath: string): boolean {
    const extension = extname(filePath).toLowerCase();
    return appHostProjectFileExtensions.includes(extension)
        || appHostCSharpSourceExtensions.includes(extension)
        || appHostJsTsSourceExtensions.includes(extension);
}

/**
 * Content-only AppHost detection for callers that hold a file path but no loaded
 * `vscode.TextDocument`.
 *
 * The editor parsers in `src/editor/parsers` require a `TextDocument` and, for C#,
 * a tree-sitter grammar load, which is too heavy for a synchronous validation gate.
 * This gate instead requires the complete runnable shape:
 *   `#:sdk Aspire.AppHost.Sdk@13.0.0`      (single-file C# AppHost directive)
 *   `DistributedApplication.CreateBuilder` (C# AppHost entry point)
 *   `import { ... } from '@aspire/hosting'`/`require('aspire')` (JS/TS AppHost)
 *   `createBuilder(...)` and `builder.build().run()` (JS/TS execution)
 * Comments and string literals are excluded from executable marker matching so a
 * model cannot turn documentation or sample text into an executable path.
 */
export function isRunnableAppHostFileContents(filePath: string, contents: string): boolean {
    const extension = extname(filePath).toLowerCase();
    if (appHostProjectFileExtensions.includes(extension)) {
        return projectContentsReferencesRunnableAspireAppHost(contents);
    }

    if (appHostCSharpSourceExtensions.includes(extension)) {
        const { withoutComments, executable } = stripCommentsAndStringLiterals(contents, 'csharp');
        return /^[ \t]*#:sdk[ \t]+Aspire\.AppHost\.Sdk\b/m.test(withoutComments)
            && /\bDistributedApplication\s*\.\s*CreateBuilder\s*\(/.test(executable)
            && /\.\s*Build\s*\(\s*\)\s*\.\s*Run\s*\(/.test(executable);
    }

    if (appHostJsTsSourceExtensions.includes(extension)) {
        const { withoutComments, executable } = stripCommentsAndStringLiterals(contents, 'jsts');
        return referencesAspireModule(withoutComments)
            && /\bcreateBuilder\s*\(/.test(executable)
            && /\.\s*build\s*\(\s*\)\s*\.\s*run\s*\(/.test(executable);
    }

    function referencesAspireModule(contents: string): boolean {
        const moduleSpecifiers = [
            ...contents.matchAll(/\bfrom\s*(["'])(?<specifier>[^"']+)\1/g),
            ...contents.matchAll(/\brequire\s*\(\s*(["'])(?<specifier>[^"']+)\1\s*\)/g),
        ];

        return moduleSpecifiers.some(match => {
            const specifier = match.groups?.specifier?.toLowerCase();
            return specifier === 'aspire'
                || specifier?.startsWith('@aspire/') === true
                || /(?:^|\/)\.aspire\/modules\/aspire(?:\.[^/]*)?$/.test(specifier ?? '')
                || /(?:^|\/)\.modules\/aspire(?:\.[^/]*)?$/.test(specifier ?? '');
        });
    }

    return false;
}

function projectSdkReferencesAspireAppHost(contents: string): boolean {
    const projectSdkMatch = /<Project\b[^>]*\bSdk\s*=\s*(["'])(?<sdks>.*?)\1/is.exec(contents);
    const sdkAttribute = projectSdkMatch?.groups?.sdks;
    if (!sdkAttribute) {
        return false;
    }

    return sdkAttribute.split(';').some(sdk => /^Aspire\.AppHost\.Sdk(?:\/|$)/i.test(sdk.trim()));
}

function isTypescriptAppHostMarker(entry: string): boolean {
    const lower = entry.toLowerCase();
    return lower === 'apphost.ts' || lower === 'apphost.mts' || lower === 'apphost.cts' ||
        lower === 'apphost.js' || lower === 'apphost.mjs' || lower === 'apphost.cjs';
}

type AppHostSourceLanguage = 'csharp' | 'jsts';

interface StrippedAppHostSource {
    /** Comments blanked out, string literals left intact. */
    readonly withoutComments: string;
    /** Comments and string literal contents both blanked out. */
    readonly executable: string;
}

/**
 * Blanks a span while preserving line structure, so offsets and line-anchored
 * regexes (like the `#:sdk` directive match) still line up with the original text.
 */
function blankOutSpan(span: string): string {
    return span.replace(/[^\n]/g, ' ');
}

/**
 * Single-pass scanner that produces both views the AppHost content gate needs.
 *
 * Accuracy matters in one direction here: every construct this scanner mis-reads
 * desynchronizes it, and the rest of the file gets blanked out, so a perfectly valid
 * AppHost is reported as `notAnAppHost`. That is why the language-specific literal
 * forms below are handled explicitly instead of treating every quote the same way:
 *
 *   C#   `@"C:\bind\"`        verbatim - backslash is literal, `""` is the escape
 *        `"""raw "quoted" """` raw - closes only on a quote run at least as long
 *        `'\''`                char literal
 *   JS/TS `/["']/`             regex literal - quotes inside are not string starts
 *         `` `a ${b} c` ``     template literal
 *
 * See https://learn.microsoft.com/dotnet/csharp/language-reference/tokens/raw-string
 * and https://tc39.es/ecma262/#sec-literals-regular-expression-literals.
 */
function stripCommentsAndStringLiterals(contents: string, language: AppHostSourceLanguage): StrippedAppHostSource {
    let withoutComments = '';
    let executable = '';
    let index = 0;
    // Tracks the last significant code character and word so a `/` in JS/TS can be
    // classified as a regex literal or a division operator.
    let lastCodeChar = '';
    let lastWord = '';
    let wordBuffer = '';

    const emitCode = (span: string): void => {
        withoutComments += span;
        executable += span;
        for (const character of span) {
            if (/[A-Za-z0-9_$]/.test(character)) {
                wordBuffer += character;
            }
            else {
                if (wordBuffer.length > 0) {
                    lastWord = wordBuffer;
                    wordBuffer = '';
                }
                else if (!/\s/.test(character)) {
                    lastWord = '';
                }
            }
            if (!/\s/.test(character)) {
                lastCodeChar = character;
            }
        }
    };

    const emitComment = (span: string): void => {
        const blanked = blankOutSpan(span);
        withoutComments += blanked;
        executable += blanked;
    };

    const emitLiteral = (span: string): void => {
        withoutComments += span;
        executable += blankOutSpan(span);
        wordBuffer = '';
        lastWord = '';
        lastCodeChar = span[span.length - 1] ?? lastCodeChar;
    };

    while (index < contents.length) {
        const current = contents[index];
        const next = contents[index + 1];

        if (current === '/' && next === '/') {
            const end = contents.indexOf('\n', index);
            const stop = end === -1 ? contents.length : end;
            emitComment(contents.slice(index, stop));
            index = stop;
            continue;
        }

        if (current === '/' && next === '*') {
            const end = contents.indexOf('*/', index + 2);
            const stop = end === -1 ? contents.length : end + 2;
            emitComment(contents.slice(index, stop));
            index = stop;
            continue;
        }

        const literalEnd = language === 'csharp'
            ? readCSharpLiteral(contents, index)
            : readJsTsLiteral(contents, index, lastCodeChar, wordBuffer.length > 0 ? wordBuffer : lastWord);
        if (literalEnd !== undefined) {
            emitLiteral(contents.slice(index, literalEnd));
            index = literalEnd;
            continue;
        }

        emitCode(current);
        index++;
    }

    return { withoutComments, executable };
}

/**
 * Returns the end offset of the C# literal starting at `start`, or `undefined` when no
 * literal starts there. Handles `$`/`@` prefixes, raw string fences, verbatim strings,
 * regular strings, and char literals.
 */
function readCSharpLiteral(contents: string, start: number): number | undefined {
    let index = start;
    let verbatim = false;
    while (index < contents.length && (contents[index] === '$' || contents[index] === '@')) {
        verbatim ||= contents[index] === '@';
        index++;
    }

    if (contents[index] === "'" && index === start) {
        return readDelimitedLiteral(contents, index, "'");
    }

    if (contents[index] !== '"') {
        return undefined;
    }

    let quoteRun = 0;
    while (contents[index + quoteRun] === '"') {
        quoteRun++;
    }

    // A raw string literal closes on the first quote run at least as long as its opening
    // fence, so embedded quotes never terminate it.
    if (quoteRun >= 3) {
        index += quoteRun;
        while (index < contents.length) {
            if (contents[index] !== '"') {
                index++;
                continue;
            }

            let closingRun = 0;
            while (contents[index + closingRun] === '"') {
                closingRun++;
            }
            if (closingRun >= quoteRun) {
                return index + closingRun;
            }
            index += closingRun;
        }

        return contents.length;
    }

    if (verbatim) {
        index++;
        while (index < contents.length) {
            if (contents[index] === '"') {
                if (contents[index + 1] === '"') {
                    index += 2;
                    continue;
                }

                return index + 1;
            }
            index++;
        }

        return contents.length;
    }

    return readDelimitedLiteral(contents, index, '"');
}

/**
 * Returns the end offset of the JS/TS literal starting at `start`, or `undefined` when no
 * literal starts there.
 */
function readJsTsLiteral(contents: string, start: number, lastCodeChar: string, lastWord: string): number | undefined {
    const current = contents[start];
    if (current === '"' || current === "'") {
        return readDelimitedLiteral(contents, start, current);
    }

    if (current === '`') {
        return readTemplateLiteral(contents, start);
    }

    if (current === '/' && canStartRegexLiteral(lastCodeChar, lastWord)) {
        return readRegexLiteral(contents, start);
    }

    return undefined;
}

/** Reads a `\`-escaped literal that a raw newline terminates, so a stray quote cannot swallow the file. */
function readDelimitedLiteral(contents: string, start: number, quote: string): number {
    let index = start + 1;
    while (index < contents.length) {
        const current = contents[index];
        if (current === '\\') {
            index += 2;
            continue;
        }
        if (current === quote) {
            return index + 1;
        }
        if (current === '\n') {
            return index;
        }
        index++;
    }

    return contents.length;
}

function readTemplateLiteral(contents: string, start: number): number {
    let index = start + 1;
    while (index < contents.length) {
        const current = contents[index];
        if (current === '\\') {
            index += 2;
            continue;
        }
        if (current === '`') {
            return index + 1;
        }
        index++;
    }

    return contents.length;
}

function readRegexLiteral(contents: string, start: number): number | undefined {
    let index = start + 1;
    let inCharacterClass = false;
    while (index < contents.length) {
        const current = contents[index];
        if (current === '\\') {
            index += 2;
            continue;
        }
        // An unescaped newline means this was a division operator, not a regex literal.
        if (current === '\n') {
            return undefined;
        }
        if (inCharacterClass) {
            inCharacterClass = current !== ']';
        }
        else if (current === '[') {
            inCharacterClass = true;
        }
        else if (current === '/') {
            index++;
            while (index < contents.length && /[a-z]/i.test(contents[index])) {
                index++;
            }

            return index;
        }
        index++;
    }

    return undefined;
}

/**
 * A `/` begins a regex literal only where an expression may begin. Everywhere else it is
 * division. This is the usual lexical heuristic: look at the previous significant token.
 */
function canStartRegexLiteral(lastCodeChar: string, lastWord: string): boolean {
    if (lastCodeChar === '') {
        return true;
    }

    if (regexPrecedingKeywords.has(lastWord)) {
        return true;
    }

    return !/[A-Za-z0-9_$)\]}"'`]/.test(lastCodeChar);
}

const regexPrecedingKeywords = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
]);

