// Run with `npm test`, which compiles first: exercises the compiled helpers.
//
// The sender, receiver and ids follow the ST 2110 gateway's MXL sender in
// fixtures/rtp-by-address.json and the tile receiver reading it; the /active
// shape is BCP-007-03's. A writer that derives its flow id from the stream
// format answers a format change with another mxl_flow_id and IS-04 flow_id,
// and an unplugged input with null for both.
const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../dist/lib/mxlFollow");
const t = require("../dist/lib/transport");
const p = require("../dist/lib/nmosConnectionPatch");
const fx = require("./fixtures/rtp-by-address.json");

const SENDER = "0c8dda41-fb99-5577-b032-7cc8606e134a";
const TILE_0 = "b5c9984a-727b-5cf6-83b9-fa352947018b";
const DOMAIN = "3f1c6a52-7d4b-4d40-9d8e-0c6b5a0e1d11";
const FLOW_1080 = "5e0b8e3a-1a2b-5c3d-8e4f-0a1b2c3d4e5f";
const FLOW_720 = "9d8c7b6a-5f4e-5d3c-8b2a-1f0e9d8c7b6a";
const IS04_1080 = "e38aa40e-44bb-507f-a02d-391de256362e";
const IS04_720 = "71c2d3e4-f5a6-5b7c-8d9e-0f1a2b3c4d5e";

const senderActive = (flow, domain = DOMAIN, on = true) => ({
    sender_id: null,
    receiver_id: null,
    master_enable: on,
    transport_params: [{ mxl_flow_id: flow, mxl_domain_id: flow === null ? null : domain }],
});
const ep = (flow, domain = DOMAIN) => ({ flowId: flow, domainId: domain });
const step = (last, active, is04) => f.mxlSenderStep(last, p.resolvedMxlEndpoint(active), is04);
// Reads one after another, as getSenderActive folds them in.
const run = (reads) => {
    let seen = null;
    return reads.map(([active, is04]) => {
        const s = step(seen, active, is04);
        seen = s.seen;
        return s;
    });
};

test("a sender switched off or with no flow resolves to nothing", () => {
    assert.deepEqual(p.resolvedMxlEndpoint(senderActive(FLOW_1080)), ep(FLOW_1080));
    assert.equal(p.resolvedMxlEndpoint(senderActive(null)), null);
    assert.equal(p.resolvedMxlEndpoint(senderActive(FLOW_1080, DOMAIN, false)), null);
    assert.equal(p.resolvedMxlEndpoint(senderActive("auto")), null);
    assert.equal(p.resolvedMxlEndpoint(undefined), null);
});

test("a format change moves the receivers to the new flow", () => {
    const [first, second] = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_720), IS04_720],
    ]);
    // A first sighting has nothing to compare with.
    assert.equal(first.action, "none");
    assert.equal(second.action, "follow");
    assert.deepEqual(second.from, ep(FLOW_1080));
    assert.deepEqual(second.seen.endpoint, ep(FLOW_720));
});

test("a flow moved to another domain is followed too", () => {
    const [, second] = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_1080, "other-domain"), IS04_1080],
    ]);
    assert.equal(second.action, "follow");
    assert.deepEqual(second.from, ep(FLOW_1080));
});

test("an unplugged input never points a receiver at nothing", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(null), null],
        [senderActive(null), null],
    ]);
    assert.deepEqual(steps.map((s) => s.action), ["none", "none", "none"]);
    // The flow the receivers were pointed at is kept, not forgotten.
    assert.deepEqual(steps[2].seen.endpoint, ep(FLOW_1080));
});

test("an input plugged back in with another format is followed from the flow before the gap", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(null), null],
        [senderActive(FLOW_720), IS04_720],
    ]);
    assert.equal(steps[2].action, "follow");
    assert.deepEqual(steps[2].from, ep(FLOW_1080));
});

test("an input plugged back in with the same format changes nothing", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(null), null],
        [senderActive(FLOW_1080), IS04_1080],
    ]);
    // IS-04 went from null to an id, so /active is read once more; the
    // flow is the one the receivers read, so nobody is patched.
    assert.equal(steps[2].action, "reread");
    const again = f.mxlSenderStep(steps[2].seen, ep(FLOW_1080), IS04_1080);
    assert.equal(again.action, "none");
});

test("an IS-04 flow change that /active does not show yet is read again, once", () => {
    const [, second] = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_1080), IS04_720],
    ]);
    assert.equal(second.action, "reread");
    // The second read shows the move.
    const moved = f.mxlSenderStep(second.seen, ep(FLOW_720), IS04_720);
    assert.equal(moved.action, "follow");
    assert.deepEqual(moved.from, ep(FLOW_1080));
    // Or it still does not: no further read, no loop.
    const still = f.mxlSenderStep(second.seen, ep(FLOW_1080), IS04_720);
    assert.equal(still.action, "none");
});

