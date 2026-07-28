import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TelemetryReporter } from '@vscode/extension-telemetry';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { __detectTelemetryLoggingOnlyForTests, __resetCommonPropertiesForTests, __resetTelemetryClientVersionProviderForTests, __resetTelemetryLoggingModeForTests, __resetTelemetryReporterFactoryForTests, __setReporterForTests, __setTelemetryClientVersionProviderForTests, __setTelemetryLoggingOnlyForTests, __setTelemetryReporterFactoryForTests, classifyError, initializeTelemetry, isCommandCancellation, sendTelemetryErrorEvent, sendTelemetryEvent, setCommandInvocationListener, setCommonTelemetryProperties, withCommandTelemetry } from '../utils/telemetry';

interface RecordedEvent {
    name: string;
    properties?: Record<string, string>;
    measurements?: Record<string, number>;
    isError?: boolean;
    isDangerous?: boolean;
}

type TelemetryLevel = 'all' | 'error' | 'crash' | 'off';

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function getExtensionTelemetryPackageVersion(): string {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const extensionPackage = readJsonFile<{ dependencies?: Record<string, string> }>(path.join(extensionRoot, 'package.json'));
    const telemetryPackage = readJsonFile<{ version: string }>(path.join(extensionRoot, 'node_modules', '@vscode', 'extension-telemetry', 'package.json'));
    assert.strictEqual(extensionPackage.dependencies?.['@vscode/extension-telemetry'], telemetryPackage.version);
    return telemetryPackage.version;
}

// A minimal fake TelemetryReporter that records calls and exposes
// `telemetryLevel`. The extension routes telemetry through
// `sendDangerousTelemetryEvent` / `sendDangerousTelemetryErrorEvent` so the
// VS Code `TelemetryLogger`-applied `<extensionId>/` prefix is bypassed; the
// regular `sendTelemetryEvent` / `sendTelemetryErrorEvent` methods are kept
// here only to fail loudly if the extension ever silently regresses back to
// the prefixed path.
class FakeTelemetryReporter {
    public events: RecordedEvent[] = [];
    public telemetryLevel: TelemetryLevel = 'all';

    sendTelemetryEvent(): void {
        throw new Error('Telemetry must use sendDangerousTelemetryEvent so VS Code does not add the extension-id prefix.');
    }

    sendTelemetryErrorEvent(): void {
        throw new Error('Telemetry must use sendDangerousTelemetryErrorEvent so VS Code does not add the extension-id prefix.');
    }

    sendDangerousTelemetryEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name, properties, measurements, isDangerous: true });
    }

    sendDangerousTelemetryErrorEvent(name: string, properties?: Record<string, string>, measurements?: Record<string, number>): void {
        this.events.push({ name, properties, measurements, isError: true, isDangerous: true });
    }

    sendRawTelemetryEvent(): void { /* not used here */ }

    dispose(): Promise<void> { return Promise.resolve(); }
}

