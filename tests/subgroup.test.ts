import { describe, expect, it } from 'vitest';
import { subgroupSegmentation } from '../src/lib/benchmark/subgroup';
import type { SubgroupKey } from '../src/lib/benchmark/subgroup';
import type { BenchmarkRecord } from '../src/lib/benchmark/types';
import type { SegMetrics } from '../src/lib/metrics/segmentation';
import type { CaseMeta } from '../src/lib/datasets/manifest';

function seg(dice: number, iou: number, hd95Mm: number, label = 1): SegMetrics {
  return {
    label,
    dice,
    iou,
    precision: 0,
    recall: 0,
    f1: 0,
    tp: 0,
    fp: 0,
    fn: 0,
    refVoxels: 0,
    predVoxels: 0,
    volumeDiffMl: 0,
    volumetricSimilarity: 0,
    hd95Mm,
    assdMm: 0,
  };
}

function rec(
  id: string,
  meta: CaseMeta,
  segmentation: SegMetrics[],
  inferMs: number,
): BenchmarkRecord {
  return {
    schema: 'tamias.benchmark.v1',
    id,
    profileId: 'p',
    datasetName: 'ds',
    task: 'segmentation',
    model: { name: 'm', version: '1', sha256: 'x' },
    case: { caseId: id, imageName: `${id}.nii`, meta },
    runtime: { provider: 'wasm', inferMs, totalMs: inferMs },
    segmentation,
    createdAt: '2026-01-01T00:00:00Z',
    appVersion: '0.0.0',
  };
}

describe('subgroupSegmentation', () => {
  it('groups by modality (2 CT + 1 MR) with case-then-group macro means', () => {
    const records: BenchmarkRecord[] = [
      rec('ct1', { modality: 'CT' }, [seg(0.8, 0.5, 2, 1), seg(0.6, 0.3, 4, 2)], 100),
      rec('ct2', { modality: 'CT' }, [seg(0.9, 0.6, NaN, 1), seg(0.7, 0.4, 6, 2)], 200),
      rec('mr1', { modality: 'MR' }, [seg(0.5, 0.25, 10, 1)], 50),
    ];
    const groups = subgroupSegmentation(records, 'modality');
    expect(groups.map((g) => g.key)).toEqual(['CT', 'MR']);

    const ct = groups[0]!;
    expect(ct.count).toBe(2);
    // per-record macro dice: 0.7, 0.8 -> 0.75
    expect(ct.meanDice).toBeCloseTo(0.75, 10);
    // per-record macro iou: 0.4, 0.5 -> 0.45
    expect(ct.meanIou).toBeCloseTo(0.45, 10);
    // per-record macro hd95: 3 (mean 2,4), 6 (NaN ignored) -> 4.5
    expect(ct.meanHd95Mm).toBeCloseTo(4.5, 10);
    expect(ct.meanInferMs).toBeCloseTo(150, 10);

    const mr = groups[1]!;
    expect(mr.count).toBe(1);
    expect(mr.meanDice).toBeCloseTo(0.5, 10);
    expect(mr.meanIou).toBeCloseTo(0.25, 10);
    expect(mr.meanHd95Mm).toBeCloseTo(10, 10);
    expect(mr.meanInferMs).toBeCloseTo(50, 10);
  });

  it('bands age into <30 / 30-49 / 50-69 / 70+ and sorts ascending', () => {
    const records: BenchmarkRecord[] = [
      rec('a', { ageYears: 25 }, [seg(0.1, 0.1, 1)], 10),
      rec('b', { ageYears: 45 }, [seg(0.2, 0.2, 1)], 10),
      rec('c', { ageYears: 65 }, [seg(0.3, 0.3, 1)], 10),
      rec('d', { ageYears: 80 }, [seg(0.4, 0.4, 1)], 10),
      // boundary values fall into the higher band
      rec('e', { ageYears: 30 }, [seg(0.5, 0.5, 1)], 10),
      rec('f', { ageYears: 70 }, [seg(0.6, 0.6, 1)], 10),
    ];
    const groups = subgroupSegmentation(records, 'ageBand');
    // string sort ascending: '30-49' < '50-69' < '70+' < '<30'
    expect(groups.map((g) => g.key)).toEqual(['30-49', '50-69', '70+', '<30']);
    const byKey = new Map(groups.map((g) => [g.key, g]));
    expect(byKey.get('<30')!.count).toBe(1);
    expect(byKey.get('30-49')!.count).toBe(2); // ages 45, 30
    expect(byKey.get('50-69')!.count).toBe(1); // age 65
    expect(byKey.get('70+')!.count).toBe(2); // ages 80, 70
  });

  it('routes missing/unknown metadata and non-segmentation records to unknown/exclusion', () => {
    const records: BenchmarkRecord[] = [
      rec('u1', {}, [seg(0.4, 0.2, 5)], 10),
      rec('u2', { modality: 'CT' }, [seg(0.8, 0.6, 3)], 30),
    ];
    // A classification record must be ignored entirely.
    const classRecord: BenchmarkRecord = {
      ...rec('c1', { modality: 'CT' }, [seg(0.9, 0.9, 1)], 999),
      task: 'classification',
      segmentation: undefined,
    };
    const groups = subgroupSegmentation([...records, classRecord], 'modality');
    expect(groups.map((g) => g.key)).toEqual(['CT', 'unknown']);
    const byKey = new Map(groups.map((g) => [g.key, g]));
    expect(byKey.get('CT')!.count).toBe(1); // classification excluded
    expect(byKey.get('CT')!.meanInferMs).toBeCloseTo(30, 10);
    expect(byKey.get('unknown')!.count).toBe(1);
    expect(byKey.get('unknown')!.meanDice).toBeCloseTo(0.4, 10);
  });

  it('yields NaN means when a group has no finite metric values', () => {
    const records: BenchmarkRecord[] = [
      rec('n1', { sex: 'F' }, [seg(NaN, NaN, NaN)], 20),
    ];
    const groups = subgroupSegmentation(records, 'sex' satisfies SubgroupKey);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe('F');
    expect(Number.isNaN(groups[0]!.meanDice)).toBe(true);
    expect(Number.isNaN(groups[0]!.meanIou)).toBe(true);
    expect(Number.isNaN(groups[0]!.meanHd95Mm)).toBe(true);
    // inferMs is finite, so it still averages.
    expect(groups[0]!.meanInferMs).toBeCloseTo(20, 10);
  });

  it('splits by contrast flag into contrast / non-contrast / unknown', () => {
    const records: BenchmarkRecord[] = [
      rec('x', { contrast: true }, [seg(0.9, 0.8, 1)], 10),
      rec('y', { contrast: false }, [seg(0.7, 0.6, 1)], 10),
      rec('z', {}, [seg(0.5, 0.4, 1)], 10),
    ];
    const groups = subgroupSegmentation(records, 'contrast');
    expect(groups.map((g) => g.key)).toEqual(['contrast', 'non-contrast', 'unknown']);
  });
});
