import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrame, parseFrame, crc16, parseQPIGS, parseQPIRI, parseQMOD, parseQPIWS,
  setOutputPriorityCommand, setChargerPriorityCommand, isQueryCommand,
} from '../src/protocol.js';

test('CRC matches well-known PI30 frames', () => {
  assert.equal(buildFrame('QPIGS').toString('hex'), '5150494753b7a90d');
  assert.equal(buildFrame('QMOD').toString('hex'), '514d4f4449c10d');
});

test('CRC never produces ( CR or LF bytes', () => {
  for (let i = 0; i < 5000; i++) {
    const [hi, lo] = crc16(Buffer.from(`Q${i}`));
    for (const b of [hi, lo]) assert.ok(![0x28, 0x0d, 0x0a].includes(b));
  }
});

test('parseFrame accepts a valid reply and strips HID padding', () => {
  const frame = buildFrame('(B');
  const padded = Buffer.concat([frame, Buffer.alloc(8 - (frame.length % 8))]);
  assert.deepEqual(parseFrame(padded), { ok: true, payload: 'B' });
});

test('parseFrame rejects a corrupted reply', () => {
  const frame = buildFrame('(230.0 50.0');
  frame[3] = 0x39; // flip a digit
  const result = parseFrame(frame);
  assert.equal(result.ok, false);
  assert.match(result.error, /Checksum/);
});

test('parseFrame rejects an incomplete reply', () => {
  assert.equal(parseFrame(Buffer.from('(230.0')).ok, false);
});

const SAMPLE_QPIGS = '000.0 00.0 230.0 49.9 0322 0254 006 375 52.50 004 076 0034 0002.6 168.2 00.00 00000 00010110 00 00 00437 010';

test('parseQPIGS reads the live values', () => {
  const r = parseQPIGS(SAMPLE_QPIGS);
  assert.equal(r.gridVolts, 0);
  assert.equal(r.outWatts, 254);
  assert.equal(r.batteryVolts, 52.5);
  assert.equal(r.batterySoc, 76);
  assert.equal(r.batteryChargeAmps, 4);
  assert.equal(r.pvVolts, 168.2);
  assert.equal(r.pvWatts, 437);
  assert.equal(r.loadOn, true);
  assert.equal(r.charging, true);
  assert.equal(r.chargingFromSolar, true);
  assert.equal(r.chargingFromGrid, false);
});

test('parseQPIGS estimates PV watts on older firmware', () => {
  const r = parseQPIGS(SAMPLE_QPIGS.split(' ').slice(0, 17).join(' '));
  assert.equal(r.pvWatts, Math.round(168.2 * 2.6));
});

test('parseQPIGS refuses truncated data instead of guessing', () => {
  assert.throws(() => parseQPIGS('230.0 50.0'));
});

test('parseQPIRI reads priorities from the correct fields', () => {
  // field 15 = input range (0), 16 = output priority (2 = SBU), 17 = charger priority (3 = only solar)
  const r = parseQPIRI('230.0 21.7 230.0 50.0 21.7 5000 5000 48.0 48.0 44.0 56.4 54.0 2 30 60 0 2 3 1 01 0 0 52.0 0 1');
  assert.equal(r.outputPriority, 'SBU');
  assert.equal(r.chargerPriority, 'OSO');
  assert.equal(r.batteryType, 'User');
  assert.equal(r.ratedWatts, 5000);
});

test('parseQMOD gives plain-English modes', () => {
  assert.equal(parseQMOD('B').label, 'Running on battery/solar');
  assert.equal(parseQMOD('F').code, 'F');
});

test('parseQPIWS: warnings when running, faults when stopped', () => {
  const bits = '0'.repeat(32).split('');
  bits[12] = '1'; // battery low
  bits[16] = '1'; // overload
  let w = parseQPIWS(bits.join(''));
  assert.deepEqual(w.map((x) => [x.text, x.level]), [['Battery low', 'warning'], ['Overload', 'warning']]);
  bits[1] = '1';
  w = parseQPIWS(bits.join(''));
  assert.equal(w.find((x) => x.text === 'Overload').level, 'fault');
});

test('setting commands', () => {
  assert.equal(setOutputPriorityCommand('UTI'), 'POP00');
  assert.equal(setOutputPriorityCommand('SBU'), 'POP02');
  assert.equal(setChargerPriorityCommand('SNU'), 'PCP02');
  assert.equal(setChargerPriorityCommand('OSO'), 'PCP03');
  assert.throws(() => setOutputPriorityCommand('XYZ'));
});

test('only queries are allowed from the console', () => {
  assert.ok(isQueryCommand('QPIGS'));
  assert.ok(!isQueryCommand('PF')); // factory reset
  assert.ok(!isQueryCommand('PBCV48.0'));
  assert.ok(!isQueryCommand('QPIGS; rm -rf /'));
});

test('parseFrame keeps CRC bytes that happen to be 0x00', () => {
  // Find a payload whose CRC contains a zero byte, then check it round-trips.
  let found = null;
  for (let i = 0; i < 100000 && !found; i++) {
    const p = `(${i}`;
    if (crc16(Buffer.from(p)).includes(0x00)) found = p;
  }
  assert.ok(found);
  const padded = Buffer.concat([buildFrame(found), Buffer.alloc(5)]);
  assert.deepEqual(parseFrame(padded), { ok: true, payload: found.slice(1) });
});
