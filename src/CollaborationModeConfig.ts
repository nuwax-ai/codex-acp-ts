import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {ReasoningEffort} from "./app-server";
import type {ModeKind} from "./app-server/ModeKind";
import {ModelId} from "./ModelId";
import {isDefaultEffort} from "./ReasoningEffortDefault";

export const COLLABORATION_MODE_CONFIG_ID = "collaboration_mode";
export const DEFAULT_COLLABORATION_MODE: ModeKind = "default";
export const PLAN_COLLABORATION_MODE: ModeKind = "plan";

export function createCollaborationModeConfigOption(currentValue: ModeKind): acp.SessionConfigOption {
    return {
        id: COLLABORATION_MODE_CONFIG_ID,
        name: "Collaboration mode",
        description: "How Codex collaborates for subsequent turns",
        category: "collaboration_mode",
        type: "select",
        currentValue,
        options: [
            {value: DEFAULT_COLLABORATION_MODE, name: "Default"},
            {value: PLAN_COLLABORATION_MODE, name: "Plan", description: "Plan before making changes"},
        ],
    };
}

export function parseCollaborationMode(value: unknown): ModeKind | null {
    if (value === DEFAULT_COLLABORATION_MODE) return DEFAULT_COLLABORATION_MODE;
    if (value === PLAN_COLLABORATION_MODE) return PLAN_COLLABORATION_MODE;
    return null;
}

export function createCodexCollaborationMode(mode: ModeKind, currentModelId: string) {
    const modelId = ModelId.fromString(currentModelId);
    return {
        mode,
        settings: {
            model: modelId.model,
            // Fork (2026-11-10): the no-explicit-tier sentinel must reach the
            // engine as `null`, not as a tier. This function is the resume and
            // mode-switch path that writes the thread settings, so forwarding
            // the sentinel verbatim would send `reasoning_effort: "default"` —
            // an unknown custom tier the engine's tier gate rejects. `null`
            // leaves the field unset and the gateway applies its own default.
            reasoning_effort: isDefaultEffort(modelId.effort)
                ? null
                : (modelId.effort as ReasoningEffort),
            developer_instructions: null,
        },
    };
}
