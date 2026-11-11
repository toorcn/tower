import { expect, it } from 'vitest';
import { timingDelays } from './simulator.js';
it('scales absolute scenario timestamps into inter-event delays', () => {
  expect(timingDelays([{ at: 0 }, { at: 1200 }, { at: 1400 }, { at: 5000 }], 2)).toEqual([0, 600, 100, 1800]);
});
it('rejects invalid speed and unordered timestamps', () => {
  for (const speed of [0, -1, NaN, Infinity]) expect(() => timingDelays([], speed)).toThrow('Speed');
  expect(() => timingDelays([{ at: 100 }, { at: 0 }], 1)).toThrow('ordered');
});
