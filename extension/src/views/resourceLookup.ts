import {
    AppHostDataRepository,
    AppHostDisplayInfo,
    ResourceJson,
    isMatchingAppHostPath,
} from './AppHostDataRepository';

export interface ResourceElementRef {
    resource: ResourceJson;
    appHostPid: number | null;
    appHostPath?: string;
}

export function findLatestResourceForElement(repository: AppHostDataRepository, element: ResourceElementRef): ResourceJson | undefined {
    const resources = findLatestResourcesForElement(repository, element);
    return resources?.find(resource => resource.name === element.resource.name);
}

export function findLatestResourcesForElement(repository: AppHostDataRepository, element: ResourceElementRef): readonly ResourceJson[] | undefined {
    const workspaceResources = [...repository.workspaceResources];
    const selectedAppHostPath = repository.workspaceAppHost?.appHostPath ?? repository.workspaceAppHostPath;

    if (element.appHostPath) {
        const matchingAppHosts = repository.appHosts.filter(appHost => isMatchingAppHostPath(appHost.appHostPath, element.appHostPath!));
        const appHostByPid = element.appHostPid !== null
            ? matchingAppHosts.find(appHost => appHost.appHostPid === element.appHostPid)
            : undefined;
        const appHost = appHostByPid ?? (matchingAppHosts.length === 1 ? matchingAppHosts[0] : undefined);
        if (appHost) {
            if (workspaceResources.length > 0 && selectedAppHostPath && isMatchingAppHostPath(appHost.appHostPath, selectedAppHostPath) && hasNoResources(appHost.resources)) {
                return workspaceResources;
            }

            return appHost.resources ?? [];
        }

        if (matchingAppHosts.length > 1) {
            return undefined;
        }

        if (!selectedAppHostPath || !isMatchingAppHostPath(element.appHostPath, selectedAppHostPath)) {
            return undefined;
        }

        return workspaceResources.length > 0
            ? workspaceResources
            : repository.workspaceAppHost?.resources ?? [];
    }

    const appHost = findAppHostForResource(repository, element);

    if (appHost && workspaceResources.length > 0 && selectedAppHostPath && isMatchingAppHostPath(appHost.appHostPath, selectedAppHostPath) && hasNoResources(appHost.resources)) {
        return workspaceResources;
    }

    if (appHost) {
        return appHost.resources ?? [];
    }

    return element.appHostPid === null ? workspaceResources : undefined;
}

export function findAppHostForResource(repository: AppHostDataRepository, element: ResourceElementRef): AppHostDisplayInfo | undefined {
    // A pid is not a durable identity for an app host. Tree items outlive the app host they were built
    // from, and the OS reuses pids, so a stale action can name a pid that now belongs to a different app
    // host - and every caller of this uses the result to pass --apphost to the CLI. When the element
    // remembers which app host file it came from, that file is the identity: a pid that resolves outside
    // it counts as not found, and an ambiguous file resolves to nothing rather than to a guess. This is
    // the same resolution order findLatestResourcesForElement above uses.
    if (element.appHostPath) {
        const matchingAppHosts = repository.appHosts.filter(appHost => isMatchingAppHostPath(appHost.appHostPath, element.appHostPath!));
        const appHostByPid = matchingAppHosts.find(appHost => appHost.appHostPid === element.appHostPid);

        return appHostByPid ?? (matchingAppHosts.length === 1 ? matchingAppHosts[0] : undefined);
    }

    return element.appHostPid !== null
        ? repository.appHosts.find(appHost => appHost.appHostPid === element.appHostPid)
        : undefined;
}

export function getAppHostPathForResource(repository: AppHostDataRepository, element: ResourceElementRef): string | undefined {
    const selectedAppHostPath = repository.workspaceAppHost?.appHostPath ?? repository.workspaceAppHostPath;

    if (element.appHostPath) {
        const elementAppHostPath = element.appHostPath;
        // Terminal-backed actions can intentionally fall back to the tree item's stale resource
        // snapshot during refresh windows, so validate the cached AppHost path before it becomes a
        // CLI --apphost argument.
        const matchingAppHosts = repository.appHosts.filter(appHost => isMatchingAppHostPath(appHost.appHostPath, elementAppHostPath));
        const appHostByPid = element.appHostPid !== null
            ? matchingAppHosts.find(appHost => appHost.appHostPid === element.appHostPid)
            : undefined;

        if (appHostByPid) {
            return appHostByPid.appHostPath;
        }

        if (matchingAppHosts.length === 1) {
            return matchingAppHosts[0].appHostPath;
        }

        if (matchingAppHosts.length > 1) {
            return undefined;
        }

        return selectedAppHostPath && isMatchingAppHostPath(elementAppHostPath, selectedAppHostPath)
            ? selectedAppHostPath
            : undefined;
    }

    return findAppHostForResource(repository, element)?.appHostPath ?? selectedAppHostPath;
}

function hasNoResources(resources: readonly ResourceJson[] | null | undefined): boolean {
    return resources === undefined || resources === null || resources.length === 0;
}
