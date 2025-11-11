// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/**
 * GitHub Copilot integration types for Aspire dashboard
 */

export interface GhcpInfoResponse {
    State: string;
    Launcher?: string;
    Models?: GhcpModelInfo[];
}

export interface GhcpModelInfo {
    Name: string;
    display_name: string;  // Note: C# has [JsonPropertyName("display_name")]
    Family: string;
    InputTokens?: number;
}

export interface OpenAIChatCompletionOption {
    model?: string;
    messages: OpenAIChatMessage[];
    tools?: OpenAIToolDefinition[];
    stream?: boolean;
}

export type OpenAIChatMessage =
    | OpenAISystemMessage
    | OpenAIUserMessage
    | OpenAIAssistantMessage
    | OpenAIToolMessage;

export interface OpenAISystemMessage {
    role: 'system';
    content: string;
}

export interface OpenAIUserMessage {
    role: 'user';
    content: string;
}

export interface OpenAIAssistantMessage {
    role: 'assistant';
    content?: string;
    tool_calls?: OpenAIToolCallResponseObject[];
}

export interface OpenAIToolMessage {
    role: 'tool';
    content: string;
    tool_call_id: string;
}

export interface OpenAIToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, any>;
    };
}

export interface OpenAIToolCallResponseObject {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
    index?: number;
}

export interface OpenAIChatCompletion {
    id?: string;
    object?: string;
    created: number;
    model: string;
    choices: OpenAIChatCompletionChoice[];
}

export interface OpenAIChatCompletionChoice {
    index?: number;
    message?: OpenAIChatCompletionMessage;
    delta?: OpenAIChatCompletionMessage;
    finish_reason?: string;
}

export interface OpenAIChatCompletionMessage {
    role?: string;
    content?: string;
    tool_calls?: OpenAIToolCallResponseObject[];
}

export const GHCP_STATE_ENABLED = 'Enabled';
export const GHCP_STATE_DISABLED = 'Disabled';
export const GHCP_STATE_UNKNOWN = 'Unknown';
