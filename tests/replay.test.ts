import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../src/data/sources/ReplaySource';

describe('parseJsonl', () => {
  it('reads the recorded format and sorts by receipt time', () => {
    const text = [
      '{"t":2000,"topic":"road/bike1/gps","payload":"{\\"lat\\":52,\\"lon\\":6,\\"ts\\":2000}"}',
      '{"t":1000,"topic":"road/bike1/condition","payload":"{\\"label\\":\\"smooth\\",\\"ts\\":1000}"}',
      '',
      'not json',
    ].join('\n');
    const records = parseJsonl(text);
    expect(records.map((r) => r.t)).toEqual([1000, 2000]);
    expect(records[0]!.topic).toBe('road/bike1/condition');
  });

  it('accepts payload objects and derives the time from the payload', () => {
    const records = parseJsonl(
      '{"topic":"road/bike1/condition","payload":{"label":"rough","ts":1793290000}}',
    );
    expect(records[0]!.t).toBe(1793290000000);
    expect(JSON.parse(records[0]!.payload).label).toBe('rough');
  });
});
