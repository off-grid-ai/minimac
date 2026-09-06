// The middleware. Everything an agent is told is assembled here, by an ordered
// list of named steps, so there is one place to see what a dispatch contains
// and one place to change it.
//
// A step is a pure function: (context) -> string | null. Returning null means
// the step contributes nothing to this dispatch. Steps never mutate context.
//
// Custom steps are ordinary modules dropped into `middleware/`, so a rule you
// want on every message is a file, not an edit to this one.

export function createPipeline(steps) {
  const ordered = steps.filter((step) => typeof step?.render === 'function');

  return {
    names() {
      return ordered.map((step) => step.name);
    },

    // The dispatch text, plus the record of which steps actually spoke - the
    // UI can show exactly what an agent was told and by whom.
    compose(context) {
      const parts = [];
      for (const step of ordered) {
        let text = null;
        try {
          text = step.render(context);
        } catch {
          text = null; // a broken step must never take the dispatch down
        }
        if (typeof text === 'string' && text.trim()) {
          parts.push({ name: step.name, text: text.trim() });
        }
      }
      return {
        text: parts.map((part) => part.text).join('\n\n---\n\n'),
        applied: parts.map((part) => part.name),
      };
    },

    // Steps may also transform a follow-up message (a steer), which is how a
    // standing instruction rides on every message rather than only the first.
    decorate(text, context) {
      let out = text;
      for (const step of ordered) {
        if (typeof step.decorate !== 'function') continue;
        try {
          out = step.decorate(out, context) ?? out;
        } catch {
          // leave the message as it was
        }
      }
      return out;
    },
  };
}

export function defineStep(name, render, decorate) {
  return { name, render, decorate };
}
