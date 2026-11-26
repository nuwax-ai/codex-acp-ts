import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
    createCodexMockTestFixture,
    createTestModel,
    mockPromptTurn,
    setupPromptTestSession,
    type CodexMockTestFixture,
} from "../acp-test-utils";
import {
    createFastModeConfigOption,
    FAST_MODE_CONFIG_ID,
    FAST_MODE_OFF,
    FAST_MODE_ON,
    isFastServiceTier,
    modelSupportsFast,
} from "../../FastModeConfig";
import {MODEL_CONFIG_ID} from "../../ModelConfigOption";

describe("Fast mode session config", () => {
    const booleanConfigCapabilities: acp.ClientCapabilities = {
        session: {
            configOptions: {
                boolean: {},
            },
        },
    };

    async function createSession(
        currentServiceTier: string | null = null,
        clientInfo: acp.Implementation | null = null,
        clientCapabilities?: acp.ClientCapabilities,
    ) {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const threadFastMode = allowThreadFastMode(codexAcpClient);
        const fastModel = createTestModel({
            id: "fast-model",
            additionalSpeedTiers: ["fast"],
        });
        const slowModel = createTestModel({id: "slow-model"});

        vi.spyOn(codexAcpClient, "readAuthRequirement").mockResolvedValue({required: false, account: null});
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            models: [fastModel, slowModel],
            collaborationMode: "default",
            currentServiceTier,
            additionalDirectories: [],
        });

        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientInfo,
            ...(clientCapabilities ? {clientCapabilities} : {}),
        });

        const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
        return {fixture, codexAcpAgent, codexAcpClient, threadFastMode, response};
    }

    /** The engine call a toggle makes (`thread/settings/update`); resolved unless a test decides otherwise. */
    function allowThreadFastMode(client: ReturnType<CodexMockTestFixture["getCodexAcpClient"]>) {
        return vi.spyOn(client, "setThreadFastMode").mockResolvedValue(undefined);
    }

    function setupPromptSession(fastModeEnabled: boolean, currentModelSupportsFast: boolean) {
        const {mockFixture, sessionState, turnStartSpy} = setupPromptTestSession({
            sessionId: "session-id",
            currentModelId: "fast-model[medium]",
            fastModeEnabled,
            currentModelSupportsFast,
        });
        const threadFastMode = allowThreadFastMode(mockFixture.getCodexAcpClient());
        return {codexAcpAgent: mockFixture.getCodexAcpAgent(), sessionState, turnStartSpy, threadFastMode};
    }

    it("returns the Fast mode config option defaulted to Off for new sessions", async () => {
        const {response} = await createSession();

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("returns the Fast mode config option as a boolean when the client supports it", async () => {
        const {response} = await createSession(null, null, booleanConfigCapabilities);

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false, true));
        const option = response.configOptions?.find(option => option.id === FAST_MODE_CONFIG_ID);
        expect(option).toMatchObject({
            id: FAST_MODE_CONFIG_ID,
            type: "boolean",
            currentValue: false,
        });
        expect(option).not.toHaveProperty("options");
    });

    it("keeps the Fast mode select option when boolean support is explicitly absent", async () => {
        const {response} = await createSession(null, null, {
            session: {
                configOptions: {
                    boolean: null,
                },
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    // The engine accepts `fast` as a request value but reports the tier under its canonical id
    // `priority`: nuwax-harness 0.18.65 answers a thread started with "fast" with "priority".
    it.each(["fast", "priority"])("initializes Fast mode as On when the app-server session tier is %s", async currentServiceTier => {
        const {response, codexAcpAgent} = await createSession(currentServiceTier);

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);
    });

    it("keeps the tier of a thread that reported `priority`, instead of clearing it on the first turn", async () => {
        const {codexAcpAgent, fixture} = await createSession("priority");
        const turnStartSpy = mockPromptTurn(fixture, "session-id");

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({serviceTier: "fast"}));
    });

    it("shows Fast mode as Off for a thread on another tier, and leaves that tier alone", async () => {
        const {codexAcpAgent, fixture} = await createSession("flex");
        const turnStartSpy = mockPromptTurn(fixture, "session-id");
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy.mock.calls[0]![0]).not.toHaveProperty("serviceTier");
    });

    it("omits Fast mode config options for JetBrains 2026.1 IntelliJ clients", async () => {
        const {response, fixture, codexAcpAgent} = await createSession(null, {
            name: "JetBrains.WebStorm",
            version: "2026.1.1",
            title: "WebStorm 2026.1.1",
            _meta: {
                platform: "intellij",
            },
        });

        expect(response.configOptions).toBeUndefined();
        await codexAcpAgent.setSessionConfigOption({sessionId: response.sessionId, configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_ON});
        expect(fixture.getAcpConnectionEvents([]).some(event =>
            event.method === "sessionUpdate" && event.args[0]?.update?.sessionUpdate === "config_option_update")).toBe(false);
    });

    it("omits Fast mode config options for JetBrains 2026.1 clients by name", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.IDE",
            version: "2026.1",
            title: "JetBrains IDE",
        });

        expect(response.configOptions).toBeUndefined();
    });

    it("keeps Fast mode config options for JetBrains clients outside 2026.1", async () => {
        const {response} = await createSession(null, {
            name: "JetBrains.WebStorm",
            version: "2026.2.0",
            title: "WebStorm 2026.2.0",
            _meta: {
                platform: "intellij",
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("keeps Fast mode config options for non-JetBrains 2026.1 clients", async () => {
        const {response} = await createSession(null, {
            name: "VSCode",
            version: "2026.1.1",
            title: "VS Code",
            _meta: {
                platform: "vscode",
            },
        });

        expect(response.configOptions).toContainEqual(createFastModeConfigOption(false));
    });

    it("toggles Fast mode through session config options", async () => {
        const {codexAcpAgent, threadFastMode} = await createSession();

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_ON,
        });
        expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: FAST_MODE_OFF,
        });
        expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);

        // Each change is applied to the thread itself, so it survives a close and resume.
        expect(threadFastMode.mock.calls).toEqual([["session-id", true], ["session-id", false]]);
    });

    it("toggles Fast mode through boolean session config options", async () => {
        const {codexAcpAgent, threadFastMode} = await createSession(null, null, booleanConfigCapabilities);

        const onResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: true,
        });
        expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true, true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        const offResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            type: "boolean",
            value: false,
        });
        expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false, true));
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);
        expect(threadFastMode.mock.calls).toEqual([["session-id", true], ["session-id", false]]);
    });

    it("rejects unknown Fast mode config ids and values", async () => {
        const {codexAcpAgent} = await createSession();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: "unknown-config",
            value: FAST_MODE_ON,
        })).rejects.toThrow();

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: FAST_MODE_CONFIG_ID,
            value: "turbo",
        })).rejects.toThrow();
    });

    it("sends the fast service tier when Fast mode is enabled for a fast-capable model", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(true, true);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: "fast",
        }));
    });

    // `serviceTier: null` tells the engine to clear the thread's tier for this and every later
    // turn, so it is reserved for a real turn-off. A thread whose tier Fast mode merely does not
    // describe (none, `flex`, a catalog tier) keeps it.
    it("leaves the thread's tier alone when Fast mode is off and the user did not turn it off", async () => {
        const {codexAcpAgent, turnStartSpy, sessionState} = setupPromptSession(false, true);
        expect(sessionState.fastModeExplicitlyOff).toBe(false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy.mock.calls[0]![0]).not.toHaveProperty("serviceTier");
    });

    it("still leaves the tier alone when the user turns off an already-off Fast mode", async () => {
        const {codexAcpAgent, turnStartSpy, sessionState, threadFastMode} = setupPromptSession(false, true);

        await codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF});
        expect(sessionState.fastModeExplicitlyOff).toBe(false);
        expect(threadFastMode).not.toHaveBeenCalled();
        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy.mock.calls[0]![0]).not.toHaveProperty("serviceTier");
    });

    it("explicitly clears the tier on every turn once the user has turned Fast mode off", async () => {
        const {codexAcpAgent, turnStartSpy, sessionState, threadFastMode} = setupPromptSession(true, true);

        await codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF});
        expect(sessionState.fastModeExplicitlyOff).toBe(true);
        // Turning off what is already off must not undo the explicit clear.
        await codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF});
        expect(sessionState.fastModeExplicitlyOff).toBe(true);
        expect(threadFastMode.mock.calls).toEqual([["session-id", false]]);
        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: null,
        }));
    });

    it("asks for the fast tier again after the user turns Fast mode back on", async () => {
        const {codexAcpAgent, turnStartSpy, sessionState, threadFastMode} = setupPromptSession(true, true);

        await codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF});
        await codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_ON});
        expect(sessionState.fastModeExplicitlyOff).toBe(false);
        expect(threadFastMode.mock.calls).toEqual([["session-id", false], ["session-id", true]]);
        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: "fast",
        }));
    });

    it("explicitly clears service tier when the selected model does not support fast", async () => {
        const {codexAcpAgent, turnStartSpy} = setupPromptSession(true, false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            serviceTier: null,
        }));
    });

    it("removes the Fast mode config option when switching to a non-fast model via session_config", async () => {
        const {codexAcpAgent} = await createSession("fast");

        const fastResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "fast-model",
        });
        expect(fastResponse.configOptions?.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(true);

        const slowResponse = await codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id",
            configId: MODEL_CONFIG_ID,
            value: "slow-model",
        });
        expect(slowResponse.configOptions?.some(o => o.id === FAST_MODE_CONFIG_ID)).toBe(false);
    });

    it("keeps Fast mode selected across model switches but stops applying it for non-fast models", async () => {
        const {codexAcpAgent, codexAcpClient, fixture} = await createSession("fast");
        const slowModel = createTestModel({id: "slow-model"});
        vi.spyOn(codexAcpClient, "fetchAvailableModels").mockResolvedValue([slowModel]);
        const turnStartSpy = mockPromptTurn(fixture, "session-id");

        await codexAcpAgent.unstable_setSessionModel({
            sessionId: "session-id",
            modelId: "slow-model[medium]",
        });

        const sessionState = codexAcpAgent.getSessionState("session-id");
        expect(sessionState.fastModeEnabled).toBe(true);
        expect(sessionState.currentModelSupportsFast).toBe(false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy).toHaveBeenCalledWith(expect.objectContaining({
            model: "slow-model",
            serviceTier: null,
        }));
    });

    // Fast mode and the thread's own tier: a change is applied to the thread at once.
    it("does not bother the engine when the choice does not change", async () => {
        const on = await createSession("priority");
        await on.codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_ON});
        const off = await createSession();
        await off.codexAcpAgent.setSessionConfigOption({sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF});

        expect(on.threadFastMode).not.toHaveBeenCalled();
        expect(off.threadFastMode).not.toHaveBeenCalled();
    });

    it("applies the last toggle when a previous toggle is in flight", async () => {
        const {codexAcpAgent, threadFastMode} = await createSession("priority");
        let confirmOff!: () => void;
        threadFastMode.mockReturnValueOnce(new Promise<void>(resolve => {confirmOff = resolve;}));
        const toggle = (value: string) => codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value,
        });

        const off = toggle(FAST_MODE_OFF);
        await vi.waitFor(() => expect(threadFastMode).toHaveBeenCalledWith("session-id", false));
        const on = toggle(FAST_MODE_ON);
        confirmOff();
        await off;
        expect((await on).configOptions).toContainEqual(createFastModeConfigOption(true));
        expect(threadFastMode.mock.calls).toEqual([["session-id", false], ["session-id", true]]);
    });

    it.each(["applied", "rejected"])("waits for the engine's %s result after queue acknowledgement", async outcome => {
        const {codexAcpAgent, codexAcpClient, fixture} = await createSession("priority");
        vi.mocked(codexAcpClient.setThreadFastMode).mockRestore();
        const app = fixture.getCodexAppServerClient();
        const queued = vi.spyOn(app, "threadSettingsUpdate").mockResolvedValue(undefined);
        const off = codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_OFF,
        });
        const completed = vi.fn();
        void off.then(completed, completed);
        await vi.waitFor(() => expect(queued).toHaveBeenCalledWith({threadId: "session-id", serviceTier: null}));
        expect(completed).not.toHaveBeenCalled();
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);

        if (outcome === "applied") {
            fixture.sendServerNotification({method: "thread/settings/updated", params: {
                threadId: "different-thread", threadSettings: {serviceTier: "default"},
            }});
            await Promise.resolve();
            expect(completed).not.toHaveBeenCalled();
            fixture.sendServerNotification({method: "thread/settings/updated", params: {
                threadId: "session-id", threadSettings: {serviceTier: "default"},
            }});
            expect((await off).configOptions).toContainEqual(createFastModeConfigOption(false));
        } else {
            fixture.sendServerNotification({method: "error", params: {
                threadId: "session-id", turnId: "settings-operation", willRetry: false,
                error: {message: "invalid thread settings override: test rejection", codexErrorInfo: "badRequest"},
            }});
            await expect(off).rejects.toThrow("invalid thread settings override: test rejection");
            expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(true);
        }
    });

    it("leaves the session as it was when the engine rejects the thread update", async () => {
        const {codexAcpAgent, threadFastMode} = await createSession();
        threadFastMode.mockRejectedValueOnce(new Error("thread is busy"));

        await expect(codexAcpAgent.setSessionConfigOption({
            sessionId: "session-id", configId: FAST_MODE_CONFIG_ID, value: FAST_MODE_ON,
        })).rejects.toThrow("thread is busy");

        const sessionState = codexAcpAgent.getSessionState("session-id");
        expect(sessionState.fastModeEnabled).toBe(false);
        expect(sessionState.fastModeExplicitlyOff).toBe(false);
    });

    // The engine answers a thread whose tier was cleared with its "default" sentinel, so a
    // session resumed after a turn-off starts out Off, and its first turn must not undo that.
    it("shows Fast mode as Off for a thread the engine reports as cleared, and leaves it so", async () => {
        const {codexAcpAgent, fixture} = await createSession("default");
        const turnStartSpy = mockPromptTurn(fixture, "session-id");
        expect(codexAcpAgent.getSessionState("session-id").fastModeEnabled).toBe(false);

        await codexAcpAgent.prompt({sessionId: "session-id", prompt: [{type: "text", text: "test"}]});

        expect(turnStartSpy.mock.calls[0]![0]).not.toHaveProperty("serviceTier");
    });
});

