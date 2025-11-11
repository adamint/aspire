// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as vscode from 'vscode';
import { extensionLogOutputChannel } from '../utils/logging';
import {
    GhcpInfoResponse,
    GhcpModelInfo,
    OpenAIChatCompletionOption,
    OpenAIChatCompletion,
    OpenAIChatMessage,
    OpenAIToolCallResponseObject,
    GHCP_STATE_ENABLED,
    GHCP_STATE_DISABLED,
    GHCP_STATE_UNKNOWN
} from './types';

/**
 * Service for integrating with GitHub Copilot via VS Code's Language Model API
 */
export class CopilotService {
    /**
     * Get information about GitHub Copilot availability and supported models
     */
    async getGhcpInfoAsync(cancellationToken: vscode.CancellationToken): Promise<GhcpInfoResponse> {
        try {
            extensionLogOutputChannel.info('CopilotService: Starting getGhcpInfoAsync');

            // Check if the Language Model API is available
            if (!vscode.lm) {
                extensionLogOutputChannel.error('CopilotService: vscode.lm API is not available!');
                return {
                    State: GHCP_STATE_DISABLED,
                    Models: []
                };
            }

            // Check if language models are available at all
            const allModels = await vscode.lm.selectChatModels();
            extensionLogOutputChannel.info(`CopilotService: Found ${allModels.length} total language models`);

            if (allModels.length > 0) {
                // Log details about each model
                allModels.forEach(model => {
                    extensionLogOutputChannel.info(`  - Model: ${model.name}, Family: ${model.family}, Vendor: ${model.vendor}, Max tokens: ${model.maxInputTokens}`);
                });
            }

            // Check if language models are available from Copilot specifically
            const models = await vscode.lm.selectChatModels({
                vendor: 'copilot'
            });

            extensionLogOutputChannel.info(`CopilotService: Found ${models.length} Copilot-specific models`);

            if (models.length === 0) {
                extensionLogOutputChannel.info('No Copilot models available - returning DISABLED state');
                return {
                    State: GHCP_STATE_DISABLED,
                    Models: []
                };
            }

            // Map VS Code language models to GHCP model info
            // Note: We include ALL models from Copilot, not just the "supported" list
            // to help with debugging and to support new models automatically
            const ghcpModels: GhcpModelInfo[] = models
                .map(model => ({
                    Name: model.name,
                    display_name: this.getDisplayName(model),
                    Family: model.family,
                    InputTokens: model.maxInputTokens
                }));

            extensionLogOutputChannel.info(`Found ${ghcpModels.length} Copilot models (no filtering applied)`);
            ghcpModels.forEach(model => {
                extensionLogOutputChannel.info(`  - ${model.display_name} (${model.Family})`);
            });

            return {
                State: GHCP_STATE_ENABLED,
                Launcher: 'VSCode',  // Identify ourselves as VS Code
                Models: ghcpModels
            };
        } catch (error) {
            extensionLogOutputChannel.error(`Error getting Copilot info: ${error}`);
            if (error instanceof Error) {
                extensionLogOutputChannel.error(`  Stack: ${error.stack}`);
            }
            return {
                State: GHCP_STATE_UNKNOWN,
                Models: []
            };
        }
    }

