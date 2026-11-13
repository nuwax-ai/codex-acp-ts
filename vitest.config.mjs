import {configDefaults, defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        // Deletes the temp homes this run created; leaked ones once reached 96 GB in /var/folders.
        globalSetup: ["./src/__tests__/temp-dir-guard.ts"],
        // Codex fixtures can download plugins with their own tests outside these owned directories.
        // Fork: the acp-validation and live-validation scripts run on node:test, not Vitest.
        include: configDefaults.include.flatMap(pattern => [
            `src/__tests__/${pattern}`,
            `scripts/${pattern}`,
        ]),
        exclude: [
            ...configDefaults.exclude,
            "scripts/acp-validation/**",
            "scripts/live-validation/**",
        ],
    },
});
