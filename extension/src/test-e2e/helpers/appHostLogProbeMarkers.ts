export const appHostLogProbeCategory = 'AspireE2E.LogProbe';

export const appHostLogProbeMarkers = {
    information: 'E2ELOGPROBEINFO',
    repeated: 'E2ELOGPROBEREPEAT',
    warning: 'E2ELOGPROBEWARN_ONE',
    warningContinuation: 'E2ELOGPROBEWARN_TWO',
    debug: 'E2ELOGPROBEDEBUG',
    error: 'E2ELOGPROBEERROR',
    exception: 'E2ELOGPROBEEXCEPTION',
} as const;

export const countedAppHostLogProbeMarkers: readonly string[] = Object.values(appHostLogProbeMarkers);
