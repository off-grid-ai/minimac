# Flow contract: one message, one context

Owner: Wanda (pm). Checkpoint w1.pw. Accepted version 1.
This contract is the product truth for the conversation rebuild. Code, design, test,
audit and review gates are judged against it.

## 1. What a person gets

- Each mission has exactly one Main room.
- Each checkpoint has exactly one thread, created with the checkpoint.
- A message stays in the room or thread where the person wrote it.
- A reply appears under its parent, in the parent's context, always.
- After Send the person sees sending, then delivered, then read, or failed.
- The person never opens a database to follow any of this.

## 2. Contexts (the only three)

| Context | Holds |
|---|---|
| Main room (`mission`) | the mission text, Thor's plan, mission-wide talk, hero messages, milestone cards, final summary |
| Checkpoint thread (`checkpoint`) | brief, owner, status, messages, agent output, artifacts, attachments, evidence, questions, result |
| Attention card (`decision`) | a decision or blocker, linked to the message that caused it |

An attention card is a card, not a room. It links to its source message and opens that
message in its own context.

## 3. Canonical owners

- Conversation rules and projections: `core/conversation.mjs`. One place decides context,
  recipients, delivery state, replies, reactions and agent output.
- Posting, delivery and agent replies: `application/conversations.mjs`. One service. No
  second path.
- Storage: `adapters/store.mjs` conversation events only.
- Server commands: one post command, one reply command, one reaction command.
- Screen: `ui/conversation.mjs` renders a context. `ui/composer.mjs` sends into that same
  context. The screen holds no truth of its own.

## 4. Invariants

1. Every message has exactly one context, set at Send and never changed.
2. A reply copies its parent's context. A reply with a different context is rejected.
3. Stored recipients equal the recipients the composer showed, in the same order.
4. Recipients are never empty. A mission-wide message to the room lists the room.
5. A hero click posts a visible message in the Main room, addressed to that hero.
6. Checkpoint work, output, files and evidence post to that checkpoint's thread.
7. The Main room shows one compact milestone card per checkpoint, not its work.
8. Unread counts are per context and drop to zero only when that context is opened.
9. A hidden message is announced. Filters never silently drop a new direct reply.
10. Nothing is created for backward compatibility. Superseded paths are deleted.

## 5. Delivery states a person sees

- sending: accepted, not yet handed to the recipient.
- delivered: the recipient has it.
- read: the recipient opened the context or answered.
- failed: it did not arrive, with the reason in plain words and a retry action.
- stale: the context ended before delivery. Shown as failed with the reason.

Rule: the state shown is per recipient. The message shows the weakest state of its
recipients, so a person never reads "delivered" when one recipient failed.

## 6. Busy agent acknowledgement

- A direct question to a working agent gets an acknowledgement inside 30 seconds.
- The acknowledgement says the question is seen and the current work continues.
- The full answer arrives later in the same context, as a reply to the question.
- No acknowledgement inside 30 seconds shows as failed, with a retry action.

## 7. Failure states and what the person sees

| Failure | What the person sees |
|---|---|
| Recipient offline | failed, "agent is not running", retry |
| Agent busy, no ack | failed after 30 seconds, retry |
| Reply to a deleted parent | rejected at Send, with the reason |
| Context closed | failed, "this checkpoint is closed" |
| Attachment missing | message sends, attachment shows as unavailable |
| Two sends of one message | one message only, by message id |

## 8. Removed, not kept

- The separate Feed path.
- Checkpoint comments as a separate path.
- Direct messages as a separate path.
- Separate hero chat histories.
- Summary, Detailed and Verbose modes.
- Work Unit and Stage filters in normal chat.
- A thread button on every message.

## 9. Acceptance criteria

A1. In the Main room, ask Thor a question. The person sees the message in the Main room,
the recipient named, the delivery state, and Thor's reply in the same Main room.
A2. In the Main room, ask Ironman a question. Ironman's reply appears in the same Main
room, not elsewhere.
A3. Open any checkpoint, send a message. The owner's reply appears in that thread.
A4. A checkpoint thread shows its work, files, evidence and result. The Main room shows
only a compact milestone for it.
A5. Click a hero. A visible hero message appears in the Main room.
A6. A decision and a blocker appear as cards linked to their source message.
A7. Unread counts are correct for the Main room and each checkpoint thread.
A8. A filter that hides a new direct reply says a reply is hidden.
A9. Every step above is done on screen, with no database inspection.

## 10. Out of scope

Migration of old conversations. Backward compatibility. New automated tests. Any second
MINIMAC server. Unrelated features.
