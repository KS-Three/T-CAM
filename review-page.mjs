/**
 * review-page.mjs — the screen where photos become data.
 *
 * Everything downstream depends on this one: buck identity, movement patterns,
 * and the camera-activity term in the stand ranking all rest on somebody having
 * looked at a frame and said what was in it. So the whole design is about
 * making that cheap to do, because a review screen that is tedious does not get
 * used and the data never arrives.
 *
 * Three decisions carry most of the weight:
 *
 * 1. You tag a VISIT, not a photo. These cameras fire two frames per trigger,
 *    and a deer working through a spot sets off several triggers — six frames
 *    of one animal. Tagging per photo would mean labelling it six times, which
 *    is the fastest way to make someone stop.
 *
 * 2. "Nothing here" is a real answer and is recorded as one. An empty visit
 *    that has been looked at and an empty visit nobody has opened are different
 *    facts, and the analysis has to tell them apart or it will read every
 *    unreviewed frame as evidence of no deer.
 *
 * 3. It is keyboard-first. D, T, N, arrows, Enter. A season's photos is
 *    thousands of frames; a mouse round trip per frame is the difference
 *    between an evening's work and never finishing.
 *
 * A separate page from the dashboard on purpose: this is a task you sit down to
 * do, not something to glance at beside a map.
 */

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Embedded the same way the dashboard does it: inside a JSON script block, with
// the closing-tag sequence broken up so a camera or buck named "</script>"
// cannot end the block early and inject markup.
const jsonBlock = obj => JSON.stringify(obj).replace(/</g, '\\u003c');

