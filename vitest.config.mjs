import {configDefaults, defineConfig} from "vitest/config";

export default defineConfig({
    test: {
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
