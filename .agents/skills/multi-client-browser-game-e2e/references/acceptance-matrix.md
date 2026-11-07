# Multi-client acceptance matrix

Adapt these rows to the feature. Each row should produce a named check with a
boolean result and diagnostic detail.

## Setup and identity

| Check | Positive signal | Common failure |
|---|---|---|
| Static server ready | Actual ephemeral URL parsed | Hardcoded port or race |
| Realtime service ready | Actual ephemeral port parsed | Connecting before listen |
| Browser ready | DevTools endpoint parsed | Browser exits or profile is locked |
| App ready | `automation.ready` resolves | Boot error or missing asset |
| Client identity | Unique player ID/name per page | Shared profile/session |
| Room membership | Expected roster on every page | Stale roster or cross-room leak |

## Presence and movement

| Check | Positive signal | Common failure |
|---|---|---|
| Self mapping | Each page sees N-1 remotes, not itself | Self included or wrong ID |
| Initial positions | Remote screen/ground positions match expected | Camera applied twice |
| Movement | Position changes in the expected direction | Input not reaching page |
| Smoothness | Intermediate samples exist for a multi-pixel step | Only final state observed |
| Facing/flip | Facing changes and mirrored atlas is correct | Frame mapping wrong |
| Vertical movement | Y changes without breaking footpoint | Camera-space Y published |
| Idle | Stable position and idle frame | Drift or stale animation |

## Worlds and transitions

| Check | Positive signal | Common failure |
|---|---|---|
| Same world | Actors visible on matching map/layout/variant | Identity compares too few fields |
| Different world | Actors hidden, roster retained | Actor remains or member disappears |
| Transition start | Loading/pose-null hides actor | Old pose lingers |
| Epoch change | New world snaps without sliding | History crosses epoch |
| Return | Actor restored without duplicate IDs | Stale history or duplicate roster |
| Unsupported view | Actors hidden | Fail-open rendering |
| Feature disabled | Game boots and moves, no connection | Presence is mandatory |

## Capacity, isolation and recovery

| Check | Positive signal | Common failure |
|---|---|---|
| Capacity | Fifth client rejected with expected code | Over-admission |
| Existing clients | First four remain healthy after rejection | Rejection closes room |
| Room isolation | Second room sees only its members | Global broadcast |
| Save isolation | Distinct profile keys/storage | Shared localStorage |
| Save integrity | Network failure does not mutate save | Remote path writes save |
| Reconnect | Same identity resumes, old generation fenced | Duplicate actor |
| Resume expiry | Clear terminal error, no silent room creation | Infinite retry |
| Presenter/GPU loss | Renderer recreates, presence survives | Runtime stops or actors vanish |
| Explicit leave | Member removed immediately | Reconnect reservation remains |

## Evidence

| Check | Positive signal |
|---|---|
| Summary | `summary.json` contains names and bools for every check |
| Screenshots | Named images at meaningful checkpoints |
| Logs | Console and page exceptions captured |
| Failure detail | Last observed state attached to the failed check |
| Cleanup | Browser, servers and temp profiles removed |
| Honesty | Report lists loopback/one-process/soak/latency limitations |

## Negative-test discipline

- A negative check needs a positive counter-signal. For example, assert the fifth
  client was rejected **and** the first four still have a full roster.
- A capacity test must use a room that is actually full, not a malformed handshake.
- A room-isolation test must create a second real room, not simply omit `join`.
- A storage-isolation test must inspect the actual storage key or observe a
  cross-client write, not just assume separate contexts.
- A reconnect test must distinguish a dropped socket from an explicit leave.
