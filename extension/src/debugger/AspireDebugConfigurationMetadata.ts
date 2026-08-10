export const appHostTelemetryTargetPathConfigKey = '__aspireAppHostTelemetryTargetPath';

/**
 * Identifies which launch reservation a debug session belongs to.
 *
 * Stamped by whichever path reserved the launching slot for the AppHost - the launch service for
 * its own launches, and the configuration provider for `launch.json`/F5. It is read back when the
 * session terminates so a terminating session can only clear the reservation it took: an AppHost
 * restart disposes the old session and starts its replacement immediately, so the old session's
 * terminate event routinely arrives after the replacement has already reserved the same AppHost.
 */
export const appHostLaunchReservationTokenConfigKey = '__aspireAppHostLaunchReservationToken';
