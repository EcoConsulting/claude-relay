import { describe, expect, test } from "bun:test";
import {
    buildAskErrorNotification,
    buildAskNotification,
    buildReplyNotification,
} from "./notifications";

describe("channel notifications", () => {
    test("buildAskNotification meta has from + ask_id and no source key", () => {
        const notif = buildAskNotification({
            type: "incoming_ask",
            from: "peer-a",
            ask_id: "ask-1",
            question: "ping?",
        });

        expect(notif.method).toBe("notifications/claude/channel");
        expect(notif.params.content).toBe("ping?");
        const meta = notif.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.from).toBe("peer-a");
        expect(meta.ask_id).toBe("ask-1");
        expect(meta).not.toHaveProperty("broadcast_id");
        expect(meta).not.toHaveProperty("thread_id");
    });

    test("buildAskNotification includes broadcast_id and thread_id only when provided", () => {
        const withExtras = buildAskNotification({
            type: "incoming_ask",
            from: "peer-a",
            ask_id: "ask-2",
            question: "q",
            broadcast_id: "bc-1",
            thread_id: "thread-1",
        });
        const metaExtras = withExtras.params.meta;
        expect(metaExtras).not.toHaveProperty("source");
        expect(metaExtras.broadcast_id).toBe("bc-1");
        expect(metaExtras.thread_id).toBe("thread-1");
    });

    test("buildReplyNotification meta has from + ask_id and no source key", () => {
        const notif = buildReplyNotification({
            type: "incoming_reply",
            from: "peer-b",
            ask_id: "ask-3",
            text: "pong!",
        });

        expect(notif.method).toBe("notifications/claude/channel");
        expect(notif.params.content).toBe("pong!");
        const meta = notif.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.from).toBe("peer-b");
        expect(meta.ask_id).toBe("ask-3");
        expect(meta).not.toHaveProperty("broadcast_id");
        expect(meta).not.toHaveProperty("thread_id");
    });

    test("buildReplyNotification includes broadcast_id and thread_id only when provided", () => {
        const withExtras = buildReplyNotification({
            type: "incoming_reply",
            from: "peer-b",
            ask_id: "ask-4",
            text: "t",
            broadcast_id: "bc-2",
            thread_id: "thread-2",
        });
        const meta = withExtras.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.broadcast_id).toBe("bc-2");
        expect(meta.thread_id).toBe("thread-2");
    });

    test("buildAskErrorNotification meta has ask_id + code and no source key", () => {
        const notif = buildAskErrorNotification("ask-5", "peer_not_found");
        expect(notif.method).toBe("notifications/claude/channel");
        expect(notif.params.content).toBe("");
        const meta = notif.params.meta;
        expect(meta).not.toHaveProperty("source");
        expect(meta.ask_id).toBe("ask-5");
        expect(meta.code).toBe("peer_not_found");
    });
});
