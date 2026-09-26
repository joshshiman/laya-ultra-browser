# Architecture: Laya proposes, the verified layer disposes.
#
# The colour split is the point. Blue is the model, which only ever ranks and
# never touches the page. Amber is deterministic code, which acts and decides
# whether the action worked. Red is a refusal. Nothing in the blue column can
# report success, which is what makes probabilistic selection safe to use.
@direction TB
@spacing 55

(Agent wants the email field) -> [Snapshot: pierce shadow DOM, check occlusion @backgroundColor:#a5d8ff @strokeColor:#1971c2] -> [[Candidate table: every visible control @backgroundColor:#a5d8ff @strokeColor:#1971c2]] -> [Laya ranks them in one local forward pass @backgroundColor:#a5d8ff @strokeColor:#1971c2] -> [Best ref, plus the runners-up @backgroundColor:#a5d8ff @strokeColor:#1971c2]

[Best ref, plus the runners-up @backgroundColor:#a5d8ff @strokeColor:#1971c2] -> {Is it a control that takes text? @backgroundColor:#fff3bf @strokeColor:#f08c00} -> "yes" -> [Resolve the ref to the real inner control @backgroundColor:#ffec99 @strokeColor:#f08c00] -> [Write with the native value setter, fire composed events @backgroundColor:#ffec99 @strokeColor:#f08c00] -> [Read the value back off that control @backgroundColor:#ffec99 @strokeColor:#f08c00] -> {Did the value take? @backgroundColor:#fff3bf @strokeColor:#f08c00}

{Is it a control that takes text? @backgroundColor:#fff3bf @strokeColor:#f08c00} -> "no" -> [Refused before anything was written @backgroundColor:#ffc9c9 @strokeColor:#e03131]

{Did the value take? @backgroundColor:#fff3bf @strokeColor:#f08c00} -> "yes" -> (verified: true, safe to report)

{Did the value take? @backgroundColor:#fff3bf @strokeColor:#f08c00} -> "no" -> [FAILED, with the reason and the fields you could have meant @backgroundColor:#ffc9c9 @strokeColor:#e03131]

[[Candidate table: every visible control @backgroundColor:#a5d8ff @strokeColor:#1971c2]] -> "if Laya is absent" -> [Match on accessible name and role instead @backgroundColor:#ffec99 @strokeColor:#f08c00]
