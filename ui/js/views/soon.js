// Planner and Notebook: not built yet. These pages say what is coming.
import { icon } from "../ui.js";

const page = (ic, title, lead, points) => `<header class="page-h"><div><h1>${title}</h1></div></header>
  <section class="card coming">
    <div class="coming-ic">${icon(ic, 34)}</div>
    <h2>Coming soon</h2>
    <p class="lead">${lead}</p>
    <ul>${points.map(p => `<li>${p}</li>`).join("")}</ul>
  </section>`;

export const planner = {
  render: () => page("spark", "Planner", "One button to plan your week.", [
    "Bloom reads your lectures, recalls, deadlines and to-dos",
    "It proposes a week that fits, and you adjust it",
    "It runs on your own Claude account",
  ]),
  actions: {},
};

export const notebook = {
  render: () => page("note", "Notebook", "Ask questions about your own course material.", [
    "Add your slides and papers as sources",
    "Get answers that point to the page they come from",
    "Summaries, study guides and practice questions",
  ]),
  actions: {},
};
