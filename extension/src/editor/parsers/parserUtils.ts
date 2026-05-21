import * as vscode from 'vscode';

/**
 * Walk backwards from the match position to find the first line of the statement.
 * Stops at the previous ';', '{', or start of file, then returns the first non-comment,
 * non-blank line after that delimiter. When a '}' is encountered, the matched '{...}'
 * block is inspected: if preceded by '=>' it is a lambda body within the current fluent
 * chain and is skipped; otherwise the '}' is treated as a statement boundary.
 *
 * Shared by C# and JS/TS AppHost parsers since the statement-boundary rules are
 * identical for C-syntax languages.
 */
export function findStatementStartLine(text: string, matchIndex: number, document: vscode.TextDocument): number {
    let i = matchIndex - 1;
    while (i >= 0) {
        const ch = text[i];
        if (ch === ';' || ch === '{') {
            break;
        }
        if (ch === '}') {
            const openBraceIdx = findMatchingOpenBrace(text, i);
            if (openBraceIdx < 0) {
                // No matching open brace — treat as delimiter
                break;
            }
            if (isPrecededByArrow(text, openBraceIdx)) {
                // Lambda body in the current fluent chain — skip over it
                i = openBraceIdx - 1;
                continue;
            }
            // Separate statement block — treat '}' as delimiter
            break;
        }
        i--;
    }
    // i is now at the delimiter or -1 (start of file)
    // Find the first non-whitespace character after the delimiter
    let start = i + 1;
    while (start < matchIndex && /\s/.test(text[start])) {
        start++;
    }
    let line = document.positionAt(start).line;
    const matchLine = document.positionAt(matchIndex).line;
    // Skip lines that are only closing braces (with optional comment), comments,
    // C# 12 file-scoped top-level directives (e.g. `#:sdk Aspire.AppHost.Sdk`),
    // or blank lines.
    while (line < matchLine) {
        const lineText = document.lineAt(line).text.trimStart();
        if (lineText === ''
            || /^\}\s*(\/\/.*)?$/.test(lineText)
            || lineText.startsWith('//')
            || lineText.startsWith('/*')
            || lineText.startsWith('*')
            || lineText.startsWith('#:')) {
            line++;
        } else {
            break;
        }
    }
    return line;
}

/**
 * Find matches whose starting character is in code rather than comments or strings.
 *
 * AppHost parsers still use targeted regexes to find resource-like calls, for example:
 *   builder.AddContainer("api", "image"); // builder.AddContainer("disabled", "image")
 *   /* builder.AddContainer("disabled", "image"); *\/
 *   var sample = """builder.AddContainer("disabled", "image");""";
 *
 * VS Code's TextDocument API does not expose C#/JS semantic tokens synchronously to
 * CodeLens providers, so the parsers first scan C-syntax trivia and string literals.
 * This keeps regex matches for real code while ignoring line comments, block comments,
 * trailing comments, escaped/verbatim/raw C# strings, and JS/TS template strings.
 * The regex must be created with the global flag.
 */
export function findMatchesOutsideCommentsAndStrings(text: string, regex: RegExp): RegExpExecArray[] {
    if (!regex.global) {
        throw new Error('findMatchesOutsideCommentsAndStrings requires a global regex');
    }

    const inactiveRanges = getInactiveCodeRanges(text);
    const results: RegExpExecArray[] = [];
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        if (!isInInactiveRange(inactiveRanges, match.index)) {
            results.push(match);
        }

        if (match[0].length === 0) {
            regex.lastIndex++;
        }
    }

    return results;
}

/**
 * Find the first match of `regex` whose starting character is in code.
 * The regex must be created with the global flag.
 */
export function findFirstMatchOutsideComments(text: string, regex: RegExp, _document: vscode.TextDocument): RegExpExecArray | undefined {
    return findMatchesOutsideCommentsAndStrings(text, regex)[0];
}

/**
 * Starting from a '}' at closeBraceIdx, walk backwards to find the matching '{'.
 * Returns the index of '{', or -1 if not found.
 */
export function findMatchingOpenBrace(text: string, closeBraceIdx: number): number {
    let depth = 1;
    let j = closeBraceIdx - 1;
    while (j >= 0 && depth > 0) {
        if (text[j] === '}') {
            depth++;
        } else if (text[j] === '{') {
            depth--;
        }
        j--;
    }
    return depth === 0 ? j + 1 : -1;
}

/**
 * Check whether the '{' at openBraceIdx is preceded (ignoring whitespace) by '=>'.
 */
