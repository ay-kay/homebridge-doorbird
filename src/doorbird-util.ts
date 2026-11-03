/* Copyright(C) 2026, Andreas Kurtz. All rights reserved.
 *
 * doorbird-util.ts: Small helpers shared across homebridge-doorbird.
 */

// Credentials embedded in a URL: scheme://user:password@host. The match runs to the last @ before the path, so a password with an @ is covered.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

// Mask the credentials in every URL within a text, so error messages and FFmpeg command lines can be logged safely.
export function redactUrl(text: string): string {
  return text.replace(URL_CREDENTIALS, "$1<redacted>@");
}
