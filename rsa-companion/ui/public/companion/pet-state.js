/* Static poses only. Interaction > visible activity > chosen pose > idle. */
function createPetState(render, clock = () => Date.now()) {
  let activity = null, chosen = null, effect = null, interaction = null;
  let touched = clock(), until = 0;
  function current() {
    if (interaction && clock() < until) return { state: interaction, effect: interaction === '14-petted' ? 'fx-heart' : null };
    if (activity) return activity;
    if (chosen) return { state: chosen, effect };
    const age = clock() - touched;
    return { state: age >= 120000 ? '05-sleep' : age >= 90000 ? '04-drowsy' : age >= 30000 ? '02-perch' : '01-idle', effect: age >= 120000 ? 'fx-sleep' : effect };
  }
  const refresh = () => render(current());
  return {
    refresh,
    touch() { touched = clock(); refresh(); },
    interact(state, duration = 1800) { touched = clock(); interaction = state; until = clock() + duration; refresh(); },
    choose(state, nextEffect = null) { chosen = state; effect = nextEffect; touched = clock(); interaction = null; refresh(); },
    activity(input) {
      if (!input) activity = null;
      else {
        const block = input.block;
        if (block?.status === 'error' || input.status === 'error') activity = { state: '11-failure', effect: 'fx-sweat' };
        else if (block?.kind === 'thinking') activity = { state: '07-think', effect: 'fx-question' };
        else if (block?.kind === 'tool') activity = { state: block.status === 'complete' ? '10-success' : '08-operate', effect: block.status === 'complete' ? 'fx-stars' : null };
        else activity = { state: '06-observe', effect: null };
      }
      touched = clock(); refresh();
    },
  };
}
