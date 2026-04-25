/**
 * Shared type definitions for Aspire configuration information.
 * These types are used across multiple files to avoid duplication.
 */

export interface FeatureInfo {
    name: string;
    description: string;
    defaultValue: boolean;
}

export interface PropertyInfo {
    name: string;
    type: string;
    description: string;
    required: boolean;
    subProperties?: PropertyInfo[];
    additionalPropertiesType?: string;
}

export interface SettingsSchema {
    properties: PropertyInfo[];
}

export interface ConfigInfo {
    localSettingsPath: string;
    globalSettingsPath: string;
    availableFeatures: FeatureInfo[];
    localSettingsSchema: SettingsSchema;
    globalSettingsSchema: SettingsSchema;
    configFileSchema?: SettingsSchema;
    capabilities?: string[];
}
