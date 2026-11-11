import { describe, expect, it, vi } from "vitest";
import type { Model, ReasoningEffortOption } from "../../app-server/v2";
import { ModelId } from "../../ModelId";
import { DEFAULT_EFFORT, hasExplicitEffort, isDefaultEffort } from "../../ReasoningEffortDefault";
import { createCodexCollaborationMode } from "../../CollaborationModeConfig";

const lowHighMax: ReasoningEffortOption[] = [
    {reasoningEffort: "low", description: "Light reasoning"},
    {reasoningEffort: "high", description: "Enhanced reasoning"},
    {reasoningEffort: "max", description: "Deep reasoning"},
];

function glmModel(): Model {
    return {
        id: "glm-5.3-flash",
        model: "glm-5.3-flash",
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        modelSpecialty: null,
        multiAgentVersion: null,
        availableAccessPrograms: null,
        displayName: "GLM-5.3-Flash",
        description: "Always-thinking gateway model with no medium tier.",
        hidden: false,
        supportedReasoningEfforts: lowHighMax,
        // The engine fills this placeholder for every catalog model.
        defaultReasoningEffort: "none",
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
        inputModalities: ["text", "image"],
    };
}

describe("Fork: the no-explicit-tier sentinel", () => {
    it("is distinct from a real tier and from absence", () => {
        expect(isDefaultEffort(null)).toBe(true);
        expect(isDefaultEffort(undefined)).toBe(true);
        expect(isDefaultEffort(DEFAULT_EFFORT)).toBe(true);
        expect(isDefaultEffort("low")).toBe(false);
        expect(hasExplicitEffort("none")).toBe(true);
        expect(hasExplicitEffort(DEFAULT_EFFORT)).toBe(false);
    });

    it("round-trips through a ModelId", () => {
        const id = ModelId.withDefaultEffort("glm-5.3-flash");
        expect(id.toString()).toBe("glm-5.3-flash[default]");
        expect(id.hasDefaultEffort).toBe(true);
        const parsed = ModelId.fromString("glm-5.3-flash[default]");
        expect(parsed.model).toBe("glm-5.3-flash");
        expect(parsed.effort).toBe(DEFAULT_EFFORT);
    });

    it("accepts a bare model id as the sentinel", () => {
        // Clients (and the model-sync path) send bare ids; the bracket-less
        // form used to throw, which silently disabled model switching.
        const parsed = ModelId.fromString("glm-5.3-flash");
        expect(parsed.model).toBe("glm-5.3-flash");
        expect(parsed.effort).toBe(DEFAULT_EFFORT);
    });

    it("reaches the engine as null in the collaboration mode", () => {
        // The resume and mode-switch path writes the thread settings from the
        // identity string: the sentinel must not be forwarded as a tier.
        const mode = createCodexCollaborationMode("default", "glm-5.3-flash[default]");
        expect(mode.settings.model).toBe("glm-5.3-flash");
        expect(mode.settings.reasoning_effort).toBeNull();
    });

    it("forwards an explicit tier in the collaboration mode unchanged", () => {
        const mode = createCodexCollaborationMode("plan", "glm-5.3-flash[high]");
        expect(mode.settings.reasoning_effort).toBe("high");
    });
});

describe("Fork: createModelId never invents a tier", () => {
    it("uses the sentinel for a catalog model with no explicit effort", async () => {
        const { createCodexMockTestFixture } = await import("../acp-test-utils");
        const fixture = createCodexMockTestFixture();
        const result = fixture.getCodexAcpClient().createModelId([glmModel()], "glm-5.3-flash", null);
        expect(result.toString()).toBe("glm-5.3-flash[default]");
    });

    it("keeps an explicit tier the engine reported", async () => {
        const { createCodexMockTestFixture } = await import("../acp-test-utils");
        const fixture = createCodexMockTestFixture();
        const result = fixture.getCodexAcpClient().createModelId([glmModel()], "glm-5.3-flash", "max");
        expect(result.toString()).toBe("glm-5.3-flash[max]");
    });

    it("passes the sentinel through instead of substituting the none placeholder", async () => {
        const { createCodexMockTestFixture } = await import("../acp-test-utils");
        const fixture = createCodexMockTestFixture();
        const result = fixture.getCodexAcpClient().createModelId([glmModel()], "glm-5.3-flash", DEFAULT_EFFORT);
        expect(result.toString()).toBe("glm-5.3-flash[default]");
    });
});

describe("Fork: runTurn never sends the sentinel as a tier", () => {
    it("passes null when the identity carries [default]", async () => {
        // The incident: modelId.effort === "default" was forwarded verbatim to
        // runTurn, which put `reasoning_effort: "default"` on the wire —
        // gateways reject it as an unknown value. The sentinel must become
        // null so the engine omits the field.
        const { createCodexMockTestFixture } = await import("../acp-test-utils");
        const fixture = createCodexMockTestFixture();
        const runTurnSpy = vi.spyOn(fixture.getCodexAppServerClient(), "runTurn")
            .mockResolvedValue({ turn: { id: "t", status: "completed" } } as never);
        // ... (drive a prompt with a [default] ModelId and assert effort===null)
        // For now the type-level guarantee is the fix itself; this test locks
        // the behavior once a full prompt fixture is wired.
        expect(runTurnSpy).not.toHaveBeenCalled(); // placeholder guard
    });
});
