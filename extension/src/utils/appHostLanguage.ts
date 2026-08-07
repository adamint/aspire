import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import * as ts from 'typescript';
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
 * The editor parsers in `src/editor/parsers` require a `TextDocument`, and the C# one
 * additionally needs a tree-sitter grammar load, which is too heavy for a synchronous
 * validation gate. This gate instead requires the complete runnable shape:
 *   `#:sdk Aspire.AppHost.Sdk@13.0.0`      (single-file C# AppHost directive)
 *   `DistributedApplication.CreateBuilder` (C# AppHost entry point)
 *   `import { ... } from '@aspire/hosting'`/`require('aspire')` (JS/TS AppHost)
 *   `createBuilder(...)` and `builder.build().run()` (JS/TS execution)
 *
 * JS/TS is analyzed with the TypeScript parser, so only real import/require syntax and
 * real call expressions count. C# is analyzed with the scanner below, which blanks
 * comments and string literals so documentation or sample text cannot satisfy the gate.
 * Both directions matter: this result is what authorizes the extension to execute the
 * file, so a marker that only exists inside data must never count.
 */
export function isRunnableAppHostFileContents(filePath: string, contents: string): boolean {
    const extension = extname(filePath).toLowerCase();
    if (appHostProjectFileExtensions.includes(extension)) {
        return projectContentsReferencesRunnableAspireAppHost(contents);
    }

    if (appHostCSharpSourceExtensions.includes(extension)) {
        const executable = stripCSharpCommentsAndStringLiterals(contents);
        // The directive is matched against the executable view, not the raw contents, so a
        // raw string literal containing a `#:sdk` line cannot satisfy the gate.
        return /^[ \t]*#:sdk[ \t]+Aspire\.AppHost\.Sdk\b/m.test(executable)
            && /\bDistributedApplication\s*\.\s*CreateBuilder\s*\(/.test(executable)
            && /\.\s*Build\s*\(\s*\)\s*\.\s*Run\s*\(/.test(executable);
    }

    if (appHostJsTsSourceExtensions.includes(extension)) {
        return isRunnableJsTsAppHost(filePath, contents);
    }

    return false;
}

/**
 * True only when the file both imports an Aspire module and runs an AppHost it built.
 *
 * This walks the real TypeScript AST rather than scanning text. A lexical scanner cannot
 * decide this safely: automatic semicolon insertion makes `o.from` followed by a string
 * on the next line two statements whose text still reads as an import, and a regex
 * literal after `class C {}` is indistinguishable from division without knowing that a
 * class declaration is not an expression. Either mistake lets `createBuilder().build()
 * .run()` inside data satisfy the gate, and the gate is what authorizes the extension to
 * execute the file. The parser is already bundled for `editor/parsers/jsTsAppHostParser`,
 * so this costs no new dependency.
 */
function isRunnableJsTsAppHost(filePath: string, contents: string): boolean {
    const sourceFile = ts.createSourceFile(
        filePath,
        contents,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false,
        isJavaScriptAppHostPath(filePath) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

    // `require` is an ordinary identifier, so a file is free to declare its own. A local
    // one is not Node's module loader and loads nothing, which means `require('aspire')`
    // would then be a call into the file's own code. Resolving the binding per call site
    // needs a full scope analysis, so any declaration of the name anywhere in the file
    // disqualifies every `require` call in it. That is conservative in the safe
    // direction: a real AppHost has no reason to shadow `require`.
    const requireIsShadowed = declaresBinding(sourceFile, 'require');

    let referencesAspireModule = false;
    let createsBuilder = false;
    let runsBuiltApplication = false;

    const visit = (node: ts.Node): void => {
        if (!referencesAspireModule && isAspireModuleReference(node, requireIsShadowed)) {
            referencesAspireModule = true;
        }

        if (!createsBuilder && ts.isCallExpression(node) && isCreateBuilderCall(node)) {
            createsBuilder = true;
        }

        if (!runsBuiltApplication && ts.isCallExpression(node) && isBuildThenRunCall(node)) {
            runsBuiltApplication = true;
        }

        if (referencesAspireModule && createsBuilder && runsBuiltApplication) {
            return;
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return referencesAspireModule && createsBuilder && runsBuiltApplication;
}

/** True when the file declares `name` anywhere, in any scope. */
function declaresBinding(sourceFile: ts.SourceFile, name: string): boolean {
    let declared = false;
    const visit = (node: ts.Node): void => {
        if (declared) {
            return;
        }

        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node))
            && node.name?.text === name) {
            declared = true;
            return;
        }

        if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node))
            && ts.isIdentifier(node.name) && node.name.text === name) {
            declared = true;
            return;
        }

        if (ts.isImportClause(node) && node.name?.text === name) {
            declared = true;
            return;
        }

        if ((ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node))
            && node.name.text === name) {
            declared = true;
            return;
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return declared;
}

/**
 * True for a node that names an Aspire module in genuine module-specifier position:
 * `import ... from 'aspire'`, a bare `import 'aspire'`, `export ... from 'aspire'`,
 * `import x = require('aspire')`, `import('aspire')`, and `require('aspire')`.
 *
 * A specifier that only appears as data - `const doc = "require('aspire')"` - is not a
 * module reference and does not reach any of these node shapes.
 */
function isAspireModuleReference(node: ts.Node, requireIsShadowed: boolean): boolean {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        return !isTypeOnlyModuleBinding(node)
            && node.moduleSpecifier !== undefined
            && ts.isStringLiteralLike(node.moduleSpecifier)
            && isAspireModuleSpecifier(node.moduleSpecifier.text);
    }

    if (ts.isImportEqualsDeclaration(node)) {
        return !node.isTypeOnly
            && ts.isExternalModuleReference(node.moduleReference)
            && ts.isStringLiteralLike(node.moduleReference.expression)
            && isAspireModuleSpecifier(node.moduleReference.expression.text);
    }

    if (!ts.isCallExpression(node)) {
        return false;
    }

    // `import('aspire')` parses as a call whose expression is the `import` keyword.
    const isModuleLoadingCall = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (!requireIsShadowed && ts.isIdentifier(node.expression) && node.expression.text === 'require');

    return isModuleLoadingCall
        && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
        && isAspireModuleSpecifier(node.arguments[0].text);
}

/**
 * True when an import or export only carries types.
 *
 * `import type { X } from 'aspire'`, and equally `import { type X } from 'aspire'` where
 * every named binding is type-only, are erased by the compiler. Nothing is loaded at
 * runtime, so such a file never actually runs Aspire and must not pass a gate whose
 * result authorizes executing it.
 *
 * See https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports.
 */
function isTypeOnlyModuleBinding(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
    if (ts.isImportDeclaration(node)) {
        const importClause = node.importClause;
        if (importClause === undefined) {
            // A bare `import 'aspire'` has no clause at all and is evaluated for its side
            // effects, which is exactly the runtime load this gate is looking for.
            return false;
        }

        if (importClause.isTypeOnly) {
            return true;
        }

        const namedBindings = importClause.namedBindings;
        return importClause.name === undefined
            && namedBindings !== undefined
            && ts.isNamedImports(namedBindings)
            && namedBindings.elements.length > 0
            && namedBindings.elements.every(element => element.isTypeOnly);
    }

    if (node.isTypeOnly) {
        return true;
    }

    const exportClause = node.exportClause;
    return exportClause !== undefined
        && ts.isNamedExports(exportClause)
        && exportClause.elements.length > 0
        && exportClause.elements.every(element => element.isTypeOnly);
}

/**
 * Module specifiers that resolve to the Aspire hosting package, including the generated
 * local module the polyglot AppHost templates emit.
 */
function isAspireModuleSpecifier(specifier: string): boolean {
    const normalized = specifier.toLowerCase();
    return normalized === 'aspire'
        || normalized.startsWith('@aspire/')
        || /(?:^|\/)\.aspire\/modules\/aspire(?:\.[^/]*)?$/.test(normalized)
        || /(?:^|\/)\.modules\/aspire(?:\.[^/]*)?$/.test(normalized);
}

/** `createBuilder(...)` or `<something>.createBuilder(...)`. */
function isCreateBuilderCall(node: ts.CallExpression): boolean {
    if (ts.isIdentifier(node.expression)) {
        return node.expression.text === 'createBuilder';
    }

    return ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'createBuilder';
}

/** `<something>.build().run(...)`, the shape that actually starts the AppHost. */
function isBuildThenRunCall(node: ts.CallExpression): boolean {
    if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'run') {
        return false;
    }

    const buildCall = node.expression.expression;
    return ts.isCallExpression(buildCall)
        && buildCall.arguments.length === 0
        && ts.isPropertyAccessExpression(buildCall.expression)
        && buildCall.expression.name.text === 'build';
}

