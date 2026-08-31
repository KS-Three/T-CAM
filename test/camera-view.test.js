/**
 * Which way a camera is pointed: the geometry, the store, and the one thing
 * that would quietly undo it — a sync.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseView, cameraView, viewFromBearing, seesPoint, facingLine,
  CAMERA_SPREAD_DEG, CAMERA_REACH_M,
} from '../camera-view.mjs';
import { openDb, upsertCamera, setCameraView } from '../db.mjs';
import { cameraFromRow } from '../serve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trailcam-camview-'));

// The invented cluster this repo uses. Never a real camera position.
const CAM = { lat: 44.12, lng: -90.65 };

// ---------------------------------------------------------------------------
// Reading a stored view
// ---------------------------------------------------------------------------

test('an unset facing reads as unknown, never as north', () => {
  // The whole point. A camera defaulted to a bearing would draw a guess in the
  // same ink as a measurement, and everything downstream would believe both.
  for (const raw of [null, undefined, '', '  ', 'null']) {
    assert.equal(parseView(raw), null, JSON.stringify(raw));
  }
  assert.equal(cameraView({ ...CAM }), null);
  assert.equal(facingLine({ ...CAM }), null);
});

test('malformed views are refused rather than half-read', () => {
  for (const raw of ['{', '{"to":"north"}', '{"to":[1]}', '{"to":[null,null]}',
    '[]', '{"to":[999,0]}', '{"to":[0,91]}', '"a string"', '42']) {
    assert.equal(parseView(raw), null, raw);
  }
});

test('a view survives the round trip through JSON', () => {
  const v = { to: [-90.6484, 44.1213], spread: 21 };
  assert.deepEqual(parseView(JSON.stringify(v)), v);
  assert.deepEqual(parseView(v), v);
});

test('spread is clamped to what a cone can actually be', () => {
  assert.equal(parseView({ to: [-90.65, 44.12], spread: 900 }).spread, 80);
  assert.equal(parseView({ to: [-90.65, 44.12], spread: -5 }).spread, 3);
  assert.equal(parseView({ to: [-90.65, 44.12], spread: 'wide' }).spread, undefined);
});

// ---------------------------------------------------------------------------
// The geometry, which is a lane's geometry
// ---------------------------------------------------------------------------

test('a facing is a bearing, a compass word and a reach', () => {
  const cam = { ...CAM, view: viewFromBearing(CAM, 45, 30) };
  const v = cameraView(cam);
  assert.equal(Math.round(v.bearingDeg), 45);
  assert.equal(v.point, 'NE');
  assert.equal(v.metres, 30);
  assert.equal(v.spreadDeg, CAMERA_SPREAD_DEG);
  assert.equal(facingLine(cam), 'NE 45° · 30 m');
});

test('every compass point comes back as the word for it', () => {
  const want = { 0: 'N', 90: 'E', 180: 'S', 270: 'W', 45: 'NE', 315: 'NW' };
  for (const [deg, word] of Object.entries(want)) {
    const cam = { ...CAM, view: viewFromBearing(CAM, Number(deg), 40) };
    assert.equal(cameraView(cam).point, word, deg + ' degrees');
  }
});

test('the default reach is a starting point, not a claim', () => {
  const cam = { ...CAM, view: viewFromBearing(CAM, 0) };
  assert.equal(cameraView(cam).metres, CAMERA_REACH_M);
});

test('a camera sees what is inside its cone and nothing outside it', () => {
  // Pointed north, 50 m.
  const cam = { ...CAM, view: viewFromBearing(CAM, 0, 50) };
  const north = (m, bearingDeg = 0) => {
    const p = viewFromBearing(CAM, bearingDeg, m);
    return [p.to[1], p.to[0]];
  };
  assert.ok(seesPoint(cam, ...north(30)), 'straight ahead, well inside');
  assert.ok(seesPoint(cam, ...north(30, 15)), 'off to one side but within the spread');
  assert.ok(!seesPoint(cam, ...north(30, 40)), 'beyond the spread');
  assert.ok(!seesPoint(cam, ...north(120)), 'the right way but too far');
  assert.ok(!seesPoint(cam, ...north(30, 180)), 'behind it');
  assert.ok(!seesPoint({ ...CAM }, ...north(10)), 'a camera with no facing sees nothing');
});

// ---------------------------------------------------------------------------
// The store, and the sync
// ---------------------------------------------------------------------------

// A provider row carries every column it owns, explicitly. cameraSummary()
// always does; a fixture that leaves one undefined fails to bind rather than
// storing a null, which is worth knowing but is not what these tests are about.
const provided = over => ({
  id: 'abc123', name: 'East Side', model: 'FLEX-M', lat: CAM.lat, lng: CAM.lng,
  gpsFix: null, battery: 90, batteryLevel: 'high', batterySource: 'AA',
  signal: 90, signalBars: 3, signalLevel: 'medium', signalType: 'LTE',
  tempValue: 60, tempUnit: 'F', memUsed: 100, memSize: 1000,
  plan: 'Free', photoCount: 10, photoLimit: 100,
  cycleStart: null, cycleEnd: null, lastSeen: null, ...over,
});

test('a facing survives a sync, which never sends one', () => {
  // The failure this guards: the provider owns every other column on a camera
  // and upsertCamera overwrites them each run. The facing is the OWNER's
  // knowledge. If it were in the ON CONFLICT list, every sync would unpoint
  // every camera and the only symptom would be cones quietly vanishing.
  const out = tmp();
  const db = openDb(out);
  const row = upsertCamera(db, provided(), { provider: 'spypoint' });
  assert.equal(row.view, null, 'a new camera starts unpointed');

  const view = viewFromBearing(CAM, 45, 30);
  setCameraView(db, row.id, view);
  const pointed = db.prepare('SELECT view FROM cameras WHERE id = ?').get(row.id);
  assert.deepEqual(JSON.parse(pointed.view), view);

  // Now a sync runs: same camera, fresh provider data, no view anywhere in it.
  upsertCamera(db, provided({ battery: 55 }), { provider: 'spypoint' });
  const after = db.prepare('SELECT view, battery FROM cameras WHERE id = ?').get(row.id);
  assert.equal(after.battery, 55, 'the provider fields did update');
  assert.deepEqual(JSON.parse(after.view), view, 'and the facing was left alone');
  db.close();
});

test('a facing can be cleared, because a moved camera must be correctable', () => {
  const out = tmp();
  const db = openDb(out);
  const row = upsertCamera(db, provided(), { provider: 'spypoint' });
  setCameraView(db, row.id, viewFromBearing(CAM, 45, 30));
  const cleared = setCameraView(db, row.id, null);
  assert.equal(cleared.view, null);
  assert.equal(cameraFromRow(cleared).facingLine, null);
  db.close();
});

test('pointing a camera that does not exist is an error, not a silent no-op', () => {
  const out = tmp();
  const db = openDb(out);
  assert.throws(() => setCameraView(db, 'spypoint:nobody', viewFromBearing(CAM, 0)),
    /no camera/);
  db.close();
});

test('the derivation travels with the camera, so nothing re-derives it', () => {
  // The map, the card and the API each working the bearing out again is how
  // they start quoting different numbers for one cone.
  const out = tmp();
  const db = openDb(out);
  const row = upsertCamera(db, provided(), { provider: 'spypoint' });
  const view = viewFromBearing(CAM, 135, 40);
  const client = cameraFromRow(setCameraView(db, row.id, view));
  assert.deepEqual(client.view, view);
  assert.equal(client.facing.point, 'SE');
  assert.equal(client.facing.metres, 40);
  assert.equal(client.facing.spreadDeg, CAMERA_SPREAD_DEG);
  assert.equal(client.facingLine, 'SE 135° · 40 m');
  db.close();
});
