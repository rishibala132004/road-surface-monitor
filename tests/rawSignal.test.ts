import { describe, expect, it } from 'vitest';
import { parseSignalCsv } from '../src/components/rawSignal';

describe('parseSignalCsv', () => {
  it('reads an Edge Impulse export and takes the label from the file name', () => {
    const csv = 'timestamp,accX,accY,accZ\n0,0.1,0.2,9.8\n16,0.2,0.1,9.7\n32,0.0,0.3,9.9\n';
    const s = parseSignalCsv(csv, 'rough.abc123.csv');
    expect(s?.label).toBe('rough');
    expect(s?.t).toEqual([0, 16, 32]);
    expect(s?.acc[2]).toEqual([9.8, 9.7, 9.9]);
    expect(s?.gyro).toBeNull();
  });

  it('accepts other column names, semicolons and a label column', () => {
    const csv =
      'time;ax;ay;az;gx;gy;gz;label\n0;1;2;3;4;5;6;Bump\n10;1;2;3;4;5;6;Bump\n20;1;2;3;4;5;6;Bump\n';
    const s = parseSignalCsv(csv, 'sample.csv');
    expect(s?.label).toBe('bump');
    expect(s?.gyro?.[0]).toEqual([4, 4, 4]);
  });

  it('rejects files without accelerometer columns', () => {
    expect(parseSignalCsv('a,b,c\n1,2,3\n4,5,6\n7,8,9\n', 'x.csv')).toBeNull();
  });
});
