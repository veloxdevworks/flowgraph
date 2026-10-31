---
"@flowgraph/core": minor
"@flowgraph/spec": minor
---

Subgraph merge-back is explicit and uses the parent's reducer on the child's new values. This is a breaking change for graphs that relied on copying the child's whole state into the parent.

### What to change

- `stateMap.out` keys are parent channels and values are child channels (`result: draft` writes the child's `draft` into the parent's `result`). If validate reports `UNDECLARED_OUTPUT_CHANNEL` on the name you meant as the child channel, swap the pair.
- With no `stateMap.out`, only channels that share a name merge. The child's `outputs` bag and child-only channels are not copied. Name the channel on the parent, or map it in `stateMap.out`.
- Inside `map`, the item is the value the child produced (one changed channel, or an object of them), not the whole child state. Point `collect` at that value.
- `append`, `merge`, and `messages` receive only what the child added or edited. A list that used to repeat the parent's seed will not. An unchanged copy is still written when `stateMap.out` targets a different parent channel than the one that seeded the child.
- A missing message id is removed only when the child channel uses the messages reducer. An `array`, `append`, or undeclared child that returns only its reply appends that reply. An explicit `RemoveMessage` is still applied. Two parallel removals of the same id remove it once. If one sibling removes an id and another edits it, node-id order applies and the later sibling wins.
- An unchanged last-write value is not written back, so a parallel sibling that writes the same channel wins. Use `append` or `merge` when both branches must keep a contribution.
- `append` cannot drop items. A child that shortens a list leaves the missing entries in place, and does not append the entries it kept.
- A `custom:` reducer still receives the child's full value. If that value already includes the seed, an additive reducer counts the seed twice. Return only the delta from the child, or map the result onto a last-write channel.
