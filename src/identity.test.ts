import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    claudeSessionName,
    claudeSessionPath,
    defaultName,
    hasFixedRelayPeerIdentity,
    resolveSessionName,
    sanitizeSessionName,
} from "./identity";

describe("defaultName", () => {
    test("extracts lowercase basename from typical path", () => {
        expect(defaultName("/Users/foo/Code/relay")).toBe("relay");
    });

    test("handles trailing slash", () => {
        expect(defaultName("/Users/foo/Code/relay/")).toBe("relay");
    });

    test("falls back to 'relay' for root path", () => {
        expect(defaultName("/")).toBe("relay");
    });

    test("falls back to 'relay' for empty string", () => {
        expect(defaultName("")).toBe("relay");
    });

    test("collapses non-alphanumerics to hyphens", () => {
        expect(defaultName("/tmp/My Project!!")).toBe("my-project");
    });

    test("strips leading and trailing hyphens", () => {
        expect(defaultName("/tmp/__hello__")).toBe("hello");
    });

    test("lowercases uppercase letters", () => {
        expect(defaultName("/tmp/RELAY")).toBe("relay");
    });

    test("collapses multiple separators into a single hyphen", () => {
        expect(defaultName("/tmp/foo   bar___baz")).toBe("foo-bar-baz");
    });

    test("is deterministic", () => {
        expect(defaultName("/a/b/project")).toBe(defaultName("/a/b/project"));
    });

    test("same basename across different paths yields same name", () => {
        expect(defaultName("/x/relay")).toBe(defaultName("/y/z/relay"));
    });
});

describe("claudeSessionName", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-identity-test-"));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("returns trimmed name when present in session file", () => {
        const sessionPath = path.join(tmpDir, "123.json");
        fs.writeFileSync(
            sessionPath,
            JSON.stringify({
                pid: 123,
                sessionId: "abc",
                cwd: "/tmp/x",
                name: "  test-relay-rename  ",
            }),
        );
        expect(claudeSessionName({ path: sessionPath })).toBe("test-relay-rename");
    });

    test("returns null when name key is missing", () => {
        const sessionPath = path.join(tmpDir, "123.json");
        fs.writeFileSync(
            sessionPath,
            JSON.stringify({ pid: 123, sessionId: "abc", cwd: "/tmp/x" }),
        );
        expect(claudeSessionName({ path: sessionPath })).toBeNull();
    });

    test("returns null when name is empty or whitespace-only", () => {
        const emptyPath = path.join(tmpDir, "empty.json");
        fs.writeFileSync(emptyPath, JSON.stringify({ name: "" }));
        expect(claudeSessionName({ path: emptyPath })).toBeNull();

        const wsPath = path.join(tmpDir, "ws.json");
        fs.writeFileSync(wsPath, JSON.stringify({ name: "   \t\n " }));
        expect(claudeSessionName({ path: wsPath })).toBeNull();
    });

    test("returns null when the file does not exist", () => {
        const missing = path.join(tmpDir, "does-not-exist.json");
        expect(claudeSessionName({ path: missing })).toBeNull();
    });

    test("returns null when the file contains malformed JSON", () => {
        const badPath = path.join(tmpDir, "bad.json");
        fs.writeFileSync(badPath, "{not valid json");
        expect(claudeSessionName({ path: badPath })).toBeNull();
    });

    test("resolves path from home and ppid when path is not given", () => {
        const sessionsDir = path.join(tmpDir, ".claude", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionsDir, "4242.json"),
            JSON.stringify({ name: "from-ppid" }),
        );
        expect(claudeSessionName({ home: tmpDir, ppid: 4242 })).toBe("from-ppid");
    });

    test("returns null when name is not a string", () => {
        const badTypePath = path.join(tmpDir, "badtype.json");
        fs.writeFileSync(badTypePath, JSON.stringify({ name: 123 }));
        expect(claudeSessionName({ path: badTypePath })).toBeNull();
    });

    test("returns null when sessionPath is a directory (non-regular file)", () => {
        const dirPath = path.join(tmpDir, "asdir");
        fs.mkdirSync(dirPath);
        expect(claudeSessionName({ path: dirPath })).toBeNull();
    });

    test("rejects names that exceed length cap", () => {
        const longPath = path.join(tmpDir, "long.json");
        fs.writeFileSync(longPath, JSON.stringify({ name: "a".repeat(65) }));
        expect(claudeSessionName({ path: longPath })).toBeNull();
    });

    test("rejects names with disallowed characters", () => {
        const badPath = path.join(tmpDir, "bad.json");
        fs.writeFileSync(badPath, JSON.stringify({ name: "evil\nname" }));
        expect(claudeSessionName({ path: badPath })).toBeNull();
    });

    test("accepts names with allowed chars: letters, digits, dot, underscore, hyphen", () => {
        const okPath = path.join(tmpDir, "ok.json");
        fs.writeFileSync(okPath, JSON.stringify({ name: "test.relay_2-new" }));
        expect(claudeSessionName({ path: okPath })).toBe("test.relay_2-new");
    });
});

