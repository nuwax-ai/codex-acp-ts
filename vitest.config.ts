import {defineConfig} from "vitest/config";

export default defineConfig({
    test: {
        // node:test scripts use their own runners and cannot be collected by Vitest.
        include: ["src/**/*.{test,spec}.{js,ts,jsx,tsx}", "scripts/next-preview-version.test.mjs"],
    },
});
