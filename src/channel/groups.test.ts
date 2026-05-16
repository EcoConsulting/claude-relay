import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startCh, tmpSocket, waitForNotif } from "./test-helpers";

function uniqueGroup(): string {
    return `tg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

describe("persistent groups integration", () => {
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

    test("1. create group with 3 members: all are members", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const m1 = await startCh({ socketPath: sockPath });
        closers.push(() => m1.close());
        const m2 = await startCh({ socketPath: sockPath });
        closers.push(() => m2.close());

        const grp = uniqueGroup();
        const result = await admin.callTool("relay_group_create", {
            name: grp,
            members: [m1.getName(), m2.getName()],
        });
        expect(result.isError).toBeFalsy();
        const payload = JSON.parse(result.content[0]!.text);
        expect(payload.ok).toBe(true);
        expect(payload.members.sort()).toEqual(
            [admin.getName(), m1.getName(), m2.getName()].sort(),
        );

        const infoR = await admin.callTool("relay_group_info", { group: grp });
        const info = JSON.parse(infoR.content[0]!.text);
        expect(info.members.map((m: { name: string }) => m.name).sort()).toEqual(
            [admin.getName(), m1.getName(), m2.getName()].sort(),
        );

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("2. send message: online members receive incoming_group_msg notification", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const notifs: Array<{ method: string; params: Record<string, unknown> }> = [];
        const member = await startCh({
            socketPath: sockPath,
            onNotification: (n) => notifs.push(n),
        });
        closers.push(() => member.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [member.getName()] });
        await admin.callTool("relay_group_send", { group: grp, text: "hello group" });

        await waitForNotif(notifs, 1);
        const notif = notifs[0]!;
        expect(notif.method).toBe("notifications/claude/channel");
        const meta = notif.params.meta as Record<string, unknown>;
        expect(meta.group).toBe(grp);
        expect(meta.from).toBe(admin.getName());
        expect(notif.params.content).toBe("hello group");

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("3. offline member connects later: relay_group_history returns unread messages", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const member = await startCh({ socketPath: sockPath });
        closers.push(() => member.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [member.getName()] });

        // Messages sent while member hasn't read yet (simulates offline delivery)
        await admin.callTool("relay_group_send", { group: grp, text: "you missed this" });
        await admin.callTool("relay_group_send", { group: grp, text: "and this" });

        // Member fetches history after reconnecting
        const histR = await member.callTool("relay_group_history", { group: grp });
        const hist = JSON.parse(histR.content[0]!.text);
        expect(hist.ok).toBe(true);
        expect(hist.messages.length).toBe(2);
        expect(hist.messages[0].text).toBe("you missed this");
        expect(hist.messages[1].text).toBe("and this");
        expect(hist.unread_remaining).toBe(0);

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("4. admin invite/remove with reason: system message in history", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const member = await startCh({ socketPath: sockPath });
        closers.push(() => member.close());
        const newPeer = await startCh({ socketPath: sockPath });
        closers.push(() => newPeer.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [member.getName()] });

        const inviteR = await admin.callTool("relay_group_invite", {
            group: grp,
            peer: newPeer.getName(),
        });
        expect(JSON.parse(inviteR.content[0]!.text).ok).toBe(true);

        const removeR = await admin.callTool("relay_group_remove", {
            group: grp,
            peer: member.getName(),
            reason: "testing removal",
        });
        expect(JSON.parse(removeR.content[0]!.text).ok).toBe(true);

        // Verify system message about removal appears in history
        const histR = await admin.callTool("relay_group_history", { group: grp });
        const hist = JSON.parse(histR.content[0]!.text);
        const sysMsg = hist.messages.find(
            (m: { type: string; text: string }) =>
                m.type === "system" && m.text.includes("testing removal"),
        );
        expect(sysMsg).toBeDefined();

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("5. non-admin tries invite/remove/delete: not_admin error", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const member = await startCh({ socketPath: sockPath });
        closers.push(() => member.close());
        const outsider = await startCh({ socketPath: sockPath });
        closers.push(() => outsider.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [member.getName()] });

        const inviteR = await member.callTool("relay_group_invite", {
            group: grp,
            peer: outsider.getName(),
        });
        expect(inviteR.isError).toBe(true);
        expect(JSON.parse(inviteR.content[0]!.text).code).toBe("not_admin");

        const removeR = await member.callTool("relay_group_remove", {
            group: grp,
            peer: admin.getName(),
            reason: "nope",
        });
        expect(removeR.isError).toBe(true);
        expect(JSON.parse(removeR.content[0]!.text).code).toBe("not_admin");

        const deleteR = await member.callTool("relay_group_delete", { group: grp });
        expect(deleteR.isError).toBe(true);
        expect(JSON.parse(deleteR.content[0]!.text).code).toBe("not_admin");

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("6. non-member tries send/history/info: not_member error", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const outsider = await startCh({ socketPath: sockPath });
        closers.push(() => outsider.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [] });

        const sendR = await outsider.callTool("relay_group_send", { group: grp, text: "hi" });
        expect(sendR.isError).toBe(true);
        expect(JSON.parse(sendR.content[0]!.text).code).toBe("not_member");

        const histR = await outsider.callTool("relay_group_history", { group: grp });
        expect(histR.isError).toBe(true);
        expect(JSON.parse(histR.content[0]!.text).code).toBe("not_member");

        const infoR = await outsider.callTool("relay_group_info", { group: grp });
        expect(infoR.isError).toBe(true);
        expect(JSON.parse(infoR.content[0]!.text).code).toBe("not_member");

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("7. member leave: can't send after leaving", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const member = await startCh({ socketPath: sockPath });
        closers.push(() => member.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [member.getName()] });

        const leaveR = await member.callTool("relay_group_leave", { group: grp });
        expect(JSON.parse(leaveR.content[0]!.text).ok).toBe(true);

        const sendR = await member.callTool("relay_group_send", {
            group: grp,
            text: "still here?",
        });
        expect(sendR.isError).toBe(true);
        expect(JSON.parse(sendR.content[0]!.text).code).toBe("not_member");

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("8. ring buffer: send 501 messages, oldest dropped, 500 remain", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [] });

        for (let i = 1; i <= 501; i++) {
            await admin.callTool("relay_group_send", { group: grp, text: `msg-${i}` });
        }

        const histR = await admin.callTool("relay_group_history", { group: grp, limit: 500 });
        const hist = JSON.parse(histR.content[0]!.text);
        expect(hist.ok).toBe(true);
        expect(hist.messages.length).toBe(500);
        // msg-1 was evicted; oldest remaining is msg-2
        expect(hist.messages[0].text).toBe("msg-2");
        expect(hist.messages[499].text).toBe("msg-501");
        expect(hist.unread_remaining).toBe(0);

        await admin.callTool("relay_group_delete", { group: grp });
    });

    test("9. group delete by admin: group_not_found after", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());

        const grp = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp, members: [] });

        const deleteR = await admin.callTool("relay_group_delete", { group: grp });
        expect(JSON.parse(deleteR.content[0]!.text).ok).toBe(true);

        // group_invite checks exists first and returns group_not_found
        const inviteR = await admin.callTool("relay_group_invite", { group: grp, peer: "x" });
        expect(inviteR.isError).toBe(true);
        expect(JSON.parse(inviteR.content[0]!.text).code).toBe("group_not_found");

        // send/history return not_member (isMember → false on missing file)
        const sendR = await admin.callTool("relay_group_send", { group: grp, text: "hi" });
        expect(sendR.isError).toBe(true);
        expect(JSON.parse(sendR.content[0]!.text).code).toBe("not_member");
    });

    test("10. relay_group_list returns correct unread counts", async () => {
        const admin = await startCh({ socketPath: sockPath });
        closers.push(() => admin.close());
        const member = await startCh({ socketPath: sockPath });
        closers.push(() => member.close());

        const grp1 = uniqueGroup();
        const grp2 = uniqueGroup();
        await admin.callTool("relay_group_create", { name: grp1, members: [member.getName()] });
        await admin.callTool("relay_group_create", { name: grp2, members: [member.getName()] });
        await admin.callTool("relay_group_send", { group: grp1, text: "one" });
        await admin.callTool("relay_group_send", { group: grp1, text: "two" });
        await admin.callTool("relay_group_send", { group: grp2, text: "three" });

        const listR = await member.callTool("relay_group_list", {});
        const list = JSON.parse(listR.content[0]!.text);
        expect(list.ok).toBe(true);
        const g1 = list.groups.find((g: { name: string }) => g.name === grp1);
        const g2 = list.groups.find((g: { name: string }) => g.name === grp2);
        expect(g1?.unread_count).toBe(2);
        expect(g2?.unread_count).toBe(1);

        await admin.callTool("relay_group_delete", { group: grp1 });
        await admin.callTool("relay_group_delete", { group: grp2 });
    });
});
