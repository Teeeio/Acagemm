# Round Artifact Guard Contract

Ensures strict-zero-source Missions have a Materializer-produced `baseline.run.py` before an Iteration Agent starts. Non-strict Missions pass through. Missing artifacts raise `ITERATION_BASELINE_ARTIFACT_MISSING` with HTTP status 409. The guard is pure and does not access persistence or HTTP.
