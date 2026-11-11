// Small interface helpers shared by every view: escaping, icons, toasts, the modal.

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);

/** Set by main.js so views can ask for a re-render or a change of view without importing it. */
export const app = { refresh() {}, go() {} };

const PATHS = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  todo: "M9 11l3 3 8-8M20 12v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1h11",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  book: "M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 19V5M9 7h6M9 11h6",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  note: "M6 3h12a1 1 0 011 1v16a1 1 0 01-1 1H6zM6 3v18M3 7h3M3 12h3M3 17h3M10 8h5M10 12h5",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.3l2-1.5-2-3.4-2.3.9a7 7 0 00-2.3-1.3L14 3h-4l-.3 2.4a7 7 0 00-2.3 1.3l-2.3-.9-2 3.4 2 1.5a7 7 0 000 2.6l-2 1.5 2 3.4 2.3-.9a7 7 0 002.3 1.3L10 21h4l.3-2.4a7 7 0 002.3-1.3l2.3.9 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  repeat: "M4 12a8 8 0 0113.7-5.7L20 8M20 4v4h-4M20 12a8 8 0 01-13.7 5.7L4 16M4 20v-4h4",
  inbox: "M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5a3 3 0 006 0h5",
  sun: "M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5",
  cal: "M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1zM4 10h16M8 3v4M16 3v4",
  sub: "M6 5v8a3 3 0 003 3h9M15 13l3 3-3 3",
  close: "M6 6l12 12M18 6L6 18",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  check: "M5 12l5 5 9-10",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
};
export const icon = (name, size = 18) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;

export const FLOWER = `<svg viewBox="-50 -50 100 100" aria-hidden="true"><g fill="var(--petal)">${[0, 72, 144, 216, 288].map(a => `<ellipse cy="-21" rx="14" ry="20" transform="rotate(${a})"/>`).join("")}</g><circle r="11" fill="var(--gold)"/></svg>`;

let toastTimer;
export function toast(message, kind = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ""; }, kind === "error" ? 6000 : 2800);
}

let modalHandlers = null;

/**
 * Opens a form in a dialog. `onSubmit(values, form)` gets the form fields as an object; it may
 * return false (or a promise of false) to keep the dialog open. `danger` adds a delete button.
 */
export function openModal({ title, body, submit = "Save", cancel = "Cancel", onSubmit, danger, wide = false }) {
  modalHandlers = { onSubmit, danger };
  $("#modal").innerHTML = `
    <form class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button type="button" class="iconbtn" data-modal="close" aria-label="Close">${icon("close")}</button></header>
      <div class="modal-b">${body}</div>
      <footer>
        ${danger ? `<button type="button" class="btn danger" data-modal="danger">${esc(danger.label)}</button>` : ""}
        <span class="grow"></span>
        ${cancel ? `<button type="button" class="btn ghost" data-modal="close">${esc(cancel)}</button>` : ""}
        ${submit ? `<button type="submit" class="btn primary">${esc(submit)}</button>` : ""}
      </footer>
    </form>`;
  $("#modal").hidden = false;
  const first = $("#modal [autofocus]") || $("#modal input, #modal textarea, #modal select");
  first?.focus();
}

export function closeModal() {
  $("#modal").hidden = true;
  $("#modal").innerHTML = "";
  modalHandlers = null;
}

export function confirmBox(title, message, okLabel = "Delete") {
  return new Promise(resolve => {
    openModal({
      title, body: `<p class="lead">${esc(message)}</p>`, submit: okLabel,
      onSubmit: () => { resolve(true); },
    });
    const done = modalHandlers;
    done.onCancel = () => resolve(false);
  });
}

/** Wired once by main.js. */
export function bindModal() {
  const root = $("#modal");
  root.addEventListener("submit", async e => {
    e.preventDefault();
    const h = modalHandlers;
    if (!h) return;
    const values = Object.fromEntries(new FormData(e.target));
    const keep = (await h.onSubmit?.(values, e.target)) === false;
    if (!keep && modalHandlers === h) closeModal();
  });
  root.addEventListener("click", async e => {
    const act = e.target.closest("[data-modal]")?.dataset.modal;
    const h = modalHandlers;
    if (act === "close" || e.target === root) { h?.onCancel?.(); closeModal(); }
    if (act === "danger" && h?.danger) { closeModal(); await h.danger.onClick(); }
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !root.hidden) { modalHandlers?.onCancel?.(); closeModal(); }
  });
}

// ---- form field snippets

export const field = (label, control, hint = "") =>
  `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;

export const input = (name, value = "", attrs = "") =>
  `<input name="${name}" value="${esc(value ?? "")}" ${attrs}>`;

export const select = (name, options, value, attrs = "") =>
  `<select name="${name}" ${attrs}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;

export const COLORS = ["rose", "lavender", "peach", "mint", "sky", "gold", "coral", "plum"];
export const cvar = color => `style="--mc:var(--c-${COLORS.includes(color) ? color : "plum"})"`;
