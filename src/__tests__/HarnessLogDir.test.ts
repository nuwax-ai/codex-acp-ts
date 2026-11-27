import * as path from "node:path";

import {describe, expect, it} from "vitest";

import {HARNESS_LOG_DIR_ENV_VAR, harnessLogDirArgs} from "../HarnessLogDir";

describe("harnessLogDirArgs", () => {
    it("adds nothing when the host names no log directory", () => {
        expect(harnessLogDirArgs({})).toEqual([]);
        expect(harnessLogDirArgs({[HARNESS_LOG_DIR_ENV_VAR]: "   "})).toEqual([]);
    });

    it("forwards an absolute directory as a quoted TOML string", () => {
        const dir = path.join(path.sep, "var", "log", "nuwax harness");

        expect(harnessLogDirArgs({[HARNESS_LOG_DIR_ENV_VAR]: dir})).toEqual([
            "-c",
            `log_dir=${JSON.stringify(dir)}`,
        ]);
    });

    it("refuses a relative directory instead of resolving it against the project", () => {
        expect(() => harnessLogDirArgs({[HARNESS_LOG_DIR_ENV_VAR]: "logs/harness"})).toThrow(
            `${HARNESS_LOG_DIR_ENV_VAR} must be an absolute path`,
        );
    });
});
