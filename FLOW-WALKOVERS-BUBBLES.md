# Flow contract: walkovers and dismissible bubbles

Accepted by: pm. Two journeys Mac can see on the floor. Every step names what a
person does and the rule that decides whether the step passed.

## Journey A — one agent walks a message to another

A1. An agent sends a message to another agent.
    Pass: within one second the sender stands up and starts crossing the floor
    toward the other agent's desk. Fail: the sender stays seated, or a bubble
    appears with nobody moving.

A2. Mac watches the sender cross the floor.
    Pass: the sender moves continuously and stops beside the other desk, not
    inside it or on top of the other agent. Silence while walking is correct.

A3. The sender arrives and speaks.
    Pass: exactly one bubble appears, anchored to the sender's head, naming the
    receiver and showing the message. It stays long enough to read.

A4. The sender returns.
    Pass: the bubble disappears when the sender leaves, the sender walks back
    and sits in their own chair, and no bubble is left floating over an empty
    chair.

A5. A second message is sent while the first walk is running.
    Pass: the second walk waits. Only one agent crosses the floor at a time.
    The waiting message runs after the first sender is seated.

A6. The same message from the same sender to the same receiver arrives again
    while that walk is still running or still on screen.
    Pass: nothing new happens. One walk, not two.

A7. The same message arrives again after that walk has finished and the sender
    is seated.
    Pass: the walk plays again. A repeated instruction is a real event and Mac
    must see it. Rule: only an in-flight or just-finished duplicate is dropped;
    a duplicate after the room is still again replays.

A8. Mac points at any agent while a walk is running.
    Pass: the room shows that agent's own current line instead. The walk keeps
    running underneath. Moving the pointer away restores the walking agent's
    bubble if the sender is still speaking.

A9. An agent goes off duty, or its run ends, mid-walk.
    Pass: the walk stops, the bubble closes, and the agent returns to its chair.
    No frozen agent standing at someone else's desk.

## Journey B — Mac closes a bubble

B1. Mac looks at any bubble on the floor.
    Pass: the bubble carries a visible close control at all times, not only on
    hover. It is reachable by keyboard.

B2. Mac clicks the close control.
    Pass: that one bubble disappears immediately. No other bubble changes. The
    agent keeps working and the feed is not opened.

B3. Mac clicks the body of a bubble instead.
    Pass: the agent's feed opens. Closing and opening must not share a target.

B4. The same agent produces a newer line after Mac closed its bubble.
    Pass: the new line shows. Dismissal hides one message, not the agent.

B5. Mac closes the bubble of an agent that is mid-walk.
    Pass: the bubble disappears and the walk still finishes normally.

B6. Mac closes a bubble, then the agent stops or goes off duty.
    Pass: nothing reappears. A closed bubble never returns for the same message.

B7. Mac presses Escape.
    Pass: every bubble currently on screen closes. The room keeps running.

B8. Mac reloads the page.
    Pass: closed bubbles stay closed for messages that are already old. Live
    current work speaks again.

## Rules that hold across both journeys

- One walk at a time. Everything else waits in the order it arrived.
- One bubble owner at a time: pointer first, then the walking speaker, then
  each working agent.
- A bubble follows its agent's body, never the chair it left.
- A message that cannot be acted out is never queued: no agent walking to
  itself, no empty message.
- Nothing on this floor shows the last thing a stopped agent said.

## Gate for the next stage

Coding may start. Each step above is the acceptance rule for it. A step is done
only when it is shown on the running floor, not when the code exists.

## Journey C — a hero walks a visible message to Mac (this mission)

Scope: only messages a person can already see in the room. Silent internal
chatter, empty text, and status noise never start a walk. This journey is the
sole acceptance source for the current mission. Journeys A and B stay as
written and are not reopened here.

C1. A hero produces a visible message during normal MINIMAC use.
    Pass: within one second that hero stands and starts walking toward Mac.
    Fail: the hero stays seated, or a bubble appears with nobody moving.

C2. Mac watches the hero cross the floor.
    Pass: the hero moves without stopping and halts beside Mac, not on top of
    Mac and not inside furniture. No bubble while walking.

C3. The hero arrives.
    Pass: exactly one bubble appears, anchored to that hero's head, showing the
    message text, readable and on screen long enough to finish reading.

C4. The hero returns.
    Pass: the bubble closes as the hero leaves, the hero walks back and sits in
    its own chair, and no bubble is left over an empty chair.

C5. Two or more heroes send visible messages close together.
    Pass: one hero crosses at a time. The others wait and then play in the
    order their messages arrived. No two heroes walk at once and none is
    skipped.

C6. The same message from the same hero arrives again while its walk is
    running or its bubble is still on screen.
    Pass: nothing new happens. One walk, not two.

C7. The same message arrives again after that walk finished and the hero is
    seated.
    Pass: the walk plays again. A repeat after the room is still is a real
    event Mac must see.

C8. A hero stops, goes off duty, or its run ends mid-walk.
    Pass: the walk ends, the bubble closes, the hero returns to its chair, and
    the next waiting message starts. No hero frozen in the open floor.

C9. A message arrives that belongs to an old or already finished run.
    Pass: it is ignored. Nothing walks for it.

C10. Mac uses MINIMAC normally for several minutes with heroes working.
    Pass: every visible message ends in a seated hero and an empty floor. The
    queue never stalls, never plays the same walk twice, and never leaves a
    hero standing with no bubble.

### Gate for this mission

Coding may start on Journey C. A step counts only when Mac can see it on the
running floor.
