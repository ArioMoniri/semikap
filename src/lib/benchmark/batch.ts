/**
 * A single batch case: an image optionally paired with a ground-truth mask,
 * keyed by a normalized basename stem.
 */
export interface BatchCase {
  caseId: string;
  imageName: string;
  referenceName?: string;
}

/**
 * Imaging file extensions stripped by {@link basenameStem}, longest first so
 * that compound extensions (e.g. `.nii.gz`) are matched before their suffixes.
 */
const IMAGING_EXTENSIONS: readonly string[] = [
  '.nii.gz',
  '.nii',
  '.nrrd',
  '.nhdr',
  '.mha',
  '.mhd',
  '.dcm',
  '.dicom',
  '.gz',
];

/** Trailing ground-truth suffixes stripped by {@link basenameStem}. */
const GT_SUFFIXES: readonly string[] = [
  '_seg',
  '_mask',
  '_gt',
  '_label',
  '_labels',
  '-seg',
  '-mask',
  '-gt',
  '-label',
];

/**
 * Reduce a file name or path to its comparison stem: strip any directory,
 * strip a trailing imaging extension (case-insensitively), then strip a single
 * trailing ground-truth suffix (case-insensitively).
 *
 * @param name - A file name or path (POSIX or Windows separators).
 * @returns The normalized stem.
 */
export function basenameStem(name: string): string {
  // Strip directory: take the segment after the last '/' or '\\'.
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  let stem = slash >= 0 ? name.slice(slash + 1) : name;

  // Strip a single trailing imaging extension (case-insensitive).
  const lower = stem.toLowerCase();
  for (const ext of IMAGING_EXTENSIONS) {
    if (lower.endsWith(ext) && lower.length > ext.length) {
      stem = stem.slice(0, stem.length - ext.length);
      break;
    }
  }

  // Strip a single trailing ground-truth suffix (case-insensitive).
  const stemLower = stem.toLowerCase();
  for (const suffix of GT_SUFFIXES) {
    if (stemLower.endsWith(suffix) && stemLower.length > suffix.length) {
      stem = stem.slice(0, stem.length - suffix.length);
      break;
    }
  }

  return stem;
}

/**
 * Pair image files with optional ground-truth mask files by their
 * {@link basenameStem}. Each image becomes one {@link BatchCase} whose
 * `caseId` is its stem; the first mask sharing that stem supplies
 * `referenceName`, otherwise it is left undefined. Duplicate image stems are
 * deduplicated (first occurrence wins) and image order is preserved.
 *
 * @param imageNames - Image file names or paths.
 * @param maskNames - Candidate ground-truth mask file names or paths.
 * @returns One batch case per distinct image stem, in image order.
 */
export function pairImagesAndMasks(
  imageNames: readonly string[],
  maskNames: readonly string[],
): BatchCase[] {
  // Index the first mask seen for each stem.
  const maskByStem = new Map<string, string>();
  for (let i = 0; i < maskNames.length; i++) {
    const mask = maskNames[i]!;
    const stem = basenameStem(mask);
    if (!maskByStem.has(stem)) {
      maskByStem.set(stem, mask);
    }
  }

  const cases: BatchCase[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < imageNames.length; i++) {
    const image = imageNames[i]!;
    const caseId = basenameStem(image);
    if (seen.has(caseId)) {
      continue;
    }
    seen.add(caseId);
    const referenceName = maskByStem.get(caseId);
    const batchCase: BatchCase =
      referenceName === undefined
        ? { caseId, imageName: image }
        : { caseId, imageName: image, referenceName };
    cases.push(batchCase);
  }

  return cases;
}
