import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HubConnection } from "./hub-connection";
import { createPendingBroadcasts } from "./pending-broadcasts";
import { rawConnect, startCh, tmpSocket, waitForNotif } from "./test-helpers";
import { MAX_TEXT_LEN, PROTOCOL_VERSION, type ServerMsg } from "../protocol";
import { relayAsk, relayBroadcast, relayReply, type ChannelContext } from "./tools";

type RecordedSend = { type: "send"; payload: unknown };

function makeFakeHub(): { hub: HubConnection; sends: RecordedSend[] } {
    const sends: RecordedSend[] = [];
    const hub: HubConnection = {
        send: (payload: unknown) => {
            sends.push({ type: "send", payload });
        },
        sendRequest: () => Promise.resolve({ type: "ack" } satisfies ServerMsg),
        onMessage: () => () => {},
        onDisconnect: () => () => {},
        nextMessage: () => new Promise<ServerMsg>(() => {}),
        close: () => {},
    };
    return { hub, sends };
}

function makeCtx(hub: HubConnection): ChannelContext {
    return {
        getHub: () => hub,
        pendingBroadcasts: createPendingBroadcasts(),
        getName: () => "tester",
        setName: () => {},
        nowFn: () => 0,
        counters: { broadcast: 0 },
        broadcastTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
    };
}

