/**
 * Built-in model providers whose credentials the engine reports through its own
 * account. For them `account/read` answers `{type: "amazonBedrock"}` or
 * `{type: "gcp"}`, so a session's login is described by that read, exactly like
 * an OpenAI one. Every other provider authenticates with a gateway of its own,
 * and the Codex account says nothing about whether that gateway is usable.
 *
 * The ids are the engine's (`model-provider-info/src/lib.rs`):
 * `AMAZON_BEDROCK_PROVIDER_ID`, `AMAZON_BEDROCK_RUNTIME_PROVIDER_ID` and
 * `GCP_PROVIDER_ID`. They are not the account type names: the Bedrock account
 * is `"amazonBedrock"`, the provider is `"amazon-bedrock"`.
 */
export const BUILT_IN_EXTERNAL_PROVIDER_IDS: ReadonlySet<string> = new Set([
    "amazon-bedrock",
    "amazon-bedrock-runtime",
    "gcp",
]);

export function isBuiltInExternalProvider(providerId: string | null | undefined): boolean {
    return providerId != null && BUILT_IN_EXTERNAL_PROVIDER_IDS.has(providerId);
}
