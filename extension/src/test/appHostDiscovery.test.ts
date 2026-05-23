/// <reference types="mocha" />

import * as assert from 'assert';
import * as path from 'path';
import { findCandidateForEditorFile, getDebugTargetForCandidate } from '../utils/appHostDiscovery';

suite('AppHost discovery', () => {
    test('resolves SDK-style C# AppHost source file to discovered project candidate', () => {
        const appHostProjectPath = buildPath('workspace', 'AppHost', 'AppHost.csproj');
        const programPath = buildPath('workspace', 'AppHost', 'Program.cs');

        const candidate = findCandidateForEditorFile(programPath, [{
            path: appHostProjectPath,
            language: 'C#',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, appHostProjectPath);
        assert.strictEqual(candidate ? getDebugTargetForCandidate(candidate) : undefined, appHostProjectPath);
    });

    test('keeps file-based C# AppHost candidate as source file', () => {
        const appHostPath = buildPath('workspace', 'AppHost', 'apphost.cs');

        const candidate = findCandidateForEditorFile(appHostPath, [{
            path: appHostPath,
            language: 'C#',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, appHostPath);
        assert.strictEqual(candidate ? getDebugTargetForCandidate(candidate) : undefined, appHostPath);
    });

    test('returns undefined when no discovered candidate contains C# source file', () => {
        const programPath = buildPath('workspace', 'Web', 'Program.cs');

        const candidate = findCandidateForEditorFile(programPath, [{
            path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
            language: 'C#',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate, undefined);
    });

    test('does not map source file to non-C# project candidate', () => {
        const programPath = buildPath('workspace', 'AppHost', 'Program.cs');

        const candidate = findCandidateForEditorFile(programPath, [{
            path: buildPath('workspace', 'AppHost', 'apphost.ts'),
            language: 'TypeScript',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate, undefined);
    });

    test('maps C# file in AppHost project directory to discovered project candidate', () => {
        const helperPath = buildPath('workspace', 'AppHost', 'Helper.cs');

        const candidate = findCandidateForEditorFile(helperPath, [{
            path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
            language: 'C#',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate?.path, buildPath('workspace', 'AppHost', 'AppHost.csproj'));
    });

    test('does not map C# file under bin directory to discovered project candidate', () => {
        const generatedPath = buildPath('workspace', 'AppHost', 'bin', 'Debug', 'net10.0', 'Generated.cs');

        const candidate = findCandidateForEditorFile(generatedPath, [{
            path: buildPath('workspace', 'AppHost', 'AppHost.csproj'),
            language: 'C#',
            status: 'buildable',
        }]);

        assert.strictEqual(candidate, undefined);
    });
});

function buildPath(...segments: string[]): string {
    return path.join(path.sep, ...segments);
}
