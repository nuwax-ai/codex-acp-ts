/**
 * Fork (nuwax-codex, 2026-11-10): the "no explicit reasoning tier" sentinel.
 *
 * A `ModelId` is `model[effort]` by construction, so a session that carries no
 * explicit tier still needs an effort token for its identity string. Inventing
 * a real tier there is what produced the `medium` incident: the adapter used
 * to fall back to a hardcoded `medium`, wrote it into the thread settings on
 * the next collaboration-mode apply, and gateways whose catalog has no
 * `medium` (GLM-5.3 takes low/high/max) rejected the request.
 *
 * The sentinel means "the model's own default": the engine omits the field on
 * the wire (verified in `convert_request.rs` — both the chat raw key and the
 * Anthropic typed channel are conditional on `Some`), and every vendor then
 * applies its documented default (GLM-5.3 = max, modern Claude = adaptive on,
 * OpenAI = medium for GPT-5.x). It must never reach a gateway as a tier.
 */

/** The effort token that means "no explicit tier; use the model's default". */
export const DEFAULT_EFFORT = "default";

/** True when `effort` is the no-explicit-tier sentinel (or absent). */
export function isDefaultEffort(effort: string | null | undefined): boolean {
    return effort === null || effort === undefined || effort === DEFAULT_EFFORT;
}

/** Type guard: `effort` names a real tier the session explicitly asked for. */
export function hasExplicitEffort(effort: string | null | undefined): effort is string {
    return !isDefaultEffort(effort);
}
