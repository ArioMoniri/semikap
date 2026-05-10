/**
 * Unit tests for the v0.7.8 persistent-measurements zustand slice.
 *
 * Goals:
 *   1. add → list contains the new entry.
 *   2. remove → only the matching id is dropped.
 *   3. clear → list is empty.
 *   4. add of two distinct entries preserves insertion order.
 *
 * The store wires a localStorage prefs round-trip; we mock-stub it so
 * the test runner doesn't need a DOM. Vitest's `node` environment
 * doesn't ship `window` so we install a tiny stub that the prefs
 * loader treats as "no window present".
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { useAppStore } from '../src/lib/state/store';

describe('useAppStore.measurements', () => {
  beforeEach(() => {
    useAppStore.getState().clearMeasurements();
  });

  it('starts empty', () => {
    expect(useAppStore.getState().measurements).toEqual([]);
  });

  it('adds a distance measurement and returns it in the list', () => {
    useAppStore.getState().addMeasurement({
      id: 'm-1',
      kind: 'distance',
      a: [0, 0, 0],
      b: [10, 0, 0],
      distanceMm: 10,
      addedAt: '2026-05-11T00:00:00.000Z',
    });
    const list = useAppStore.getState().measurements;
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe('distance');
    if (list[0]?.kind === 'distance') {
      expect(list[0].distanceMm).toBe(10);
    }
  });

  it('adds an angle measurement and stores all three points', () => {
    useAppStore.getState().addMeasurement({
      id: 'a-1',
      kind: 'angle',
      vertex: [0, 0, 0],
      arm1: [10, 0, 0],
      arm2: [0, 10, 0],
      degrees: 90,
      addedAt: '2026-05-11T00:00:00.000Z',
    });
    const list = useAppStore.getState().measurements;
    expect(list).toHaveLength(1);
    if (list[0]?.kind === 'angle') {
      expect(list[0].degrees).toBe(90);
      expect(list[0].vertex).toEqual([0, 0, 0]);
      expect(list[0].arm1).toEqual([10, 0, 0]);
      expect(list[0].arm2).toEqual([0, 10, 0]);
    }
  });

  it('removes only the matching id, preserves the rest', () => {
    const s = useAppStore.getState();
    s.addMeasurement({
      id: 'd-1',
      kind: 'distance',
      a: [0, 0, 0],
      b: [1, 0, 0],
      distanceMm: 1,
      addedAt: '2026-05-11T00:00:00.000Z',
    });
    s.addMeasurement({
      id: 'd-2',
      kind: 'distance',
      a: [0, 0, 0],
      b: [2, 0, 0],
      distanceMm: 2,
      addedAt: '2026-05-11T00:00:01.000Z',
    });
    s.addMeasurement({
      id: 'd-3',
      kind: 'distance',
      a: [0, 0, 0],
      b: [3, 0, 0],
      distanceMm: 3,
      addedAt: '2026-05-11T00:00:02.000Z',
    });
    s.removeMeasurement('d-2');
    const list = useAppStore.getState().measurements;
    expect(list.map((m) => m.id)).toEqual(['d-1', 'd-3']);
  });

  it('clearMeasurements wipes the list', () => {
    useAppStore.getState().addMeasurement({
      id: 'd-1',
      kind: 'distance',
      a: [0, 0, 0],
      b: [1, 0, 0],
      distanceMm: 1,
      addedAt: '2026-05-11T00:00:00.000Z',
    });
    useAppStore.getState().clearMeasurements();
    expect(useAppStore.getState().measurements).toEqual([]);
  });

  it('preserves insertion order across multiple adds', () => {
    const s = useAppStore.getState();
    for (let i = 0; i < 5; i++) {
      s.addMeasurement({
        id: `d-${i}`,
        kind: 'distance',
        a: [0, 0, 0],
        b: [i, 0, 0],
        distanceMm: i,
        addedAt: `2026-05-11T00:00:0${i}.000Z`,
      });
    }
    const ids = useAppStore.getState().measurements.map((m) => m.id);
    expect(ids).toEqual(['d-0', 'd-1', 'd-2', 'd-3', 'd-4']);
  });
});
