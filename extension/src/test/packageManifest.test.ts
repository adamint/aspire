import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

type ManifestMenuItem = {
    command?: string;
    when?: string;
};

type DebuggerProperty = {
    type?: string | string[];
    description?: string;
    additionalProperties?: { type?: string };
    items?: { type?: string };
    default?: unknown;
};

type DebuggerContribution = {
    type?: string;
    configurationAttributes?: {
        launch?: {
            properties?: { [key: string]: DebuggerProperty };
        };
    };
};

type ExtensionManifest = {
    contributes: {
        viewsWelcome?: Array<{ view?: string; contents?: string; when?: string }>;
        menus?: {
            'view/title'?: ManifestMenuItem[];
        };
        debuggers?: DebuggerContribution[];
    };
};

type PackageNls = Record<string, string>;

function readManifest(): ExtensionManifest {
    const manifestPath = path.resolve(__dirname, '../../package.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
}

function readPackageNls(): PackageNls {
    const packageNlsPath = path.resolve(__dirname, '../../package.nls.json');
    return JSON.parse(fs.readFileSync(packageNlsPath, 'utf8')) as PackageNls;
}

function assertContains(whenClause: string | undefined, fragment: string): void {
    assert.ok(whenClause?.includes(fragment), `Expected "${whenClause}" to contain "${fragment}"`);
}

suite('extension/package.json', () => {
    test('running apphosts welcome states use string view mode checks', () => {
        const manifest = readManifest();
        const runningAppHostsWelcome = manifest.contributes.viewsWelcome?.filter(item => item.view === 'aspire-vscode.runningAppHosts') ?? [];

        const workspaceWelcome = runningAppHostsWelcome.find(item => item.contents === '%views.runningAppHosts.welcome%');
        const globalWelcome = runningAppHostsWelcome.find(item => item.contents === '%views.runningAppHosts.globalWelcome%');

        assertContains(workspaceWelcome?.when, "aspire.viewMode != 'global'");
        assertContains(globalWelcome?.when, "aspire.viewMode == 'global'");
    });

    test('running apphosts title actions use string view and view mode checks', () => {
        const manifest = readManifest();
        const titleMenus = manifest.contributes.menus?.['view/title'] ?? [];

        const switchToGlobal = titleMenus.find(item => item.command === 'aspire-vscode.switchToGlobalView');
        const switchToWorkspace = titleMenus.find(item => item.command === 'aspire-vscode.switchToWorkspaceView');
        const refreshRunningAppHosts = titleMenus.find(item => item.command === 'aspire-vscode.refreshRunningAppHosts');

        assertContains(switchToGlobal?.when, "view == 'aspire-vscode.runningAppHosts'");
        assertContains(switchToGlobal?.when, "aspire.viewMode != 'global'");
        assertContains(switchToWorkspace?.when, "view == 'aspire-vscode.runningAppHosts'");
        assertContains(switchToWorkspace?.when, "aspire.viewMode == 'global'");
        assertContains(refreshRunningAppHosts?.when, "view == 'aspire-vscode.runningAppHosts'");
    });

    test('aspire launch configuration declares an env property as a string-valued object', () => {
        const manifest = readManifest();
        const aspireDebugger = manifest.contributes.debuggers?.find(d => d.type === 'aspire');
        const properties = aspireDebugger?.configurationAttributes?.launch?.properties;

        assert.ok(properties, 'Expected aspire debugger to declare launch configuration properties');
        const envProperty = properties.env;
        assert.ok(envProperty, 'Expected aspire launch configuration to declare an env property');
        assert.strictEqual(envProperty.type, 'object');
        assert.strictEqual(envProperty.additionalProperties?.type, 'string');
        assert.strictEqual(envProperty.description, '%extension.debug.env%');
    });

    test('aspire launch configuration declares an args property as a string array', () => {
        const manifest = readManifest();
        const aspireDebugger = manifest.contributes.debuggers?.find(d => d.type === 'aspire');
        const properties = aspireDebugger?.configurationAttributes?.launch?.properties;

        assert.ok(properties, 'Expected aspire debugger to declare launch configuration properties');
        const argsProperty = properties.args;
        assert.ok(argsProperty, 'Expected aspire launch configuration to declare an args property');
        assert.strictEqual(argsProperty.type, 'array');
        assert.strictEqual(argsProperty.items?.type, 'string');
        assert.strictEqual(argsProperty.description, '%extension.debug.args%');
    });

    test('running apphosts error welcome updates CLI with installer command that does not depend on current CLI support', () => {
        const packageNls = readPackageNls();
        const errorWelcome = packageNls['views.runningAppHosts.errorWelcome'];

        assert.ok(!errorWelcome.includes('not installed'), `Error welcome should not report the CLI as not installed when it may only be unavailable to VS Code or too old: ${errorWelcome}`);
        assert.ok(errorWelcome.includes('(command:aspire-vscode.installCliDaily)'), `Expected error welcome to link to the daily installer command: ${errorWelcome}`);
        assert.ok(!errorWelcome.includes('(command:aspire-vscode.updateSelf)'), `Error welcome must not use updateSelf because old CLIs may not support self update: ${errorWelcome}`);
    });
});
