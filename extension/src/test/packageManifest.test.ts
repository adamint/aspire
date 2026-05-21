import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

type ManifestMenuItem = {
    command?: string;
    when?: string;
};

type CommandContribution = {
    command?: string;
    title?: string;
    category?: string;
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
        commands?: CommandContribution[];
        viewsWelcome?: Array<{ view?: string; contents?: string; when?: string }>;
        menus?: {
            commandPalette?: ManifestMenuItem[];
            'view/title'?: ManifestMenuItem[];
        };
        debuggers?: DebuggerContribution[];
    };
};

function readManifest(): ExtensionManifest {
    const manifestPath = path.resolve(__dirname, '../../package.json');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;
}

function readPackageNls(): Record<string, string> {
    const packageNlsPath = path.resolve(__dirname, '../../package.nls.json');
    return JSON.parse(fs.readFileSync(packageNlsPath, 'utf8')) as Record<string, string>;
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

    test('open dashboard to the side command is contributed and localized', () => {
        const manifest = readManifest();
        const packageNls = readPackageNls();

        const command = manifest.contributes.commands?.find(c => c.command === 'aspire-vscode.openDashboardToSide');
        assert.ok(command, 'Expected the side-by-side dashboard command to be contributed');
        assert.strictEqual(command.title, '%command.openDashboardToSide%');
        assert.strictEqual(command.category, 'Aspire');
        assert.strictEqual(packageNls['command.openDashboardToSide'], 'Open Aspire Dashboard to the Side');
    });

    test('open dashboard to the side command palette item is visible when AppHosts are running', () => {
        const manifest = readManifest();
        const commandPalette = manifest.contributes.menus?.commandPalette ?? [];

        const command = commandPalette.find(c => c.command === 'aspire-vscode.openDashboardToSide');
        assert.ok(command, 'Expected the side-by-side dashboard command in the command palette');
        assert.strictEqual(command.when, '!aspire.noRunningAppHosts');
    });
});
