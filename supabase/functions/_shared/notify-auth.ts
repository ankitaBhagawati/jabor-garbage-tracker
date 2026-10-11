import { corsHeaders } from "./cors.ts";

// jabor-notify is called by our own server (api/reports/submit.js), never by a person. Its only
// credential is a shared secret in the x-jabor-notify-secret header. A user's JWT, whatever role it
// carries, does not authorise anything here. Pure and free of Deno imports so it is tested from node.

const encoder = new TextEncoder();
const sha256 = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

// Compares two secrets in constant time: both are hashed to the same length, then every byte is
// compared with no early exit, so neither the content nor the length of the real secret leaks.
export async function secretsMatch(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

// Returns a 403 response to send, or null when the caller holds the secret. Fails closed when the
// secret is not configured.
export async function authorizeNotify(req: Request, secret: string | undefined): Promise<Response | null> {
  const given = req.headers.get("x-jabor-notify-secret") ?? "";
  if (secret && given && await secretsMatch(given, secret)) return null;
  return new Response(JSON.stringify({ error: "Forbidden." }), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
