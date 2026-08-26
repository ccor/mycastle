// redact.ts — strip credentials from URLs before they reach stdout.
// Config loaders only validate that `url` is a string, so an in-URL userinfo
// (http://user:pass@host) is a quieter leak surface than a password field.
// Out of scope: tokens in the query string (?token=...).

/**
 * Strip userinfo (user:pass@) from a URL. Tries the URL parser first; falls
 * back to a regex when the value is not parseable (config may hold bare
 * "host:8080" style strings).
 */
export function redactUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return raw;
  } catch {
    return raw.replace(/^([a-zA-Z][\w+.-]*:\/\/)[^/@]+@/, "$1");
  }
}