describe("fast mode tier helpers", () => {
    it("recognises both ids of the Fast mode tier and nothing else", () => {
        expect(isFastServiceTier("fast")).toBe(true);
        expect(isFastServiceTier("priority")).toBe(true);
        for (const other of ["flex", "ultrafast", "default", "Fast", "", null, undefined]) {
            expect(isFastServiceTier(other)).toBe(false);
        }
    });

    // Same rule as the engine's `ModelPreset::supports_fast_mode`, field by field: the deprecated
    // `additionalSpeedTiers` names the tier `fast`, `serviceTiers` lists it as `priority`.
    it("finds the fast tier in either model field, under the id that field uses", () => {
        const tier = (id: string) => ({id, name: id, description: ""});
        expect(modelSupportsFast(createTestModel({additionalSpeedTiers: ["fast"]}))).toBe(true);
        expect(modelSupportsFast(createTestModel({serviceTiers: [tier("priority")]}))).toBe(true);
        expect(modelSupportsFast(createTestModel({additionalSpeedTiers: ["fast"], serviceTiers: [tier("flex")]}))).toBe(true);
        // A `fast` id under `serviceTiers` is not one the engine honours, so it is not offered.
        expect(modelSupportsFast(createTestModel({serviceTiers: [tier("fast")]}))).toBe(false);
        expect(modelSupportsFast(createTestModel({serviceTiers: [tier("flex"), tier("default")]}))).toBe(false);
        expect(modelSupportsFast(createTestModel())).toBe(false);
        expect(modelSupportsFast(undefined)).toBe(false);
    });
});
