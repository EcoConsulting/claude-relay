import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { logsDir } from "./data-dir";
import { debug, error, info, initLogger, warn } from "./logger";

describe("logger", () => {
    it("is a no-op during tests and does not create log files", () => {
        const LOGS_DIR = logsDir();
        const before = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR) : [];

        initLogger({ console: true });
        info("test info", "unit");
        warn("test warn", "unit");
        error("test error", "unit");
        debug("test debug", "unit");

        const after = fs.existsSync(LOGS_DIR) ? fs.readdirSync(LOGS_DIR) : [];
        const today = new Date().toISOString().slice(0, 10);
        const newToday = after.filter((f) => f.startsWith(`relay-${today}`) && !before.includes(f));
        expect(newToday).toEqual([]);
    });
});
