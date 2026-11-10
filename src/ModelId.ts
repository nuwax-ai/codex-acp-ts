import type {ReasoningEffort} from "./app-server";
import type {Model} from "./app-server/v2";
import {DEFAULT_EFFORT} from "./ReasoningEffortDefault";

/**
 * ACP Model ID, combining the base model ID and its reasoning effort level.
 * @example
 * const id = ModelId.fromString("gpt-5.2[high]");
 */
export class ModelId {
    private constructor(
        public readonly model: string,
        public readonly effort: string
    ) {}

    static fromComponents(model: Model, effort: ReasoningEffort): ModelId {
        return new ModelId(model.id, effort);
    }

    static create(modelId: string, effort: ReasoningEffort): ModelId {
        return new ModelId(modelId, effort);
    }

    /** A `ModelId` whose effort is the no-explicit-tier sentinel. */
    static withDefaultEffort(modelId: string): ModelId {
        return new ModelId(modelId, DEFAULT_EFFORT);
    }

    /** True when this id carries the no-explicit-tier sentinel. */
    get hasDefaultEffort(): boolean {
        return this.effort === DEFAULT_EFFORT;
    }

    static fromString(modelId: string): ModelId {
        const bracketMatch = modelId.match(/^(?<model>[^\[]+?)(?:\[(?<effort>[^\]]+)\])?$/);
        const model = bracketMatch?.groups?.["model"];
        const effort = bracketMatch?.groups?.["effort"] ?? DEFAULT_EFFORT;

        if (!model) {
            throw new Error(`Unsupported format of modelId: ${modelId}. Expected: modelId[effort].`);
        }

        return new ModelId(model, effort);
    }

    toString(): string {
        return `${this.model}[${this.effort}]`;
    }
}
