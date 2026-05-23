/// <reference types="mocha" />

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AspireDebugConfigurationProvider } from '../debugger/AspireDebugConfigurationProvider';

suite('AspireDebugConfigurationProvider', () => {
    let tempDir: string;

    setup(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-debug-configuration-provider-'));
    });

    teardown(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('resolves launch config SDK-style AppHost Program.cs to containing project file', async () => {
        const appHostDirectory = path.join(tempDir, 'AppHost');
        fs.mkdirSync(appHostDirectory);

        const programPath = path.join(appHostDirectory, 'Program.cs');
        const projectPath = path.join(appHostDirectory, 'AppHost.csproj');
        fs.writeFileSync(programPath, 'var builder = DistributedApplication.CreateBuilder(args);\nbuilder.Build().Run();');
        fs.writeFileSync(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />');

        const provider = new AspireDebugConfigurationProvider();
        const config = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
            name: 'Debug AppHost',
            type: 'aspire',
            request: 'launch',
            program: programPath
        });

        assert.strictEqual(config?.program, projectPath);
    });

    test('leaves launch config single-file apphost.cs unchanged', async () => {
        const appHostPath = path.join(tempDir, 'apphost.cs');
        fs.writeFileSync(appHostPath, '#:sdk Aspire.AppHost.Sdk\nvar builder = DistributedApplication.CreateBuilder(args);');

        const provider = new AspireDebugConfigurationProvider();
        const config = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
            name: 'Debug AppHost',
            type: 'aspire',
            request: 'launch',
            program: appHostPath
        });

        assert.strictEqual(config?.program, appHostPath);
    });

    test('leaves launch config non-AppHost C# source file unchanged', async () => {
        const appDirectory = path.join(tempDir, 'App');
        fs.mkdirSync(appDirectory);

        const programPath = path.join(appDirectory, 'Program.cs');
        fs.writeFileSync(programPath, 'Console.WriteLine("Hello");');
        fs.writeFileSync(path.join(appDirectory, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');

        const provider = new AspireDebugConfigurationProvider();
        const config = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, {
            name: 'Debug AppHost',
            type: 'aspire',
            request: 'launch',
            program: programPath
        });

        assert.strictEqual(config?.program, programPath);
    });
});
