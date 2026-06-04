import * as path from 'path';
import * as vscode from 'vscode';

export const appHostDiscoveryFindFilesMaxResults = 512;

interface SegmentExcludeRule {
    readonly glob: string;
    readonly segments: readonly string[];
}

const commonExcludePatterns = [
    '**/artifacts/**',
    '**/[Bb]in/**',
    '**/[Oo]bj/**',
    '**/[Dd]ebug/**',
    '**/[Rr]elease/**',
    '**/dist/**',
    '**/out/**',
    '**/build/**',
    '**/target/**',
    '**/publish/**',
    '**/node_modules/**',
    '**/.venv/**',
    '**/packages/**',
    '**/.vs/**',
    '**/.vscode-test/**',
    '**/.worktrees/**',
    '**/.claude/**',
    '**/.idea/**',
    '**/.git/**',
    '**/.angular/**',
    '**/.aspire/modules/**',
    '**/.azurite/**',
];

const appHostDiscoveryExcludeRules: readonly SegmentExcludeRule[] = [
    { glob: '**/artifacts/**', segments: ['artifacts'] },
    { glob: '**/[Bb]in/**', segments: ['bin'] },
    { glob: '**/[Oo]bj/**', segments: ['obj'] },
    { glob: '**/node_modules/**', segments: ['node_modules'] },
    { glob: '**/.git/**', segments: ['.git'] },
    { glob: '**/.vs/**', segments: ['.vs'] },
    { glob: '**/.vscode-test/**', segments: ['.vscode-test'] },
    { glob: '**/.worktrees/**', segments: ['.worktrees'] },
    // Coding agents commonly store full git worktrees under .claude/worktrees. Treat the
    // whole tool directory as generated workspace state so discovery doesn't recurse into
    // dozens of nested repo copies and spawn a storm of file-search processes.
    { glob: '**/.claude/**', segments: ['.claude'] },
    { glob: '**/.idea/**', segments: ['.idea'] },
    { glob: '**/.aspire/modules/**', segments: ['.aspire', 'modules'] },
];

export function getCommonExcludeGlob(): string {
    return toBraceGlob(commonExcludePatterns);
}

export function getAppHostDiscoveryExcludeGlob(): string {
    return toBraceGlob([
        ...appHostDiscoveryExcludeRules.map(rule => rule.glob),
        ...getEnabledWorkspaceExcludePatterns(),
    ]);
}

export function isExcludedDiscoveryUri(workspaceFolder: vscode.WorkspaceFolder, uri: vscode.Uri): boolean {
    const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
    if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return true;
    }

    const segments = relativePath.split(/[\\/]+/).map(segment => segment.toLowerCase());
    return appHostDiscoveryExcludeRules.some(rule => containsSegments(segments, rule.segments));
}

function toBraceGlob(patterns: readonly string[]): string {
    return `{${patterns.join(',')}}`;
}

function containsSegments(pathSegments: readonly string[], ruleSegments: readonly string[]): boolean {
    const normalizedRuleSegments = ruleSegments.map(segment => segment.toLowerCase());
    return pathSegments.some((_, index) => normalizedRuleSegments.every((segment, ruleIndex) => pathSegments[index + ruleIndex] === segment));
}

function getEnabledWorkspaceExcludePatterns(): string[] {
    return [
        ...getEnabledExcludePatterns(vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude', {})),
        ...getEnabledExcludePatterns(vscode.workspace.getConfiguration('search').get<Record<string, unknown>>('exclude', {})),
    ];
}

function getEnabledExcludePatterns(excludes: Record<string, unknown>): string[] {
    return Object.entries(excludes)
        .filter(([, value]) => isExcludeEnabled(value))
        // VS Code's glob parser doesn't support nested brace expressions. Since we combine
        // patterns into one outer brace group, skip user patterns that would split it incorrectly.
        .filter(([pattern]) => canComposeIntoBraceGlob(pattern))
        .map(([pattern]) => pattern);
}

function isExcludeEnabled(value: unknown): boolean {
    return value === true;
}

function canComposeIntoBraceGlob(pattern: string): boolean {
    return !/[{},]/.test(pattern);
}