export function isPrecededByArrow(text: string, openBraceIdx: number): boolean {
    let k = openBraceIdx - 1;
    while (k >= 0 && /\s/.test(text[k])) {
        k--;
    }
    return k >= 1 && text[k - 1] === '=' && text[k] === '>';
}

interface InactiveCodeRange {
    start: number;
    end: number;
}

function getInactiveCodeRanges(text: string): InactiveCodeRange[] {
    const ranges: InactiveCodeRange[] = [];
    let i = 0;

    while (i < text.length) {
        const rangeEnd =
            tryReadLineCommentEnd(text, i)
            ?? tryReadBlockCommentEnd(text, i)
            ?? tryReadCSharpRawStringEnd(text, i)
            ?? tryReadCSharpVerbatimStringEnd(text, i)
            ?? tryReadPrefixedStringEnd(text, i)
            ?? tryReadEscapedStringEnd(text, i, '"')
            ?? tryReadEscapedStringEnd(text, i, "'")
            ?? tryReadEscapedStringEnd(text, i, '`');

        if (rangeEnd !== undefined) {
            ranges.push({ start: i, end: rangeEnd });
            i = rangeEnd;
        } else {
            i++;
        }
    }

    return ranges;
}

function isInInactiveRange(ranges: readonly InactiveCodeRange[], index: number): boolean {
    let low = 0;
    let high = ranges.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const range = ranges[mid];
        if (index < range.start) {
            high = mid - 1;
        } else if (index >= range.end) {
            low = mid + 1;
        } else {
            return true;
        }
    }

    return false;
}

function tryReadLineCommentEnd(text: string, start: number): number | undefined {
    if (text[start] !== '/' || text[start + 1] !== '/') {
        return undefined;
    }

    const newlineIndex = text.indexOf('\n', start + 2);
    return newlineIndex < 0 ? text.length : newlineIndex;
}

function tryReadBlockCommentEnd(text: string, start: number): number | undefined {
    if (text[start] !== '/' || text[start + 1] !== '*') {
        return undefined;
    }

    const endIndex = text.indexOf('*/', start + 2);
    return endIndex < 0 ? text.length : endIndex + 2;
}

function tryReadCSharpRawStringEnd(text: string, start: number): number | undefined {
    const delimiterStart = getRawStringDelimiterStart(text, start);
    if (delimiterStart === undefined) {
        return undefined;
    }

    const quoteCount = countConsecutive(text, delimiterStart, '"');
    if (quoteCount < 3) {
        return undefined;
    }

    let i = delimiterStart + quoteCount;
    while (i < text.length) {
        if (text[i] === '"' && countConsecutive(text, i, '"') >= quoteCount) {
            return i + quoteCount;
        }

        i++;
    }

    return text.length;
}

function getRawStringDelimiterStart(text: string, start: number): number | undefined {
    if (text[start] === '"') {
        return start;
    }

    if (text[start] !== '$') {
        return undefined;
    }

    let i = start;
    while (text[i] === '$') {
        i++;
    }

    return text[i] === '"' ? i : undefined;
}

function tryReadCSharpVerbatimStringEnd(text: string, start: number): number | undefined {
    const quoteStart =
        text[start] === '@' && text[start + 1] === '"'
            ? start + 1
            : text[start] === '$' && text[start + 1] === '@' && text[start + 2] === '"'
                ? start + 2
                : text[start] === '@' && text[start + 1] === '$' && text[start + 2] === '"'
                    ? start + 2
                    : undefined;

    if (quoteStart === undefined) {
        return undefined;
    }

    let i = quoteStart + 1;
    while (i < text.length) {
        if (text[i] === '"') {
            if (text[i + 1] === '"') {
                i += 2;
            } else {
                return i + 1;
            }
        } else {
            i++;
        }
    }

    return text.length;
}

function tryReadPrefixedStringEnd(text: string, start: number): number | undefined {
    if (text[start] !== '$' || text[start + 1] !== '"') {
        return undefined;
    }

    return tryReadEscapedStringEnd(text, start + 1, '"');
}

function tryReadEscapedStringEnd(text: string, start: number, quote: '"' | "'" | '`'): number | undefined {
    if (text[start] !== quote) {
        return undefined;
    }

    let i = start + 1;
    while (i < text.length) {
        if (text[i] === '\\') {
            i += 2;
        } else if (text[i] === quote) {
            return i + 1;
        } else {
            i++;
        }
    }

    return text.length;
}

function countConsecutive(text: string, start: number, ch: string): number {
    let count = 0;
    while (text[start + count] === ch) {
        count++;
    }

    return count;
}
