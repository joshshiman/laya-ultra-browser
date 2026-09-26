# README hero. The full flow is in docs/architecture.png.
#
# Two rows with no shared node labels, on purpose. A single connected chain laid out
# left-to-right comes out around 23:1 and renders as an unreadable strip at README
# width; two disconnected rows land near 3:1 and stay legible. Giving row 2 its own
# first node is the cost of that, so it opens with "Then" to carry the sequence.
#
# The sketchy look comes from the borders, so the fills are left solid. Cross-hatching
# on top of a sketchy border reads as noise and costs legibility at README width.
#
# Blue is the local model. It ranks, and that is all it ever does: it never touches
# the page and never decides an action worked. Amber is deterministic code, which
# acts and verifies. Red is a refusal.
@direction LR
@spacing 55

(Say what you want) -> [Snapshot, piercing shadow DOM @backgroundColor:#a5d8ff @strokeColor:#1971c2] -> [Laya ranks every candidate in one local pass @backgroundColor:#a5d8ff @strokeColor:#1971c2] -> (Chosen ref, plus the runners-up @backgroundColor:#a5d8ff @strokeColor:#1971c2)

[Then resolve, write, and read the value back @backgroundColor:#ffec99 @strokeColor:#f08c00] -> {Did the value take? @backgroundColor:#fff3bf @strokeColor:#f08c00} -> "yes" -> (verified: true, safe to report)

{Did the value take? @backgroundColor:#fff3bf @strokeColor:#f08c00} -> "no" -> [FAILED, with the reason and the fields you could have meant @backgroundColor:#ffc9c9 @strokeColor:#e03131]
