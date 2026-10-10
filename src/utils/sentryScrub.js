// Shared by the browser and the api/ functions: strip personal data and credentials
// from a Sentry event before it leaves the machine.
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const SUPABASE_KEY = /sb_(secret|publishable)_[\w-]+/g;

export function scrubText(text) {
  return text.replace(EMAIL, "[email]").replace(JWT, "[token]").replace(SUPABASE_KEY, "[key]");
}

export function scrubEvent(event) {
  // ponytail: scrub the whole serialized event, so new fields are covered without listing them.
  const clean = JSON.parse(scrubText(JSON.stringify(event)));
  delete clean.user;
  if (clean.request) {
    delete clean.request.cookies;
    delete clean.request.headers;
    delete clean.request.data;
  }
  return clean;
}
