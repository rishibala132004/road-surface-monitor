import { describe, expect, it } from 'vitest';
import {
  normaliseConfidence,
  normaliseLabel,
  parseMessage,
  parseTopic,
  type ParseContext,
} from '../src/data/contract';

const ctx: ParseContext = {
  topicPrefix: 'road',
  classIds: ['smooth', 'rough', 'bump', 'stopped'],
  aliases: { cobbles: 'rough', pothole: 'bump', idle: 'stopped' },
  owntracksMap: { 'alice/phone': 'bike2' },
  owntracksDefaultBike: 'bike1',
  receivedAt: 1_793_290_000_000,
};

describe('parseTopic', () => {
  it('recognises the three bike topics', () => {
    expect(parseTopic('road/bike1/condition', 'road')).toEqual({
      kind: 'condition',
      device: 'bike1',
    });
    expect(parseTopic('road/bike7/gps', 'road')).toEqual({ kind: 'gps', device: 'bike7' });
    expect(parseTopic('road/bike1/status', 'road')).toEqual({ kind: 'status', device: 'bike1' });
  });
  it('recognises OwnTracks topics', () => {
    expect(parseTopic('owntracks/alice/phone', 'road')).toEqual({
      kind: 'owntracks',
      owntracksKey: 'alice/phone',
    });
  });
  it('ignores other prefixes', () => {
    expect(parseTopic('other/bike1/condition', 'road').kind).toBe('unknown');
  });
});

describe('condition messages', () => {
  it('parses the full example from the contract', () => {
    const msg = parseMessage(
      'road/bike1/condition',
      JSON.stringify({
        v: 1,
        device: 'bike1',
        label: 'rough',
        confidence: 0.91,
        ts: 1793290000000,
        scores: { smooth: 0.05, rough: 0.91, bump: 0.03, stopped: 0.01 },
        vib: 3.2,
        inference_ms: 4.1,
        seq: 1532,
        lat: 52.2318,
        lon: 6.8722,
      }),
      ctx,
    );
    expect(msg?.kind).toBe('condition');
    if (msg?.kind !== 'condition') return;
    expect(msg.label).toBe('rough');
    expect(msg.known).toBe(true);
    expect(msg.confidence).toBeCloseTo(0.91);
    expect(msg.ts).toBe(1793290000000);
    expect(msg.scores?.rough).toBeCloseTo(0.91);
    expect(msg.vib).toBe(3.2);
    expect(msg.inferenceMs).toBe(4.1);
    expect(msg.seq).toBe(1532);
    expect(msg.lat).toBe(52.2318);
    expect(msg.lon).toBe(6.8722);
  });

  it('needs only a label: device comes from the topic, confidence defaults to 1, seconds become ms', () => {
    const msg = parseMessage('road/bike3/condition', '{"label":"smooth","ts":1793290000}', ctx);
    expect(msg?.kind).toBe('condition');
    if (msg?.kind !== 'condition') return;
    expect(msg.device).toBe('bike3');
    expect(msg.confidence).toBe(1);
    expect(msg.ts).toBe(1793290000000); // seconds -> ms
  });

  it('accepts confidence from 0 to 100 and percentage strings', () => {
    expect(normaliseConfidence(87)).toBeCloseTo(0.87);
    expect(normaliseConfidence('87%')).toBeCloseTo(0.87);
    expect(normaliseConfidence(0.5)).toBe(0.5);
    expect(normaliseConfidence(1)).toBe(1);
    expect(normaliseConfidence(undefined, 1)).toBe(1);
  });

  it('matches labels case-insensitively and through aliases', () => {
    expect(normaliseLabel('ROUGH', ctx.classIds, ctx.aliases)).toEqual({
      label: 'rough',
      known: true,
    });
    expect(normaliseLabel(' Cobbles ', ctx.classIds, ctx.aliases)).toEqual({
      label: 'rough',
      known: true,
    });
    expect(normaliseLabel('Bump_1', ctx.classIds, ctx.aliases)).toEqual({
      label: 'bump',
      known: true,
    });
    expect(normaliseLabel('gravel', ctx.classIds, ctx.aliases)).toEqual({
      label: 'gravel',
      known: false,
    });
  });

  it('keeps unknown labels rather than dropping the message', () => {
    const msg = parseMessage(
      'road/bike1/condition',
      '{"label":"Lava","confidence":90,"ts":1}',
      ctx,
    );
    expect(msg?.kind).toBe('condition');
    if (msg?.kind !== 'condition') return;
    expect(msg.known).toBe(false);
    expect(msg.label).toBe('lava');
    expect(msg.rawLabel).toBe('Lava');
    expect(msg.confidence).toBeCloseTo(0.9);
  });

  it('normalises scores given in percent and with alias keys', () => {
    const msg = parseMessage(
      'road/bike1/condition',
      '{"label":"bump","ts":1793290000000,"scores":{"Smooth":5,"Cobbles":10,"Pothole":80,"idle":5}}',
      ctx,
    );
    if (msg?.kind !== 'condition') throw new Error('expected condition');
    expect(msg.scores).toEqual({ smooth: 0.05, rough: 0.1, bump: 0.8, stopped: 0.05 });
  });

  it('ignores unknown fields and missing ts falls back to receipt time', () => {
    const msg = parseMessage(
      'road/bike1/condition',
      '{"label":"smooth","foo":1,"bar":{"x":2}}',
      ctx,
    );
    if (msg?.kind !== 'condition') throw new Error('expected condition');
    expect(msg.ts).toBe(ctx.receivedAt);
  });

  it('rejects non-JSON and label-less payloads', () => {
    expect(parseMessage('road/bike1/condition', 'hello', ctx)).toBeNull();
    expect(parseMessage('road/bike1/condition', '{"confidence":0.5}', ctx)).toBeNull();
  });

  it('handles binary payloads', () => {
    const bytes = new TextEncoder().encode('{"label":"rough","ts":5}');
    expect(parseMessage('road/bike1/condition', bytes, ctx)?.kind).toBe('condition');
  });
});

