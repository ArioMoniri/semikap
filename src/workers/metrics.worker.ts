/// <reference lib="webworker" />
/**
 * Metrics worker — runs segmentation scoring (including the O(surfaceA·surfaceB)
 * HD95/ASSD surface metrics) off the main thread so the UI stays responsive on
 * large volumes. Thin Comlink wrapper over the pure `scoreSegmentation` core.
 */
import * as Comlink from 'comlink';
import { scoreSegmentation, type ScoreInputs } from '../lib/metrics/score';
import type { MultiLabelResult } from '../lib/metrics/segmentation';

export interface MetricsApi {
  computeSegmentation(input: ScoreInputs): Promise<MultiLabelResult>;
}

const api: MetricsApi = {
  async computeSegmentation(input: ScoreInputs): Promise<MultiLabelResult> {
    return scoreSegmentation(input);
  },
};

Comlink.expose(api);