describe("sanitizeSessionName", () => {
    test("returns trimmed name for valid input", () => {
        expect(sanitizeSessionName("  foo-bar  ")).toBe("foo-bar");
    });

    test("returns null for empty or whitespace", () => {
        expect(sanitizeSessionName("")).toBeNull();
        expect(sanitizeSessionName("   ")).toBeNull();
    });

    test("returns null for names exceeding 64 chars", () => {
        expect(sanitizeSessionName("a".repeat(65))).toBeNull();
    });

    test("accepts exactly 64 chars", () => {
        const name = "a".repeat(64);
        expect(sanitizeSessionName(name)).toBe(name);
    });

    test("rejects control characters and whitespace-in-body", () => {
        expect(sanitizeSessionName("ab\ncd")).toBeNull();
        expect(sanitizeSessionName("a b")).toBeNull();
        expect(sanitizeSessionName("a\tb")).toBeNull();
    });

    test("rejects slashes and shell metacharacters", () => {
        expect(sanitizeSessionName("../etc")).toBeNull();
        expect(sanitizeSessionName("$(whoami)")).toBeNull();
        expect(sanitizeSessionName("a;b")).toBeNull();
    });
});

describe("claudeSessionPath", () => {
    test("joins home, .claude/sessions, and <ppid>.json", () => {
        expect(claudeSessionPath({ home: "/u/alice", ppid: 4242 })).toBe(
            path.join("/u/alice", ".claude", "sessions", "4242.json"),
        );
    });

    test("defaults to os.homedir() and process.ppid", () => {
        const resolved = claudeSessionPath();
        expect(resolved).toBe(
            path.join(os.homedir(), ".claude", "sessions", `${process.ppid}.json`),
        );
    });
});

describe("hasFixedRelayPeerIdentity", () => {
    const original = process.env.RELAY_PEER_ID;

    afterEach(() => {
        if (original === undefined) delete process.env.RELAY_PEER_ID;
        else process.env.RELAY_PEER_ID = original;
    });

    test("returns true when RELAY_PEER_ID is set and valid", () => {
        process.env.RELAY_PEER_ID = "Hilo";
        expect(hasFixedRelayPeerIdentity()).toBe(true);
    });

    test("returns false when RELAY_PEER_ID is unset", () => {
        delete process.env.RELAY_PEER_ID;
        expect(hasFixedRelayPeerIdentity()).toBe(false);
    });

    test("returns false when RELAY_PEER_ID is empty", () => {
        process.env.RELAY_PEER_ID = "";
        expect(hasFixedRelayPeerIdentity()).toBe(false);
    });

    test("returns false when RELAY_PEER_ID has disallowed characters", () => {
        process.env.RELAY_PEER_ID = "evil name!!";
        expect(hasFixedRelayPeerIdentity()).toBe(false);
    });

    test("returns false when RELAY_PEER_ID exceeds 64 chars", () => {
        process.env.RELAY_PEER_ID = "a".repeat(65);
        expect(hasFixedRelayPeerIdentity()).toBe(false);
    });
});

describe("resolveSessionName", () => {
    const original = process.env.RELAY_PEER_ID;

    afterEach(() => {
        if (original === undefined) delete process.env.RELAY_PEER_ID;
        else process.env.RELAY_PEER_ID = original;
    });

    test("uses RELAY_PEER_ID when set and valid", () => {
        process.env.RELAY_PEER_ID = "Hilo";
        expect(resolveSessionName("/some/path")).toBe("Hilo");
    });

    test("trims surrounding whitespace from RELAY_PEER_ID", () => {
        process.env.RELAY_PEER_ID = "  Hilo  ";
        expect(resolveSessionName("/some/path")).toBe("Hilo");
    });

    test("ignores empty RELAY_PEER_ID and falls back to a non-empty name", () => {
        process.env.RELAY_PEER_ID = "";
        const result = resolveSessionName("/tmp/some-dir");
        expect(result).not.toBe("");
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("ignores RELAY_PEER_ID with disallowed characters and falls back", () => {
        process.env.RELAY_PEER_ID = "a b c!!";
        const result = resolveSessionName("/tmp/some-dir");
        expect(result).not.toBe("a b c!!");
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });

    test("ignores RELAY_PEER_ID exceeding length cap and falls back", () => {
        const tooLong = "a".repeat(65);
        process.env.RELAY_PEER_ID = tooLong;
        const result = resolveSessionName("/tmp/some-dir");
        expect(result).not.toBe(tooLong);
        expect(result.length).toBeLessThanOrEqual(64);
    });

    test("falls back to a non-empty string when RELAY_PEER_ID is unset", () => {
        delete process.env.RELAY_PEER_ID;
        const result = resolveSessionName("/tmp/test-dir");
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
    });
});
