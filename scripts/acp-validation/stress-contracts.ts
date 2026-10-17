/** Contracts shared by the stress driver and its negative regression tests. */
export interface ProcessIdentity {
    pid: number;
    lstart: string;
    command: string;
    role: string;
}

export async function waitForTrackedProcesses<T extends ProcessIdentity>(options: {
    tracked: () => T[];
    table: () => Map<number, { lstart: string }> | null;
    kill: (pid: number) => void;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}): Promise<T[]> {
    const servingDeadline = options.now() + 10_000;
    const updateDeadline = options.now() + 35_000;
    const isUpdateCheck = (proc: T) => /\bgit\b.*\bls-remote\b/.test(proc.command)
        && /github[.]com[/:]openai\/plugins(?:[.]git)?(?:\s|$)/.test(proc.command);
    for (;;) {
        const table = options.table();
        // A failed probe cannot establish that a process disappeared.
        if (table === null) return options.tracked();
        const survivors = options.tracked().filter((proc) => table.get(proc.pid)?.lstart === proc.lstart);
        if (survivors.length === 0) return [];
        const deadline = survivors.every(isUpdateCheck) ? updateDeadline : servingDeadline;
        if (options.now() >= deadline) {
            // Preserve the failed observation BEFORE cleanup. Successful test
            // cleanup must never turn an expired product process into a pass.
            for (const proc of survivors) {
                // Recheck identity immediately before killing a tracked PID.
                if (options.table()?.get(proc.pid)?.lstart !== proc.lstart) continue;
                try { options.kill(proc.pid); } catch { /* already exited */ }
            }
            await options.sleep(1000);
            return survivors;
        }
        await options.sleep(500);
    }
}

export async function cancelAndObserve<T, R>(options: {
    recorded: () => R[];
    notify: () => Promise<unknown>;
    response: () => Promise<T>;
    sleep: (ms: number) => Promise<void>;
}): Promise<{ response: T; afterCancel: R[] }> {
    // Include the whole notification -> acknowledgement interval. Establishing
    // this cursor after awaiting the prompt would hide extra paid attempts.
    const cursor = options.recorded().length;
    await options.notify();
    const response = await options.response();
    await options.sleep(1500);
    return { response, afterCancel: options.recorded().slice(cursor) };
}
