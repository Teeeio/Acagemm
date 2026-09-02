# Autopilot Candidate Service Contract

Selects the candidate used by automatic iteration progression. Priority is: candidate with a patch digest, eligible/passed candidate, then first candidate. Input is persisted state; output is a candidate DTO or `null`. The selector is pure and does not mutate state or perform I/O.
