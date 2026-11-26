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
 * alias (`ServiceTier::from_request_value`), but reports the tier under its
 * canonical id `"priority"`, so both have to be recognised when reading one back.
 */
export const FAST_SERVICE_TIER = "fast";

/** Whether a tier id the engine reported is the Fast mode tier. */
export function isFastServiceTier(tier: string | null | undefined): boolean {
    return tier === FAST_SERVICE_TIER || tier === "priority";
}

/**
 * The model offers the Fast mode tier. Mirrors the engine's
 * `ModelPreset::supports_fast_mode`: `additionalSpeedTiers` is deprecated in
 * favour of `serviceTiers`, and a catalog may fill in either.
 */
export function modelSupportsFast(model: Model | undefined): boolean {
    return model?.additionalSpeedTiers?.includes(FAST_SERVICE_TIER)
        || model?.serviceTiers?.some(tier => isFastServiceTier(tier.id))
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
