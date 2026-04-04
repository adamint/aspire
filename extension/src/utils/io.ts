import { realpathSync } from 'fs';
import { access, stat } from 'fs/promises';

/**
 * Resolves a file path to its canonical on-disk casing using the native OS realpath.
 * On case-insensitive file systems (macOS, Windows), this returns the path with
 * the actual casing stored on disk, preventing case mismatches when paths are
 * compared or hashed by other tools (e.g., the Aspire CLI backchannel socket lookup).
 * Falls back to the original path if the native realpath call fails for any reason
 * (e.g., the file does not exist).
 */
export function resolveCanonicalPath(p: string): string {
    try {
        return realpathSync.native(p);
    } catch {
        return p;
    }
}

export async function doesFileExist(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

export async function isDirectory(path: string): Promise<boolean> {
    try {
        const statResult = await stat(path);
        return statResult.isDirectory();
    } catch {
        return false;
    }
}
