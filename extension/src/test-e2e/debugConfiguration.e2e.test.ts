import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { executeE2eControlCommand } from './helpers/fixtures';
import { waitForWorkspaceAppHost } from './helpers/assertions';
import { getWorkspaceRoot } from './helpers/paths';
import { openAspireView } from './helpers/vscode';

suite('Aspire debug configuration E2E', function () {
    this.timeout(60000);

    const projectDirectory = path.join(getWorkspaceRoot(), 'MauiNoDebugProject');
    const projectPath = path.join(projectDirectory, 'MauiNoDebugProject.csproj');

    teardown(() => {
        fs.rmSync(projectDirectory, { recursive: true, force: true });
    });

    test('uses dotnet run for NoDebug project launch configurations', async () => {
        await openAspireView();
        await waitForWorkspaceAppHost();

        fs.mkdirSync(projectDirectory, { recursive: true });
        fs.writeFileSync(projectPath, `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0-ios</TargetFramework>
  </PropertyGroup>
</Project>
`);

        const status = await executeE2eControlCommand({
            name: 'createNoDebugProjectDebugConfiguration',
            projectPath,
            args: ['run', '-p:TargetFramework=net10.0-ios', '-p:RuntimeIdentifier=iossimulator-x64'],
        });

        assert.strictEqual(status.status, 'applied');
        assert.ok(isDebugConfiguration(status.result), `Expected debug configuration result, got ${JSON.stringify(status.result)}`);
        assert.strictEqual(status.result.type, 'coreclr');
        assert.strictEqual(status.result.program, 'dotnet');
        assert.deepStrictEqual(status.result.args, ['run', '--project', projectPath, '--no-launch-profile', '-p:TargetFramework=net10.0-ios', '-p:RuntimeIdentifier=iossimulator-x64']);
        assert.strictEqual(status.result.cwd, projectDirectory);
        assert.strictEqual(status.result.noDebug, true);
        assert.strictEqual(status.result.executablePath, undefined);
    });
});

interface DebugConfigurationResult {
    readonly type: string;
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly noDebug: boolean;
    readonly executablePath?: string;
}

function isDebugConfiguration(value: unknown): value is DebugConfigurationResult {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<DebugConfigurationResult>;
    return typeof candidate.type === 'string'
        && typeof candidate.program === 'string'
        && Array.isArray(candidate.args)
        && typeof candidate.cwd === 'string'
        && typeof candidate.noDebug === 'boolean';
}