export function reviewHtml({ species = [], bucks = [], remaining = 0 } = {}) {
  const payload = jsonBlock({ species, bucks, remaining });
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review photos — TrailCam</title>
<style>
  :root {
    --bg: #10140f; --panel: #1a201a; --line: #2c3529; --ink: #e8efe4;
    --muted: #93a08c; --accent: #7fb069; --ok: #77c66e; --warn: #d9a441; --bad: #d76b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
           padding: 14px 20px; border-bottom: 1px solid var(--line); }
  header h1 { margin: 0; font-size: 17px; }
  header a { color: var(--accent); text-decoration: none; font-size: 13px; }
  .count { color: var(--muted); font-size: 13px; }
  .count b { color: var(--ink); }
  main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px;
         padding: 18px 20px; align-items: start; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }

  .stage { background: #000; border: 1px solid var(--line); border-radius: 10px;
           overflow: hidden; position: relative; }
  .stage img { display: block; width: 100%; height: auto; max-height: 68vh;
               object-fit: contain; background: #000; }
  .stage .missing { padding: 60px 20px; text-align: center; color: var(--muted); }
  .frames { display: flex; gap: 6px; padding: 8px; overflow-x: auto;
            border-top: 1px solid var(--line); background: var(--panel); }
  .frames button { flex: 0 0 auto; width: 76px; height: 52px; padding: 0; cursor: pointer;
                   border: 2px solid transparent; border-radius: 5px; overflow: hidden;
                   background: #000; }
  .frames button.on { border-color: var(--accent); }
  .frames img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .side { display: flex; flex-direction: column; gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 14px; }
  .card h2 { margin: 0 0 4px; font-size: 14px; }
  .card .sub { color: var(--muted); font-size: 12px; }
  .keys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
  .keys button { padding: 10px 8px; cursor: pointer; font: 600 13px/1.2 inherit;
                 background: var(--bg); color: var(--ink); border: 1px solid var(--line);
                 border-radius: 7px; text-align: left; }
  .keys button:hover { border-color: var(--accent); }
  .keys button kbd { display: block; font-size: 10px; color: var(--muted);
                     font-family: inherit; letter-spacing: .06em; margin-top: 2px; }
  .keys button.wide { grid-column: 1 / -1; }
  .keys button.primary { background: var(--accent); color: #10240f; border-color: var(--accent); }
  .keys button.primary kbd { color: #23401c; }

  .tags { list-style: none; margin: 8px 0 0; padding: 0; }
  .tags li { display: flex; align-items: center; gap: 8px; padding: 6px 0;
             border-top: 1px solid var(--line); font-size: 13px; }
  .tags li:first-child { border-top: 0; }
  .tags .what { flex: 1; }
  .tags .buck { color: var(--accent); font-weight: 600; }
  .tags button { background: none; border: 0; color: var(--bad); cursor: pointer;
                 font-size: 15px; padding: 0 4px; }
  .empty { color: var(--muted); font-size: 13px; font-style: italic; }

  label { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 3px; }
  select, input { width: 100%; padding: 7px 9px; font: inherit; font-size: 13px;
                  color: var(--ink); background: var(--bg); border: 1px solid var(--line);
                  border-radius: 6px; }
  .done { text-align: center; padding: 60px 20px; color: var(--muted); }
  .done h2 { color: var(--ink); }
  .toast { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%);
           background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
           padding: 9px 14px; font-size: 13px; box-shadow: 0 4px 18px rgba(0,0,0,.5); }
  .toast.bad { border-color: var(--bad); color: var(--bad); }
</style>

<header>
  <h1>Review photos</h1>
  <span class="count" id="count"></span>
  <a href="/">&larr; back to the map</a>
  <a href="/tonight">Tonight &rarr;</a>
  <a href="/journal">Journal</a>
</header>

<main id="main"></main>

<script type="application/json" id="data">${payload}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const mainEl = document.getElementById('main');
const countEl = document.getElementById('count');

let queue = [];        // visits still to look at
let visit = null;      // the one on screen
let frame = 0;         // which photo of it
let bucks = D.bucks || [];
let busy = false;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

function toast(msg, bad) {
  document.querySelector('.toast')?.remove();
  const t = el('div', 'toast' + (bad ? ' bad' : ''), msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 1800);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || ('request failed: ' + res.status));
  return data;
}

async function loadQueue() {
  const data = await api('GET', '/api/visits?unreviewed=1&limit=50');
  queue = data.visits;
  D.remaining = data.remaining;
  visit = queue[0] || null;
  frame = 0;
  render();
}

const when = iso => {
  if (!iso) return 'time unknown';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

function render() {
  countEl.innerHTML = '<b>' + D.remaining + '</b> visit' + (D.remaining === 1 ? '' : 's')
    + ' left to review';
  mainEl.textContent = '';

  if (!visit) {
    const done = el('div', 'done');
    done.appendChild(el('h2', null, D.remaining === 0 ? 'All caught up' : 'Nothing to show'));
    done.appendChild(el('p', null, D.remaining === 0
      ? 'Every visit has been looked at. New ones appear here after the next sync.'
      : 'No visits loaded. Run a sync, then group photos into visits.'));
    mainEl.appendChild(done);
    return;
  }

  // ---- the photo -----------------------------------------------------
  const left = el('div');
  const stage = el('div', 'stage');
  const photo = visit.photos[frame];
  const src = photo && (photo.file || photo.url);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Frame ' + (frame + 1) + ' of ' + visit.photos.length;
    // A photo listed but not yet downloaded is a real state and worth saying,
    // rather than showing a broken image icon.
    img.onerror = () => {
      img.remove();
      stage.prepend(el('div', 'missing', photo.downloaded
        ? 'This frame could not be loaded from disk.'
        : 'This frame has not been downloaded yet — run the sync.'));
    };
    stage.appendChild(img);
  } else {
    stage.appendChild(el('div', 'missing', 'No image for this frame.'));
  }

  if (visit.photos.length > 1) {
    const strip = el('div', 'frames');
    visit.photos.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = i === frame ? 'on' : '';
      b.title = 'Frame ' + (i + 1) + ' — ' + when(p.takenAt);
      const t = document.createElement('img');
      t.src = p.file || p.url || '';
      t.alt = '';
      b.appendChild(t);
      b.onclick = () => { frame = i; render(); };
      strip.appendChild(b);
    });
    stage.appendChild(strip);
  }
  left.appendChild(stage);
  mainEl.appendChild(left);

  // ---- what is in it -------------------------------------------------
  const side = el('div', 'side');

  const head = el('div', 'card');
  head.appendChild(el('h2', null, visit.camera_name));
  head.appendChild(el('div', 'sub', when(visit.started_at)));
  head.appendChild(el('div', 'sub',
    visit.photo_count + ' frame' + (visit.photo_count === 1 ? '' : 's')
    + (visit.spanSeconds ? ' over ' + visit.spanSeconds + 's' : '')
    + ' \\u2014 one visit, tagged once'));
  side.appendChild(head);

  const tagCard = el('div', 'card');
  tagCard.appendChild(el('h2', null, 'What was there?'));
  const list = el('ul', 'tags');
  if (!visit.detections.length) {
    list.appendChild(el('li', 'empty', 'Nothing tagged yet.'));
  } else {
    for (const d of visit.detections) {
      const li = document.createElement('li');
      const what = el('span', 'what');
      what.textContent = (d.count > 1 ? d.count + ' ' : '') + (d.species || 'unidentified');
      if (d.buck_name) {
        what.appendChild(document.createTextNode(' \\u2014 '));
        what.appendChild(el('span', 'buck', d.buck_name));
      }
      li.appendChild(what);
      const del = el('button', null, '\\u00d7');
      del.title = 'Remove this tag';
      del.onclick = () => removeDetection(d.id);
      li.appendChild(del);
      list.appendChild(li);
    }
  }
  tagCard.appendChild(list);

  const keys = el('div', 'keys');
  const addBtn = (label, key, fn, cls) => {
    const b = document.createElement('button');
    if (cls) b.className = cls;
    b.appendChild(document.createTextNode(label));
    b.appendChild(el('kbd', null, key));
    b.onclick = fn;
    keys.appendChild(b);
    return b;
  };
  addBtn('Deer', 'D', () => tag('deer'));
  addBtn('Turkey', 'T', () => tag('turkey'));
  addBtn('Other', 'O', () => tag('other'));
  addBtn('Nothing here', 'N', nothingHere);
  addBtn('Next visit', 'ENTER', () => finish(true), 'wide primary');
  tagCard.appendChild(keys);

  // Naming a buck is what makes a deer THIS deer across cameras and seasons.
  const buckWrap = el('div');
  buckWrap.appendChild(el('label', null, 'Tag the last deer as a known buck'));
  const sel = document.createElement('select');
  sel.id = 'buckSel';
  const none = document.createElement('option');
  none.value = ''; none.textContent = 'not a named buck';
  sel.appendChild(none);
  for (const b of bucks) {
    const o = document.createElement('option');
    o.value = String(b.id);
    o.textContent = b.name + (b.sightings ? ' (' + b.sightings + ')' : '');
    sel.appendChild(o);
  }
  const add = document.createElement('option');
  add.value = '__new'; add.textContent = '+ new buck\\u2026';
  sel.appendChild(add);
  sel.onchange = () => assignBuck(sel.value);
  buckWrap.appendChild(sel);
  tagCard.appendChild(buckWrap);
  side.appendChild(tagCard);

  const help = el('div', 'card');
  help.appendChild(el('h2', null, 'Why a visit, not a photo'));
  help.appendChild(el('div', 'sub',
    'These cameras fire two frames per trigger, and a deer working through sets '
    + 'off several. Tagging each frame would mean labelling the same animal six '
    + 'times. Arrow keys step through the frames; the tag covers the visit.'));
  side.appendChild(help);

  mainEl.appendChild(side);
}