describe("channel tools", () => {
    let sockPath: string;
    const closers: Array<() => Promise<void>> = [];

    beforeEach(() => {
        sockPath = tmpSocket();
    });

    afterEach(async () => {
        while (closers.length) {
            const c = closers.pop()!;
            try {
                await c();
            } catch {}
        }
    });

    test("relay_peers returns peers excluding self", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());

        const result = await ch1.callTool("relay_peers", {});
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.me).toBe(ch1.getName());
        const names = payload.peers.map((p: { name: string }) => p.name);
        expect(names).toContain(ch2.getName());
        expect(names).not.toContain(ch1.getName());
        const peer = payload.peers.find((p: { name: string }) => p.name === ch2.getName());
        expect(peer).toHaveProperty("cwd");
        expect(peer).toHaveProperty("git_branch");
        expect(peer).toHaveProperty("last_seen");
    });

    test("relay_rename to a free name updates getName", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const originalName = ch.getName();
        const newName = `${originalName}-renamed`;

        const result = await ch.callTool("relay_rename", { new_name: newName });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload).toEqual({ ok: true, name: newName });
        expect(ch.getName()).toBe(newName);

        // Verify via a probe that the hub reflects the new name
        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "probe-rename",
            cwd: "/tmp",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        JSON.parse(await probe.nextLine());
        probe.send({ type: "list_peers" });
        const peers = JSON.parse(await probe.nextLine());
        const names = peers.peers.map((p: { name: string }) => p.name);
        expect(names).toContain(newName);
        expect(names).not.toContain(originalName);
        probe.close();
    });

    test("relay_rename to a taken name returns name_taken and keeps name", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());

        const originalName = ch2.getName();
        const result = await ch2.callTool("relay_rename", { new_name: ch1.getName() });
        expect(result.isError).toBe(true);
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload).toEqual({ ok: false, code: "name_taken" });
        expect(ch2.getName()).toBe(originalName);
    });

    test("relay_ask returns immediately with {ok, ask_id} before target replies", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());

        // Caller fires the ask; target never replies in this test.
        const result = await ch1.callTool("relay_ask", { to: ch2.getName(), question: "ping?" });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        expect(typeof payload.ask_id).toBe("string");
        expect(payload.ask_id.length).toBeGreaterThan(0);
        // Non-blocking: no text/from in the tool result.
        expect(payload).not.toHaveProperty("text");
        expect(payload).not.toHaveProperty("from");
    });

    test("ask reply arrives at caller as channel notification with ask_id and from in meta", async () => {
        const callerNotifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch1 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => callerNotifs.push(n),
        });
        closers.push(() => ch1.close());
        const targetNotifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch2 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => targetNotifs.push(n),
        });
        closers.push(() => ch2.close());

        const askResult = await ch1.callTool("relay_ask", {
            to: ch2.getName(),
            question: "ping?",
        });
        const askPayload = JSON.parse(askResult.content[0]!.text);
        const askId = askPayload.ask_id as string;

        await waitForNotif(targetNotifs, 1);

        await ch2.callTool("relay_reply", { ask_id: askId, text: "pong!" });

        await waitForNotif(callerNotifs, 1);
        const notif = callerNotifs[0]!;
        expect(notif.method).toBe("notifications/claude/channel");
        const meta = notif.params.meta as Record<string, unknown>;
        expect(meta).not.toHaveProperty("source");
        expect(meta.ask_id).toBe(askId);
        expect(meta.from).toBe(ch2.getName());
        expect(typeof meta.thread_id).toBe("string");
        expect(notif.params.content).toBe("pong!");
        // Reply notification for a direct ask carries no broadcast_id.
        expect(meta).not.toHaveProperty("broadcast_id");
    });

    test("relay_ask to unknown peer: ack ok but peer_not_found arrives as error notification", async () => {
        const notifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch = await startCh({
            socketPath: sockPath,
            onNotification: (n) => notifs.push(n),
        });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_ask", { to: "nobody", question: "?" });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        const askId = payload.ask_id as string;

        await waitForNotif(notifs, 1);
        const notif = notifs[0]!;
        expect(notif.method).toBe("notifications/claude/channel");
        const meta = notif.params.meta as Record<string, unknown>;
        expect(meta).not.toHaveProperty("source");
        expect(meta.ask_id).toBe(askId);
        expect(meta.code).toBe("peer_not_found");
    });

    test("relay_ask: peer_gone arrives as error notification after target disconnects", async () => {
        const notifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch1 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => notifs.push(n),
        });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });

        const result = await ch1.callTool("relay_ask", {
            to: ch2.getName(),
            question: "bye?",
        });
        const askId = JSON.parse(result.content[0]!.text).ask_id as string;

        // Give the hub a tick to route the incoming_ask, then close ch2.
        await new Promise((r) => setTimeout(r, 50));
        await ch2.close();

        await waitForNotif(notifs, 1);
        const errNotif = notifs.find((n) => {
            const m = n.params.meta as Record<string, unknown>;
            return m.ask_id === askId && m.code === "peer_gone";
        });
        expect(errNotif).toBeDefined();
    });

    test("relay_ask: hub-side error (peer_gone) arrives as error notification", async () => {
        const notifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch1 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => notifs.push(n),
        });
        closers.push(() => ch1.close());
        const probe = await rawConnect(sockPath);
        probe.send({
            type: "register",
            name: "t-target",
            cwd: "/tmp",
            git_branch: "",
            protocol_version: PROTOCOL_VERSION,
        });
        JSON.parse(await probe.nextLine());

        const res = await ch1.callTool("relay_ask", { to: "t-target", question: "slow?" });
        const askId = JSON.parse(res.content[0]!.text).ask_id as string;
        await new Promise((r) => setTimeout(r, 100));
        probe.close();

        const waitFor = async (): Promise<{
            method: string;
            params: Record<string, unknown>;
        }> => {
            for (let i = 0; i < 200; i++) {
                const found = notifs.find((n) => {
                    const m = n.params.meta as Record<string, unknown>;
                    return m.ask_id === askId;
                });
                if (found) return found;
                await new Promise((r) => setTimeout(r, 10));
            }
            throw new Error("no error notification arrived");
        };
        const notif = await waitFor();
        const meta = notif.params.meta as Record<string, unknown>;
        expect(meta).not.toHaveProperty("source");
        expect(meta.ask_id).toBe(askId);
        expect(meta.code).toBe("peer_gone");
    });

    test("relay_ask to invalid args returns bad_args", async () => {
        const ch = await startCh({ socketPath: sockPath });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_ask", { to: 42, question: "x" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
    });

    test("relay_ask surfaces thread_id on target notification and on reply notification back to caller", async () => {
        const callerNotifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch1 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => callerNotifs.push(n),
        });
        closers.push(() => ch1.close());
        const targetNotifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const ch2 = await startCh({
            socketPath: sockPath,
            onNotification: (n) => targetNotifs.push(n),
        });
        closers.push(() => ch2.close());

        await ch1.callTool("relay_ask", {
            to: ch2.getName(),
            question: "turn-1?",
            thread_id: "chat-42",
        });

        await waitForNotif(targetNotifs, 1);
        const askMeta = targetNotifs[0]!.params.meta as Record<string, unknown>;
        expect(askMeta.thread_id).toBe("chat-42");
        const askId = askMeta.ask_id as string;

        await ch2.callTool("relay_reply", { ask_id: askId, text: "answer-1" });

        await waitForNotif(callerNotifs, 1);
        const replyMeta = callerNotifs[0]!.params.meta as Record<string, unknown>;
        expect(replyMeta.thread_id).toBe("chat-42");
        expect(replyMeta.ask_id).toBe(askId);
        expect(callerNotifs[0]!.params.content).toBe("answer-1");
    });

    test("relay_broadcast returns ok with broadcast_id and peer_count excluding self by default", async () => {
        const ch1 = await startCh({ socketPath: sockPath });
        closers.push(() => ch1.close());
        const ch2 = await startCh({ socketPath: sockPath });
        closers.push(() => ch2.close());
        const ch3 = await startCh({ socketPath: sockPath });
        closers.push(() => ch3.close());

        const result = await ch1.callTool("relay_broadcast", { question: "hello all?" });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        expect(typeof payload.broadcast_id).toBe("string");
        expect(payload.broadcast_id.length).toBeGreaterThan(0);
        expect(payload.peer_count).toBe(2);
    });

    test("relay_broadcast: recipients receive notification with broadcast_id; replies arrive as tagged notifications on broadcaster", async () => {
        const notifsA: Array<{ method: string; params: Record<string, unknown> }> = [];
        const notifsB: Array<{ method: string; params: Record<string, unknown> }> = [];
        const notifsC: Array<{ method: string; params: Record<string, unknown> }> = [];
        const chA = await startCh({
            socketPath: sockPath,
            onNotification: (n: { method: string; params: Record<string, unknown> }) =>
                notifsA.push(n),
        });
        closers.push(() => chA.close());
        const chB = await startCh({
            socketPath: sockPath,
            onNotification: (n: { method: string; params: Record<string, unknown> }) =>
                notifsB.push(n),
        });
        closers.push(() => chB.close());
        const chC = await startCh({
            socketPath: sockPath,
            onNotification: (n: { method: string; params: Record<string, unknown> }) =>
                notifsC.push(n),
        });
        closers.push(() => chC.close());

        const result = await chA.callTool("relay_broadcast", { question: "all hands?" });
        const payload = JSON.parse(result.content[0]!.text);
        const broadcastId = payload.broadcast_id as string;
        expect(payload.peer_count).toBe(2);

        await waitForNotif(notifsB, 1);
        await waitForNotif(notifsC, 1);

        const notifB = notifsB[0]!;
        expect(notifB.method).toBe("notifications/claude/channel");
        const metaB = notifB.params.meta as Record<string, unknown>;
        expect(metaB.broadcast_id).toBe(broadcastId);
        expect(metaB.from).toBe(chA.getName());
        expect(notifB.params.content).toBe("all hands?");
        const askIdB = metaB.ask_id as string;

        const notifC = notifsC[0]!;
        const metaC = notifC.params.meta as Record<string, unknown>;
        expect(metaC.broadcast_id).toBe(broadcastId);
        const askIdC = metaC.ask_id as string;
        expect(askIdC).not.toBe(askIdB);

        await chB.callTool("relay_reply", { ask_id: askIdB, text: "B-answer" });
        await chC.callTool("relay_reply", { ask_id: askIdC, text: "C-answer" });

        await waitForNotif(notifsA, 2);
        const replyNotifs = notifsA.filter(
            (n) =>
                (n.params.meta as { broadcast_id?: string } | undefined)?.broadcast_id ===
                broadcastId,
        );
        expect(replyNotifs.length).toBe(2);
        const texts = replyNotifs.map((n) => n.params.content).sort();
        expect(texts).toEqual(["B-answer", "C-answer"]);
        for (const n of replyNotifs) {
            expect(n.method).toBe("notifications/claude/channel");
            const meta = n.params.meta as Record<string, unknown>;
            expect(meta.broadcast_id).toBe(broadcastId);
            expect(typeof meta.ask_id).toBe("string");
            expect(typeof meta.from).toBe("string");
        }
    });

    test("relay_ask returns bad_args when question exceeds MAX_TEXT_LEN and does not send", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayAsk(ctx, {
            to: "peer",
            question: "x".repeat(MAX_TEXT_LEN + 1),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });

    test("relay_ask accepts a question at MAX_TEXT_LEN and sends to hub", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayAsk(ctx, {
            to: "peer",
            question: "x".repeat(MAX_TEXT_LEN),
        });
        expect(result.isError).toBeFalsy();
        expect(sends.length).toBe(1);
        const payload = sends[0]!.payload as { type: string; question: string };
        expect(payload.type).toBe("ask");
        expect(payload.question.length).toBe(MAX_TEXT_LEN);
    });

    test("relay_reply returns bad_args when text exceeds MAX_TEXT_LEN and does not send", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayReply(ctx, {
            ask_id: "a-1",
            text: "y".repeat(MAX_TEXT_LEN + 1),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });

    test("relay_reply accepts text at MAX_TEXT_LEN and sends to hub", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayReply(ctx, {
            ask_id: "a-1",
            text: "y".repeat(MAX_TEXT_LEN),
        });
        expect(result.isError).toBeFalsy();
        expect(sends.length).toBe(1);
        const payload = sends[0]!.payload as { type: string; text: string };
        expect(payload.type).toBe("reply");
        expect(payload.text.length).toBe(MAX_TEXT_LEN);
    });

    test("relay_broadcast returns bad_args when question exceeds MAX_TEXT_LEN and does not send", async () => {
        const { hub, sends } = makeFakeHub();
        const ctx = makeCtx(hub);
        const result = await relayBroadcast(ctx, {
            question: "z".repeat(MAX_TEXT_LEN + 1),
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "bad_args" });
        expect(sends).toEqual([]);
    });
});
