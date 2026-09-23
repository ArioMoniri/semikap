#!/usr/bin/env python3
"""Expand scripts/bench/matrix.json into the benchmark job matrix.

  plan_matrix.py --cases data/cases.csv   -> {"include": [...]} for the bench job (stdout)

Each run (model group x dataset) is cut into shards of casesPerJob cases, in the order of
the dataset's rows in cases.csv (written by make_cases_csv.py after QC).
"""
import argparse, csv, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MATRIX = os.path.join(HERE, "..", "matrix.json")
MAX_JOBS = 256  # GitHub Actions matrix limit


def matrix(spec, rows):
    if spec.get("include"):
        return {"include": spec["include"]}
    jobs = []
    for run in spec["runs"]:
        ds, per = run["dataset"], run["casesPerJob"]
        cases = [r["case_id"] for r in rows if r["source"] == ds]
        models = spec["groups"][run["group"]]["models"]
        for j in range(math.ceil(len(cases) / per)):
            chunk = cases[j * per:(j + 1) * per]
            jobs.append({"group": run["group"], "models": " ".join(models), "dataset": ds, "shard": f"{j:02d}",
                         "cases": ",".join(chunk), "n": len(chunk)})
    if len(jobs) > MAX_JOBS:
        sys.exit(f"{len(jobs)} jobs > GitHub's {MAX_JOBS}-job matrix limit: raise casesPerJob")
    return {"include": jobs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default="data/cases.csv")
    ap.add_argument("--matrix", default=MATRIX)
    a = ap.parse_args()
    m = matrix(json.load(open(a.matrix)), list(csv.DictReader(open(a.cases))))
    print(json.dumps(m, separators=(",", ":")))
    by = {}
    for j in m["include"]:
        k = (j.get("group", j.get("model")), j["dataset"])
        by[k] = by.get(k, 0) + 1
    print(f"{len(m['include'])} jobs: {by}", file=sys.stderr)


if __name__ == "__main__":
    main()