// ---- actions ----------------------------------------------------------

async function tag(species) {
  if (busy || !visit) return;
  const photo = visit.photos[frame];
  if (!photo) return toast('No frame to tag', true);
  busy = true;
  try {
    await api('POST', '/api/detections', { photoId: photo.id, species, count: 1 });
    visit = await api('GET', '/api/visits/' + visit.id);
    render();
  } catch (err) {
    toast(err.message, true);
  } finally { busy = false; }
}

async function removeDetection(id) {
  if (busy) return;
  busy = true;
  try {
    await api('DELETE', '/api/detections/' + id);
    visit = await api('GET', '/api/visits/' + visit.id);
    render();
  } catch (err) { toast(err.message, true); } finally { busy = false; }
}

async function assignBuck(value) {
  const deer = visit.detections.filter(d => d.species === 'deer');
  if (!deer.length) { toast('Tag a deer first, then name it', true); return render(); }
  const target = deer[deer.length - 1];
  try {
    if (value === '__new') return newBuckField(target);
    const buckId = value === '' ? null : Number(value);
    await api('PATCH', '/api/detections/' + target.id, { buckId });
    visit = await api('GET', '/api/visits/' + visit.id);
    render();
  } catch (err) { toast(err.message, true); render(); }
}

/**
 * Naming a buck happens in the page, not in a prompt().
 *
 * prompt blocks the whole page, cannot be styled, and is dismissed by a stray
 * Escape halfway through a naming — and this screen is keyboard-driven, so
 * stray keys are the normal case rather than the exception.
 */
