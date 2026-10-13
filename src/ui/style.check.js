// A guard for the look of the site: `node src/ui/style.check.js`
// No emoji, no pill-shaped buttons, no decorative animation, no purple gradients, in the public site and the admin.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const FILES = ["Jabor.jsx", "SupportJaborSection.jsx", "style.css", "index.html", "src/ui/Select.tsx", "src/ui/select.css", "src/ui/glyphs.tsx",
  "src/admin/admin.css", "src/legal/legal.css", "src/legal/content.ts", "src/legal/LegalPage.tsx"];
const code = n => String.fromCodePoint(n);
const EMOJI = new RegExp(`[${code(0x1F000)}-${code(0x1FAFF)}${code(0x2600)}-${code(0x27BF)}${code(0x2B50)}${code(0x2B55)}${code(0x2705)}${code(0x274C)}${code(0x23F3)}${code(0x2139)}]`, "u");
const ESCAPED_EMOJI = /\\u\{1F[0-9A-F]{3,4}\}|\\u(?:26|27)[0-9A-F]{2}|\\uFE0F/;
// the only animations the public site keeps: a spinner, and short fades for the menu and dialogs
const ALLOWED_KEYFRAMES = new Set(["spin", "fadeIn", "slideIn", "popIn", "drawerIn"]);
// the only places a round or pill radius is allowed: a toggle switch, and decorative discs and dots (not buttons)
const ROUND_OK = [/\.switch/, /\.timeline-icon/, /\.adm-timeline/, /\.pbar|\.pfill/];

for (const file of FILES) {
  const text = await readFile(new URL(`../../${file}`, import.meta.url), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; }); // a file that is not there yet is skipped
  if (text === null) continue;
  assert.ok(!EMOJI.test(text), `${file}: no emoji`);
  assert.ok(!ESCAPED_EMOJI.test(text), `${file}: no escaped emoji`);
  if (!/\.(jsx|css|html)$/.test(file)) continue;
  for (const [, name] of text.matchAll(/@keyframes\s+([\w-]+)/g)) assert.ok(ALLOWED_KEYFRAMES.has(name), `${file}: animation "${name}" is not on the allowed list`);
  for (const word of ["reveal-on-scroll", "typed-word", "quoteFloat", "logoLift", "wordFade", "pulse-dot", "disclaimer-shine", "startup-loader", "pinbob", "material-symbols", "Material+Symbols"]) assert.ok(!text.includes(word), `${file}: ${word} is gone`);
  // a purple or violet gradient
  for (const [gradient] of text.matchAll(/linear-gradient\([^;{}]*\)/g)) {
    for (const [, hex] of gradient.matchAll(/#([0-9a-fA-F]{6})/g)) {
      const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
      assert.ok(!(b > g + 30 && r > g + 20), `${file}: purple gradient ${gradient}`);
    }
    assert.ok(!/purple|violet|indigo|fuchsia/i.test(gradient), `${file}: no purple gradient`);
  }
  // pill and round radii, line by line
  for (const line of text.split("\n")) {
    if (!/border-?[rR]adius:\s*"?(?:999|99|50%)/.test(line)) continue;
    assert.ok(/border-?[rR]adius:\s*"?50%/.test(line) && !/(?:btn|button|chip|tab|nav|link|pill|badge)/i.test(line) || ROUND_OK.some(re => re.test(line)) || /animation:\s*"?spin|\.quote-dot|loader|spinner|width:\s*7px|slider/.test(line), `${file}: a pill or round shape that is not on the list: ${line.trim().slice(0, 100)}`);
  }
}
console.log("site style ok");
