# Autopilot Candidate Action Service Contract

Coordinates automatic candidate patch application and candidate-round recovery. Patch application delegates to the injected command executor; recovery generates the stable continuation goal and delegates to `startMainRound`. Inputs and outputs remain transport-neutral state objects.
