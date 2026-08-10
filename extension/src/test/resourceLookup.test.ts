import * as assert from 'assert';
import * as path from 'path';
import { AppHostDataRepository, AppHostDisplayInfo, ResourceJson } from '../views/AppHostDataRepository';
import { findAppHostForResource, ResourceElementRef } from '../views/resourceLookup';

function appHost(appHostPath: string, appHostPid: number): AppHostDisplayInfo {
    return {
        appHostPath,
        appHostPid,
        cliPid: null,
        dashboardUrl: null,
        resources: [],
    };
}

// findAppHostForResource only reads the app host list, so the repository is represented by that list
// alone rather than by driving a real repository through discovery.
function repositoryWith(...appHosts: AppHostDisplayInfo[]): AppHostDataRepository {
    return { appHosts } as unknown as AppHostDataRepository;
}

function resourceRef(appHostPid: number | null, appHostPath?: string): ResourceElementRef {
    return {
        resource: { name: 'api' } as ResourceJson,
        appHostPid,
        appHostPath,
    };
}

suite('resourceLookup', () => {
    const first = path.join('/repo', 'First', 'First.AppHost.csproj');
    const second = path.join('/repo', 'Second', 'Second.AppHost.csproj');

    test('resolves the app host the element came from', () => {
        const target = appHost(first, 100);
        const resolved = findAppHostForResource(repositoryWith(appHost(second, 99), target), resourceRef(100, first));

        assert.strictEqual(resolved, target);
    });

    test('does not resolve a different app host that reused the pid', () => {
        // Every caller passes the result to the CLI as --apphost, so resolving by pid alone would send
        // a resource name from one app host to another that happens to be running under the same pid.
        const resolved = findAppHostForResource(repositoryWith(appHost(second, 100)), resourceRef(100, first));

        assert.strictEqual(resolved, undefined);
    });

    test('resolves an app host restarted under a new pid', () => {
        const restarted = appHost(first, 250);
        const resolved = findAppHostForResource(repositoryWith(restarted, appHost(second, 99)), resourceRef(100, first));

        assert.strictEqual(resolved, restarted);
    });

    test('fails closed when the path alone cannot pick one app host', () => {
        const resolved = findAppHostForResource(repositoryWith(appHost(first, 300), appHost(first, 301)), resourceRef(100, first));

        assert.strictEqual(resolved, undefined);
    });

    test('falls back to the pid when the element remembers no path', () => {
        const target = appHost(first, 100);
        const resolved = findAppHostForResource(repositoryWith(target, appHost(second, 99)), resourceRef(100));

        assert.strictEqual(resolved, target);
    });
});