describe('gps messages', () => {
  it('parses the gps topic', () => {
    const msg = parseMessage(
      'road/bike1/gps',
      '{"lat":52.23,"lon":6.87,"ts":1793290000000,"speed":17.2,"acc":5,"heading":140}',
      ctx,
    );
    expect(msg).toMatchObject({
      kind: 'gps',
      device: 'bike1',
      lat: 52.23,
      lon: 6.87,
      speed: 17.2,
      acc: 5,
      heading: 140,
    });
  });
  it('parses OwnTracks location messages and maps the phone to a bike', () => {
    const msg = parseMessage(
      'owntracks/alice/phone',
      '{"_type":"location","lat":52.2,"lon":6.9,"tst":1793290000,"vel":15,"acc":8,"cog":90,"alt":40}',
      ctx,
    );
    expect(msg).toMatchObject({
      kind: 'gps',
      device: 'bike2',
      speed: 15,
      acc: 8,
      heading: 90,
      alt: 40,
      ts: 1793290000000,
    });
  });
  it('uses the default bike for unmapped phones and ignores other _type values', () => {
    const msg = parseMessage(
      'owntracks/bob/x',
      '{"_type":"location","lat":52.2,"lon":6.9,"tst":1}',
      ctx,
    );
    expect(msg).toMatchObject({ kind: 'gps', device: 'bike1' });
    expect(parseMessage('owntracks/bob/x', '{"_type":"lwt"}', ctx)).toBeNull();
  });
  it('rejects fixes without a position', () => {
    expect(parseMessage('road/bike1/gps', '{"ts":1}', ctx)).toBeNull();
    expect(parseMessage('road/bike1/gps', '{"lat":0,"lon":0}', ctx)).toBeNull();
  });
});

describe('status messages', () => {
  it('parses all optional fields', () => {
    const msg = parseMessage(
      'road/bike1/status',
      '{"device":"bike1","battery":78,"model":"road-v3","rate_hz":1.0,"uptime_s":1234}',
      ctx,
    );
    expect(msg).toMatchObject({
      kind: 'status',
      battery: 78,
      model: 'road-v3',
      rateHz: 1,
      uptimeS: 1234,
    });
  });
});
