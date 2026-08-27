/**
 * providers/moultrie.mjs — NOT IMPLEMENTED.
 *
 * This file exists to hold the shape and to record what was actually found, so
 * the next attempt starts from evidence instead of repeating the search.
 *
 * WHAT WAS MEASURED (2026-08-27)
 *
 * Moultrie is a much harder target than SpyPoint, and not for lack of looking:
 *
 *   - No community client exists. SpyPoint has two independent ones that agree
 *     on every endpoint, which is what made that provider a short job. For
 *     Moultrie the only related project on GitHub is lzilioli/moultrie-scraper,
 *     and it drives a headless browser with Puppeteer rather than calling an
 *     API — what people resort to when there is no easy API.
 *
 *   - web.moultriemobile.com is a Blazor WebAssembly app (.NET 8). Its
 *     _framework/blazor.boot.json lists compiled .wasm assemblies, so the app
 *     logic — including every endpoint — is compiled, not readable JavaScript.
 *     There is no bundle to grep.
 *
 *   - It authenticates with MSAL
 *     (Microsoft.Authentication.WebAssembly.Msal), i.e. Microsoft/Azure OAuth
 *     with browser redirects. That is a different world from SpyPoint's
 *     POST /user/login with a username and password that returns a bearer
 *     token. A standalone client needs the full authorization-code + PKCE
 *     flow, and a way to refresh a token that typically expires in an hour.
 *
 *   - api.moultriemobile.com does not answer publicly;
 *     adminapi.moultriemobile.com does, but is their admin surface.
 *
 *   - Moultrie publishes no developer API and runs no developer programme.
 *
 * WHAT WOULD UNBLOCK IT
 *
 * One capture from somebody with a Moultrie account, which takes about five
 * minutes — see docs/moultrie-capture.md. From a logged-in session it yields
 * the real API host, the camera and photo endpoints, the response shapes, and
 * how the token is carried. With that, implementing this file is ordinary work
 * rather than guesswork.
 *
 * The fallback, if the OAuth flow proves impractical to reimplement, is
 * browser automation: drive a real login with Playwright, then reuse the
 * session. Slower and more fragile, but proven to work by the scraper above.
 *
 * DO NOT stub these methods with invented endpoints. A provider that returns
 * plausible-looking wrong data is worse than one that refuses, because the map
 * and the hunt planner will happily render it.
 */

const NOT_IMPLEMENTED = `Moultrie support is not implemented.

There is no usable Moultrie API client to build on: their web app is Blazor
WebAssembly behind Microsoft MSAL OAuth, so the endpoints are compiled into
.wasm rather than sitting in readable JavaScript, and login is a browser
redirect flow rather than a simple password exchange.

To move this forward, someone with a Moultrie account needs to capture one
logged-in session — about five minutes with browser DevTools. The steps are in
docs/moultrie-capture.md.`;

const refuse = () => { throw new Error(NOT_IMPLEMENTED); };

export default {
  id: 'moultrie',
  label: 'Moultrie',
  envPrefix: 'MOULTRIE',
  implemented: false,
  why: NOT_IMPLEMENTED,

  login: refuse,
  cameras: refuse,
  photos: refuse,
  normalizeCamera: refuse,
  photoDate: refuse,
  photoUrl: refuse,
  photoId: refuse,
  photoTags: refuse,
};
