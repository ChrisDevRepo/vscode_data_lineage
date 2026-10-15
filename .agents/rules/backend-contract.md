# Hop backend contract (BB and CT)

This file is the single definition of what the engine does with a hop submission. Other documents link here instead of restating it.

## ACK or REJECT

- The engine guards a submission with deterministic checks only. Every submission gets ACK (commit) or REJECT (nothing committed). There is no third outcome and no silent change.
- Tool arguments keep their supplied types and content. Object references must copy exact IDs from metadata; aliases, changed casing, invisible-character stripping and numeric or JSON-string coercion are not accepted repairs. Invalid input is returned to the agent with its field path.
- A check never interprets SQL and never rejects on an assumption, such as "the answer looks truncated" or "this column only filters". It checks that the named objects and columns are valid and connected.
- Every REJECT names the rule broken, the failing path and a self-repair hint. Each repeat of the same step adds detail. The step ends as a logged error only when its reply limit is spent.
- A REJECT holds the valid parts of the submission. The hint lists `Held:` and `Resend:` parts; a resent part replaces its held value whole.
- A fault the model cannot correct (engine state changed under a queued task, a thrown exception) stops the run as a logged error. Anything the model can correct is a REJECT, never a stop.
- Whatever the engine does besides ACK or REJECT (routing, deferral, removal) is written to the debug log at least.

## CT checks

A `column_flow` reference passes when all three hold; any failure is a REJECT:

1. **Target.** The referenced object is a loaded neighbour of the focus, is not removed, and is inside the approved scope. An object outside the scope (excluded, out of direction or beyond depth) is rejected as `column_out_of_scope`: remove the reference, record the finding in `sections`, and name the object in `questions`, which keeps it as a follow-up question.
2. **Attribute.** For an object type that carries column metadata, the column is one of its declared columns, even when its name resembles a SQL literal. Procedures and external objects carry none, so their columns are accepted and the debug log says they were not verified. Procedure output names are not inferred from inbound columns or interpreted as SQL expressions.
3. **Link.** The mapping connects to one of the hop's qualified input columns (the requested root on the origin, the task's endpoints afterwards), directly or through another mapping in the same submission. A procedure that writes a table and reads it back declares that internal write on its first visit (`out_col` names the written column), because a visited object is not visited again.

The engine stores an accepted mapping exactly as declared, including the model's `transforms`. It does not drop or reject a contributor because of how the SQL uses it; which columns count as contributors is defined only in the prompt.

## Events

- A SQL-hop submission has one findings shape, with no model-authored verdict. Every open neighbor admitted for investigation, including a queued neighbor, needs a question or prune decision, else REJECT (`missing_task_decision`). A column mapping supplies trace context, not the neighbor's investigation purpose.
- The engine visits tables and external storage without a model call, keeps their metadata in the result and forwards the incoming question in the approved direction. In CT it carries qualified stored endpoints as unconfirmed candidates to each eligible writer upstream or reader downstream, without creating value edges. Missing SQL on a view, procedure or function is unavailable evidence, not automatic storage forwarding.
- Only an exact depth limits routing. An eligible neighbor beyond it becomes a follow-up; a CT mapping beyond it is rejected (`column_out_of_scope`). Exclusions and the approved direction apply at every automatic forwarding step. A visited or removed neighbor receives no new work; the reason is logged.
- Forwarded columns are candidates. The next object is asked whether it writes (upstream) or uses (downstream) them at all, not told to map them: a mapped candidate continues; an unmapped one ends at that object (debug log), without a REJECT. Example: procedure A writes table B, B passes through, procedure C reads B. C maps the B columns it uses; the others end at C. The scheduler visits an object only after every unfinished object that can reach it, so a candidate reaches a visited object only inside a cycle; it ends there (debug log), because that object declared its read-back writes on its first visit.
- An endpoint assigned by a direct mapping is the model's own claim. When some of a hop's assigned endpoints continue, every other one needs a mapping or a `terminated_inputs` entry, else REJECT. At an ordinary non-origin hop without scalar caller-output targets, an empty `column_flow` ends all arriving traces; origin and scalar caller-output tasks retain their explicit target-accounting checks.
- `prune_neighbors` and `lineage_prune_current` are explicit events. Only a SQL node reached solely through storage forwarding may prune itself; direct/root work and committed mappings remain protected. A refused `prune_neighbors` target (unknown, origin, visited, analyzed, queued or already removed) rejects the whole submission; the agent must explicitly correct the list, including `[]` to withdraw it. A prune is rejected when the named node is outside the approved scope or when removing it would disconnect committed analysis from the origin. Column endpoints in the same submission, including held mappings restored during repair, are protected before a prune commits; later prune resolution preserves committed endpoints too.
- A follow-up naming a table or external storage uses the same automatic forwarding path to its next eligible objects in the approved direction, so its question reaches SQL instead of ending at the table. A follow-up admits its objects into the approved scope whatever the depth. A next object that is pruned or outside the border is not added (debug log); only naming it restores it.
- The engine never rebuilds column lineage from historical edges, matching names or prose. A queued task dispatches with the endpoints it was accepted with.
