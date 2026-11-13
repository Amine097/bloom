// Notebook tab "Flashcards": not built yet.
// A Notebook tab is { id, label, render(lectureId), actions, onKey?(event, lectureId) }; see notebook.js.

export const cardsTab = {
  id: "cards",
  label: "Flashcards",
  render: () => `<section class="card"><div class="card-b"><p class="muted">Flashcards are coming soon.</p></div></section>`,
  actions: {},
};
