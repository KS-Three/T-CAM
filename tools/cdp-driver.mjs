/**
 * tools/cdp-driver.mjs — drive the served dashboard in a real headless
 * Chromium, with nothing installed.
 *
 * The repo's verification bar for UI work is "driven in a browser", and this
 * is the harness that clears it: launch, load a page, click and type through
 * the DevTools protocol, read state back with evaluate(), screenshot what a
 * person would see. It exists because several shipped bugs — cones filled
 * with nothing, panels laid out off-screen, photos 404ing behind their own
 * captions — passed every source-text test and were only visible in a
 * browser.
 *
 * Dependency-free on purpose, like everything else here: Node 22's global
 * fetch and WebSocket talk CDP directly. The one external need is a Chromium
 * binary; pass its path in the CHROME env var, or let the lookup below find
 * a common one (including the preinstalled copy in Claude's cloud
 * environment).
 *
 * Typical session:
 *
 *   import { launch } from './tools/cdp-driver.mjs';
 *   const b = await launch(9333);
 *   await b.goto('http://127.0.0.1:8787/');
 *   await b.evaluate("document.getElementById('view3dBtn').click()");
 *   await b.shot('after.png');           // LOOK at it
 *   b.close();
 *
 * Real pointer gestures (drags, swipes) go through b.send with
 * Input.dispatchMouseEvent / Input.dispatchKeyEvent — see the DevTools
 * protocol docs; evaluate() covers everything that a synthetic .click() can.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

function findChromium() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const fixed = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of fixed) if (existsSync(p)) return p;
  // Claude's cloud environment ships Playwright's build under /opt/pw-browsers.
  try {
    for (const d of readdirSync('/opt/pw-browsers')) {
      const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
      if (d.startsWith('chromium-') && existsSync(p)) return p;
    }
  } catch { /* not that environment */ }
  throw new Error('no Chromium found — set CHROME=/path/to/chrome');
}

/**
 * Launch a fresh headless Chromium and attach to its first page.
 *
 * The profile dir is keyed by port, so two launches on one port share
 * cookies, localStorage and the service worker — which is exactly what the
 * offline drives rely on (save online, kill the server, relaunch the same
 * port, the worker answers). Use a new port for a clean slate.
 */
export async function launch(port = 9333, { width = 1200, height = 900 } = {}) {
  const proc = spawn(findChromium(), [
    '--headless=new', '--remote-debugging-port=' + port, '--no-sandbox',
    '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`,
    '--user-data-dir=/tmp/cdp-profile-' + port, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let ws = null;
  for (let i = 0; i < 60 && !ws; i++) {
    await sleep(250);
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      ws = tabs.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch { /* not up yet */ }
  }
  if (!ws) { proc.kill(); throw new Error('chromium never answered on port ' + port); }

  const sock = new WebSocket(ws);
  await new Promise((ok, no) => { sock.onopen = ok; sock.onerror = no; });
  let id = 0;
  const pending = new Map();
  const events = [];               // unsolicited CDP events, e.g. exceptions
  sock.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { ok, no } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
    } else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const i = ++id;
    pending.set(i, { ok, no });
    sock.send(JSON.stringify({ id: i, method, params }));
  });

  return {
    send, events,
    /** Run an expression in the page; promises are awaited, the value returned. */
    async evaluate(expr) {
      const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? 'page threw');
      }
      return r.result.value;
    },
    async goto(url) {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Page.navigate', { url });
      await sleep(1200);           // tiles and baked state; poll for more precision
    },
    /** PNG of the viewport (or a clip {x,y,width,height}) to `path`. */
    async shot(path, clip) {
      const r = await send('Page.captureScreenshot',
        clip ? { clip: { ...clip, scale: 2 } } : {});
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, Buffer.from(r.data, 'base64'));
    },
    close() {
      try { sock.close(); } catch { /* already gone */ }
      proc.kill();
    },
  };
}
