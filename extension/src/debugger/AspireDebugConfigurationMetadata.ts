export const appHostTelemetryTargetPathConfigKey = '__aspireAppHostTelemetryTargetPath';

// This internal field survives VS Code's two debug-configuration resolver stages so the
// eventual CLI process can distinguish a launch.json-owned target from a persisted default.
export const appHostSelectionOriginConfigKey = '__aspireAppHostSelectionOrigin';

export type AppHostSelectionOrigin = 'explicit-launch-configuration' | 'default-discovery' | 'user-selection';