    /**
     * Generate a non-streaming response from GitHub Copilot
     */
    async generateResponseAsync(
        request: OpenAIChatCompletionOption,
        cancellationToken: vscode.CancellationToken
    ): Promise<OpenAIChatCompletion> {
        const model = await this.selectModel(request.model || 'gpt-4o');

        if (!model) {
            throw new Error(`Model ${request.model} not available`);
        }

        const messages = this.convertToVSCodeMessages(request.messages);
        const tools = request.tools ? this.convertToVSCodeTools(request.tools) : undefined;

        const response = await model.sendRequest(messages, { tools }, cancellationToken);

        const content: string[] = [];
        const toolCalls: OpenAIToolCallResponseObject[] = [];
        let toolCallIndex = 0;

        // Iterate through the stream to collect both text and tool calls
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                content.push(part.value);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const argumentsString = JSON.stringify(part.input);
                extensionLogOutputChannel.info(`  Non-streaming tool call: ${part.name}, id=${part.callId}, args=${argumentsString}`);

                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: argumentsString
                    },
                    index: toolCallIndex++
                });
            }
        }

        return {
            created: Math.floor(Date.now() / 1000),
            model: request.model || model.family,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: content.join(''),
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                },
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
            }]
        };
    }

    /**
     * Generate a streaming response from GitHub Copilot
     */
    async *generateStreamingResponseAsync(
        request: OpenAIChatCompletionOption,
        cancellationToken: vscode.CancellationToken
    ): AsyncGenerator<OpenAIChatCompletion> {
        const model = await this.selectModel(request.model || 'gpt-4o');

        if (!model) {
            throw new Error(`Model ${request.model} not available`);
        }

        const messages = this.convertToVSCodeMessages(request.messages);
        const tools = request.tools ? this.convertToVSCodeTools(request.tools) : undefined;

        const response = await model.sendRequest(messages, { tools }, cancellationToken);

        const toolCalls: OpenAIToolCallResponseObject[] = [];
        let toolCallIndex = 0;

        // Stream all parts (text and tool calls)
        for await (const part of response.stream) {
            // Check for cancellation before processing each part
            if (cancellationToken.isCancellationRequested) {
                extensionLogOutputChannel.info('Streaming cancelled by user');
                break;
            }

            if (part instanceof vscode.LanguageModelTextPart) {
                yield {
                    created: Math.floor(Date.now() / 1000),
                    model: request.model || model.family,
                    choices: [{
                        index: 0,
                        delta: {
                            content: part.value
                        }
                    }]
                };
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const argumentsString = JSON.stringify(part.input);
                extensionLogOutputChannel.info(`  Streaming tool call: ${part.name}, id=${part.callId}, args=${argumentsString}`);

                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: {
                        name: part.name,
                        arguments: argumentsString
                    },
                    index: toolCallIndex++
                });
            }
        }

        // Send final chunk with tool calls and finish reason
        yield {
            created: Math.floor(Date.now() / 1000),
            model: request.model || model.family,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: toolCalls.length > 0 ? toolCalls : undefined
                },
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
            }]
        };
    }

    private async selectModel(family: string): Promise<vscode.LanguageModelChat | undefined> {
        // Try exact match first
        let models = await vscode.lm.selectChatModels({
            vendor: 'copilot',
            family: family
        });

        if (models.length > 0) {
            extensionLogOutputChannel.info(`Found exact model match for family: ${family}`);
            return models[0];
        }

        // If no exact match, try to find a model that contains the family name
        // For example, if requesting "gpt-4o", might match "copilot-gpt-4o"
        const allCopilotModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        const partialMatch = allCopilotModels.find(m =>
            m.family.toLowerCase().includes(family.toLowerCase()) ||
            m.name.toLowerCase().includes(family.toLowerCase())
        );

        if (partialMatch) {
            extensionLogOutputChannel.info(`Found partial model match for family ${family}: ${partialMatch.name} (${partialMatch.family})`);
            return partialMatch;
        }

        extensionLogOutputChannel.warn(`No model found for family: ${family}`);
        return undefined;
    }

    private convertToVSCodeMessages(messages: OpenAIChatMessage[]): vscode.LanguageModelChatMessage[] {
        extensionLogOutputChannel.info(`Converting ${messages.length} messages to VS Code format`);

        return messages.map((msg, index) => {
            extensionLogOutputChannel.info(`  Message ${index}: role=${msg.role}`);

            switch (msg.role) {
                case 'system':
                    // VS Code doesn't have explicit system messages, so we convert to user message
                    return vscode.LanguageModelChatMessage.User(`[System] ${msg.content}`);
                case 'user':
                    return vscode.LanguageModelChatMessage.User(msg.content);
                case 'assistant': {
                    const assistantMsg = msg as any; // OpenAIAssistantMessage
                    // If the assistant message includes tool calls, we need to include them
                    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0) {
                        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];

                        // Add text content if present
                        if (assistantMsg.content) {
                            parts.push(new vscode.LanguageModelTextPart(assistantMsg.content));
                        }

                        // Add tool calls
                        for (const toolCall of assistantMsg.tool_calls) {
                            let parsedArgs: any = {};
                            try {
                                // toolCall.function.arguments is a JSON string per OpenAI spec
                                if (toolCall.function.arguments && toolCall.function.arguments.trim() !== '') {
                                    parsedArgs = JSON.parse(toolCall.function.arguments);
                                }
                            } catch (error) {
                                extensionLogOutputChannel.error(`Failed to parse tool call arguments for ${toolCall.function.name}: ${error}`);
                                extensionLogOutputChannel.error(`Arguments string: ${toolCall.function.arguments}`);
                                // Continue with empty object if parsing fails
                            }

                            parts.push(new vscode.LanguageModelToolCallPart(
                                toolCall.id,
                                toolCall.function.name,
                                parsedArgs
                            ));
                        }

                        extensionLogOutputChannel.info(`  Assistant message with ${assistantMsg.tool_calls.length} tool calls`);
                        return vscode.LanguageModelChatMessage.Assistant(parts);
                    }

                    // Simple text-only assistant message
                    return vscode.LanguageModelChatMessage.Assistant(assistantMsg.content || '');
                }
                case 'tool':
                    // Tool results must be sent as User messages with LanguageModelToolResultPart
                    const toolMsg = msg as any; // OpenAIToolMessage
                    extensionLogOutputChannel.info(`  Tool result for call_id=${toolMsg.tool_call_id}, content length=${toolMsg.content?.length || 0}`);
                    return vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelToolResultPart(
                            toolMsg.tool_call_id,
                            [new vscode.LanguageModelTextPart(toolMsg.content)]
                        )
                    ]);
                default:
                    const unknownMsg = msg as any;
                    extensionLogOutputChannel.warn(`  Unknown message role: ${unknownMsg.role}`);
                    return vscode.LanguageModelChatMessage.User(JSON.stringify(msg));
            }
        });
    }

    /**
     * Convert OpenAI tool definitions to VS Code LanguageModelChatTool format.
     *
     * VS Code accepts the complete JSON Schema for parameters, unlike Visual Studio
     * which requires parsing the schema into individual parameter descriptors.
     *
     * Example OpenAI tool:
     * {
     *   type: 'function',
     *   function: {
     *     name: 'get_weather',
     *     description: 'Get weather for a location',
     *     parameters: {
     *       type: 'object',
     *       properties: {
     *         location: { type: 'string', description: 'City name' }
     *       },
     *       required: ['location']
     *     }
     *   }
     * }
     */
    private convertToVSCodeTools(tools: any[]): vscode.LanguageModelChatTool[] {
        extensionLogOutputChannel.info(`Converting ${tools.length} tools to VS Code format`);

        return tools.map(tool => {
            if (tool.type === 'function') {
                extensionLogOutputChannel.info(`  Tool: ${tool.function.name}`);
                extensionLogOutputChannel.info(`    Parameters schema: ${JSON.stringify(tool.function.parameters)}`);

                return {
                    name: tool.function.name,
                    description: tool.function.description || '',
                    // VS Code uses 'inputSchema' not 'parametersSchema'
                    inputSchema: tool.function.parameters || {}
                } as vscode.LanguageModelChatTool;
            }
            throw new Error(`Unsupported tool type: ${tool.type}`);
        });
    }

    private getDisplayName(model: vscode.LanguageModelChat): string {
        // Use the model's built-in name which is already friendly
        return model.name;
    }
}
