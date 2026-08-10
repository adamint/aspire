import * as fs from 'fs';
import * as path from 'path';

export type AppHostIdentityRelation = 'same' | 'different' | 'ambiguous';

export function canonicalizeAppHostPath(value: string): string {
    const resolvedPath = path.resolve(value);
    try {
        return fs.realpathSync.native(resolvedPath);
    }
    catch {
        return resolvedPath;
    }
}

export function getAppHostPathComparisonKey(value: string): string {
    const canonicalPath = canonicalizeAppHostPath(value);
    return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

/**
 * Compares the two path shapes the extension can receive for one C# AppHost:
 * the project from discovery and its Program.cs entry point from a running session.
 * The alias is accepted only when the directory has one C# project, because otherwise
 * selecting a project for Program.cs would be a guess.
 */
export function compareAppHostIdentity(left: string | undefined, right: string | undefined): AppHostIdentityRelation {
    if (!left || !right) {
        return 'different';
    }

    const leftKey = getAppHostPathComparisonKey(left);
    const rightKey = getAppHostPathComparisonKey(right);
    if (leftKey === rightKey) {
        return 'same';
    }

    const leftDirectory = path.dirname(canonicalizeAppHostPath(left));
    const rightDirectory = path.dirname(canonicalizeAppHostPath(right));
    if (getAppHostPathComparisonKey(leftDirectory) !== getAppHostPathComparisonKey(rightDirectory) ||
        !isProjectAndSourcePair(left, right)) {
        return 'different';
    }

    try {
        const projectCount = fs.readdirSync(leftDirectory, { withFileTypes: true })
            .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.csproj')
            .length;
        return projectCount === 1 ? 'same' : 'ambiguous';
    }
    catch {
        return 'ambiguous';
    }
}

export function isSameAppHost(left: string | undefined, right: string | undefined): boolean {
    return compareAppHostIdentity(left, right) === 'same';
}

function isProjectAndSourcePair(left: string, right: string): boolean {
    return (isCSharpProject(left) && isCSharpProjectSource(right)) ||
        (isCSharpProjectSource(left) && isCSharpProject(right));
}

function isCSharpProject(value: string): boolean {
    return path.extname(value).toLowerCase() === '.csproj';
}

function isCSharpProjectSource(value: string): boolean {
    return path.basename(value).toLowerCase() === 'program.cs';
}
