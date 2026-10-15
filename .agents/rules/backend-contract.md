# Hop backend contract (BB and CT)

This file is the single definition of what the engine does with a hop submission. Other documents link here instead of restating it.

## ACK or REJECT

- The engine guards a submission with deterministic checks only. Every submission gets ACK (commit) or REJECT (nothing committed). There is no third outcome and no silent change.
- A check never interprets SQL and never rejects on an assumption, such as "the answer looks truncated" or "this column only filters". It checks that the named objects and columns are valid and connected.
- Every REJECT names the rule broken, the failing path and a self-repair hint. Each repeat of the same step adds detail. The step ends as a logged error only when its reply limit is spent.
- A REJECT holds the valid parts of the submission. The hint lists `Held:` and `Resend:` parts; a resent part replaces its held value whole.
- A fault the model cannot correct (engine state changed under a queued task, a thrown exception) stops the run as a logged error. Anything the model can correct is a REJECT, never a stop.
- Whatever the engine does besides ACK or REJECT (routing, deferral, removal) is written to the debug log at least.

## CT checks

A `column_flow` reference passes when all three hold; any failure is a REJECT:

1. **Target.** The referenced object is a loaded neighbour of the focus, is not removed, and is inside the approved scope. An object outside the scope (excluded, out of direction or beyond depth) is rejected as `column_out_of_scope`: remove the reference, record the finding in `sections`, and name the object in `questions`, which keeps it as a follow-up question.
2. **Attribute.** For an object type that carries column metadata, the column is one of its declared columns; a literal is not a column. Procedures and external objects carry none, so their columns are accepted and the debug log says they were not verified.
3. **Link.** The mapping connects to one of the hop's qualified input columns (the requested root on the origin, the task's endpoints afterwards), directly or through another mapping in the same submission. A procedure that writes a table and reads it back declares that internal write on its first visit (`out_col` names the written column), because a visited object is not visited again.

The engine stores an accepted mapping exactly as declared, including the model's `transforms`. It does not drop or reject a contributor because of its classification (filter-only, delete-only write, metadata scalar return).

## Events

- On `analyze`, every un-queued open neighbour needs a question or a prune decision, else REJECT (`missing_task_decision`).
- Only an exact depth limits routing. Without one, the approved scope already holds every loaded object reachable in the approved direction, and a question, a passthrough or a CT mapping to a loaded neighbour is admitted and added to the scope. At an exact depth, the object beyond it becomes a follow-up, and a CT mapping to it is rejected (`column_out_of_scope`).
- Only an explicit `passthrough` forwards the incoming question, the same way in BB and CT: to every open neighbour in the approved direction (one already queued merges it; one past an exact depth becomes a follow-up). In CT it also forwards the columns as candidates: a table's stored endpoints to every writer upstream, its qualified columns to every reader downstream. Both go to the same open neighbours; a neighbour that is visited, removed, or outside the exclusion or direction border receives neither (debug log).
- Forwarded columns are candidates. The next object is asked whether it writes (upstream) or uses (downstream) them at all, not told to map them: a mapped candidate continues; an unmapped one ends at that object (debug log), without a REJECT. Example: procedure A writes table B, B passes through, procedure C reads B. C maps the B columns it uses; the others end at C. The scheduler visits an object only after every unfinished object that can reach it, so a candidate reaches a visited object only inside a cycle; it ends there (debug log), because that object declared its read-back writes on its first visit.
- An endpoint assigned by a direct mapping is the model's own claim. When some of a hop's assigned endpoints continue, every other one needs a mapping or a `terminated_inputs` entry, else REJECT; an empty `column_flow` ends them all.
- `prune_neighbors` and `lineage_prune_current` are explicit events. Only a node reached through passthrough may prune itself. A prune is rejected when the named node is outside the approved scope or when removing it would disconnect committed analysis from the origin.
- A follow-up on a table or another object without SQL also queues its next objects in the approved direction. The table passes through and forwards the follow-up question to them, so the question reaches analysed SQL instead of ending as a new follow-up. A follow-up admits its objects into the approved scope whatever the depth. A next object that is pruned or outside the border is not added (debug log); only naming it restores it.
- The engine never rebuilds column lineage from historical edges, matching names or prose. A queued task dispatches with the endpoints it was accepted with.
