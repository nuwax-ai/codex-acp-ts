import type {ApprovalsReviewer, AskForApproval, SandboxMode, SandboxPolicy} from "./app-server/v2";
import type {SessionConfigOption, SessionMode, SessionModeState} from "@agentclientprotocol/sdk/unstable";
import {AIR_KIND_KEY, airOnlyMeta} from "./AirExtension";

export const MODE_CONFIG_ID = "mode";

type AgentModeKind = "plan" | "auto_review" | "standard" | "full_access";

export class AgentMode {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly kind: AgentModeKind;
    readonly approvalPolicy: AskForApproval;
    readonly approvalsReviewer: ApprovalsReviewer;
    readonly sandboxPolicy: SandboxPolicy;
    readonly sandboxMode: SandboxMode;

    private constructor(
        id: string,
        name: string,
        description: string,
        kind: AgentModeKind,
        approvalPolicy: AskForApproval,
        approvalsReviewer: ApprovalsReviewer,
        sandboxPolicy: SandboxPolicy,
        sandboxMode: SandboxMode,
    ) {
        this.id = id;
        this.name = name;
        this.description = description;
        this.kind = kind;
        this.approvalPolicy = approvalPolicy;
        this.approvalsReviewer = approvalsReviewer;
        this.sandboxPolicy = sandboxPolicy;
        this.sandboxMode = sandboxMode; // same as sandboxPolicy, need to look for
    }

    static readonly ReadOnly = new AgentMode(
        "read-only",
        "Read-only",
        "Requires approval to edit files and access the internet.",
        "standard",
        "on-request",
        "user",
        {
            type: "readOnly",
            networkAccess: false,
        },
        "read-only",
    );
    static readonly WorkspaceWrite = new AgentMode(
        "workspace-write",
        "Workspace access",
        "Edit workspace files, run commands, and access the network; ask before writing outside the workspace.",
        "standard",
        "on-request",
        "user",
        {
            type: "workspaceWrite",
            writableRoots: [],
            // Fork (nuwax-codex, 2026-11-13): outbound network is part of the
            // workspace-write baseline (matches the engine's
            // `sandbox_workspace_write.network_access` default). Explicit
            // `false` here would re-restrict every client session regardless
            // of engine defaults.
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        },
        "workspace-write",
    );
    static readonly Agent = new AgentMode(
        "agent",
        "Auto review",
        "Only ask for actions detected as potentially unsafe",
        "auto_review",
        "on-request",
        "auto_review",
        {
            type: "workspaceWrite",
            writableRoots: [],
            // Fork (nuwax-codex, 2026-11-13): same network baseline as
            // WorkspaceWrite — see the comment there.
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
        },
        "workspace-write",
    );
    static readonly AgentFullAccess = new AgentMode(
        "agent-full-access",
        "Full access",
        "Unrestricted access to the internet and any file on your computer",
        "full_access",
        "never",
        "user",
        {"type": "dangerFullAccess"},
        "danger-full-access",
    );

    /**
     * Fork (nuwax-codex, 2026-11-10): the default is `workspace-write`, whose
     * reviewer is `user` — NOT `agent` ("Auto review"), whose reviewer is
     * `auto_review`.
     *
     * The `agent` preset routes every approval-needing action to the engine's
     * guardian reviewer (a model call per action) instead of asking the user.
     * nuwax-client already owns that decision: its `agent_mode` (ask/yolo)
     * answers `session/request_permission` locally, so with `agent` as the
     * default the guardian pre-empts it — the client's ask dialogs never
     * appeared (measured: 842 guardian reviews, 0 permission requests) and
     * yolo still paid a model call per action. Both presets share the same
     * `workspaceWrite` sandbox, so only the decision-maker changes.
     *
     * `Agent` stays selectable for clients that want the reviewer.
     */
    static DEFAULT_AGENT_MODE = AgentMode.WorkspaceWrite;

    /** Only AIR gets the mode kind, in `_meta.jetbrains.air.kind`. */
    toSessionMode(airClient: boolean): SessionMode {
        const meta = airOnlyMeta(airClient, AIR_KIND_KEY, this.kind);
        return {
            id: this.id,
            name: this.name,
            description: this.description,
            ...(meta ? {_meta: meta} : {}),
        };
    }

    toSessionModeState(airClient: boolean): SessionModeState {
        return {
            availableModes: AgentMode.all().map(mode => mode.toSessionMode(airClient)),
            currentModeId: this.id
        };
    }

    toConfigOption(airClient: boolean): SessionConfigOption {
        return {
            id: MODE_CONFIG_ID,
            name: "Mode",
            description: "Approval and sandboxing preset for the session",
            category: "mode",
            type: "select",
            currentValue: this.id,
            options: AgentMode.all().map(mode => {
                const meta = airOnlyMeta(airClient, AIR_KIND_KEY, mode.kind);
                return {
                    value: mode.id,
                    name: mode.name,
                    description: mode.description,
                    ...(meta ? {_meta: meta} : {}),
                };
            }),
        };
    }

    static all(): AgentMode[] {
        return [AgentMode.ReadOnly, AgentMode.WorkspaceWrite, AgentMode.Agent, AgentMode.AgentFullAccess];
    }

    static find(modeId: string): AgentMode | null {
        const match = AgentMode.all().find(m => m.id === modeId);
        return match ?? null;
    }

    static getInitialAgentMode(): AgentMode {
        const predefinedAgentMode = process.env["INITIAL_AGENT_MODE"];
        if (predefinedAgentMode) {
            return AgentMode.find(predefinedAgentMode) ?? AgentMode.DEFAULT_AGENT_MODE;
        } else {
            return AgentMode.DEFAULT_AGENT_MODE;
        }
    }
}
