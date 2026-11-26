/**
 * Service tier the adapter asks the engine for: `serviceTier` on thread start
 * and resume, `serviceTierForTurn` on a turn.
 *
 * This is the adapter's own vocabulary, no longer a protocol type. The engine
 * used to publish it as the enum `"fast" | "flex"`, which is where the name
 * came from; the protocol now types the field as a free string, because tiers
 * are configured per model (`ModelServiceTier`), so `generate-ts` no longer
 * emits `ServiceTier.ts`. The engine still recognises both ids (`ServiceTier`
 * in `codex_protocol::config_types`). `"fast"` is the only one the adapter
 * selects — see `resolveFastServiceTier`.
 */
export type ServiceTier = "fast" | "flex";
