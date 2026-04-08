import * as vscode from 'vscode';
import { AppHostResourceParser, ParsedResource, registerParser } from './AppHostResourceParser';

/**
 * JavaScript / TypeScript AppHost resource parser.
 * Detects AppHost files via Aspire module imports, then extracts .add*("name") calls.
 */
class JsTsAppHostParser implements AppHostResourceParser {
    getSupportedExtensions(): string[] {
        return ['.ts', '.js'];
    }

    isAppHostFile(document: vscode.TextDocument): boolean {
        const text = document.getText();
        // Match @aspire package imports, local aspire module imports (e.g. ./.modules/aspire.js),
        // or the createBuilder() entry point from the Aspire TS SDK.
        return /(?:from\s+['"](?:@aspire|[^'"]*aspire[^'"]*)|require\s*\(\s*['"](?:@aspire|[^'"]*aspire[^'"]*))/.test(text)
            || /\bcreateBuilder\s*\(/.test(text);
    }

    parseResources(document: vscode.TextDocument): ParsedResource[] {
        const text = document.getText();
        const results: ParsedResource[] = [];

        // Match .addXyz("name") or .addXyz('name') patterns
        // \s* matches whitespace including newlines, supporting multi-line calls
        const pattern = /\.(add\w+)\s*\(\s*(['"])([^'"]+)\2/gi;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(text)) !== null) {
            const methodName = match[1];
            const resourceName = match[3];

            const matchStart = match.index;
            const startPos = document.positionAt(matchStart);
            const endPos = document.positionAt(matchStart + match[0].length);

            // Find the start of the full statement (walk back to previous ';', '{', '}', or start of file)
            const statementStartLine = this._findStatementStartLine(text, matchStart, document);

            results.push({
                name: resourceName,
                methodName: methodName,
                range: new vscode.Range(startPos, endPos),
                kind: methodName.toLowerCase() === 'addstep' ? 'pipelineStep' : 'resource',
                statementStartLine,
            });
        }

        return results;
    }

    /**
     * Walk backwards from the match position to find the first line of the statement.
     * Stops at the previous ';', '{', or start of file, then returns the first non-comment,
     * non-blank line after that delimiter. When a '}' is encountered, the matched '{...}'
     * block is inspected: if preceded by '=>' it is a lambda body within the current fluent
     * chain and is skipped; otherwise the '}' is treated as a statement boundary.
     */
    private _findStatementStartLine(text: string, matchIndex: number, document: vscode.TextDocument): number {
        let i = matchIndex - 1;
        while (i >= 0) {
            const ch = text[i];
            if (ch === ';' || ch === '{') {
                break;
            }
            if (ch === '}') {
                const openBraceIdx = this._findMatchingOpenBrace(text, i);
                if (openBraceIdx < 0) {
                    // No matching open brace — treat as delimiter
                    break;
                }
                if (this._isPrecededByArrow(text, openBraceIdx)) {
                    // Lambda body in the current fluent chain — skip over it
                    i = openBraceIdx - 1;
                    continue;
                }
                // Separate statement block — treat '}' as delimiter
                break;
            }
            i--;
        }
        let start = i + 1;
        while (start < matchIndex && /\s/.test(text[start])) {
            start++;
        }
        let line = document.positionAt(start).line;
        const matchLine = document.positionAt(matchIndex).line;
        // Skip lines that are only closing braces (with optional comment) or comments
        while (line < matchLine) {
            const lineText = document.lineAt(line).text.trimStart();
            if (/^\}\s*(\/\/.*)?$/.test(lineText) || lineText.startsWith('//') || lineText.startsWith('/*') || lineText.startsWith('*')) {
                line++;
            } else {
                break;
            }
        }
        return line;
    }

    /**
     * Starting from a '}' at closeBraceIdx, walk backwards to find the matching '{'.
     * Returns the index of '{', or -1 if not found.
     */
    private _findMatchingOpenBrace(text: string, closeBraceIdx: number): number {
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
    private _isPrecededByArrow(text: string, openBraceIdx: number): boolean {
        let k = openBraceIdx - 1;
        while (k >= 0 && /\s/.test(text[k])) {
            k--;
        }
        return k >= 1 && text[k - 1] === '=' && text[k] === '>';
    }
}

// Self-register on import
registerParser(new JsTsAppHostParser());