function newBuckField(target) {
  const sel = document.getElementById('buckSel');
  if (document.getElementById('newBuck')) return;
  const wrap = el('div');
  wrap.appendChild(el('label', null, 'Name this buck'));
  const input = document.createElement('input');
  input.id = 'newBuck';
  input.placeholder = 'Split G2';
  wrap.appendChild(input);
  sel.parentNode.appendChild(wrap);
  input.focus();

  const cancel = () => { wrap.remove(); sel.value = ''; };
  input.onkeydown = async e => {
    e.stopPropagation();          // the page's shortcuts must not fire while typing
    if (e.key === 'Escape') return cancel();
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name) return cancel();
    try {
      const made = await api('POST', '/api/bucks', { name });
      bucks = await api('GET', '/api/bucks');
      await api('PATCH', '/api/detections/' + target.id, { buckId: made.id });
      visit = await api('GET', '/api/visits/' + visit.id);
      render();
      toast('Tagged as ' + name);
    } catch (err) { toast(err.message, true); render(); }
  };
}

/**
 * Reviewed, and genuinely empty. This is a claim, not an absence of one —
 * see the note at the top of this file.
 */
async function nothingHere() {
  if (!visit) return;
  await finish(false);
}

async function finish(hadSomething) {
  if (busy || !visit) return;
  busy = true;
  try {
    await api('POST', '/api/visits/' + visit.id + '/review', { reviewed: true });
    D.remaining = Math.max(0, D.remaining - 1);
    queue = queue.filter(v => v.id !== visit.id);
    visit = queue[0] || null;
    frame = 0;
    if (!visit && D.remaining > 0) return loadQueue();
    render();
    toast(hadSomething ? 'Marked reviewed' : 'Marked reviewed \\u2014 nothing there');
  } catch (err) { toast(err.message, true); } finally { busy = false; }
}

// ---- keyboard ---------------------------------------------------------
// The whole point of the screen. A season is thousands of frames and a mouse
// round trip per frame is the difference between an evening and never finishing.
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'd') { e.preventDefault(); tag('deer'); }
  else if (k === 't') { e.preventDefault(); tag('turkey'); }
  else if (k === 'o') { e.preventDefault(); tag('other'); }
  else if (k === 'n') { e.preventDefault(); nothingHere(); }
  else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
  else if (e.key === 'ArrowRight' && visit) {
    e.preventDefault();
    frame = Math.min(visit.photos.length - 1, frame + 1); render();
  } else if (e.key === 'ArrowLeft' && visit) {
    e.preventDefault();
    frame = Math.max(0, frame - 1); render();
  }
});

loadQueue().catch(err => {
  mainEl.appendChild(el('div', 'done', 'Could not load visits: ' + err.message));
});
</script>
</html>`;
}
