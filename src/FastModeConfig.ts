import type {SessionConfigOption} from "@agentclientprotocol/sdk/unstable";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type {Model} from "./app-server/v2";

export const FAST_MODE_CONFIG_ID = "fast-mode";
export const FAST_MODE_CATEGORY = "model_config";
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";

const FAST_MODE_DESCRIPTION = "1.5x speed, increased usage";

/**
 * The tier the adapter requests when Fast mode is on. The engine accepts this
 * alias (`ServiceTier::from_request_value`) but names the tier under its
 * canonical id, {@link FAST_TIER_REPORTED_ID}: it reports a thread's tier that
 * way and lists the tier that way in a model's `serviceTiers`.
 */
export const FAST_SERVICE_TIER = "fast";
export const FAST_TIER_REPORTED_ID = "priority";

/**
 * Whether a tier id the engine reported for a thread is the Fast mode tier.
 * Both ids count: the engine reports `priority`, and a thread persisted by an
 * older engine may still say `fast`.
 */
export function isFastServiceTier(tier: string | null | undefined): boolean {
    return tier === FAST_SERVICE_TIER || tier === FAST_TIER_REPORTED_ID;
}

/**
 * The model offers the Fast mode tier. Mirrors the engine's
 * `ModelPreset::supports_fast_mode` field by field: the deprecated
 * `additionalSpeedTiers` names the tier `fast`, `serviceTiers` lists it as
 * `priority`, and a `fast` id under `serviceTiers` is not one the engine honours.
 */
export function modelSupportsFast(model: Model | undefined): boolean {
    return model?.additionalSpeedTiers?.includes(FAST_SERVICE_TIER)
        || model?.serviceTiers?.some(tier => tier.id === FAST_TIER_REPORTED_ID)
        || false;
}

/**
 * What goes into `serviceTier` on a turn. The engine reads the field as a
 * double option, so the three states mean different things to it:
 *
 * - `"fast"` — Fast mode is on and the model has the tier.
 * - `null` — an explicit request for standard speed: the engine clears the
 *   requested tier for this and subsequent turns. Sent when the user turned
 *   Fast mode off, or when the selected model has no fast tier.
 * - `undefined` — the field is omitted: the engine leaves the thread's tier
 *   unchanged. Sent when Fast mode is off and the user did not turn it off, so
 *   a tier this adapter does not manage (or none) is never cleared by accident.
 *
 * A toggle is also applied to the thread itself right away
 * (`CodexAcpClient.setThreadFastMode`), so the choice survives a close and
 * resume; what a turn carries only has to agree with that.
 */
export type TurnServiceTier = "fast" | null | undefined;

export function resolveTurnServiceTier(
    fastModeEnabled: boolean,
    fastModeExplicitlyOff: boolean,
    currentModelSupportsFast: boolean,
): TurnServiceTier {
    if (fastModeEnabled) {
        return currentModelSupportsFast ? FAST_SERVICE_TIER : null;
    }
    return fastModeExplicitlyOff ? null : undefined;
}

export function clientSupportsBooleanConfigOptions(clientCapabilities?: acp.ClientCapabilities | null): boolean {
    return clientCapabilities?.session?.configOptions?.boolean != null;
}

export function createFastModeConfigOption(fastModeEnabled: boolean, useBooleanConfigOption = false): SessionConfigOption {
    if (useBooleanConfigOption) {
        return {
            id: FAST_MODE_CONFIG_ID,
            name: "Fast mode",
            description: FAST_MODE_DESCRIPTION,
            category: FAST_MODE_CATEGORY,
            type: "boolean",
            currentValue: fastModeEnabled,
        };
    }

    return {
        id: FAST_MODE_CONFIG_ID,
        name: "Fast mode",
        description: FAST_MODE_DESCRIPTION,
        category: FAST_MODE_CATEGORY,
        type: "select",
        currentValue: fastModeEnabled ? FAST_MODE_ON : FAST_MODE_OFF,
        options: [
            {
                value: FAST_MODE_OFF,
                name: "Off",
                description: "Default speed, normal usage",
            },
            {
                value: FAST_MODE_ON,
                name: "On",
                description: FAST_MODE_DESCRIPTION,
            },
        ],
    };
}
