import type { BenchmarkTask } from '../datasets/manifest';

/**
 * A versioned, lockable benchmark definition binding a dataset, a set of model
 * hashes, and metric configuration (Phase 4).
 */
export interface BenchmarkDefinition {
  schema: 'tamias.benchmarkdef.v1';
  id: string;
  name: string;
  version: string;
  task: BenchmarkTask;
  datasetName: string;
  modelHashes: string[];
  metricConfig: { surface: boolean };
  locked: boolean;
  createdAt: string;
}

const VALID_TASKS: readonly BenchmarkTask[] = ['segmentation', 'classification'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new TypeError(`BenchmarkDefinition.${key} must be a string`);
  }
  return value;
}

/**
 * Parse an unknown value into a BenchmarkDefinition, throwing precise TypeErrors
 * when the schema, task, model hashes, or boolean fields are invalid.
 */
export function parseBenchmarkDefinition(raw: unknown): BenchmarkDefinition {
  if (!isObject(raw)) {
    throw new TypeError('BenchmarkDefinition must be an object');
  }
  if (raw['schema'] !== 'tamias.benchmarkdef.v1') {
    throw new TypeError("BenchmarkDefinition.schema must be 'tamias.benchmarkdef.v1'");
  }
  const id = requireString(raw, 'id');
  const name = requireString(raw, 'name');
  const version = requireString(raw, 'version');
  const task = raw['task'];
  if (typeof task !== 'string' || !VALID_TASKS.includes(task as BenchmarkTask)) {
    throw new TypeError("BenchmarkDefinition.task must be 'segmentation' or 'classification'");
  }
  const datasetName = requireString(raw, 'datasetName');

  const modelHashes = raw['modelHashes'];
  if (!Array.isArray(modelHashes) || modelHashes.length === 0) {
    throw new TypeError('BenchmarkDefinition.modelHashes must be a non-empty array');
  }
  for (let i = 0; i < modelHashes.length; i++) {
    if (typeof modelHashes[i] !== 'string') {
      throw new TypeError(`BenchmarkDefinition.modelHashes[${i}] must be a string`);
    }
  }

  const metricConfig = raw['metricConfig'];
  if (!isObject(metricConfig) || typeof metricConfig['surface'] !== 'boolean') {
    throw new TypeError('BenchmarkDefinition.metricConfig.surface must be a boolean');
  }

  const locked = raw['locked'];
  if (typeof locked !== 'boolean') {
    throw new TypeError('BenchmarkDefinition.locked must be a boolean');
  }

  const createdAt = requireString(raw, 'createdAt');

  return {
    schema: 'tamias.benchmarkdef.v1',
    id,
    name,
    version,
    task: task as BenchmarkTask,
    datasetName,
    modelHashes: (modelHashes as string[]).slice(),
    metricConfig: { surface: metricConfig['surface'] },
    locked,
    createdAt,
  };
}

/**
 * Return an immutable copy of the definition with locked set to true, leaving
 * the input definition unchanged.
 */
export function lockDefinition(def: BenchmarkDefinition): BenchmarkDefinition {
  return { ...def, locked: true };
}
