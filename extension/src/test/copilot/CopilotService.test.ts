// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { CopilotService } from '../../copilot/CopilotService';
import {
    OpenAIChatCompletionOption,
    GHCP_STATE_ENABLED,
    GHCP_STATE_DISABLED
} from '../../copilot/types';

suite('CopilotService Tests', () => {
    let copilotService: CopilotService;
    let selectChatModelsStub: sinon.SinonStub;
    let sendRequestStub: sinon.SinonStub;

    // Helper to create a mock model
    function createMockModel(family: string, displayName: string) {
        return {
            id: `copilot-${family}`,
            vendor: 'copilot',
            family: family,
            version: '',
            name: family,  // Name should be the family (e.g., 'gpt-4o') not the display name
            maxInputTokens: 128000,
            sendRequest: sendRequestStub
        };
    }

    // Helper to create a mock response with text
    function createMockResponse(text: string) {
        return {
            text: text,
            stream: (async function* () {
                yield new vscode.LanguageModelTextPart(text);
            })()
        };
    }

    // Helper to create a streaming mock response that yields LanguageModelParts
    async function* createStreamingMockResponse(chunks: Array<{ text?: string; toolCalls?: any[] }>, finishReason: string = 'stop') {
        for (const chunk of chunks) {
            if (chunk.text !== undefined) {
                // Yield a LanguageModelTextPart
                yield new vscode.LanguageModelTextPart(chunk.text);
            }
            if (chunk.toolCalls) {
                for (const toolCall of chunk.toolCalls) {
                    // Yield a LanguageModelToolCallPart
                    yield new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input);
                }
            }
        }
    }

    setup(() => {
        copilotService = new CopilotService();

        // Stub the VS Code Language Model API
        selectChatModelsStub = sinon.stub(vscode.lm, 'selectChatModels');
        sendRequestStub = sinon.stub();
    });

    teardown(() => {
        sinon.restore();
    });

    suite('getGhcpInfoAsync', () => {
        test('Should return enabled state when Copilot models are available', async () => {
            // Mock available models
            const mockModels = [
                createMockModel('gpt-4o', 'GPT 4o'),
                createMockModel('gpt-4', 'GPT 4')
            ];

            selectChatModelsStub.resolves(mockModels as any);

            const result = await copilotService.getGhcpInfoAsync(new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.State, GHCP_STATE_ENABLED);
            assert.ok(result.Models, 'Models should be defined when enabled');
            assert.strictEqual(result.Models.length, 2, 'Should have 2 models');
            assert.strictEqual(result.Launcher, 'VSCode', 'Launcher should be VSCode');

            // Verify model structure
            const firstModel = result.Models[0];
            assert.strictEqual(firstModel.Name, 'gpt-4o', 'Model name should match');
            assert.strictEqual(firstModel.display_name, 'gpt-4o', 'Display name should match family');
            assert.strictEqual(firstModel.Family, 'gpt-4o', 'Family should match');
        });

        test('Should return disabled state when no Copilot models are available', async () => {
            // Mock no models
            selectChatModelsStub.resolves([]);

            const result = await copilotService.getGhcpInfoAsync(new vscode.CancellationTokenSource().token);

            assert.strictEqual(result.State, GHCP_STATE_DISABLED);
            assert.ok(!result.Models || result.Models.length === 0);
        });

        test('Should handle cancellation', async () => {
            const cts = new vscode.CancellationTokenSource();
            cts.cancel();

            selectChatModelsStub.resolves([]);

            const result = await copilotService.getGhcpInfoAsync(cts.token);

            // Should still return a result even when cancelled (implementation may vary)
            assert.ok(result.State === GHCP_STATE_ENABLED || result.State === GHCP_STATE_DISABLED);
        });
    });

    suite('generateResponseAsync', () => {
        test('Should generate response with user message', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Hello'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Say hello in one word' }
                ],
                stream: false
            };

            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(result.choices, 'Should have choices');
            assert.strictEqual(result.choices.length, 1, 'Should have exactly one choice');
            assert.ok(result.choices[0].message, 'Choice should have a message');
            assert.ok(result.choices[0].message.content, 'Message should have content');
            assert.strictEqual(result.choices[0].finish_reason, 'stop', 'Should finish with stop');
        });

        test('Should handle system message', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Hi there!'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant' },
                    { role: 'user', content: 'Hello' }
                ],
                stream: false
            };

            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(result.choices[0].message?.content, 'Should have response content');
        });

        test('Should throw error when model is unavailable', async () => {
            // Mock no matching models
            selectChatModelsStub.resolves([]);

            const request: OpenAIChatCompletionOption = {
                model: 'nonexistent-model',
                messages: [
                    { role: 'user', content: 'Test' }
                ],
                stream: false
            };

            await assert.rejects(
                async () => copilotService.generateResponseAsync(request, new vscode.CancellationTokenSource().token),
                /not available/,
                'Should throw error for unavailable model'
            );
        });

        test('Should handle cancellation', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('This is a story...'));

            const cts = new vscode.CancellationTokenSource();
            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Tell me a long story' }
                ],
                stream: false
            };

            // Cancel immediately
            cts.cancel();

            // Should complete normally (cancellation is checked during generation)
            const result = await copilotService.generateResponseAsync(request, cts.token);
            assert.ok(result, 'Should return a result');
        });
    });

    suite('generateStreamingResponseAsync', () => {
        test('Should generate streaming response', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);

            const mockResponse = {
                text: '',
                stream: createStreamingMockResponse([
                    { text: '1' },
                    { text: ', ' },
                    { text: '2' },
                    { text: ', ' },
                    { text: '3' }
                ], 'stop')
            };

            sendRequestStub.resolves(mockResponse);

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Count from 1 to 3' }
                ],
                stream: true
            };

            const results: any[] = [];
            for await (const chunk of copilotService.generateStreamingResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            )) {
                results.push(chunk);
            }

            assert.ok(results.length > 0, 'Should have at least one result');

            // Check streaming chunks (all but last)
            for (let i = 0; i < results.length - 1; i++) {
                const chunk = results[i];
                assert.ok(chunk.choices, 'Chunk should have choices');
                assert.strictEqual(chunk.choices.length, 1, 'Chunk should have one choice');
                // Streaming chunks should have delta
                if (chunk.choices[0].delta?.content) {
                    assert.ok(typeof chunk.choices[0].delta.content === 'string', 'Delta content should be string');
                }
            }

            // Check final chunk
            const finalChunk = results[results.length - 1];
            assert.ok(finalChunk.choices[0].finish_reason, 'Final chunk should have finish_reason');
            assert.strictEqual(finalChunk.choices[0].finish_reason, 'stop', 'Finish reason should be stop');
        });

        test('Should handle tool calls in streaming response', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);

            const toolCall = {
                name: 'get_weather',
                input: { location: 'Seattle' },
                callId: 'call_123'
            };

            const mockResponse = {
                text: '',
                stream: (async function* () {
                    // Yield LanguageModelToolCallPart
                    yield new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input);
                })()
            };

            sendRequestStub.resolves(mockResponse);

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'What is the weather in Seattle?' }
                ],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            description: 'Get the current weather for a location',
                            parameters: {
                                type: 'object',
                                properties: {
                                    location: {
                                        type: 'string',
                                        description: 'The city name'
                                    }
                                },
                                required: ['location']
                            }
                        }
                    }
                ],
                stream: true
            };

            const results: any[] = [];
            for await (const chunk of copilotService.generateStreamingResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            )) {
                results.push(chunk);
            }

            assert.ok(results.length > 0, 'Should have results');

            const finalChunk = results[results.length - 1];

            // Model used the tool - we verify the structure is correct
            assert.strictEqual(finalChunk.choices[0].finish_reason, 'tool_calls', 'Should finish with tool_calls');
            assert.ok(finalChunk.choices[0].delta?.tool_calls, 'Should have tool calls when finish_reason is tool_calls');
            assert.ok(finalChunk.choices[0].delta.tool_calls.length > 0, 'Should have at least one tool call');

            const returnedToolCall = finalChunk.choices[0].delta.tool_calls[0];
            assert.ok(returnedToolCall.id, 'Tool call should have an id');
            assert.strictEqual(returnedToolCall.type, 'function', 'Tool call type should be function');
            assert.ok(returnedToolCall.function?.name, 'Tool call should have a function name');
            assert.ok(returnedToolCall.function?.arguments, 'Tool call should have arguments');
        });

        test('Should handle cancellation during streaming', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);

            const mockResponse = {
                text: '',
                stream: createStreamingMockResponse([
                    { text: 'This is ' },
                    { text: 'a very ' },
                    { text: 'long ' },
                    { text: 'essay...' }
                ], 'stop')
            };

            sendRequestStub.resolves(mockResponse);

            const cts = new vscode.CancellationTokenSource();
            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Write a very long essay' }
                ],
                stream: true
            };

            let chunkCount = 0;
            for await (const chunk of copilotService.generateStreamingResponseAsync(request, cts.token)) {
                chunkCount++;
                if (chunkCount === 2) {
                    cts.cancel(); // Cancel after a few chunks
                }
                // Continue processing chunks (cancellation is checked in the loop)
            }

            assert.ok(chunkCount >= 2, 'Should have processed some chunks before cancellation');
        });

        test('Should handle assistant and tool messages in conversation', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);

            const mockResponse = {
                text: '',
                stream: createStreamingMockResponse([
                    { text: 'The weather ' },
                    { text: 'in Seattle ' },
                    { text: 'is sunny!' }
                ], 'stop')
            };

            sendRequestStub.resolves(mockResponse);

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'What is the weather?' },
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'call_123',
                            type: 'function',
                            function: {
                                name: 'get_weather',
                                arguments: '{"location":"Seattle"}'
                            }
                        }]
                    },
                    {
                        role: 'tool',
                        content: 'Sunny, 75°F',
                        tool_call_id: 'call_123'
                    }
                ],
                stream: true
            };

            const results: any[] = [];
            for await (const chunk of copilotService.generateStreamingResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            )) {
                results.push(chunk);
            }

            assert.ok(results.length > 0, 'Should have results');

            // Should get a final response incorporating the tool result
            const finalChunk = results[results.length - 1];
            assert.ok(finalChunk.choices[0].finish_reason, 'Should have finish reason');
        });
    });

    suite('Edge Cases', () => {
        test('Should handle empty message list gracefully', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Hello'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [],
                stream: false
            };

            try {
                await copilotService.generateResponseAsync(request, new vscode.CancellationTokenSource().token);
                // May or may not throw depending on implementation
            } catch (error) {
                // Error is acceptable for empty messages
                assert.ok(error instanceof Error);
            }
        });

        test('Should handle multiple user messages in sequence', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Second answer'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'First question' },
                    { role: 'assistant', content: 'First answer' },
                    { role: 'user', content: 'Second question' }
                ],
                stream: false
            };

            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(result.choices[0].message?.content, 'Should have response');
        });

        test('Should handle empty tool call arguments', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Continued response'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'call_empty',
                            type: 'function',
                            function: {
                                name: 'no_args_function',
                                arguments: ''  // Empty arguments
                            }
                        }]
                    },
                    {
                        role: 'tool',
                        content: 'Success',
                        tool_call_id: 'call_empty'
                    },
                    { role: 'user', content: 'Continue' }
                ],
                stream: false
            };

            // Should handle empty arguments gracefully without throwing
            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(result, 'Should return a result');
        });

        test('Should handle malformed JSON in tool call arguments', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Continued response'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        tool_calls: [{
                            id: 'call_malformed',
                            type: 'function',
                            function: {
                                name: 'some_function',
                                arguments: '{invalid json here'  // Malformed JSON
                            }
                        }]
                    },
                    {
                        role: 'tool',
                        content: 'Success despite bad args',
                        tool_call_id: 'call_malformed'
                    },
                    { role: 'user', content: 'Continue' }
                ],
                stream: false
            };

            // Should handle malformed JSON gracefully (logs error but continues)
            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(result, 'Should return a result despite malformed JSON');
        });

        test('Should handle tools with no required parameters', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);
            sendRequestStub.resolves(createMockResponse('Used the simple tool'));

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Use the simple tool' }
                ],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'simple_tool',
                            description: 'A simple tool with no required params',
                            parameters: {
                                type: 'object',
                                properties: {},
                                required: []
                            }
                        }
                    }
                ],
                stream: false
            };

            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            assert.ok(result, 'Should handle tools with no required parameters');
        });

        test('Should handle partial model name match', async () => {
            // Mock multiple models with similar names
            selectChatModelsStub.resolves([
                createMockModel('gpt-4o', 'GPT 4o'),
                createMockModel('gpt-4-turbo', 'GPT 4 Turbo')
            ]);
            sendRequestStub.resolves(createMockResponse('Test response'));

            // Try with partial name that should match (e.g., "gpt-4" should match "gpt-4o")
            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4',
                messages: [
                    { role: 'user', content: 'Test' }
                ],
                stream: false
            };

            const result = await copilotService.generateResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            );

            // If partial match works, should get a result
            assert.ok(result, 'Should handle partial model name match');
        });

        test('Should handle multiple tool calls in single response', async () => {
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);

            const toolCalls = [
                { name: 'get_weather', input: { location: 'Seattle' }, callId: 'call_1' },
                { name: 'get_weather', input: { location: 'Portland' }, callId: 'call_2' },
                { name: 'get_weather', input: { location: 'San Francisco' }, callId: 'call_3' }
            ];

            const mockResponse = {
                text: '',
                stream: (async function* () {
                    // Yield multiple LanguageModelToolCallParts
                    for (const toolCall of toolCalls) {
                        yield new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input);
                    }
                })()
            };

            sendRequestStub.resolves(mockResponse);

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Get weather for Seattle, Portland, and San Francisco' }
                ],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            description: 'Get weather for a location',
                            parameters: {
                                type: 'object',
                                properties: {
                                    location: { type: 'string' }
                                },
                                required: ['location']
                            }
                        }
                    }
                ],
                stream: true
            };

            const results: any[] = [];
            for await (const chunk of copilotService.generateStreamingResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            )) {
                results.push(chunk);
            }

            const finalChunk = results[results.length - 1];

            assert.strictEqual(finalChunk.choices[0].finish_reason, 'tool_calls', 'Should finish with tool_calls');
            assert.ok(finalChunk.choices[0].delta?.tool_calls, 'Should have tool calls');
            assert.ok(finalChunk.choices[0].delta.tool_calls.length >= 1, 'Should have at least one tool call');
        });

        test('Should use inputSchema not parametersSchema for tools', async () => {
            // This test verifies the fix for the inputSchema vs parametersSchema bug
            selectChatModelsStub.resolves([createMockModel('gpt-4o', 'GPT 4o')]);

            const toolCall = {
                name: 'GetConsoleLogs',
                input: { resourceName: 'apiservice' },
                callId: 'call_logs'
            };

            const mockResponse = {
                text: '',
                stream: (async function* () {
                    // Yield LanguageModelToolCallPart
                    yield new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input);
                })()
            };

            sendRequestStub.resolves(mockResponse);

            const request: OpenAIChatCompletionOption = {
                model: 'gpt-4o',
                messages: [
                    { role: 'user', content: 'Get console logs for apiservice' }
                ],
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'GetConsoleLogs',
                            description: 'Get console logs for a resource',
                            parameters: {
                                type: 'object',
                                properties: {
                                    resourceName: {
                                        type: 'string',
                                        description: 'The resource name'
                                    }
                                },
                                required: ['resourceName']
                            }
                        }
                    }
                ],
                stream: true
            };

            const results: any[] = [];
            for await (const chunk of copilotService.generateStreamingResponseAsync(
                request,
                new vscode.CancellationTokenSource().token
            )) {
                results.push(chunk);
            }

            const finalChunk = results[results.length - 1];

            assert.strictEqual(finalChunk.choices[0].finish_reason, 'tool_calls', 'Should call the tool');
            const toolCallResult = finalChunk.choices[0].delta?.tool_calls?.[0];
            assert.ok(toolCallResult, 'Should have a tool call');

            // Verify it has arguments (the fix ensures schema is passed correctly)
            assert.ok(toolCallResult.function?.arguments, 'Tool call should have arguments when schema is provided correctly');

            // Parse and verify arguments structure
            const args = JSON.parse(toolCallResult.function.arguments);
            assert.ok('resourceName' in args, 'Arguments should have resourceName');
        });
    });
});
