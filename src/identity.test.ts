import { describe, expect, test } from "bun:test";
import { defaultName } from "./identity";

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
