// X (Twitter) API v2 posting via OAuth 1.0a user context. No dependency —
// signed with built-in Web Crypto (HMAC-SHA1). Self-check at the bottom.

interface XCreds {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

function pctEncode(v: string): string {
  return encodeURIComponent(v).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

async function hmacSha1Base64(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// RFC 5849 signature base string. `params` is every param to sign: oauth_*
// plus any query/body params for form-encoded requests (none for JSON or
// multipart bodies — those are excluded from the signature).
function signatureBaseString(
  method: string,
  url: string,
  params: Record<string, string>,
): string {
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(params[k])}`)
    .join("&");
  return `${method.toUpperCase()}&${pctEncode(url)}&${pctEncode(paramString)}`;
}

export function oauthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string,
): Promise<string> {
  const key = `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`;
  return hmacSha1Base64(key, signatureBaseString(method, url, params));
}

// Builds the "Authorization: OAuth ..." header for a request. `extraParams`
// holds any form-urlencoded body/query params that must be signed (empty for
// JSON or multipart requests).
async function authHeader(
  method: string,
  url: string,
  c: XCreds,
  extraParams: Record<string, string> = {},
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.consumerKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.token,
    oauth_version: "1.0",
  };
  oauth.oauth_signature = await oauthSignature(
    method,
    url,
    { ...oauth, ...extraParams },
    c.consumerSecret,
    c.tokenSecret,
  );
  return "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
      .join(", ");
}

// Uploads an image (by URL) to X and returns its media_id_string. Simple
// upload — fine for images up to 5 MB. ponytail: single-shot upload, switch to
// chunked INIT/APPEND/FINALIZE only if reports ever exceed 5 MB.
async function uploadMedia(imageUrl: string, c: XCreds): Promise<string> {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Could not fetch report image (${img.status}).`);
  const bytes = new Uint8Array(await img.arrayBuffer());

  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const form = new FormData();
  form.append("media", new Blob([bytes]));

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: await authHeader("POST", url, c) },
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.errors?.[0]?.message || JSON.stringify(data)?.slice(0, 200) || res.statusText;
    throw new Error(`X media upload error ${res.status}: ${msg}`);
  }
  return data?.media_id_string ?? "";
}

// Posts `text` (optionally with an image) to X from the account the access
// token belongs to. Returns the new tweet id. Throws on missing creds or a
// rejected request. An image failure does NOT block the post — it falls back
// to a text-only tweet.
export async function postToX(text: string, imageUrl?: string | null): Promise<string> {
  const c: XCreds = {
    consumerKey: Deno.env.get("X_API_KEY") ?? "",
    consumerSecret: Deno.env.get("X_API_SECRET") ?? "",
    token: Deno.env.get("X_ACCESS_TOKEN") ?? "",
    tokenSecret: Deno.env.get("X_ACCESS_SECRET") ?? "",
  };
  if (!c.consumerKey || !c.consumerSecret || !c.token || !c.tokenSecret) {
    throw new Error("X API credentials are not configured.");
  }

  let mediaId = "";
  if (imageUrl) {
    try {
      mediaId = await uploadMedia(imageUrl, c);
    } catch (e) {
      console.error("media upload failed, posting text-only:", e);
    }
  }

  const url = "https://api.x.com/2/tweets";
  const payload: Record<string, unknown> = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: await authHeader("POST", url, c), // JSON body not signed
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.detail || data?.title ||
      (data && JSON.stringify(data).slice(0, 200)) || res.statusText;
    throw new Error(`X API error ${res.status}: ${msg}`);
  }
  return data?.data?.id ?? "";
}

// Self-check: (1) base string matches X's official OAuth 1.0a example verbatim
// (validates percent-encoding + param sorting + assembly); (2) HMAC-SHA1+base64
// matches a canonical vector (validates the signing primitive). Together they
// cover oauthSignature. Run: deno run supabase/functions/_shared/x.ts
if (import.meta.main) {
  const base = signatureBaseString(
    "POST",
    "https://api.twitter.com/1.1/statuses/update.json",
    {
      status: "Hello Ladies + Gentlemen, a signed OAuth request!",
      include_entities: "true",
      oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: "1318622958",
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_version: "1.0",
    },
  );
  const wantBase =
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521";
  if (base !== wantBase) throw new Error(`base string mismatch:\n got ${base}\nwant ${wantBase}`);

  const mac = await hmacSha1Base64("key", "The quick brown fox jumps over the lazy dog");
  if (mac !== "3nybhbi3iqa8ino29wqQcBydtNk=") throw new Error(`HMAC-SHA1 mismatch: ${mac}`);

  console.log("x.ts self-check OK");
}
