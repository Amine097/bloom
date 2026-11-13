// Planner: not built yet. This page says what is coming.
import { icon } from "../ui.js";

const page = (ic, title, lead, points) => `<header class="page-h"><div><h1>${title}</h1></div></header>
  <section class="card coming">
    <div class="coming-ic">${icon(ic, 34)}</div>
    <h2>Coming soon</h2>
    <p class="lead">${lead}</p>
    <ul>${points.map(p => `<li>${p}</li>`).join("")}</ul>
  </section>`;

export const render = () => page("spark", "Planner", "One button to plan your week.", [
    "Bloom reads your lectures, recalls, deadlines and to-dos",
    "It proposes a week that fits, and you adjust it",
    "It runs on your own Claude account",
]);

export const actions = {};

/** Called once by main.js when the app has started and the data is loaded. */
export function onStart() {}