test("a sender read again unchanged does nothing", () => {
    const steps = run([
        [senderActive(FLOW_1080), IS04_1080],
        [senderActive(FLOW_1080), IS04_1080],
    ]);
    assert.equal(steps[1].action, "none");
});

const mxlRx = (id, sub) => ({ id, transport: "urn:x-nmos:transport:mxl", interface_bindings: [], subscription: sub });
const rxActive = (flow, sender = null, on = true) => ({
    sender_id: sender, master_enable: on,
    transport_params: [{ mxl_flow_id: flow, mxl_domain_id: DOMAIN }],
});

const none = new Map();

test("a receiver taking the sender by name is pointed at the flow it writes now", () => {
    // The tile receiver as read: running, IS-04 names the sender. Its /active
    // still reads the 1080 flow; the sender writes the 720 one.
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const active = { [TILE_0]: rxActive(FLOW_1080) };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, none), [TILE_0]);
    // Named in IS-05 only.
    const byIs05 = { rx: mxlRx("rx", { active: true, sender_id: null }) };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), byIs05, { rx: rxActive(FLOW_1080, SENDER) }, none), ["rx"]);
});

test("a receiver left on an old flow is found with no move seen, as after a restart", () => {
    // Nothing remembered of the sender: the first read already shows the
    // new flow. The step rule has nothing to follow ...
    const first = f.mxlSenderStep(null, ep(FLOW_720), IS04_720);
    assert.equal(first.action, "none");
    // ... and the receiver's own /active still says where it is.
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, first.seen.endpoint, receivers, { [TILE_0]: rxActive(FLOW_1080) }, none), [TILE_0]);
});

test("a receiver already on the flow, not yet read, or off is not patched", () => {
    const receivers = {
        on: mxlRx("on", { active: true, sender_id: SENDER }),
        unread: mxlRx("unread", { active: true, sender_id: SENDER }),
        disabled: mxlRx("disabled", { active: true, sender_id: SENDER }),
        stopped: mxlRx("stopped", { active: false, sender_id: SENDER }),
        other: mxlRx("other", { active: true, sender_id: "another-sender" }),
        rtp: { ...mxlRx("rtp", { active: true, sender_id: SENDER }), transport: "urn:x-nmos:transport:rtp.mcast" },
    };
    const active = {
        on: rxActive(FLOW_720),
        disabled: rxActive(FLOW_1080, null, false),
        stopped: rxActive(FLOW_1080),
        other: rxActive(FLOW_1080),
        rtp: rxActive(FLOW_1080),
    };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, none), []);
    // Same flow id in another domain is another flow.
    const moved = { on: { ...rxActive(FLOW_720), transport_params: [{ mxl_flow_id: FLOW_720, mxl_domain_id: "other-domain" }] } };
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), { on: receivers.on }, moved, none), ["on"]);
});

test("a receiver is re-patched at most once per value of the sender's flow", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const active = { [TILE_0]: rxActive(FLOW_1080) };
    const patched = new Map([[TILE_0, f.mxlRepatchKey(SENDER, ep(FLOW_720))]]);
    // Patched to 720 and still reading 1080 -- refused, or not applied yet.
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720), receivers, active, patched), []);
    // The sender moves again: one more attempt.
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_1080 + "-b"), receivers, active, patched), [TILE_0]);
    assert.deepEqual(f.mxlReceiversOffFlow(SENDER, ep(FLOW_720, "other-domain"), receivers, active, patched), [TILE_0]);
});

test("a receiver refusing a flow is asked once while the sender stays on it", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const patched = new Map();
    const on1080 = { [TILE_0]: rxActive(FLOW_1080) };
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), [TILE_0]);
    // Refused: still on 1080. Every further read of either side sends nothing.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), []);
    assert.equal(patched.get(TILE_0), f.mxlRepatchKey(SENDER, ep(FLOW_720)));
});

test("a receiver that refused a flow is asked again when the sender comes back to it", () => {
    const receivers = { [TILE_0]: fx.receivers[TILE_0] };
    const patched = new Map();
    const on1080 = { [TILE_0]: rxActive(FLOW_1080) };
    // 1080 -> 720, refused.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), [TILE_0]);
    // Back to 1080, where the receiver still is: nothing to send.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, on1080, patched), []);
    // 720 again: the receiver reads a flow nobody writes, so it is asked again.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched), [TILE_0]);
});

test("an unnamed receiver that refused a flow is asked again on the next move to it", () => {
    const receivers = { rx: mxlRx("rx", { active: true, sender_id: null }) };
    const patched = new Map();
    const on1080 = { rx: rxActive(FLOW_1080) };
    const unnamed = () => f.mxlUnnamedReceiversOnFlow(ep(FLOW_1080), receivers, on1080);
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched, unnamed()), ["rx"]);
    // Refused; the sender goes back to 1080 and then to 720 again.
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, on1080, patched), []);
    assert.deepEqual(f.mxlRepatchTargets(SENDER, ep(FLOW_720), receivers, on1080, patched, unnamed()), ["rx"]);
    // A claim for another sender is left alone.
    patched.set("rx", f.mxlRepatchKey("another-sender", ep(FLOW_1080)));
    f.mxlRepatchTargets(SENDER, ep(FLOW_1080), receivers, on1080, patched);
    assert.equal(patched.get("rx"), f.mxlRepatchKey("another-sender", ep(FLOW_1080)));
});

