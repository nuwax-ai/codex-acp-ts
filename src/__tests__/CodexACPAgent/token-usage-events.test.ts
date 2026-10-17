import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerNotification } from '../../app-server';
import {
    createBaseTestFixture,
    createCodexMockTestFixture,
    createTestSessionState,
    createTestModel,
    type CodexMockTestFixture,
    type MethodCallEvent,
} from '../acp-test-utils';
import type { AcpClientConnection } from '../../ACPSessionConnection';
import type { Thread, TokenUsageBreakdown } from '../../app-server/v2';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import { toTokenCount } from '../../TokenCount';

function createTokenUsageNotification(
    sessionId: string,
    tokenUsage: {
        total: TokenUsageBreakdown;
        last: TokenUsageBreakdown;
        modelContextWindow: number | null;
    }
): ServerNotification {
    return {
        method: 'thread/tokenUsage/updated',
        params: {
            threadId: sessionId,
            turnId: 'turn-id',
            tokenUsage,
        },
    };
}

describe('Token Usage Events', () => {
    let mockFixture: CodexMockTestFixture;
    const sessionId = 'test-session-id';

    beforeEach(() => {
        mockFixture = createCodexMockTestFixture();
        vi.clearAllMocks();
    });
    describe('PromptResponse usage', () => {
        function setupPromptWithTokenUsage(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            // awaitTurnCompleted sends notifications before resolving
            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                // Send notifications during turn (after handler is registered)
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return codexAcpAgent;
        }

        it('should include token_count in PromptResponse on end_turn', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 5000,
                    inputTokens: 4000,
                    cachedInputTokens: 1000,
                    cacheWriteInputTokens: 0,
                    outputTokens: 900,
                    reasoningOutputTokens: 100,
                },
                last: {
                    totalTokens: 2500,
                    inputTokens: 2000,
                    cachedInputTokens: 500,
                    cacheWriteInputTokens: 0,
                    outputTokens: 450,
                    reasoningOutputTokens: 50,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-end-turn.json'
            );
        });

        it('should include token_count in PromptResponse on cancelled', async () => {
            const tokenUsageNotification = createTokenUsageNotification(sessionId, {
                total: {
                    totalTokens: 3000,
                    inputTokens: 2500,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 500,
                    reasoningOutputTokens: 0,
                },
                last: {
                    totalTokens: 1500,
                    inputTokens: 1200,
                    cachedInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 300,
                    reasoningOutputTokens: 0,
                },
                modelContextWindow: 128000,
            });

            const codexAcpAgent = setupPromptWithTokenUsage([tokenUsageNotification], "interrupted");

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-cancelled.json'
            );
        });

        it('should return null token_count when no token usage event received', async () => {
            const codexAcpAgent = setupPromptWithTokenUsage([]);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-null.json'
            );
        });

        it('should use last token usage from multiple updates', async () => {
            const notifications: ServerNotification[] = [
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ];

            const codexAcpAgent = setupPromptWithTokenUsage(notifications);

            const response = await codexAcpAgent.prompt({
                sessionId,
                prompt: [{ type: 'text', text: 'test prompt' }],
            });

            await expect(`${JSON.stringify(response, null, 2)}\n`).toMatchFileSnapshot(
                'data/token-usage-multiple-updates.json'
            );
        });
    });

    describe('session/update usage_update', () => {
        function setupPromptAndReturnEvents(notifications: ServerNotification[], turnStatus: string = "completed") {
            const codexAcpAgent = mockFixture.getCodexAcpAgent();

            mockFixture.getCodexAppServerClient().turnStart = vi.fn().mockResolvedValue({
                turn: { id: "turn-id", items: [], status: "inProgress", error: null }
            });

            mockFixture.getCodexAppServerClient().awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                for (const notification of notifications) {
                    mockFixture.sendServerNotification(notification);
                }
                return {
                    threadId: sessionId,
                    turn: { id: "turn-id", items: [], status: turnStatus, error: null }
                };
            });

            vi.spyOn(codexAcpAgent, 'getSessionState').mockReturnValue(createTestSessionState({ sessionId }));

            return async () => {
                await codexAcpAgent.prompt({
                    sessionId,
                    prompt: [{ type: 'text', text: 'test prompt' }],
                });
                return mockFixture.getAcpConnectionEvents([]);
            };
        }

        it('should emit usage_update with latest turn usage as a context proxy', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: {
                        totalTokens: 5000,
                        inputTokens: 4000,
                        cachedInputTokens: 1000,
                        cacheWriteInputTokens: 0,
                        outputTokens: 900,
                        reasoningOutputTokens: 100,
                    },
                    last: {
                        totalTokens: 2500,
                        inputTokens: 2000,
                        cachedInputTokens: 500,
                        cacheWriteInputTokens: 0,
                        outputTokens: 450,
                        reasoningOutputTokens: 50,
                    },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events[0], null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update.json');
        });

        it('should emit latest turn usage from multiple updates', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 2000, inputTokens: 1600, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 },
                    last: { totalTokens: 1000, inputTokens: 800, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 },
                    modelContextWindow: 128000,
                }),
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 3500, inputTokens: 2800, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 100 },
                    last: { totalTokens: 1500, inputTokens: 1200, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 100 },
                    modelContextWindow: 128000,
                }),
            ])();

            await expect(`${JSON.stringify(events, null, 2)}\n`).toMatchFileSnapshot('data/token-usage-session-update-multiple.json');
        });

        it('should skip usage_update when model context window is unavailable', async () => {
            const events = await setupPromptAndReturnEvents([
                createTokenUsageNotification(sessionId, {
                    total: { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 900, reasoningOutputTokens: 100 },
                    last: { totalTokens: 2500, inputTokens: 2000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 450, reasoningOutputTokens: 50 },
                    modelContextWindow: null,
                }),
            ])();

            expect(events).toEqual([]);
        });
    });

    describe('restored usage after loadSession', () => {
        const restoredTotal: TokenUsageBreakdown = {
            totalTokens: 5000,
            inputTokens: 4000,
            cachedInputTokens: 1000,
            cacheWriteInputTokens: 0,
            outputTokens: 900,
            reasoningOutputTokens: 100,
        };
        const restoredLast: TokenUsageBreakdown = {
            totalTokens: 2500,
            inputTokens: 2000,
            cachedInputTokens: 500,
            cacheWriteInputTokens: 0,
            outputTokens: 450,
            reasoningOutputTokens: 50,
        };

        function setupLoadSessionWithRestoredUsage(
            fixture: CodexMockTestFixture,
            modelContextWindow: number | null,
        ) {
            const agent = fixture.getCodexAcpAgent();
            const client = fixture.getCodexAcpClient();
            const appServer = fixture.getCodexAppServerClient();

            client.authRequired = vi.fn().mockResolvedValue(false);
            client.getAccount = vi.fn().mockResolvedValue({
                account: null,
                requiresOpenaiAuth: false,
            });
            client.listSkills = vi.fn().mockResolvedValue({ data: [] });

            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({
                data: [model],
                nextCursor: null,
            });

            const thread: Thread = {
                id: 'session-1',
                sessionId: 'session-1',
                parentThreadId: null,
                threadSource: null,
                originator: null,
                forkedFromId: null,
                preview: 'Hi',
                ephemeral: false,
                modelProvider: 'openai',
                model: null,
                reasoningEffort: null,
                createdAt: 123,
                updatedAt: 124,
                recencyAt: null,
                status: { type: 'idle' },
                path: null,
                cwd: '/test/project',
                cliVersion: '0.0.0',
                section: null,
                sectionEnteredAt: null,
                projectId: null,
                historyMode: 'legacy',
                source: 'cli',
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            };
            appServer.threadResume = vi.fn().mockImplementation(async () => {
                // The app-server replays the persisted `thread/tokenUsage/updated`
                // snapshot to the attaching connection right after the resume
                // response, mirroring the wire's response-then-notification order.
                queueMicrotask(() => {
                    fixture.sendServerNotification(createTokenUsageNotification('session-1', {
                        total: restoredTotal,
                        last: restoredLast,
                        modelContextWindow,
                    }));
                });
                return {
                    thread,
                    model: model.id,
                    modelProvider: 'openai',
                    cwd: '/test/project',
                    approvalPolicy: 'never',
                    sandbox: { type: 'dangerFullAccess' },
                    reasoningEffort: model.defaultReasoningEffort,
                };
            });
            appServer.threadReadWithHistory = vi.fn().mockResolvedValue({ thread });

            return agent;
        }

        it('should surface the restored usage replay as usage_update with total/last preserved', async () => {
            const fixture = createCodexMockTestFixture();
            const agent = setupLoadSessionWithRestoredUsage(fixture, 128000);

            await agent.initialize({ protocolVersion: 1 });

            await agent.loadSession({
                sessionId: 'session-1',
                cwd: '/test/project',
                mcpServers: [],
            });

            // The restored cumulative usage must land in the session state.
            const state = agent.getSessionState('session-1');
            expect(state.totalTokenUsage).toEqual(toTokenCount(restoredTotal));
            expect(state.lastTokenUsage).toEqual(toTokenCount(restoredLast));
            expect(state.modelContextWindow).toBe(128000);

            // And the client must receive the restored usage_update.
            const usageUpdates = fixture.getAcpConnectionEvents([])
                .filter((event) => event.method === 'sessionUpdate')
                .map((event) => event.args[0]?.update)
                .filter((update) => update?.sessionUpdate === 'usage_update');
            expect(usageUpdates).toEqual([
                { sessionUpdate: 'usage_update', used: 2500, size: 128000 },
            ]);
        });

        it('should keep restored usage state even when usage_update cannot be derived', async () => {
            const fixture = createCodexMockTestFixture();
            const agent = setupLoadSessionWithRestoredUsage(fixture, null);

            await agent.initialize({ protocolVersion: 1 });

            await agent.loadSession({
                sessionId: 'session-1',
                cwd: '/test/project',
                mcpServers: [],
            });

            const state = agent.getSessionState('session-1');
            expect(state.totalTokenUsage).toEqual(toTokenCount(restoredTotal));
            expect(state.lastTokenUsage).toEqual(toTokenCount(restoredLast));
            expect(state.modelContextWindow).toBeNull();

            const usageUpdates = fixture.getAcpConnectionEvents([])
                .filter((event) => event.method === 'sessionUpdate')
                .map((event) => event.args[0]?.update)
                .filter((update) => update?.sessionUpdate === 'usage_update');
            expect(usageUpdates).toEqual([]);
        });
    });

    describe('restored usage reload over an existing session handler', () => {
        const initialRestoredTotal: TokenUsageBreakdown = {
            totalTokens: 5000,
            inputTokens: 4000,
            cachedInputTokens: 1000,
            cacheWriteInputTokens: 0,
            outputTokens: 900,
            reasoningOutputTokens: 100,
        };
        const initialRestoredLast: TokenUsageBreakdown = {
            totalTokens: 2500,
            inputTokens: 2000,
            cachedInputTokens: 500,
            cacheWriteInputTokens: 0,
            outputTokens: 450,
            reasoningOutputTokens: 50,
        };

        function usageBreakdown(totalTokens: number, inputTokens: number, outputTokens: number): TokenUsageBreakdown {
            return {
                totalTokens,
                inputTokens,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens,
                reasoningOutputTokens: 0,
            };
        }

        function createRestoredUsageThread(): Thread {
            return {
                id: 'session-1',
                sessionId: 'session-1',
                parentThreadId: null,
                threadSource: null,
                originator: null,
                forkedFromId: null,
                preview: 'Hi',
                ephemeral: false,
                modelProvider: 'openai',
                model: null,
                reasoningEffort: null,
                createdAt: 123,
                updatedAt: 124,
                recencyAt: null,
                status: {type: 'idle'},
                path: null,
                cwd: '/test/project',
                cliVersion: '0.0.0',
                section: null,
                sectionEnteredAt: null,
                projectId: null,
                historyMode: 'legacy',
                source: 'cli',
                agentNickname: null,
                agentRole: null,
                gitInfo: null,
                name: null,
                turns: [],
            };
        }

        function setupReloadableSession(fixture: CodexMockTestFixture) {
            const agent = fixture.getCodexAcpAgent();
            const client = fixture.getCodexAcpClient();
            const appServer = fixture.getCodexAppServerClient();

            client.authRequired = vi.fn().mockResolvedValue(false);
            client.getAccount = vi.fn().mockResolvedValue({
                account: null,
                requiresOpenaiAuth: false,
            });
            client.listSkills = vi.fn().mockResolvedValue({data: []});

            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({
                data: [model],
                nextCursor: null,
            });

            const thread = createRestoredUsageThread();
            // The snapshot the app-server replays after each resume response;
            // tests mutate it between loads to mirror what the server persisted.
            const replay = {
                total: {...initialRestoredTotal},
                last: {...initialRestoredLast},
                modelContextWindow: 128000 as number | null,
            };

            appServer.threadResume = vi.fn().mockImplementation(async () => {
                queueMicrotask(() => {
                    fixture.sendServerNotification(createTokenUsageNotification('session-1', {
                        total: replay.total,
                        last: replay.last,
                        modelContextWindow: replay.modelContextWindow,
                    }));
                });
                return {
                    thread,
                    model: model.id,
                    modelProvider: 'openai',
                    cwd: '/test/project',
                    approvalPolicy: 'never',
                    sandbox: {type: 'dangerFullAccess'},
                    reasoningEffort: model.defaultReasoningEffort,
                };
            });
            appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread});

            return {agent, appServer, replay};
        }

        function mockPromptTurn(fixture: CodexMockTestFixture, liveUsage: {
            total: TokenUsageBreakdown;
            last: TokenUsageBreakdown;
            modelContextWindow: number | null;
        } | null) {
            const appServer = fixture.getCodexAppServerClient();
            appServer.turnStart = vi.fn().mockResolvedValue({
                turn: {id: 'turn-id', items: [], status: 'inProgress', error: null},
            });
            appServer.awaitTurnCompleted = vi.fn().mockImplementation(async () => {
                if (liveUsage !== null) {
                    fixture.sendServerNotification(createTokenUsageNotification('session-1', liveUsage));
                }
                return {
                    threadId: 'session-1',
                    turn: {id: 'turn-id', items: [], status: 'completed', error: null},
                };
            });
        }

        it('resume after an existing prompt restores usage and keeps later live usage flowing', async () => {
            const fixture = createCodexMockTestFixture();
            const {agent} = setupReloadableSession(fixture);
            mockPromptTurn(fixture, null);
            await agent.initialize({protocolVersion: 1});
            const request = {sessionId: 'session-1', cwd: '/test/project', mcpServers: []};
            await agent.loadSession(request);
            await agent.prompt({sessionId: 'session-1', prompt: [{type: 'text', text: 'First turn.'}]});

            await agent.resumeSession(request);
            expect(agent.getSessionState('session-1').totalTokenUsage).toEqual(toTokenCount(initialRestoredTotal));
            const liveUsage = {
                total: usageBreakdown(8000, 6500, 1500),
                last: usageBreakdown(3000, 2500, 500),
                modelContextWindow: 128000,
            };
            mockPromptTurn(fixture, liveUsage);
            const response = await agent.prompt({sessionId: 'session-1', prompt: [{type: 'text', text: 'Second turn.'}]});
            await fixture.getCodexAcpClient().waitForSessionNotifications('session-1');
            expect(agent.getSessionState('session-1').totalTokenUsage).toEqual(toTokenCount(liveUsage.total));
            expect(response.usage?.totalTokens).toBe(3000);
        });

        it('serializes concurrent loads and resume through history replay and state installation', async () => {
            const fixture = createCodexMockTestFixture();
            const {agent, appServer} = setupReloadableSession(fixture);
            let releaseHistory: (value: {thread: Thread}) => void = () => {};
            const history = new Promise<{thread: Thread}>(resolve => { releaseHistory = resolve; });
            appServer.threadReadWithHistory = vi.fn()
                .mockReturnValueOnce(history)
                .mockResolvedValue({thread: createRestoredUsageThread()});
            await agent.initialize({protocolVersion: 1});
            const request = {sessionId: 'session-1', cwd: '/test/project', mcpServers: []};
            const first = agent.loadSession(request);
            await vi.waitFor(() => expect(appServer.threadReadWithHistory).toHaveBeenCalledTimes(1));
            const second = agent.loadSession(request);
            const third = agent.resumeSession(request);
            await new Promise(resolve => setImmediate(resolve));
            expect(appServer.threadResume).toHaveBeenCalledTimes(1);

            releaseHistory({thread: createRestoredUsageThread()});
            await first;
            await second;
            await third;
            expect(appServer.threadResume).toHaveBeenCalledTimes(3);
            expect(agent.getSessionState('session-1').totalTokenUsage).toEqual(toTokenCount(initialRestoredTotal));
            expect(agent.getSessionState('session-1').lastTokenUsage).toEqual(toTokenCount(initialRestoredLast));
            const usageUpdates = fixture.getAcpConnectionEvents([])
                .filter(event => event.method === 'sessionUpdate')
                .map(event => event.args[0]?.update)
                .filter(update => update?.sessionUpdate === 'usage_update');
            expect(usageUpdates).toEqual(Array.from({length: 3}, () => ({sessionUpdate: 'usage_update', used: 2500, size: 128000})));
        });

        it('releases the open queue and failed capture when resume fails before subscription', async () => {
            const fixture = createCodexMockTestFixture();
            const {agent, appServer} = setupReloadableSession(fixture);
            vi.mocked(appServer.threadResume).mockRejectedValueOnce(new Error('resume request failed'));
            await agent.initialize({protocolVersion: 1});
            const request = {sessionId: 'session-1', cwd: '/test/project', mcpServers: []};
            const results = await Promise.allSettled([agent.loadSession(request), agent.loadSession(request)]);
            expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled']);
            expect(results[0]).toMatchObject({reason: {message: 'resume request failed'}});
            expect(agent.getSessionState('session-1').totalTokenUsage).toEqual(toTokenCount(initialRestoredTotal));
            expect(appServer.takePendingRestoredTokenUsage('session-1')).toBeNull();
        });

        it('does not revive a closed session from an open queued behind an earlier load', async () => {
            const fixture = createCodexMockTestFixture();
            const {agent, appServer} = setupReloadableSession(fixture);
            let releaseHistory: (value: {thread: Thread}) => void = () => {};
            appServer.threadReadWithHistory = vi.fn().mockReturnValue(new Promise(resolve => { releaseHistory = resolve; }));
            await agent.initialize({protocolVersion: 1});
            const request = {sessionId: 'session-1', cwd: '/test/project', mcpServers: []};
            const first = agent.loadSession(request);
            await vi.waitFor(() => expect(appServer.threadReadWithHistory).toHaveBeenCalledTimes(1));
            const second = agent.loadSession(request);
            const results = Promise.allSettled([first, second]);
            await agent.closeSession({sessionId: 'session-1'});
            releaseHistory({thread: createRestoredUsageThread()});

            expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
            expect(appServer.threadResume).toHaveBeenCalledTimes(1);
            expect(() => agent.getSessionState('session-1')).toThrow('Session session-1 not found');
            expect(appServer.takePendingRestoredTokenUsage('session-1')).toBeNull();
        });

        it('reload after a prompt restores usage into the newly installed state exactly once', async () => {
            const fixture = createCodexMockTestFixture();
            const {agent, appServer} = setupReloadableSession(fixture);
            mockPromptTurn(fixture, null);

            await agent.initialize({protocolVersion: 1});
            const request = {sessionId: 'session-1', cwd: '/test/project', mcpServers: []};
            await agent.loadSession(request);
            const firstState = agent.getSessionState('session-1');
            expect(firstState.totalTokenUsage).toEqual(toTokenCount(initialRestoredTotal));

            // The prompt leaves a session-scoped notification handler behind.
            await agent.prompt({sessionId: 'session-1', prompt: [{type: 'text', text: 'Continue.'}]});

            fixture.clearAcpConnectionDump();
            await agent.loadSession(request);
            await fixture.getCodexAcpClient().waitForSessionNotifications('session-1');

            const reloadedState = agent.getSessionState('session-1');
            expect(reloadedState).not.toBe(firstState);
            expect(reloadedState.totalTokenUsage).toEqual(toTokenCount(initialRestoredTotal));
            expect(reloadedState.lastTokenUsage).toEqual(toTokenCount(initialRestoredLast));
            expect(reloadedState.modelContextWindow).toBe(128000);

            // Exactly one restored usage_update reached the client: the one the
            // load emitted. The pre-load handler must not have duplicated it.
            const usageUpdates = fixture.getAcpConnectionEvents([])
                .filter((event) => event.method === 'sessionUpdate')
                .map((event) => event.args[0]?.update)
                .filter((update) => update?.sessionUpdate === 'usage_update');
            expect(usageUpdates).toEqual([
                {sessionUpdate: 'usage_update', used: 2500, size: 128000},
            ]);
        });

        it('a reloaded snapshot with newer persisted usage wins and a late duplicate does not double-apply', async () => {
            const fixture = createCodexMockTestFixture();
            const {agent, replay} = setupReloadableSession(fixture);
            const liveUsage = {
                total: usageBreakdown(8000, 6500, 1500),
                last: usageBreakdown(3000, 2500, 500),
                modelContextWindow: 128000,
            };
            mockPromptTurn(fixture, liveUsage);

            await agent.initialize({protocolVersion: 1});
            const request = {sessionId: 'session-1', cwd: '/test/project', mcpServers: []};
            await agent.loadSession(request);
            const firstState = agent.getSessionState('session-1');

            // The interleaved prompt adds live usage to the session state.
            await agent.prompt({sessionId: 'session-1', prompt: [{type: 'text', text: 'Continue.'}]});
            await fixture.getCodexAcpClient().waitForSessionNotifications('session-1');
            expect(firstState.totalTokenUsage).toEqual(toTokenCount(liveUsage.total));

            // The server persisted that turn, so the next load replays newer
            // totals; the reloaded state must carry them, not the stale live
            // snapshot and not null.
            replay.total = usageBreakdown(9000, 7500, 1500);
            replay.last = usageBreakdown(3500, 3000, 500);
            await agent.loadSession(request);
            await fixture.getCodexAcpClient().waitForSessionNotifications('session-1');

            const reloadedState = agent.getSessionState('session-1');
            expect(reloadedState).not.toBe(firstState);
            expect(reloadedState.totalTokenUsage).toEqual(toTokenCount(replay.total));
            expect(reloadedState.lastTokenUsage).toEqual(toTokenCount(replay.last));
            expect(reloadedState.modelContextWindow).toBe(128000);

            // A late duplicate of the older restored replay must not roll the
            // reloaded state back.
            fixture.sendServerNotification(createTokenUsageNotification('session-1', {
                total: initialRestoredTotal,
                last: initialRestoredLast,
                modelContextWindow: 128000,
            }));
            await fixture.getCodexAcpClient().waitForSessionNotifications('session-1');
            expect(agent.getSessionState('session-1')).toBe(reloadedState);
            expect(reloadedState.totalTokenUsage).toEqual(toTokenCount(replay.total));
            expect(reloadedState.lastTokenUsage).toEqual(toTokenCount(replay.last));
        });

        it('a rejecting transport keeps the load successful and never raises an unhandled rejection', async () => {
            const unhandled: unknown[] = [];
            const onUnhandledRejection = (reason: unknown) => {
                unhandled.push(reason);
            };
            process.on('unhandledRejection', onUnhandledRejection);

            const acpEvents: MethodCallEvent[] = [];
            const acpConnection: AcpClientConnection = {
                notify: (method: string, params: unknown) => {
                    acpEvents.push({method, args: [method, params]});
                    const update = (params as {update?: {sessionUpdate?: string}} | undefined)?.update;
                    if (method === 'session/update' && update?.sessionUpdate === 'usage_update') {
                        return Promise.reject(new Error('ACP transport closed'));
                    }
                    return Promise.resolve();
                },
                request: () => Promise.resolve({mock: 'Mocked return'}),
            };
            let serverNotification: ((notification: ServerNotification) => void) | null = null;
            const mockCodexConnection = {
                sendRequest: () => Promise.resolve(undefined),
                onUnhandledNotification: (handler: (notification: ServerNotification) => void) => {
                    serverNotification = handler;
                },
                onNotification: () => {},
                onRequest: () => {},
                end: () => {},
            } as unknown as MessageConnection;
            const fixture = createBaseTestFixture({
                connection: mockCodexConnection,
                getExitCode: () => null,
                acpConnection: {connection: acpConnection, events: acpEvents, eventHandlers: []},
            });

            const agent = fixture.getCodexAcpAgent();
            const client = fixture.getCodexAcpClient();
            const appServer = fixture.getCodexAppServerClient();
            client.authRequired = vi.fn().mockResolvedValue(false);
            client.getAccount = vi.fn().mockResolvedValue({
                account: null,
                requiresOpenaiAuth: false,
            });
            client.listSkills = vi.fn().mockResolvedValue({data: []});
            const model = createTestModel();
            appServer.listModels = vi.fn().mockResolvedValue({
                data: [model],
                nextCursor: null,
            });
            const thread = createRestoredUsageThread();
            appServer.threadResume = vi.fn().mockImplementation(async () => {
                queueMicrotask(() => {
                    serverNotification?.(createTokenUsageNotification('session-1', {
                        total: initialRestoredTotal,
                        last: initialRestoredLast,
                        modelContextWindow: 128000,
                    }));
                });
                return {
                    thread,
                    model: model.id,
                    modelProvider: 'openai',
                    cwd: '/test/project',
                    approvalPolicy: 'never',
                    sandbox: {type: 'dangerFullAccess'},
                    reasoningEffort: model.defaultReasoningEffort,
                };
            });
            appServer.threadReadWithHistory = vi.fn().mockResolvedValue({thread});

            try {
                await agent.initialize({protocolVersion: 1});
                // The load must succeed even though the usage_update send rejects.
                await agent.loadSession({sessionId: 'session-1', cwd: '/test/project', mcpServers: []});

                const state = agent.getSessionState('session-1');
                expect(state.totalTokenUsage).toEqual(toTokenCount(initialRestoredTotal));
                expect(state.lastTokenUsage).toEqual(toTokenCount(initialRestoredLast));
                expect(state.modelContextWindow).toBe(128000);

                // Let the rejected send's catch settle; nothing may surface as
                // an unhandled rejection.
                await new Promise(resolve => setImmediate(resolve));
                await new Promise(resolve => setImmediate(resolve));
                expect(unhandled).toEqual([]);
            } finally {
                process.off('unhandledRejection', onUnhandledRejection);
            }
        });
    });
});
