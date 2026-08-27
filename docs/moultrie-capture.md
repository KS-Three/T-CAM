# Capturing a Moultrie session

**About five minutes, on a computer, by someone with a Moultrie Mobile account.**

Moultrie publishes no API and there is no community client to copy, so the only
way to add Moultrie support is to observe what their own web app does. This is
the same thing the browser is already doing — it just writes it down.

> **Read the safety notes at the bottom before sharing the file.** The capture
> contains a login token for that account. Treat it like a password.

## Steps

1. In **Chrome** or **Edge**, go to <https://web.moultriemobile.com> and log in
   as normal.

2. Press **F12** to open DevTools, and click the **Network** tab.

3. Tick **Preserve log**. In the filter box type **Fetch/XHR** (or click the
   `Fetch/XHR` button) so only data requests are listed.

4. Now use the site normally for a minute, making sure to:
   - open the camera list or map,
   - open one camera's photos,
   - scroll the photo list far enough to load more.

   Each of those makes the calls we need to see.

5. **Right-click anywhere in the request list → "Save all as HAR with content"**
   (Edge calls it "Export HAR"). Save the file.

6. Before sending it, sanitize it — see below.

## Sanitize before sharing

A HAR is a complete recording of the session, **including the login token and
possibly the password from the sign-in request**. Do this first:

1. Open the `.har` in a text editor (it is just JSON).
2. Use Find & Replace to blank these wherever they appear:
   - `Authorization` header values — replace the long token with `REDACTED`
   - `Cookie` and `Set-Cookie` header values
   - anything containing the account password
   - the account email, if preferred
3. Camera coordinates can stay or go. They are the physical locations of real
   cameras, so if they belong to someone else, ask them first.

Changing the token to `REDACTED` does not reduce the file's usefulness here:
what matters is the **shape** — which host, which paths, which parameters,
which fields come back — not the credential itself.

If editing JSON is a nuisance, an easier alternative that reveals almost as
much: in the Network tab, right-click each interesting request →
**Copy → Copy as cURL**, paste those into a text file, and delete the
`-H 'Authorization: ...'` lines by hand. Five or six requests is plenty.

## What this makes possible

From a sanitized capture the following become answerable, none of which can be
guessed:

- the real API host, since `api.moultriemobile.com` is not publicly reachable
- the camera-list and photo-list endpoints and their parameters
- the JSON field names for location, battery, signal and last-contact
- how photo URLs are formed, and whether they need auth to download
- whether the token is a plain bearer or something that must be refreshed
  through the Microsoft OAuth flow — this decides whether a standalone client
  is practical, or whether it has to drive a real browser

With that in hand, `providers/moultrie.mjs` becomes ordinary work: it has to
satisfy the same interface as `providers/spypoint.mjs`, and after that Moultrie
cameras appear on the same map, in the same status cards, and in the same hunt
plan as everything else.

## If the capture shows OAuth cannot be reimplemented

That is a real possible outcome. The fallback is browser automation — drive the
login with Playwright and reuse the resulting session, the way
[lzilioli/moultrie-scraper](https://github.com/lzilioli/moultrie-scraper) does
with Puppeteer. It works, but it is slower, needs a real browser installed, and
breaks whenever Moultrie changes their front end. Worth knowing which of the
two you are in for before starting, which is exactly what the capture tells you.
