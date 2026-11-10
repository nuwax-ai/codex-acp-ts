import { describe, expect, it } from "vitest";
import { AgentMode } from "../AgentMode";

describe("Fork: the default agent mode", () => {
    it("asks the user, not a model reviewer", () => {
        // nuwax-client owns the ask/yolo decision through session/request_permission.
        // A default of `auto_review` pre-empts it with a guardian model call per
        // action (measured: 842 guardian reviews, 0 permission requests).
        expect(AgentMode.DEFAULT_AGENT_MODE.approvalsReviewer).toBe("user");
        expect(AgentMode.DEFAULT_AGENT_MODE.approvalPolicy).toBe("on-request");
    });

    it("keeps the same sandbox as the auto-review preset", () => {
        // Only the decision-maker differs, so switching the default cannot
        // silently widen what the agent may touch.
        expect(AgentMode.DEFAULT_AGENT_MODE.sandboxPolicy).toEqual(
            AgentMode.Agent.sandboxPolicy,
        );
    });

    it("keeps the auto-review preset selectable", () => {
        const agent = AgentMode.find("agent");
        expect(agent?.approvalsReviewer).toBe("auto_review");
        expect(AgentMode.all().map((mode) => mode.id)).toContain("agent");
    });

    it("honours INITIAL_AGENT_MODE over the default", () => {
        const previous = process.env["INITIAL_AGENT_MODE"];
        try {
            process.env["INITIAL_AGENT_MODE"] = "agent";
            expect(AgentMode.getInitialAgentMode().id).toBe("agent");
            process.env["INITIAL_AGENT_MODE"] = "read-only";
            expect(AgentMode.getInitialAgentMode().id).toBe("read-only");
            process.env["INITIAL_AGENT_MODE"] = "not-a-mode";
            expect(AgentMode.getInitialAgentMode().id).toBe(
                AgentMode.DEFAULT_AGENT_MODE.id,
            );
        } finally {
            if (previous === undefined) {
                delete process.env["INITIAL_AGENT_MODE"];
            } else {
                process.env["INITIAL_AGENT_MODE"] = previous;
            }
        }
    });
});
