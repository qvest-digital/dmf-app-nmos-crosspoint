// Run with `npm test`, after `npm run build`: exercises the compiled helpers.
const test = require("node:test");
const assert = require("node:assert/strict");
const o = require("../dist/lib/deviceOrder");

const ids = (devs) => devs.map((d) => d.id);

test("devices order by crosspoint number, not by discovery order", () => {
    // Discovery order as a registry might announce them.
    const devs = [
        { id: "sink1", num: 1009, displayLabel: "Sink 1" },
        { id: "b1", num: 1005, displayLabel: "studio-b - Source 1" },
        { id: "a2", num: 1002, displayLabel: "default - Source 2" },
        { id: "a1", num: 1001, displayLabel: "default - Source 1" },
    ];
    assert.deepEqual(ids(o.sortDevices(devs)), ["a1", "a2", "b1", "sink1"]);
});

test("unnumbered devices go last, in natural label order", () => {
    const devs = [
        { id: "x10", num: -1, displayLabel: "Source 10" },
        { id: "n", num: 1003, displayLabel: "Zulu" },
        { id: "x2", num: -1, displayLabel: "Source 2" },
    ];
    // Natural order, not string order: "Source 2" before "Source 10".
    assert.deepEqual(ids(o.sortDevices(devs)), ["n", "x2", "x10"]);
});

test("equal numbers fall back to the label, then the id", () => {
    const devs = [
        { id: "c", num: 7, displayLabel: "Sink 1" },
        { id: "b", num: 7, displayLabel: "Sink" },
        { id: "a2", num: 7, displayLabel: "Sink" },
    ];
    // ComplexCompare alone calls "Sink" and "Sink 1" equal.
    assert.deepEqual(ids(o.sortDevices(devs)), ["a2", "b", "c"]);
});

test("the label falls back to alias, then name", () => {
    const devs = [
        { id: "1", num: -1, name: "Beta" },
        { id: "2", num: -1, alias: "Alpha", name: "Zeta" },
    ];
    assert.deepEqual(ids(o.sortDevices(devs)), ["2", "1"]);
});

test("the order does not depend on the input order", () => {
    const base = [
        { id: "a", num: 3, displayLabel: "A" },
        { id: "b", num: -1, displayLabel: "B" },
        { id: "c", num: 1, displayLabel: "C" },
        { id: "d", num: -1, displayLabel: "A" },
    ];
    const want = ["c", "a", "d", "b"];
    assert.deepEqual(ids(o.sortDevices([...base])), want);
    assert.deepEqual(ids(o.sortDevices([...base].reverse())), want);
});

function shadow() {
    return { a: { num: 1000 }, b: { num: 1001 }, c: { num: 1002 } };
}

test("moving onto a number in use swaps the two devices", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "c", 1000), true);
    assert.deepEqual(d, { a: { num: 1002 }, b: { num: 1001 }, c: { num: 1000 } });
});

test("moving onto a free number leaves the others alone", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "a", 5), true);
    assert.deepEqual(d, { a: { num: 5 }, b: { num: 1001 }, c: { num: 1002 } });
});

test("the number arrives as a string from the UI", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "b", "1002"), true);
    assert.deepEqual(d, { a: { num: 1000 }, b: { num: 1002 }, c: { num: 1001 } });
});

test("-1 clears the number and moves nobody else", () => {
    const d = shadow();
    assert.equal(o.moveDeviceNum(d, "b", -1), true);
    assert.deepEqual(d, { a: { num: 1000 }, b: { num: -1 }, c: { num: 1002 } });
});

test("an unnumbered device taking a number hands -1 to its holder", () => {
    const d = { a: { num: -1 }, b: { num: 4 } };
    assert.equal(o.moveDeviceNum(d, "a", 4), true);
    assert.deepEqual(d, { a: { num: 4 }, b: { num: -1 } });
});

test("no change for the same number, 0, garbage or an unknown device", () => {
    for (const [id, num] of [["a", 1000], ["a", 0], ["a", -5], ["a", "x"], ["zz", 3]]) {
        const d = shadow();
        assert.equal(o.moveDeviceNum(d, id, num), false, `${id} -> ${num}`);
        assert.deepEqual(d, shadow());
    }
});