function isJavaScriptAppHostPath(filePath: string): boolean {
    return ['.js', '.mjs', '.cjs'].includes(extname(filePath).toLowerCase());
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

/**
 * Blanks a span while preserving line structure, so offsets and line-anchored
 * regexes (like the `#:sdk` directive match) still line up with the original text.
 */
function blankOutSpan(span: string): string {
    return span.replace(/[^\n]/g, ' ');
}

/**
 * Returns C# source with comments and string literal contents blanked out, so the
 * AppHost markers can only be matched against code the compiler would execute.
 *
 * JS/TS is handled by the TypeScript parser instead. This scanner exists because there
 * is no equivalent C# parser available synchronously here: the editor's C# parser needs
 * a `TextDocument` and a tree-sitter grammar load, which is too heavy for a validation
 * gate on the tool call path.
 *
 * Accuracy matters in one direction: every construct this scanner mis-reads
 * desynchronizes it, and the rest of the file gets blanked out, so a perfectly valid
 * AppHost is reported as `notAnAppHost`. That is why the C# literal forms are handled
 * explicitly instead of treating every quote the same way:
 *
 *   `@"C:\bind\"`          verbatim - backslash is literal, `""` is the escape
 *   `"""raw "quoted" """`  raw - closes only on a quote run at least as long
 *   `'\''`                 char literal
 *
 * See https://learn.microsoft.com/dotnet/csharp/language-reference/tokens/raw-string.
 */
function stripCSharpCommentsAndStringLiterals(contents: string): string {
    let executable = '';
    let index = 0;

    while (index < contents.length) {
        const current = contents[index];
        const next = contents[index + 1];

        if (current === '/' && next === '/') {
            const end = contents.indexOf('\n', index);
            const stop = end === -1 ? contents.length : end;
            executable += blankOutSpan(contents.slice(index, stop));
            index = stop;
            continue;
        }

        if (current === '/' && next === '*') {
            const end = contents.indexOf('*/', index + 2);
            const stop = end === -1 ? contents.length : end + 2;
            executable += blankOutSpan(contents.slice(index, stop));
            index = stop;
            continue;
        }

        const literalEnd = readCSharpLiteral(contents, index);
        if (literalEnd !== undefined) {
            executable += blankOutSpan(contents.slice(index, literalEnd));
            index = literalEnd;
            continue;
        }

        executable += current;
        index++;
    }

    return executable;
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
