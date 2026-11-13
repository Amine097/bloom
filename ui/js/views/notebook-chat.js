// Notebook tab "Ask": not built yet.
// A Notebook tab is { id, label, render(lectureId), actions, onKey?(event, lectureId) }; see notebook.js.

export const chatTab = {
  id: "chat",
  label: "Ask",
  render: () => `<section class="card"><div class="card-b"><p class="muted">Asking questions about the PDF is coming soon.</p></div></section>`,
  actions: {},
};