suite('telemetry utilities', () => {
    let fake: FakeTelemetryReporter;
    let restore: () => void;

    setup(() => {
        fake = new FakeTelemetryReporter();
        restore = __setReporterForTests(fake as unknown as Parameters<typeof __setReporterForTests>[0]);
        __resetCommonPropertiesForTests();
    });

    teardown(() => {
        setCommandInvocationListener(undefined);
        restore();
        __resetTelemetryReporterFactoryForTests();
        __resetTelemetryClientVersionProviderForTests();
        __resetTelemetryLoggingModeForTests();
        __resetCommonPropertiesForTests();
    });

    test('sendTelemetryEvent merges common properties', () => {
        setCommonTelemetryProperties({ apphost_languages: 'csharp', apphost_present: 'true' });
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.x' });
        assert.strictEqual(fake.events.length, 1);
        const event = fake.events[0];
        assert.strictEqual(event.name, 'aspire/vscode/command/invoked');
        assert.deepStrictEqual(event.properties, {
            apphost_languages: 'csharp',
            apphost_present: 'true',
            command: 'cmd.x',
        });
    });

    test('setCommonTelemetryProperties replaces and clears keys', () => {
        setCommonTelemetryProperties({ apphost_languages: 'first', apphost_present: 'keep' });
        setCommonTelemetryProperties({ apphost_languages: undefined });
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.y' });
        assert.deepStrictEqual(fake.events[0].properties, { apphost_present: 'keep', command: 'cmd.y' });
    });

    test('sendTelemetryEvent emits via the dangerous channel so VS Code does not add an extension-id prefix', () => {
        // `vscode.env.createTelemetryLogger` (used internally by
        // `@vscode/extension-telemetry`'s regular `sendTelemetryEvent`) prepends
        // `<extensionId>/` to every event name, turning
        // `aspire/vscode/command/invoked` into
        // `microsoft-aspire.aspire-vscode/aspire/vscode/command/invoked` on
        // the wire. `sendDangerousTelemetryEvent` skips the logger and reaches
        // the sender directly, preserving the registry-declared name verbatim.
        // This test pins the dangerous path so a future refactor cannot
        // accidentally regress back to the prefixed channel.
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.prefixed' });

        assert.strictEqual(fake.events.length, 1);
        assert.strictEqual(fake.events[0].name, 'aspire/vscode/command/invoked');
        assert.strictEqual(fake.events[0].isDangerous, true, 'must route through sendDangerousTelemetryEvent');
        assert.notStrictEqual(fake.events[0].name.startsWith('microsoft-aspire.aspire-vscode/'), true, 'wire name must not include extension-id prefix');
    });

    test('sendTelemetryErrorEvent emits via the dangerous error channel', () => {
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        }, { duration_ms: 12 });

        assert.strictEqual(fake.events.length, 1);
        const event = fake.events[0];
        assert.strictEqual(event.name, 'aspire/vscode/debug/runsession/end');
        assert.strictEqual(event.isError, true);
        assert.strictEqual(event.isDangerous, true, 'must route through sendDangerousTelemetryErrorEvent');
    });

    test('dashboard passthrough event names emit verbatim through the dangerous channel', () => {
        // Sanity-check that an `aspire/dashboard/*` registry entry reaches the
        // wire as-is. The passthrough is the only producer that uses this
        // namespace; the prefix bypass is what lets the dashboard's native
        // `aspire/dashboard/...` names survive intact (instead of becoming
        // `microsoft-aspire.aspire-vscode/aspire/dashboard/...`).
        sendTelemetryEvent('aspire/dashboard/operation', {
            dashboard_event_name: 'aspire/dashboard/command',
            result: 'success',
        });

        assert.strictEqual(fake.events.length, 1);
        assert.strictEqual(fake.events[0].name, 'aspire/dashboard/operation');
        assert.strictEqual(fake.events[0].isDangerous, true);
    });

    test('sendTelemetryEvent sanitizes property values before the dangerous send path', () => {
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cmd.leak user@example.com /Users/alice/source C:\\Users\\bob\\source --token=secret client_secret=secret connectionstring=secret https://storage.example/?sig=signature Authorization: Bearer abc.def-ghi 4fd8856f-0fc4-4c65-9074-c234c5a0898b',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'cmd.leak <email> /Users/<user>/source C:\\Users\\<user>\\source --token=<redacted> client_secret=<redacted> connectionstring=<redacted> https://<redacted> Authorization: Bearer <redacted> <guid>');
    });

    test('sendTelemetryEvent redacts arbitrary URL hosts and non-home filesystem paths', () => {
        // Item 1: the manual sanitizer replaces the `TelemetryLogger.cleanData()` that the dangerous
        // send path bypasses. cleanData strips whole URLs and absolute paths, so a private host such
        // as `https://storage.example/...` or a workspace path such as `/mnt/customer/project` must
        // not survive. Only the URL scheme is kept for coarse analytics.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'open https://storage.example/container/blob?x=1 file:///opt/data /mnt/customer/project D:\\Work\\customer\\proj',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'open https://<redacted> file://<redacted> <path> <path>');
    });

    test('sendTelemetryEvent redacts URI-prefixed values and home paths inside them', () => {
        // Custom/remote schemes (`file://`, `vscode-remote://`) must be redacted just like http(s):
        // the whole URL is replaced (scheme kept) so a private remote host/authority cannot leak. A
        // non-URL Windows home path in the same value is still redacted to `<user>`.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cmd.leak file:///Users/alice/source vscode-remote://ssh-remote+devbox/home/bob/source C:\\Users\\Bob Smith\\source',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'cmd.leak file://<redacted> vscode-remote://<redacted> C:\\Users\\<user>\\source');
    });

    test('sendTelemetryEvent keeps sanitized JSON dashboard values parseable', () => {
        // Dashboard passthrough values cross a JSON boundary. Redaction must not corrupt the JSON: a
        // backslash-encoded Windows home path (`C:\\Users\\...`) must keep its doubled separators and
        // the string must still parse after the host/path redaction runs.
        const payload = JSON.stringify({ userAgent: 'Browser C:\\Users\\bob\\workspace', endpoint: 'https://acct.blob.core/container?sig=x' });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: payload,
        });

        const sanitized = fake.events[0].properties?.command ?? '';
        const parsed = JSON.parse(sanitized) as { userAgent: string; endpoint: string };
        assert.strictEqual(parsed.userAgent, 'Browser C:\\Users\\<user>\\workspace');
        assert.strictEqual(parsed.endpoint, 'https://<redacted>');
    });

    test('sendTelemetryEvent sanitizes JSON-encoded dashboard bundle values without corrupting JSON', () => {
        // The dashboard passthrough emits its properties bundle as a JSON string in
        // `dashboard_properties`. Sanitization must redact the embedded home path while keeping the
        // doubled backslashes so the bundle still parses downstream.
        sendTelemetryEvent('aspire/dashboard/operation', {
            dashboard_event_name: 'aspire/dashboard/component/open',
            result: 'success',
            dashboard_properties: JSON.stringify({
                v: {
                    'Aspire.Dashboard.UserAgent': 'Browser C:\\Users\\bob\\workspace',
                },
            }),
        });

        const dashboardProperties = fake.events[0].properties?.dashboard_properties;
        if (dashboardProperties === undefined) {
            assert.fail('Expected dashboard_properties to be emitted.');
        }
        const parsed = JSON.parse(dashboardProperties);
        assert.strictEqual(parsed.v['Aspire.Dashboard.UserAgent'], 'Browser C:\\Users\\<user>\\workspace');
    });

    test('sendTelemetryEvent redacts standalone credential tokens that are not key=value assignments', () => {
        // Item 1: VS Code's `TelemetryLogger.cleanData()` (bypassed on the dangerous send path)
        // wipes standalone credential shapes — Google API keys, JWTs, Slack tokens, and GitHub
        // PATs — that carry no `key=` prefix or `Bearer` header. Restore equivalent coverage so a
        // bare token pasted into a command cannot leak verbatim.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'auth AIzaSyA1234567890abcdefghijklmnopqrstuv eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U xoxb-1234567890-abcdefghij ghp_1234567890abcdefghijklmnopqrstuvwxyz github_pat_AAAAAAAAAAAAAAAAAAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'auth <redacted> <redacted> <redacted> <redacted> <redacted>');
    });

    test('sendTelemetryEvent redacts a standalone token nested inside a JSON dashboard bundle', () => {
        // A credential can arrive as a leaf inside the `dashboard_properties` JSON bundle. Structural
        // sanitization must redact it while keeping the bundle parseable.
        sendTelemetryEvent('aspire/dashboard/operation', {
            dashboard_event_name: 'aspire/dashboard/component/open',
            result: 'success',
            dashboard_properties: JSON.stringify({
                v: {
                    'Aspire.Dashboard.Token': 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
                },
            }),
        });

        const dashboardProperties = fake.events[0].properties?.dashboard_properties;
        if (dashboardProperties === undefined) {
            assert.fail('Expected dashboard_properties to be emitted.');
        }
        const parsed = JSON.parse(dashboardProperties);
        assert.strictEqual(parsed.v['Aspire.Dashboard.Token'], '<redacted>');
    });

    test('sendTelemetryEvent redacts a secret in a JSON-escaped quoted value without corrupting JSON', () => {
        // Item 2: `JSON.stringify({ x: 'token="secret"' })` is `{"x":"token=\"secret\""}`. A text-level
        // `token=...` regex consumes only up to the escaped quote, leaking `secret` and leaving an
        // unescaped quote that makes the bundle unparseable. Structural sanitization decodes the leaf
        // first, so the secret is redacted and the JSON still parses.
        const payload = JSON.stringify({ x: 'token="secret"' });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: payload,
        });

        const sanitized = fake.events[0].properties?.command ?? '';
        assert.strictEqual(sanitized, '{"x":"token=\\"<redacted>\\""}');
        const parsed = JSON.parse(sanitized) as { x: string };
        assert.strictEqual(parsed.x, 'token="<redacted>"');
    });

    test('sendTelemetryEvent redacts UNC network paths, including doubled separators in JSON bundles', () => {
        // Item 4: VS Code's `cleanData()` treats UNC paths (`\\server\share\...`) as absolute paths.
        // They have no drive letter, so the earlier fallback (drive-letter only) let them through. The
        // bare form and the JSON-encoded form (every separator doubled) must both be redacted.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'open \\\\server\\share\\customer\\project',
        });
        assert.strictEqual(fake.events[0].properties?.command, 'open <path>');

        fake.events.length = 0;
        const payload = JSON.stringify({ p: '\\\\server\\share\\customer\\project' });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: payload,
        });
        const sanitized = fake.events[0].properties?.command ?? '';
        const parsed = JSON.parse(sanitized) as { p: string };
        assert.strictEqual(parsed.p, '<path>');
    });

    test('sendTelemetryEvent redacts a URL through the next whitespace so a quoted query tail cannot leak', () => {
        // A quote used to terminate the URL match and leak the query tail:
        // `https://private.example/?q="customer"&account=alice` became
        // `https://<redacted>"customer"&account=alice`, so `&account=alice` survived. JSON bundles
        // are sanitized structurally upstream, so a quote here is a literal character in free-form
        // text and can be consumed like VS Code's `cleanData()` does — redact through whitespace.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'open https://private.example/?q="customer"&account=alice then quit',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'open https://<redacted> then quit');
    });

    test('sendTelemetryEvent redacts a bearer token through the next whitespace so a quoted tail cannot leak', () => {
        // Same class of bug as the URL case, but for a secret: a quote inside the token used to leave
        // the tail behind (`authorization: bearer abc"def` -> `authorization: bearer <redacted>"def`).
        // The token body stops on whitespace or `,;}` but not on a quote.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'authorization: bearer abc"def, next',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'authorization: bearer <redacted>, next');
    });

    test('sendTelemetryEvent redacts a URL with a quoted query inside a JSON bundle and keeps it parseable', () => {
        // The structural path must stay unharmed by the whitespace-through redaction: the URL leaf is
        // fully redacted and the bundle still round-trips as valid JSON.
        const payload = JSON.stringify({ url: 'https://private.example/?q="customer"&account=alice' });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: payload,
        });

        const sanitized = fake.events[0].properties?.command ?? '';
        assert.strictEqual(sanitized, '{"url":"https://<redacted>"}');
        const parsed = JSON.parse(sanitized) as { url: string };
        assert.strictEqual(parsed.url, 'https://<redacted>');
    });

    test('sendTelemetryEvent redacts home usernames that contain spaces', () => {
        // The username is a single path segment that can legitimately contain spaces. Redaction must
        // consume the whole segment up to the next separator instead of stopping at the first space
        // (which previously leaked the rest of the username, e.g. `.../<user> Smith/project`).
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'posix /Users/Alice Smith/project win C:\\Users\\Alice Smith\\project home /home/Alice Smith/project',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            'posix /Users/<user>/project win C:\\Users\\<user>\\project home /home/<user>/project');
    });

    test('sendTelemetryEvent redacts exact home directories that contain spaces', () => {
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: '/Users/Alice Smith',
        });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'C:\\Users\\Alice Smith',
        });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: '/home/Alice Smith',
        });

        assert.strictEqual(fake.events[0].properties?.command, '/Users/<user>');
        assert.strictEqual(fake.events[1].properties?.command, 'C:\\Users\\<user>');
        assert.strictEqual(fake.events[2].properties?.command, '/home/<user>');
    });

    test('sendTelemetryEvent redacts embedded terminal home directories that contain spaces', () => {
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cwd=/Users/Alice Smith --flag',
        });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cwd="C:\\Users\\Alice Smith" --flag',
        });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cwd=/home/Alice Smith',
        });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cwd=/Users/Alice Smith -f',
        });
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: 'cwd=/Users/Alice Bob Carol Dave --flag',
        });

        assert.strictEqual(fake.events[0].properties?.command, 'cwd=/Users/<user> --flag');
        assert.strictEqual(fake.events[1].properties?.command, 'cwd="C:\\Users\\<user>" --flag');
        assert.strictEqual(fake.events[2].properties?.command, 'cwd=/home/<user>');
        assert.strictEqual(fake.events[3].properties?.command, 'cwd=/Users/<user> -f');
        assert.strictEqual(fake.events[4].properties?.command, 'cwd=/Users/<user> --flag');
    });

    test('sendTelemetryEvent redacts the current home directory before shell and punctuation boundaries', () => {
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;
        const homeDirectory = process.platform === 'win32' ? 'C:\\Users\\Alice Smith' : '/Users/Alice Smith';
        const expectedHomeDirectory = process.platform === 'win32' ? 'C:\\Users\\<user>' : '/Users/<user>';

        try {
            if (process.platform === 'win32') {
                process.env.USERPROFILE = homeDirectory;
            }
            else {
                process.env.HOME = homeDirectory;
            }

            sendTelemetryEvent('aspire/vscode/command/invoked', {
                command: `open ${homeDirectory} | cat`,
            });
            sendTelemetryEvent('aspire/vscode/command/invoked', {
                command: `path is ${homeDirectory}, ok building ${homeDirectory} failed`,
            });

            assert.strictEqual(fake.events[0].properties?.command, `open ${expectedHomeDirectory} | cat`);
            assert.strictEqual(fake.events[1].properties?.command, `path is ${expectedHomeDirectory}, ok building ${expectedHomeDirectory} failed`);
        }
        finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            }
            else {
                process.env.HOME = originalHome;
            }

            if (originalUserProfile === undefined) {
                delete process.env.USERPROFILE;
            }
            else {
                process.env.USERPROFILE = originalUserProfile;
            }
        }
    });

    test('sendTelemetryEvent redacts exact Windows current home directories before punctuation and words', () => {
        const originalHome = process.env.HOME;
        const originalUserProfile = process.env.USERPROFILE;

        try {
            process.env.HOME = 'C:\\Users\\Alice Smith';
            process.env.USERPROFILE = 'C:\\Users\\Alice Smith';

            sendTelemetryEvent('aspire/vscode/command/invoked', {
                command: 'path is C:\\Users\\Alice Smith, ok building C:\\Users\\Alice Smith failed',
            });

            assert.strictEqual(fake.events[0].properties?.command, 'path is C:\\Users\\<user>, ok building C:\\Users\\<user> failed');
        }
        finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            }
            else {
                process.env.HOME = originalHome;
            }

            if (originalUserProfile === undefined) {
                delete process.env.USERPROFILE;
            }
            else {
                process.env.USERPROFILE = originalUserProfile;
            }
        }
    });

    test('sendTelemetryEvent redacts quoted secrets', () => {
        // The trailing `https://...?sig="signature"&next=1` is redacted to a bare `https://<redacted>`:
        // the sig pass redacts the value and then the URL pass consumes the whole URL through the next
        // whitespace (quotes no longer terminate it), so no query tail survives.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: '--token="secret" token=\'secret\' password=\'secret\' https://storage.example/?sig="signature"&next=1',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            '--token="<redacted>" token=\'<redacted>\' password=\'<redacted>\' https://<redacted>');
    });

    test('sendTelemetryEvent redacts quoted secrets that contain spaces', () => {
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: '--token="secret value" token=\'secret value\' https://storage.example/?sig="secret value"&next=1',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            '--token="<redacted>" token=\'<redacted>\' https://<redacted>');
    });

    test('sendTelemetryEvent does not over-redact path segments after a spaced home username', () => {
        // Only the username segment should be redacted. A following, unrelated path segment (which may
        // itself contain spaces) and adjacent tokens must survive because redaction stops at the
        // separator that ends the username.
        sendTelemetryEvent('aspire/vscode/command/invoked', {
            command: '/Users/Alice Smith/some folder/file --flag /Users/alice C:\\Users\\bob\\x',
        });

        assert.strictEqual(
            fake.events[0].properties?.command,
            '/Users/<user>/some folder/file --flag /Users/<user> C:\\Users\\<user>\\x');
    });

    test('telemetry level "off" suppresses regular and error events', () => {
        fake.telemetryLevel = 'off';
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.off' });
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });
        assert.strictEqual(fake.events.length, 0);
    });

    test('VS Code logging-only mode is detected and gates the dangerous send path', () => {
        // Item 2: the `sendDangerous*` APIs bypass `TelemetryLogger`, which is what normally enforces
        // VS Code's "logging only" mode (used by extension test hosts and OSS builds). Without a gate,
        // running the extension's tests would emit REAL telemetry to the production key. There is no
        // public API that reports this state, so the gate detects it behaviorally by routing a probe
        // through a throwaway `TelemetryLogger` and observing whether VS Code invokes the sender.
        //
        // Prove the mechanism, not just an override: the extension test host is logging-only, so the
        // real behavioral probe must report logging-only even though `vscode.env.isTelemetryEnabled`
        // is true and the level is `'all'`. This is exactly the condition (telemetry "enabled" yet the
        // sender unreachable) that neither `isTelemetryEnabled` nor `telemetryLevel` can distinguish.
        assert.strictEqual(vscode.env.isTelemetryEnabled, true, 'expected the extension test host to report telemetry as enabled');
        fake.telemetryLevel = 'all';
        assert.strictEqual(__detectTelemetryLoggingOnlyForTests(), true, 'expected the behavioral probe to detect logging-only mode in the test host');

        // Prove both send paths consult the gate: forced logging-only suppresses, cleared emits.
        const restoreLoggingOnly = __setTelemetryLoggingOnlyForTests(true);
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.suppressed' });
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });
        assert.strictEqual(fake.events.length, 0, 'logging-only mode must not reach the telemetry sender');

        restoreLoggingOnly();
        __setTelemetryLoggingOnlyForTests(false);
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.allowed' });
        assert.strictEqual(fake.events.length, 1);
        assert.strictEqual(fake.events[0].properties?.command, 'cmd.allowed');
    });

    test('telemetry level "crash" suppresses regular and error events from our gate', () => {
        // We do not currently expose a crash channel; matching the underlying
        // reporter's behavior, only `'all'` allows usage events and `'error'`
        // or above allows error events. `'crash'` should suppress both.
        fake.telemetryLevel = 'crash';
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.crash' });
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });
        assert.strictEqual(fake.events.length, 0);
    });

    test('telemetry level "error" suppresses regular events but allows error events', () => {
        fake.telemetryLevel = 'error';
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.errorOnly' });
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });
        assert.strictEqual(fake.events.length, 1);
        assert.strictEqual(fake.events[0].isError, true);
        assert.strictEqual(fake.events[0].name, 'aspire/vscode/debug/runsession/end');
    });

    test('telemetry level "all" allows both regular and error events', () => {
        fake.telemetryLevel = 'all';
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.allRegular' });
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });

        assert.strictEqual(fake.events.length, 2);
        assert.strictEqual(fake.events[0].isError, undefined);
        assert.strictEqual(fake.events[0].isDangerous, true);
        assert.strictEqual(fake.events[1].isError, true);
        assert.strictEqual(fake.events[1].isDangerous, true);
    });

    test('telemetry level is consulted per emit so mid-session changes are honored immediately', () => {
        fake.telemetryLevel = 'all';
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.beforeFlip' });
        fake.telemetryLevel = 'off';
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.afterFlip' });
        assert.strictEqual(fake.events.length, 1);
        assert.strictEqual(fake.events[0].properties?.command, 'cmd.beforeFlip');

        fake.telemetryLevel = 'error';
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });
        assert.strictEqual(fake.events.length, 2);
        assert.strictEqual(fake.events[1].isError, true);
    });

    test('uninitialized reporter drops regular and error events silently', () => {
        restore();
        sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.noReporter' });
        sendTelemetryErrorEvent('aspire/vscode/debug/runsession/end', {
            resource_type: 'project',
            mode: 'run',
            exit_code_bucket: 'nonzero',
            end_reason: 'process_exit',
        });
        assert.strictEqual(fake.events.length, 0);

        restore = __setReporterForTests(fake as unknown as Parameters<typeof __setReporterForTests>[0]);
    });

    test('initializeTelemetry constructs the reporter and emits unprefixed event names', () => {
        restore();
        // initializeTelemetry marks the reporter as production (not a test fake), so the logging-only
        // gate would otherwise suppress the emit in this logging-only test host. Disable the gate here
        // to exercise the real init/emit path; logging-only detection has its own dedicated test.
        const restoreLoggingOnly = __setTelemetryLoggingOnlyForTests(false);
        let createdWithKey: string | undefined;
        const restoreFactory = __setTelemetryReporterFactoryForTests((aiKey) => {
            createdWithKey = aiKey;
            return fake as unknown as TelemetryReporter;
        });

        try {
            const subscriptions: vscode.Disposable[] = [];
            initializeTelemetry({
                extension: {
                    id: 'microsoft-aspire.aspire-vscode',
                    packageJSON: {
                        aiKey: 'test-key',
                        version: '1.2.3'
                    }
                },
                subscriptions
            } as unknown as vscode.ExtensionContext);

            sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.initialized' });

            assert.strictEqual(createdWithKey, 'test-key');
            assert.strictEqual(subscriptions.length, 1);
            assert.strictEqual(fake.events[0].name, 'aspire/vscode/command/invoked');
            assert.strictEqual(fake.events[0].isDangerous, true);
            assert.strictEqual(fake.events[0].properties?.['common.extname'], 'microsoft-aspire.aspire-vscode');
            assert.strictEqual(fake.events[0].properties?.['common.extversion'], '1.2.3');
            assert.strictEqual(fake.events[0].properties?.['common.vscodemachineid'], vscode.env.machineId);
            assert.strictEqual(fake.events[0].properties?.['common.vscodesessionid'], vscode.env.sessionId);
            assert.strictEqual(fake.events[0].properties?.['common.vscodeversion'], vscode.version);
            assert.strictEqual(fake.events[0].properties?.['common.product'], vscode.env.appHost);
            let expectedUiKind: string;
            switch (vscode.env.uiKind) {
                case vscode.UIKind.Desktop:
                    expectedUiKind = 'desktop';
                    break;
                case vscode.UIKind.Web:
                    expectedUiKind = 'web';
                    break;
                default:
                    expectedUiKind = String(vscode.env.uiKind);
                    break;
            }
            assert.strictEqual(fake.events[0].properties?.['common.uikind'], expectedUiKind);
            assert.strictEqual(fake.events[0].properties?.['common.remotename'], vscode.env.remoteName ?? 'none');
            assert.strictEqual(fake.events[0].properties?.['common.isnewappinstall'], String(vscode.env.isNewAppInstall));
            if (vscode.env.appRoot) {
                const productJsonPath = path.join(vscode.env.appRoot, 'product.json');
                if (fs.existsSync(productJsonPath)) {
                    assert.strictEqual(fake.events[0].properties?.['common.vscodecommithash'], readJsonFile<{ commit: string }>(productJsonPath).commit);
                }
            }
            assert.strictEqual(fake.events[0].properties?.['common.telemetryclientversion'], getExtensionTelemetryPackageVersion());
        }
        finally {
            restoreFactory();
            restoreLoggingOnly();
        }
    });

    test('common.telemetryclientversion flows through from the injected provider instead of a hard-coded literal', () => {
        restore();
        const restoreLoggingOnly = __setTelemetryLoggingOnlyForTests(false);
        const restoreFactory = __setTelemetryReporterFactoryForTests(() => fake as unknown as TelemetryReporter);
        const restoreVersionProvider = __setTelemetryClientVersionProviderForTests(() => '9.9.9-injected');

        try {
            initializeTelemetry({
                extension: {
                    id: 'microsoft-aspire.aspire-vscode',
                    packageJSON: {
                        aiKey: 'test-key',
                        version: '1.2.3'
                    }
                },
                subscriptions: []
            } as unknown as vscode.ExtensionContext);

            sendTelemetryEvent('aspire/vscode/command/invoked', { command: 'cmd.version' });

            assert.strictEqual(fake.events[0].properties?.['common.telemetryclientversion'], '9.9.9-injected');
        }
        finally {
            restoreVersionProvider();
            restoreFactory();
            restoreLoggingOnly();
        }
    });

    test('initializeTelemetry ignores malformed VS Code product metadata', () => {
        restore();
        const restoreFactory = __setTelemetryReporterFactoryForTests(() => fake as unknown as TelemetryReporter);
        const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-vscode-product-'));
        fs.writeFileSync(path.join(appRoot, 'product.json'), '{not valid json');
        const appRootStub = sinon.stub(vscode.env, 'appRoot').value(appRoot);

        try {
            const subscriptions: vscode.Disposable[] = [];
            assert.doesNotThrow(() => initializeTelemetry({
                extension: {
                    id: 'microsoft-aspire.aspire-vscode',
                    packageJSON: {
                        aiKey: 'test-key',
                        version: '1.2.3'
                    }
                },
                subscriptions
            } as unknown as vscode.ExtensionContext));
        }
        finally {
            appRootStub.restore();
            fs.rmSync(appRoot, { recursive: true, force: true });
            restoreFactory();
        }
    });

    test('withCommandTelemetry emits success outcome', async () => {
        await withCommandTelemetry('cmd.success', () => 42);
        assert.strictEqual(fake.events.length, 1);
        const event = fake.events[0];
        assert.strictEqual(event.name, 'aspire/vscode/command/invoked');
        assert.strictEqual(event.properties?.command, 'cmd.success');
        assert.strictEqual(event.properties?.outcome, 'success');
        assert.strictEqual(event.properties?.error_kind, undefined);
        assert.ok(typeof event.measurements?.duration_ms === 'number');
    });

    test('withCommandTelemetry includes additional properties', async () => {
        await withCommandTelemetry('cmd.tree', () => undefined, { source: 'tree' });
        assert.strictEqual(fake.events[0].properties?.source, 'tree');
    });

    test('withCommandTelemetry classifies thrown errors and rethrows', async () => {
        await assert.rejects(
            withCommandTelemetry('cmd.error', () => { throw new TypeError('bad'); })
        );
        assert.strictEqual(fake.events.length, 1);
        const event = fake.events[0];
        assert.strictEqual(event.properties?.outcome, 'error');
        assert.strictEqual(event.properties?.error_kind, 'TypeError');
    });

    test('withCommandTelemetry drops non-identifier error names', async () => {
        const err = new Error('sensitive@example.com /Users/alice/project');
        err.name = 'Bad Error /Users/alice/project';

        await assert.rejects(withCommandTelemetry('cmd.invalidErrorName', () => { throw err; }));

        assert.strictEqual(fake.events[0].properties?.outcome, 'error');
        assert.strictEqual(fake.events[0].properties?.error_kind, 'Error');
        assert.strictEqual(classifyError(err), 'Error');
    });

    test('withCommandTelemetry classifies handled unsuccessful outcomes without rethrowing', async () => {
        const result = await withCommandTelemetry('cmd.handledError', () => ({ success: false, hadOutput: false }));

        assert.deepStrictEqual(result, { success: false, hadOutput: false });
        assert.strictEqual(fake.events.length, 1);
        const event = fake.events[0];
        assert.strictEqual(event.properties?.outcome, 'error');
        assert.strictEqual(event.properties?.error_kind, 'HandledError');
    });

    test('withCommandTelemetry records a handled failure error_kind when the result supplies one', async () => {
        const result = await withCommandTelemetry('cmd.handledKind', () => ({ success: false, errorKind: 'ResourceNotFound' }));

        assert.deepStrictEqual(result, { success: false, errorKind: 'ResourceNotFound' });
        assert.strictEqual(fake.events.length, 1);
        const event = fake.events[0];
        assert.strictEqual(event.properties?.outcome, 'error');
        assert.strictEqual(event.properties?.error_kind, 'ResourceNotFound');
    });

    test('withCommandTelemetry normalizes caller-provided handled error kind', async () => {
        const result = await withCommandTelemetry('cmd.invalidHandledErrorKind', () => ({
            success: false,
            errorKind: 'Bad Error C:\\Users\\bob',
        }));

        assert.deepStrictEqual(result, { success: false, errorKind: 'Bad Error C:\\Users\\bob' });
        assert.strictEqual(fake.events[0].properties?.outcome, 'error');
        assert.strictEqual(fake.events[0].properties?.error_kind, 'Error');
    });

    test('withCommandTelemetry classifies cancellations and does not record error_kind', async () => {
        const err = new Error('Canceled');
        err.name = 'Canceled';
        await assert.rejects(withCommandTelemetry('cmd.canceled', () => { throw err; }));
        assert.strictEqual(fake.events[0].properties?.outcome, 'canceled');
        assert.strictEqual(fake.events[0].properties?.error_kind, undefined);
    });

    test('withCommandTelemetry invokes the command invocation listener once per call', async () => {
        let calls = 0;
        setCommandInvocationListener(() => { calls++; });
        await withCommandTelemetry('cmd.a', () => undefined);
        await withCommandTelemetry('cmd.b', () => undefined);
        await withCommandTelemetry('cmd.c', () => undefined);
        assert.strictEqual(calls, 3);
    });

    test('isCommandCancellation recognizes the well-known cancellation shapes', () => {
        const e1 = new Error('Canceled');
        e1.name = 'Canceled';
        assert.strictEqual(isCommandCancellation(e1), true);

        const e2 = new Error('CancellationError thrown');
        e2.name = 'CancellationError';
        assert.strictEqual(isCommandCancellation(e2), true);

        const e3 = new Error('canceled');
        assert.strictEqual(isCommandCancellation(e3), true);

        assert.strictEqual(isCommandCancellation('Canceled'), true);
        assert.strictEqual(isCommandCancellation(new Error('something else')), false);
        assert.strictEqual(isCommandCancellation(undefined), false);
    });
});