test("receivers naming no sender follow when they read the flow the sender left", () => {
    const receivers = {
        byFlow: mxlRx("byFlow", { active: true, sender_id: null }),
        elsewhere: mxlRx("elsewhere", { active: true, sender_id: null }),
        disabled: mxlRx("disabled", { active: true, sender_id: null }),
        unread: mxlRx("unread", { active: true, sender_id: null }),
        // Named ones are the level rule's.
        named: mxlRx("named", { active: true, sender_id: SENDER }),
        byIs05: mxlRx("byIs05", { active: true, sender_id: null }),
    };
    const active = {
        byFlow: rxActive(FLOW_1080),
        elsewhere: rxActive(FLOW_720),
        disabled: rxActive(FLOW_1080, null, false),
        named: rxActive(FLOW_1080),
        byIs05: rxActive(FLOW_1080, "another-sender"),
    };
    assert.deepEqual(f.mxlUnnamedReceiversOnFlow(ep(FLOW_1080), receivers, active), ["byFlow"]);
    const otherDomain = { byFlow: { ...rxActive(FLOW_1080), transport_params: [{ mxl_flow_id: FLOW_1080, mxl_domain_id: "other-domain" }] } };
    assert.deepEqual(f.mxlUnnamedReceiversOnFlow(ep(FLOW_1080), { byFlow: receivers.byFlow }, otherDomain), []);
});

test("every running MXL receiver has its /active read, named or not", () => {
    assert.equal(t.receiverActiveRead(fx.receivers[TILE_0]), true);
    assert.equal(t.receiverActiveRead(mxlRx("rx", { active: true, sender_id: null })), true);
    assert.equal(t.receiverActiveRead(mxlRx("rx", { active: false, sender_id: SENDER })), false);
    // RTP stays as it was: only when naming no sender.
    const rtp = (sub) => ({ ...mxlRx("rtp", sub), transport: "urn:x-nmos:transport:rtp.mcast" });
    assert.equal(t.receiverActiveRead(rtp({ active: true, sender_id: SENDER })), false);
    assert.equal(t.receiverActiveRead(rtp({ active: true, sender_id: null })), true);
});

test("overlapping /active reads: a late older answer never replaces a newer one", () => {
    const o = new f.ReadOrder();
    const a = o.begin(SENDER);
    const b = o.begin(SENDER);
    assert.equal(o.take(SENDER, b), true);
    assert.equal(o.take(SENDER, a), false);
});

test("overlapping /active reads: the older answer counts when the newer read fails", () => {
    const o = new f.ReadOrder();
    const a = o.begin(SENDER);
    const b = o.begin(SENDER);
    // a answers first; b then fails and takes nothing. a must have counted.
    assert.equal(o.take(SENDER, a), true);
    // And b answering after all still wins over a.
    assert.equal(o.take(SENDER, b), true);
    // Senders are ordered separately.
    const c = o.begin("other");
    assert.equal(o.take("other", c), true);
    o.forget(SENDER);
    assert.equal(o.take(SENDER, o.begin(SENDER)), true);
});

test("overlapping /active reads: an answer arriving after the sender was removed is dropped", () => {
    const o = new f.ReadOrder();
    const old = o.begin(SENDER);
    o.forget(SENDER);
    assert.equal(o.take(SENDER, old), false);
    // Registered again: the read begun for the earlier sender still does not
    // count, the new one does.
    const fresh = o.begin(SENDER);
    assert.equal(o.take(SENDER, old), false);
    assert.equal(o.take(SENDER, fresh), true);
    // A registry switch forgets every sender.
    const before = o.begin("other");
    o.clear();
    assert.equal(o.take("other", before), false);
});

test("an MXL receiver naming no sender is connected by the flow it reads", () => {
    const rx = mxlRx("rx", { active: true, sender_id: null });
    const senders = { [SENDER]: fx.senders[SENDER], twin: { ...fx.senders[SENDER], id: "twin" } };
    const active = { [SENDER]: senderActive(FLOW_1080), twin: senderActive(FLOW_720) };
    assert.equal(t.receiverNeedsActive(rx), true);
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), active, senders), SENDER);
    // The sender moved on: the receiver reads a flow nobody writes.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), { ...active, [SENDER]: senderActive(FLOW_720, "d2") }, senders), "");
    // Switched off in IS-05.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080, null, false), active, senders), "");
    // Two senders writing the same flow: not guessed between.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), { ...active, twin: senderActive(FLOW_1080) }, senders), "");
    // A sender switched off writes nothing.
    assert.equal(t.connectedSenderId(rx, rxActive(FLOW_1080), { [SENDER]: senderActive(FLOW_1080, DOMAIN, false) }, senders), "");
});
