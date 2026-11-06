import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { parseGpx, serializeGpx, GpxError } from '../src/core/gpx.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const parse = (s) => parseGpx(s, DOMParser);

test('GPX 1.0 con waypoint e quote', () => {
  const { tracks } = parse(fx('gpx10.gpx'));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Giro 1.0');
  assert.equal(tracks[0].points.length, 3);
  assert.deepEqual(tracks[0].points[1], { lat: 46.001, lon: 10, ele: 1010 });
  assert.equal(tracks[0].waypoints.length, 1);
  assert.deepEqual(tracks[0].waypoints[0], { lat: 46.0005, lon: 10.0005, ele: 1200, name: 'Rifugio' });
});

test('GPX 1.1 senza prefisso', () => {
  const xml = `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">
    <trk><name>Uno</name><trkseg><trkpt lat="45.5" lon="9.5"><ele>12.25</ele></trkpt><trkpt lat="45.6" lon="9.5"/></trkseg></trk></gpx>`;
  const { tracks } = parse(xml);
  assert.equal(tracks[0].points[0].ele, 12.25);
  assert.equal(tracks[0].points[1].ele, null);
});

test('namespace con prefisso', () => {
  const { tracks } = parse(fx('prefixed.gpx'));
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Prefissata');
  assert.equal(tracks[0].points.length, 2);
  assert.equal(tracks[0].points[0].ele, 2000.5);
  assert.equal(tracks[0].waypoints[0].name, 'Cima');
});

test('multi trk, multi trkseg appiattiti, rte, duplicati e punti invalidi scartati', () => {
  const { tracks } = parse(fx('multi.gpx'));
  assert.deepEqual(tracks.map((t) => t.name), ['Prima', 'Seconda', 'Rotta']);
  // 2 + (3 con un duplicato consecutivo -> 2) = 4 punti, segmenti in ordine
  assert.equal(tracks[0].points.length, 4);
  assert.deepEqual(tracks[0].points.map((p) => p.lat), [46.0, 46.01, 46.02, 46.03]);
  assert.equal(tracks[0].points[2].ele, null);
  // lat="abc" scartato
  assert.equal(tracks[1].points.length, 2);
  // rte
  assert.equal(tracks[2].points.length, 2);
  assert.equal(tracks[2].points[1].ele, 905);
  // i wpt vanno sulla prima traccia
  assert.deepEqual(tracks[0].waypoints.map((w) => w.name), ['Partenza', 'Arrivo']);
  assert.equal(tracks[1].waypoints.length, 0);
});

test('coordinate fuori range e attributi vuoti scartati', () => {
  const xml = `<gpx><trk><trkseg>
    <trkpt lat="91" lon="10"/><trkpt lat="" lon="10"/><trkpt lat="46" lon="181"/>
    <trkpt lat="46" lon="10"/><trkpt lat="46.1" lon="10"/></trkseg></trk></gpx>`;
  assert.equal(parse(xml).tracks[0].points.length, 2);
});

test('senza nome: nome di ripiego in italiano', () => {
  const xml = '<gpx><trk><trkseg><trkpt lat="46" lon="10"/></trkseg></trk></gpx>';
  assert.equal(parse(xml).tracks[0].name, 'Traccia 1');
});

test('CRLF e BOM iniziale', () => {
  const text = '﻿' + fx('gpx10.gpx').replace(/\n/g, '\r\n');
  const { tracks } = parse(text);
  assert.equal(tracks[0].points.length, 3);
  assert.equal(tracks[0].name, 'Giro 1.0');
  const ws = parse('\n \r\n' + fx('prefixed.gpx'));
  assert.equal(ws.tracks.length, 1);
});

test('XML malformato: GpxError in italiano', () => {
  const bad = [
    '<gpx><trk><trkseg><trkpt lat="46" lon="10"></trk></gpx>',
    '<gpx><trk><trkseg><trkpt lat="46" lon=',
    'questo non è xml',
    '',
  ];
  for (const b of bad) {
    assert.throws(() => parse(b), (e) => e instanceof GpxError && /[a-zà-ù]/i.test(e.message) && /GPX|file|XML|vuoto/i.test(e.message), JSON.stringify(b));
  }
});

test('GPX valido ma senza punti: GpxError', () => {
  assert.throws(() => parse('<gpx><trk><name>x</name><trkseg></trkseg></trk></gpx>'), GpxError);
  assert.throws(() => parse('<gpx><wpt lat="46" lon="10"/></gpx>'), GpxError);
  assert.throws(() => parse('<html><body/></html>'), GpxError);
});

test('serializzazione: round trip con escape XML', () => {
  const track = {
    name: `A & B <"C"> 'd' > e`,
    reversed: false,
    points: [
      { lat: 46.123456789, lon: 10.987654321, ele: 1234.5 },
      { lat: 46.2, lon: 10.9, ele: null },
      { lat: 46.3, lon: 10.8, ele: -3 },
    ],
    waypoints: [{ lat: 46.2, lon: 10.9, ele: 5, name: 'Rif. "Alpe" & <co>' }],
  };
  const xml = serializeGpx(track);
  assert.match(xml, /version="1\.1"/);
  assert.ok(xml.includes('A &amp; B &lt;&quot;C&quot;&gt;'));
  assert.ok(!xml.includes('<"C">'));
  const back = parse(xml).tracks[0];
  assert.equal(back.name, track.name);
  assert.deepEqual(back.points, track.points);
  assert.deepEqual(back.waypoints, track.waypoints);
});

test('serializzazione: applyReverse', () => {
  const track = {
    name: 'r', reversed: true, waypoints: [],
    points: [{ lat: 46, lon: 10, ele: 1 }, { lat: 46.1, lon: 10, ele: 2 }, { lat: 46.2, lon: 10, ele: 3 }],
  };
  assert.deepEqual(parse(serializeGpx(track)).tracks[0].points.map((p) => p.ele), [3, 2, 1]);
  assert.deepEqual(parse(serializeGpx(track, { applyReverse: false })).tracks[0].points.map((p) => p.ele), [1, 2, 3]);
});

test('serializzazione: caratteri di controllo non producono XML invalido', () => {
  const track = { name: 'a\u0001b\u000Bc', reversed: false, waypoints: [], points: [{ lat: 1, lon: 2, ele: null }] };
  assert.equal(parse(serializeGpx(track)).tracks[0].name, 'abc');
});
