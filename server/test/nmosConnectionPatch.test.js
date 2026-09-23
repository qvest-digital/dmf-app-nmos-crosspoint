// Run with `npm test`, after `npm run build`: exercises the compiled helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../dist/lib/nmosConnectionPatch");

const flow = "11111111-2222-4333-8444-555555555555";
const domain = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";

test("the newest Connection API version a device offers is used", () => {
    const controls = [
        { type: "urn:x-nmos:control:sr-ctrl/v1.1", href: "http://d/x-nmos/connection/v1.1/" },
        { type: "urn:x-nmos:control:sr-ctrl/v1.2", href: "http://d/x-nmos/connection/v1.2/" },
        { type: "urn:x-nmos:control:manifest-base/v1.3", href: "http://d/m/" },
    ];
    assert.deepEqual(p.selectControlHrefs(controls), [{ href: "http://d/x-nmos/connection/v1.2/", version: "v1.2" }]);
    assert.deepEqual(p.selectControlHrefs(controls.slice(0, 1)), [{ href: "http://d/x-nmos/connection/v1.1/", version: "v1.1" }]);
    assert.deepEqual(p.selectControlHrefs([]), []);
});

test("transports map to the names the crosspoint uses", () => {
    assert.equal(p.transportKind("urn:x-nmos:transport:mxl"), "mxl");
    assert.equal(p.transportKind("urn:x-nmos:transport:rtp.mcast"), "rtp.mcast");
    assert.equal(p.transportKind("urn:x-nmos:transport:somethingelse"), "");
});

test("an MXL sender's flow and domain come from its active parameters", () => {
    const ep = p.mxlEndpointFromActive({ transport_params: [{ mxl_flow_id: flow, mxl_domain_id: domain }] });
    assert.deepEqual(ep, { flowId: flow, domainId: domain });
    assert.throws(() => p.mxlEndpointFromActive({ transport_params: [{ mxl_flow_id: null, mxl_domain_id: domain }] }), /mxl_flow_id/);
    assert.throws(() => p.mxlEndpointFromActive({ transport_params: [{ mxl_flow_id: flow, mxl_domain_id: null }] }), /mxl_domain_id/);
    assert.throws(() => p.mxlEndpointFromActive({ transport_params: [{ mxl_flow_id: "auto", mxl_domain_id: domain }] }), /mxl_flow_id/);
});

test("an MXL receiver is patched with flow and domain and no transport file", () => {
    const patch = p.buildMxlReceiverPatch("snd", { flowId: flow, domainId: domain },
        [{ mxl_domain_id: { enum: [domain] }, mxl_flow_id: {} }]);
    assert.deepEqual(patch, {
        sender_id: "snd",
        master_enable: true,
        activation: { mode: "activate_immediate" },
        transport_params: [{ mxl_flow_id: flow, mxl_domain_id: domain }],
    });
    assert.equal("transport_file" in patch, false);
});

test("a receiver that cannot reach the sender's domain is refused", () => {
    assert.throws(() => p.buildMxlReceiverPatch("snd", { flowId: flow, domainId: domain },
        [{ mxl_domain_id: { enum: ["0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"] } }]), /domain mismatch/);
    // No enum is no restriction.
    assert.doesNotThrow(() => p.buildMxlReceiverPatch("snd", { flowId: flow, domainId: domain }, [{ mxl_domain_id: {} }]));
    assert.doesNotThrow(() => p.buildMxlReceiverPatch("snd", { flowId: flow, domainId: domain }, null));
});

test("disconnecting an MXL receiver switches it off", () => {
    assert.deepEqual(p.buildMxlDisconnectPatch(), {
        sender_id: null, master_enable: false, activation: { mode: "activate_immediate" },
    });
});

test("RTP legs follow the SDP and surplus legs are switched off", () => {
    const legs = [{ multicast_ip: "239.1.1.1", destination_port: 5004, source_ip: "192.0.2.1" }];
    assert.deepEqual(p.buildRtpTransportParams(2, legs, false), [
        { multicast_ip: "239.1.1.1", destination_port: 5004, rtp_enabled: true, source_ip: "192.0.2.1" },
        { rtp_enabled: false },
    ]);
    assert.deepEqual(p.buildRtpTransportParams(2, legs, true), [{ rtp_enabled: false }, { rtp_enabled: false }]);
});
