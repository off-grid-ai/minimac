import {
  createEscalationEvent,
  createLeaseEvent,
  createOrderEvent,
  createPeerMessageEvent,
  ESCALATION_STATE,
} from '../core/coordination.mjs';

export function createFleetCoordination({ getEvents, emit, deliver, orchestratorId }) {
  const delivered = new Set(
    getEvents().filter((event) => event.kind === 'order').map((event) => event.payload?.key).filter(Boolean),
  );
  let sequence = getEvents().filter((event) => event.kind === 'escalation').length;

  function order(spec) {
    const event = createOrderEvent(spec);
    if (delivered.has(event.payload.key)) return { event, duplicate: true };
    delivered.add(event.payload.key);
    emit(event);
    return { event, duplicate: false };
  }

  async function escalate(spec) {
    sequence += 1;
    const event = createEscalationEvent({
      ...spec,
      id: spec.id ?? `e${sequence}`,
      toAgentId: orchestratorId(),
    });
    emit(event);
    await deliver(event.payload.toAgentId, escalationBrief(event.payload), { wake: true });
    return event.payload;
  }

  async function message(spec) {
    const event = createPeerMessageEvent(spec);
    await deliver(event.payload.toAgentId, event.payload.text, { wake: false });
    emit(event);
    return event.payload;
  }

  function resolve(id, resolution) {
    const raised = [...getEvents()].reverse().find(
      (event) => event.kind === 'escalation' && event.payload?.id === id,
    );
    if (!raised) return { error: `no escalation ${id}` };
    const event = createEscalationEvent({
      ...raised.payload,
      state: ESCALATION_STATE.RESOLVED,
      resolution,
    });
    emit(event);
    return { escalation: event.payload };
  }

  function lease(agentId, payload) {
    const event = createLeaseEvent(agentId, payload);
    emit(event);
    return event.payload;
  }

  return Object.freeze({ order, escalate, message, resolve, lease });
}

function escalationBrief(item) {
  return [
    `# Escalation ${item.id}`,
    item.checkpointId ? `Checkpoint: ${item.checkpointId}` : null,
    `Needs: ${item.needs}`,
    item.why,
    item.involvedAgentId ? `Avenger involved: ${item.involvedAgentId}` : null,
    item.receipt ? `Receipt: ${item.receipt}` : null,
  ].filter(Boolean).join('\n');
}
