// Tests for the Select component's logic: `node src/ui/selectLogic.check.js`
// (The component itself is exercised in a browser by tests/select.spec.js.)
import assert from "node:assert/strict";

const L = await import("./selectLogic.ts");
const opts = labels => labels.map(label => ({ value: label.toLowerCase(), label }));

// search appears only for lists longer than 8
assert.deepEqual([0, 1, 8, 9, 40].map(L.needsSearch), [false, false, false, true, true]);

// filtering: contains, any case, extra spaces ignored, order kept, empty query keeps everything
const districts = opts(["Jorhat", "Dibrugarh", "Sivasagar", "Majuli", "Golaghat", "Kamrup Metropolitan", "Kamrup", "Cachar", "Nagaon"]);
assert.equal(L.filterOptions(districts, "").length, 9);
assert.equal(L.filterOptions(districts, "   ").length, 9);
assert.deepEqual(L.filterOptions(districts, "kam").map(o => o.label), ["Kamrup Metropolitan", "Kamrup"]);
assert.deepEqual(L.filterOptions(districts, "  JOR ").map(o => o.label), ["Jorhat"]);
assert.deepEqual(L.filterOptions(districts, "kamrup  metro").map(o => o.label), ["Kamrup Metropolitan"]);
assert.deepEqual(L.filterOptions(districts, "zzz"), []);
assert.deepEqual(L.filterOptions(opts(["a.b", "axb"]), "a.b").map(o => o.label), ["a.b"], "what is typed is text, not a pattern");

// keyboard movement: no wrap, the ends stop; -1 is "nothing highlighted yet"
assert.equal(L.nextIndex(-1, "ArrowDown", 5), 0);
assert.equal(L.nextIndex(0, "ArrowDown", 5), 1);
assert.equal(L.nextIndex(4, "ArrowDown", 5), 4);
assert.equal(L.nextIndex(-1, "ArrowUp", 5), 4);
assert.equal(L.nextIndex(0, "ArrowUp", 5), 0);
assert.equal(L.nextIndex(3, "ArrowUp", 5), 2);
assert.equal(L.nextIndex(2, "Home", 5), 0);
assert.equal(L.nextIndex(2, "End", 5), 4);
assert.equal(L.nextIndex(1, "PageDown", 20), 6);
assert.equal(L.nextIndex(18, "PageDown", 20), 19);
assert.equal(L.nextIndex(3, "PageUp", 20), 0);
for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) assert.equal(L.nextIndex(0, key, 0), -1, `${key} on an empty list`);

// placement: a phone gets a bottom sheet; a desktop panel opens below, flips up when it must, never leaves the screen
const rect = (top, height = 48, left = 100, width = 320) => ({ top, bottom: top + height, left, width });
for (const width of [320, 360, 390, 639]) assert.deepEqual(L.choosePlacement(rect(100), width, 800), { mode: "sheet" }, `${width}px wide`);
let p = L.choosePlacement(rect(100), 1280, 800);
assert.equal(p.mode, "below");
assert.equal(p.maxHeight, 280, "the panel is at most 280px tall");
assert.equal(p.top, 100 + 48 + 4);
p = L.choosePlacement(rect(600), 1280, 800); // 144px below, 588px above: flip
assert.equal(p.mode, "above");
assert.equal(p.maxHeight, 280);
assert.equal(p.bottom, 800 - 600 + 4);
p = L.choosePlacement(rect(300), 1280, 480); // 480-348-12 = 120 below, 288 above
assert.equal(p.mode, "above");
p = L.choosePlacement(rect(200), 1280, 420); // 420-248-12 = 160 below, 188 above: both short, the larger wins and the panel shrinks to fit
assert.equal(p.mode, "above");
assert.equal(p.maxHeight, 188);
p = L.choosePlacement(rect(100), 1280, 330); // 330-148-12 = 170 below, 88 above: stay below, shrunk
assert.equal(p.mode, "below");
assert.equal(p.maxHeight, 170);
// the panel always fits horizontally
p = L.choosePlacement(rect(100, 48, 1200, 320), 1280, 800);
assert.ok(p.left + p.width <= 1280 - 8, "pushed back inside the right edge");
p = L.choosePlacement(rect(100, 48, -50, 320), 1280, 800);
assert.ok(p.left >= 8, "pushed back inside the left edge");
for (const [top, vh] of [[10, 500], [250, 500], [480, 500], [700, 800], [20, 200]]) {
  const q = L.choosePlacement(rect(top), 1024, vh);
  if (q.mode === "below") assert.ok(q.top + q.maxHeight <= vh, `below fits: top ${top}, viewport ${vh}`);
  if (q.mode === "above") assert.ok(vh - q.bottom - q.maxHeight >= 0, `above fits: top ${top}, viewport ${vh}`);
}

console.log("select logic ok");
