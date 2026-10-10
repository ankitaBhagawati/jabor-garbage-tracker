// Fails if the built client bundle contains a Supabase secret key or a service-role JWT.
// Run after `npm run build`: `node scripts/check-bundle.mjs`. Prints file names only, never values.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const JWT = /eyJ[\w-]+\.([\w-]+)\.[\w-]+/g;
const SECRET_KEY = /sb_secret_[\w-]{8,}/;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap(d => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
}

const leaks = [];
for (const file of files("dist")) {
  const text = readFileSync(file, "utf8");
  if (SECRET_KEY.test(text)) leaks.push(`${file}: Supabase secret key`);
  for (const [, payload] of text.matchAll(JWT)) {
    try {
      const role = JSON.parse(Buffer.from(payload, "base64url").toString()).role;
      if (role && role !== "anon") leaks.push(`${file}: JWT with role ${role}`);
    } catch { /* not a JWT */ }
  }
}

if (leaks.length) {
  console.error(leaks.join("\n"));
  process.exit(1);
}
console.log("bundle ok: no secret keys or non-anon JWTs");
