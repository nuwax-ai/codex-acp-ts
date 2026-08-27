import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import {
    createCodexMockTestFixture,
    createTestModel,
} from "../acp-test-utils";
import {AgentMode} from "../../AgentMode";

describe("Plan session mode ↔ collaboration mode", () => {
    async function createSession() {
        const fixture = createCodexMockTestFixture();
        const codexAcpAgent = fixture.getCodexAcpAgent();
        const codexAcpClient = fixture.getCodexAcpClient();
        const model = createTestModel({id: "test-model"});

        vi.spyOn(codexAcpClient, "authRequired").mockResolvedValue(false);
        vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: null, requiresOpenaiAuth: false});
        vi.spyOn(codexAcpClient, "newSession").mockResolvedValue({
            sessionId: "session-id",
            currentModelId: "test-model[medium]",
            models: [model],
            collaborationMode: "default",
            currentServiceTier: null,
            additionalDirectories: [],
        });

        await codexAcpAgent.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
        });
        const response = await codexAcpAgent.newSession({cwd: "/test/cwd", mcpServers: []});
        return {fixture, codexAcpAgent, codexAcpClient, response};
    }

    it("advertises the plan mode in availableModes", async () => {
        const {response} = await createSession();
        const modeIds = (response.modes?.availableModes ?? []).map((m) => m.id);
        expect(modeIds).toContain(AgentMode.Plan.id);
    });

    it("set_mode(plan) syncs codex collaboration mode to plan", async () => {
        const {codexAcpAgent, codexAcpClient, response} = await createSession();
        const setCollaboration = vi
            .spyOn(codexAcpClient, "setCollaborationMode")
            .mockResolvedValue(undefined);

        await codexAcpAgent.setSessionMode({
            sessionId: response.sessionId,
            modeId: AgentMode.Plan.id,
        });

        expect(setCollaboration).toHaveBeenCalledWith(
            "session-id",
            "plan",
            "test-model[medium]",
        );
    });

    it("switching back to agent restores the default collaboration mode", async () => {
        const {codexAcpAgent, codexAcpClient, response} = await createSession();
        const setCollaboration = vi
            .spyOn(codexAcpClient, "setCollaborationMode")
            .mockResolvedValue(undefined);

        await codexAcpAgent.setSessionMode({
            sessionId: response.sessionId,
            modeId: AgentMode.Plan.id,
        });
        await codexAcpAgent.setSessionMode({
            sessionId: response.sessionId,
            modeId: AgentMode.Agent.id,
        });

        const modes = setCollaboration.mock.calls.map((call) => call[1]);
        expect(modes).toEqual(["plan", "default"]);
    });

    it("keeps the existing collaboration mode when it already matches", async () => {
        const {codexAcpAgent, codexAcpClient, response} = await createSession();
        const setCollaboration = vi
            .spyOn(codexAcpClient, "setCollaborationMode")
            .mockResolvedValue(undefined);

        // 初始 collaborationMode 即 default，切 agent 档不应触发重复下发
        await codexAcpAgent.setSessionMode({
            sessionId: response.sessionId,
            modeId: AgentMode.Agent.id,
        });
        expect(setCollaboration).not.toHaveBeenCalled();
    });
});
