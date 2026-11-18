const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const template = fs.readFileSync(path.join(__dirname,
    "../../charts/nmos-crosspoint/templates/config.yaml"), "utf8");
const block = template.match(/^  merge-settings\.js: \|\n((?:    .*\n)+)/m);
assert.ok(block, "the ConfigMap must contain the startup merge script");
const script = block[1].replace(/^    /gm, "");
const seed = {
    staticNmosRegistries: [{ ip: "registry.example.test", port: 8010, priority: 10, domain: "" }],
    server: { port: 80, address: "0.0.0.0" },
};

function merge(persisted) {
    let written;
    const files = {
        "/seed/settings.json": JSON.stringify(seed),
        "/config/settings.json": persisted,
    };
    const mockFs = {
        existsSync: file => files[file] !== undefined,
        readFileSync: file => {
            assert.ok(file in files, `unexpected read: ${file}`);
            return files[file];
        },
        writeFileSync: (file, data) => {
            assert.equal(file, "/config/settings.json");
            written = JSON.parse(data);
        },
    };
    vm.runInNewContext(script, {
        require: name => {
            assert.equal(name, "fs");
            return mockFs;
        },
    });
    return written;
}

test("a fresh volume receives the complete settings seed", () => {
    assert.deepEqual(merge(undefined), seed);
});

test("registry changes preserve operator settings and generated identities", () => {
    const persisted = {
        staticNmosRegistries: [{ ip: "old.example.test", port: 80 }],
        audioMonitor: { enabled: true },
        probe: { token: "persisted-test-token" },
        virtualNode: { nodeId: "persisted-node-id" },
    };
    assert.deepEqual(merge(JSON.stringify(persisted)), {
        ...persisted,
        staticNmosRegistries: seed.staticNmosRegistries,
        server: seed.server,
    });
});

test("invalid persisted settings fail instead of resetting operator configuration", () => {
    assert.throws(() => merge("{invalid"), { name: "SyntaxError" });
});

test("a restored listener matches the chart while other settings survive", () => {
    const restored = {
        ...seed,
        server: { port: 8080, address: "127.0.0.1" },
        audioMonitor: { enabled: true },
    };
    assert.deepEqual(merge(JSON.stringify(restored)), {
        ...restored,
        server: seed.server,
    });
});
