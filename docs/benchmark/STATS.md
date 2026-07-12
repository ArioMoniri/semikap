# Corrected statistical tests for model comparison

Adapted from the [`correctR`](https://hendersontrent.github.io/correctR/) R package
(Henderson & Trent). When two models are compared on **resampled** data (CV folds
or repeated train/test splits), the per-fold performance differences are **not
independent** — folds share training data — so a naïve paired t-test
under-estimates the variance and inflates the Type-I error rate. These tests
apply the **Nadeau & Bengio (2003)** variance correction.

Let `d = (d₁ … d_m)` be the per-resample differences between model A and model B
for a chosen metric (e.g. `Dice_A(caseᵢ) − Dice_B(caseᵢ)`). Let `μ = mean(d)` and
`s² = var(d)` (unbiased, n−1 denominator). All tests use a Student-t reference.

### 1. Corrected resampled t-test — `resampledTtest(d, n1, n2)`
For repeated random train/test splits. `n1` = training-set size, `n2` = test-set size, `n = |d|`.

```
t  = μ / sqrt( s² · (1/n + n2/n1) )
df = n − 1
```

### 2. Corrected k-fold CV t-test — `kfoldTtest(d, k)`
For k-fold cross-validation. `k` = number of folds, `n = |d|`.

```
t  = μ / sqrt( s² · ((1/n + 1/k) / (1 − 1/k)) )
df = n − 1
```
(Correction taken verbatim from the correctR source: `(1/n + 1/k)/(1 − 1/k)`.)

### 3. Corrected repeated k-fold CV t-test — `repeatedKfoldTtest(d, k, r, n1, n2)`
For repeated k-fold CV. `k` = folds, `r` = repeats, `n1`/`n2` = train/test sizes.

```
t  = μ / sqrt( s² · (1/(k·r) + n2/n1) )
df = k·r − 1
```

### p-values
- Two-tailed: `p = 2 · P(T ≤ −|t|) = I_x(df/2, 1/2)` with `x = df/(df + t²)`
  (via the regularized incomplete beta function — no external dependency).
- One-tailed (H₁: A > B): `p = 1 − P(T ≤ t)`.

## Additional comparison methods

Beyond the correctR corrected t-tests, the suite also implements the methods most
used for comparing radiology-AI models (all pure, all pinned to SciPy/reference
values in `tests/`):

- **DeLong's test** (`roc-compare.ts`) — compares two **correlated ROC AUCs** on
  the same cases (the medical-imaging standard). Fast midrank algorithm; z-test.
  DeLong, DeLong & Clarke-Pearson (1988); Sun & Xu (2014).
- **McNemar's test** (`paired-tests.ts`) — paired correct/incorrect at a
  threshold; exact binomial (b+c<25) or χ² with continuity correction. Recommended
  by Dietterich (1998) for classifier comparison.
- **Wilcoxon signed-rank** — non-parametric paired test (normal approximation,
  tie + continuity correction).
- **Permutation (sign-flip) test** — exact for n≤18, seeded Monte-Carlo otherwise.
- **Bootstrap CI** — percentile CI + p-value for a mean paired difference (seeded).
- **Bayesian correlated t-test** (`bayesian.ts`) — Benavoli, Corani, Demšar &
  Zaffalon (2017): posterior P(A worse) / P(equivalent, via a ROPE) / P(A better),
  using the same Nadeau-Bengio correlation correction.

### References
- Nadeau, C. & Bengio, Y. (2003). *Inference for the Generalization Error.* Machine Learning 52, 239–281.
- Bouckaert, R. & Frank, E. (2004). *Evaluating the Replicability of Significance Tests for Comparing Learning Algorithms.* PAKDD.
- DeLong, E. R., DeLong, D. M. & Clarke-Pearson, D. L. (1988). *Comparing the Areas under Two or More Correlated ROC Curves.* Biometrics 44, 837–845.
- Sun, X. & Xu, W. (2014). *Fast Implementation of DeLong's Algorithm.* IEEE SPL 21(11).
- Dietterich, T. G. (1998). *Approximate Statistical Tests for Comparing Supervised Classification Learning Algorithms.* Neural Computation 10(7).
- Benavoli, A., Corani, G., Demšar, J. & Zaffalon, M. (2017). *Time for a Change: a Tutorial for Comparing Multiple Classifiers Through Bayesian Analysis.* JMLR 18.
- Henderson, T. (2023). *correctR.* https://hendersontrent.github.io/correctR/

All local / on-device — the on-prem invariant guard covers `src/lib/stats/`.
