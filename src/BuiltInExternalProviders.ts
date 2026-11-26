import type {AuthStatus} from "./AuthStatusMeta";

/**
 * The engine's built-in model providers that authenticate with credentials of
 * their own: Amazon Bedrock and Google Cloud Vertex AI.
 *
 * `account/read` cannot describe a session on one of them. Its params carry no
 * thread id, so it always answers for the engine's default configuration: with
 * an OpenAI default and a Vertex AI thread it reports the OpenAI account, which
 * says nothing about that session. A session on such a provider is therefore
 * described by the provider alone. The status names the auth source; whether
 * the credentials actually work is settled by the first real request.
 *
 * The ids are the engine's (`model-provider-info/src/lib.rs`):
 * `AMAZON_BEDROCK_PROVIDER_ID`, `AMAZON_BEDROCK_RUNTIME_PROVIDER_ID` and
 * `GCP_PROVIDER_ID`. They are not the account type names: the Bedrock account
 * is `"amazonBedrock"`, the provider is `"amazon-bedrock"`.
 */
const STATUS_BY_PROVIDER_ID: ReadonlyMap<string, AuthStatus> = new Map([
    ["amazon-bedrock", {kind: "external", label: "AWS Bedrock"}],
    ["amazon-bedrock-runtime", {kind: "external", label: "AWS Bedrock"}],
    ["gcp", {kind: "external", label: "Google Cloud Vertex AI"}],
]);

export function isBuiltInExternalProvider(providerId: string | null | undefined): providerId is string {
    return providerId != null && STATUS_BY_PROVIDER_ID.has(providerId);
}

/** The auth status of a session on such a provider: the provider is the auth source. */
export function builtInExternalProviderStatus(providerId: string): AuthStatus {
    const status = STATUS_BY_PROVIDER_ID.get(providerId);
    if (status === undefined) {
        throw new Error(`Not a built-in external provider: ${providerId}`);
    }
    return {...status};
}
