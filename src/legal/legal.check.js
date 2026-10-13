// Tests for the Privacy Policy and Terms text: `node src/legal/legal.check.js`
// The text must stay plain (no emoji, no dashes used as punctuation), have its sections, and name every outside
// service the site is allowed to talk to (the list in vercel.json's content security policy).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { PRIVACY, TERMS, DOCS, CONTACT_EMAIL, UPDATED } = await import("./content.ts");
const code = n => String.fromCodePoint(n);
const EMOJI = new RegExp(`[${code(0x1F000)}-${code(0x1FAFF)}${code(0x2600)}-${code(0x27BF)}${code(0x2B50)}]`, "u");
const textOf = doc => [doc.title, ...doc.intro, ...doc.sections.flatMap(s => [s.title, ...(s.paragraphs ?? []), ...(s.list ?? []), ...(s.after ?? [])])].join("\n");

for (const doc of DOCS) {
  const text = textOf(doc);
  assert.ok(!/[–—]/.test(text), `${doc.title}: no em or en dashes`);
  assert.ok(!EMOJI.test(text) && !text.includes(String.fromCodePoint(0xFE0F)), `${doc.title}: no emoji`);
  assert.ok(!/(lorem|placeholder|todo|tbd|coming soon)/i.test(text), `${doc.title}: no unfinished text`);
  assert.ok(text.includes(CONTACT_EMAIL), `${doc.title}: a way to reach us`);
  assert.equal(new Set(doc.sections.map(s => s.title)).size, doc.sections.length, `${doc.title}: section titles are unique`);
  for (const section of doc.sections) assert.ok(section.paragraphs?.length || section.list?.length, `${doc.title}: "${section.title}" has text`);
}
assert.match(UPDATED, /^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
assert.deepEqual(DOCS.map(d => d.path), ["/privacy", "/terms"]);
assert.equal(PRIVACY.title, "Privacy Policy");
assert.equal(TERMS.title, "Terms and Conditions");

// the Privacy Policy covers what the app does
const privacy = textOf(PRIVACY);
for (const topic of ["photo", "anonymous", "GPS", "public", "name and email", "IP address", "cookies", "remove", "Contact"]) assert.match(privacy, new RegExp(topic, "i"), `privacy mentions ${topic}`);
// the Terms cover the usual ground
const terms = textOf(TERMS);
for (const topic of ["Moderation", "Your content", "No guarantee", "Governing law", "Support payments", "Anonymous reports", "What you may report"]) assert.match(terms, new RegExp(topic), `terms mention ${topic}`);

// every outside service the site may use is named in the Privacy Policy
const vercel = JSON.parse(await readFile(new URL("../../vercel.json", import.meta.url), "utf8"));
const csp = vercel.headers.flatMap(h => h.headers).find(h => h.key === "Content-Security-Policy").value;
const SERVICES = { "challenges.cloudflare.com": "Turnstile", "googletagmanager.com": "Google Analytics", "razorpay.com": "Razorpay", "sentry": "Sentry", "res.cloudinary.com": "Cloudinary", "supabase.co": "Supabase" };
for (const [host, name] of Object.entries(SERVICES)) {
  assert.ok(csp.includes(host), `${host} is still in the policy list (update this test if a service was removed)`);
  assert.ok(privacy.includes(name), `the Privacy Policy names ${name}`);
}
for (const name of ["Vercel", "Upstash", "Resend"]) assert.ok(privacy.includes(name), `the Privacy Policy names ${name}`);
// the pages are served at their own addresses
const sources = vercel.rewrites.filter(r => r.destination === "/index.html").map(r => r.source);
for (const doc of DOCS) assert.ok(sources.includes(doc.path), `${doc.path} is rewritten to the app shell`);
// the site's footer and the report form link to them
const app = await readFile(new URL("../../Jabor.jsx", import.meta.url), "utf8");
for (const doc of DOCS) assert.ok(app.includes(`href="${doc.path}"`), `Jabor.jsx links to ${doc.path}`);

console.log("legal pages ok");
