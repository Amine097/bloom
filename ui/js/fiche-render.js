// Lays a generated fiche out as A4 pages that look like the LaTeX course companions: it reads the
// files Claude wrote (front.html, ch*.html), keeps only the markup it knows (sanitize), turns it into
// the sheet's structure (numbering, boxes with their titles, lecture cards, key figures with the
// slide images, MCQs whose answers go to the end), then flows it into pages of fixed size, splitting
// paragraphs, lists, tables and boxes across pages the way tcolorbox does, with running headers,
// page numbers and a table of contents. Also the full-window viewer and the PDF export (printing).
// The look itself is ui/fiche.css; the markup Claude may use is MARKUP in fiches-core.js.
import { D } from "./store.js";
import { esc, icon, openViewer, toast } from "./ui.js";
import { pdfUrl } from "./files.js";
import { labelsFor, chapterFiles, parseProgress, citeTarget, BOX_TYPES } from "./fiches-core.js";
import { readFicheFile, listFicheFiles, slideImage, printPage } from "./fiche-run.js";

const PT = 96 / 72; // CSS px per pt

// ---------------------------------------------------------------- stylesheet and fonts

let cssReady = null;
function ensureCss() {
  cssReady ??= new Promise(resolve => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "fiche.css";
    link.onload = link.onerror = () => resolve();
    document.head.append(link);
  }).then(() => Promise.all(["400 10pt", "italic 400 10pt", "700 10pt", "italic 700 10pt"]
    .map(f => document.fonts.load(`${f} "Fiche Fira Sans"`).catch(() => null))));
  return cssReady;
}

// ---------------------------------------------------------------- keeping only known markup

const HTML_TAGS = new Set("div section header footer article aside p span b strong i em u s sub sup br ul ol li table thead tbody tfoot tr th td caption colgroup col h1 h2 h3 h4 h5 h6 cite dfn var small mark abbr figure figcaption blockquote hr code q".split(" "));
const SVG_TAGS = new Set("svg g path rect circle ellipse line polyline polygon text tspan defs marker title desc lineargradient radialgradient stop clippath pattern".split(" "));
const MATH_TAGS = new Set("math mi mn mo mrow msup msub msubsup mfrac msqrt mroot mtext mspace mtable mtr mtd munder mover munderover mstyle mpadded mphantom semantics".split(" "));
const DROP = new Set("script style iframe frame frameset object embed link meta base form input button textarea select option img image video audio source track picture canvas use foreignobject template noscript svg:script a:script".split(" "));
const SVG_ATTRS = new Set(("viewbox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill stroke stroke-width stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit " +
  "opacity fill-opacity stroke-opacity fill-rule clip-rule transform font-size font-weight font-style text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing " +
  "marker-end marker-start marker-mid markerwidth markerheight refx refy orient markerunits id offset stop-color stop-opacity gradientunits gradienttransform fx fy " +
  "dx dy rotate textlength lengthadjust preserveaspectratio clip-path clippathunits patternunits patterncontentunits patterntransform xmlns visibility display").split(" "));
const MATH_ATTRS = new Set("mathvariant display stretchy fence separator lspace rspace accent accentunder linethickness columnalign".split(" "));

let svgSerial = 0;

/** HTML written by Claude → a fragment holding only the elements and attributes the sheet uses. */
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${String(html ?? "")}`, "text/html");
  const clean = el => {
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; } // comments
      if (child.nodeType !== 1) continue;
      const tag = child.localName.toLowerCase();
      const ns = child.namespaceURI || "";
      const isSvg = ns.endsWith("/svg"), isMath = ns.endsWith("/MathML");
      const known = isSvg ? SVG_TAGS.has(tag) : isMath ? MATH_TAGS.has(tag) : HTML_TAGS.has(tag);
      if (DROP.has(tag) && !(isSvg && tag === "svg")) { child.remove(); continue; }
      if (!known) { clean(child); child.replaceWith(...child.childNodes); continue; }
      for (const a of [...child.attributes]) {
        const name = a.name.toLowerCase(), v = a.value;
        let ok;
        if (isSvg) ok = SVG_ATTRS.has(name) || (name === "class") || (name === "style" && !/url\s*\(\s*['"]?(?!#)|expression|@import|javascript/i.test(v));
        else if (isMath) ok = MATH_ATTRS.has(name) || name === "class";
        else ok = name === "class" || name.startsWith("data-") || ["colspan", "rowspan", "start", "scope", "lang"].includes(name);
        if (ok && /javascript:|url\s*\(\s*['"]?(?!#)/i.test(v) && name !== "style") ok = false;
        if (!ok) child.removeAttribute(a.name);
      }
      clean(child);
    }
  };
  clean(doc.body);
  // ids inside each drawing are made unique, with their url(#id) references
  for (const svg of doc.body.querySelectorAll("svg")) {
    const n = ++svgSerial, map = new Map();
    for (const el of svg.querySelectorAll("[id]")) { map.set(el.id, `fs${n}-${el.id}`); el.id = `fs${n}-${el.id}`; }
    if (!map.size) continue;
    for (const el of [svg, ...svg.querySelectorAll("*")]) {
      for (const a of [...el.attributes]) {
        if (a.value.includes("url(#")) el.setAttribute(a.name, a.value.replace(/url\(#([^)]+)\)/g, (m, id) => (map.has(id) ? `url(#${map.get(id)})` : m)));
      }
    }
  }
  const frag = document.createDocumentFragment();
  frag.append(...[...doc.body.childNodes].map(n => document.importNode(n, true)));
  return frag;
}

// ---------------------------------------------------------------- the sheet's structure

const h = (tag, cls = "", html = "") => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html) el.innerHTML = html;
  return el;
};
const ic = name => `<i class="fc-ic i-${name}" aria-hidden="true"></i>`;
const ROMAN = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
export function roman(n) {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}
const BOX_ICON = { def: "book", mech: "cogs", clin: "stethoscope", num: "hashtag", meth: "flask", math: "calculator", prof: "chalkboard-teacher", trap: "bullseye", warn: "exclamation-triangle", added: "plus-circle", takehome: "heart", draw: "pencil-alt", summary: "clipboard-list" };

function boxTitle(type, titleNode, L) {
  const bt = h("div", "bt");
  const inner = titleNode ? [...titleNode.childNodes] : [];
  const hasText = inner.some(n => n.textContent.trim() || n.nodeType === 1);
  bt.innerHTML = ic(BOX_ICON[type]);
  if (type === "takehome" && hasText) bt.append(...inner);
  else {
    bt.append(L[type]);
    if (hasText && type !== "summary") { bt.append(type === "prof" ? " " : ": "); bt.append(...inner); }
  }
  return bt;
}

/** Makes `<cite>` clickable when it names a lecture of this fiche. */
function linkCites(root, keys) {
  for (const c of root.querySelectorAll("cite")) {
    const t = citeTarget(c.textContent);
    if (t && keys[t.key]) { c.dataset.goto = "slide"; c.dataset.key = t.key; c.dataset.page = t.page; c.title = `Open ${t.key}, page ${t.page}`; }
  }
}

/** Turns one box written by Claude into the sheet's box. */
function normBox(box, L) {
  const type = BOX_TYPES.find(t => box.classList.contains(t)) || "added";
  box.className = `box ${type} has-t`;
  const first = box.firstElementChild;
  const titleNode = first && /^h[1-6]$/i.test(first.localName) ? first : null;
  const bt = boxTitle(type, titleNode, L);
  titleNode?.remove();
  box.prepend(bt);
  return box;
}

/**
 * One chapter file → { blocks, title, number, sections: [{ no, title, el }], lectures: [{ key, who, when, title }] }.
 * `ctx`: { L, keys (KEY → { title, file, pages }), answers (collected), parts (counter), toc }.
 */
function normChapter(frag, no, fallbackTitle, ctx) {
  const { L } = ctx;
  const root = h("div");
  root.append(frag);
  // stray wrappers (a lone <section> or <div> around everything) are unwrapped
  while (root.children.length === 1 && /^(div|section|article)$/.test(root.firstElementChild.localName) && !root.firstElementChild.className) root.firstElementChild.replaceWith(...root.firstElementChild.childNodes);
  const blocks = [];
  let title = fallbackTitle, part = null;
  const sections = [];
  let sec = 0, sub = 0;

  // part banners: before the chapter heading
  for (const p of root.querySelectorAll("div.part")) {
    ctx.parts += 1;
    part = { no: ctx.parts, title: p.textContent.trim() };
    p.remove();
  }
  const h1 = root.querySelector("h1");
  if (h1) { title = h1.textContent.trim() || title; h1.remove(); }
  for (const extra of root.querySelectorAll("h1")) extra.outerHTML = `<h2>${extra.innerHTML}</h2>`;

  // boxes first (their h4 become titles), then the rest
  for (const box of root.querySelectorAll("div.box")) normBox(box, L);
  for (const el of root.querySelectorAll("h4, h5, h6")) {
    if (el.closest(".box") && el.localName === "h5") continue;
    const p = h("p");
    p.innerHTML = `<b>${el.innerHTML}</b>`;
    el.replaceWith(p);
  }
  for (const el of root.querySelectorAll("h2, h3")) {
    const isSec = el.localName === "h2";
    if (isSec) { sec += 1; sub = 0; } else sub += 1;
    const n = isSec ? `${no}.${sec}` : `${no}.${sec}.${sub}`;
    const t = el.innerHTML;
    el.innerHTML = `<span class="n">${n}</span><span class="t">${t}</span>`;
    if (isSec) {
      el.dataset.toc = `s${no}-${sec}`;
      sections.push({ no: n, title: el.textContent.slice(n.length).trim(), id: el.dataset.toc });
    }
  }
  const lectures = [];
  for (const card of root.querySelectorAll("div.lecture")) {
    const key = card.dataset.lecture || "";
    const info = ctx.keys[key] || {};
    const t = card.textContent.trim() || info.title || key;
    const who = card.dataset.who || "", when = card.dataset.when || "";
    lectures.push({ key, title: t, who, when });
    const el = h("div", "fc-lecture");
    el.innerHTML = `<div class="l1">${ic("file")}<span class="t">${esc(t)}</span><span class="k">${esc(L.key)} [${esc(key)}]</span><span class="who">${esc(who)}</span>${when ? `<span class="when">&nbsp;· ${esc(when)}</span>` : ""}</div>
      ${info.file ? `<div class="l2">${esc(L.file)}: ${esc(info.file)}${info.pages ? ` (${info.pages} ${esc(L.pages)})` : ""}</div>` : ""}`;
    card.replaceWith(el);
  }
  for (const p of root.querySelectorAll("p.objectives")) p.prepend(h("b", "fc-label", esc(L.objectives)));
  for (const p of root.querySelectorAll("p.minor")) p.prepend(h("b", "fc-label", esc(L.minor)));

  // key figures
  for (const sct of root.querySelectorAll("section.figures")) {
    const row = h("div", "fc-figrow");
    for (const fig of sct.querySelectorAll("figure")) row.append(normFigure(fig));
    sct.replaceChildren(h("h2", "fc-star-h", `${ic("image")}<span>${esc(L.keyFigures)}</span>`), row);
    sct.dataset.need = String(Math.round(144 * PT));
  }
  for (const fig of root.querySelectorAll("figure")) if (!fig.closest(".fc-figrow")) normFigure(fig);

  // self-test
  let q = 0;
  for (const sct of root.querySelectorAll("section.selftest")) {
    const cols = h("div", "fc-cols");
    for (const m of sct.querySelectorAll(".mcq")) {
      q += 1;
      cols.append(normMcq(m, `Q${no}.${q}`, ctx));
    }
    sct.replaceChildren(h("h2", "fc-star-h", `${ic("question-circle")}<span>${esc(L.selftest)}</span>`), cols);
    sct.dataset.need = String(Math.round(168 * PT));
  }
  linkCites(root, ctx.keys);

  const head = h("h1", "fc-ch", `<span class="n">${no}</span><span class="bar">|</span><span class="t">${esc(title)}</span>`);
  head.dataset.toc = `c${no}`;
  if (part) {
    const banner = h("div", "fc-partbanner", `${esc(L.part.toUpperCase())} ${roman(part.no).toUpperCase()}<span class="dot">·</span>${esc(part.title)}`);
    blocks.push(banner);
  }
  blocks.push(head, ...root.childNodes);
  return { blocks, title, number: no, part, sections, lectures };
}

function normFigure(fig) {
  const w = Math.min(1, Math.max(0.15, Number(fig.dataset.width) || (fig.classList.contains("drawn") ? 0.48 : 0.32)));
  fig.style.width = `${(w * 100).toFixed(1)}%`;
  if (fig.classList.contains("slide")) {
    const cap = h("div", "fc-cap");
    const fc = fig.querySelector("figcaption");
    if (fc) { cap.append(...fc.childNodes); fc.remove(); }
    cap.append(...[...fig.childNodes]);
    const hold = h("div", "fc-imgwrap");
    hold.dataset.key = fig.dataset.lecture || "";
    hold.dataset.page = fig.dataset.page || "";
    fig.replaceChildren(hold, cap);
  }
  return fig;
}

const LETTERS = ["A", "B", "C", "D", "E"];
function normMcq(m, qn, ctx) {
  const out = h("div", "mcq");
  const ol = m.querySelector("ol, ul");
  const why = m.querySelector(".why");
  why?.remove();
  ol?.remove();
  const qp = h("p");
  qp.innerHTML = `<b class="qn">${qn}</b>`;
  const rest = [...m.childNodes];
  const firstP = rest.find(n => n.nodeType === 1 && n.localName === "p");
  if (firstP) { qp.append(...firstP.childNodes); firstP.remove(); }
  out.append(qp, ...[...m.childNodes].filter(n => n.nodeType === 1 || n.textContent.trim()));
  const list = h("ol");
  [...(ol?.children || [])].slice(0, 5).forEach((li, k) => {
    const item = h("li");
    item.innerHTML = `<b class="opt">${LETTERS[k]}.</b>`;
    item.append(...li.childNodes);
    list.append(item);
  });
  out.append(list);
  let a = String(m.dataset.answer || "").trim().toUpperCase();
  if (/^[1-5]$/.test(a)) a = LETTERS[Number(a) - 1];
  if (!LETTERS.includes(a)) a = "?";
  ctx.answers.push({ qn, a, why: why ? [...why.childNodes] : [] });
  return out;
}

// ---------------------------------------------------------------- reading a fiche's files

const imageCache = new Map(); // "<id>|KEY|page" → object URL (or null: cannot be made)

/** The slide without its white margins (the LaTeX fiches show cropped captures). Same blob when there is nothing to trim. */
async function trimWhite(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const W = bmp.width, H = bmp.height;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (px[i + 3] > 16 && (px[i] < 238 || px[i + 1] < 238 || px[i + 2] < 238)) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return blob;
    const pad = Math.round(Math.max(W, H) * 0.01);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (w * hh > 0.9 * W * H) return blob;
    const out = document.createElement("canvas");
    out.width = w; out.height = hh;
    out.getContext("2d").drawImage(c, x0, y0, w, hh, 0, 0, w, hh);
    return await new Promise(resolve => out.toBlob(b => resolve(b || blob), "image/png"));
  } catch {
    return blob;
  }
}

async function fillSlides(id, root) {
  const holds = [...root.querySelectorAll(".fc-imgwrap")];
  await Promise.all(holds.map(async hold => {
    const key = hold.dataset.key, page = Number(hold.dataset.page);
    const ck = `${id}|${key}|${page}`;
    if (!imageCache.has(ck)) {
      const raw = key && page > 0 ? await slideImage(id, key, page) : null;
      const blob = raw ? await trimWhite(raw) : null;
      imageCache.set(ck, blob ? URL.createObjectURL(blob) : null);
    }
    const url = imageCache.get(ck);
    if (url) {
      const img = new Image();
      img.className = "fc-img";
      img.alt = `${key} page ${page}`;
      img.src = url;
      try { await img.decode(); } catch { /* shown as it is */ }
      img.dataset.goto = "slide"; img.dataset.key = key; img.dataset.page = page;
      hold.replaceChildren(img);
    } else {
      const ph = h("div", "fc-ph", `<span><b>${esc(key)} · page ${page || "?"}</b>slide image not available here: click to open the PDF</span>`);
      ph.dataset.goto = "slide"; ph.dataset.key = key; ph.dataset.page = page;
      hold.replaceChildren(ph);
    }
  }));
}

/** Drops the cached slide images of a fiche (when it is deleted or rewritten). */
export function forgetImages(id) {
  for (const [k, url] of imageCache) if (k.startsWith(`${id}|`)) { if (url) URL.revokeObjectURL(url); imageCache.delete(k); }
}

/** The chapter files of a fiche, in progress.json's order, then any others. */
async function chapterList(id) {
  const names = await listFicheFiles(id);
  const progress = parseProgress(await readFicheFile(id, "progress.json").catch(() => null));
  const files = chapterFiles(names);
  const ordered = [];
  for (const c of progress?.chapters || []) if (files.includes(c.file) && !ordered.some(x => x.file === c.file)) ordered.push(c);
  for (const f of files) if (!ordered.some(x => x.file === f)) ordered.push({ file: f, title: "" });
  return { chapters: ordered, hasFront: names.includes("front.html") };
}

/** Whether a fiche has at least one chapter written (something to show). */
export async function hasChapters(id) {
  try { return (await chapterList(id)).chapters.length > 0; } catch { return false; }
}

// ---------------------------------------------------------------- flowing into pages

const ATOMIC = "img, svg, figure, tr, thead, .fc-code, .mcq, .fc-ans, h1, h2, h3, h4, h5, .bt, .fc-lecture, .fc-partbanner, math, .eq, .frac, hr, .fc-toc-part, .fc-toc-ch, .fc-toc-sec, .fc-tp, caption, .fc-ph";
const KEEP_WITH_NEXT = "h1, h2, h3, h4, h5, .bt, .fc-partbanner, .fc-star-h";
const isCols = el => el.classList?.contains("fc-cols");

/** Position just before element `el`. */
const before = el => ({ node: el.parentNode, offset: [...el.parentNode.childNodes].indexOf(el) });

/** Moves a position at the very start of a container up to "before the container", within `root`. */
function liftStart(pos, root) {
  let { node, offset } = pos;
  while (node !== root) {
    const atStart = offset === 0 || (node.nodeType === 3 && !node.data.slice(0, offset).trim());
    if (!atStart) break;
    const p = before(node);
    node = p.node; offset = p.offset;
  }
  return { node, offset };
}

/** Whether the range from the start of `root` to `pos` holds no visible content. */
function emptyBefore(root, pos) {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(pos.node, pos.offset);
  if (r.toString().trim()) return false;
  const frag = r.cloneContents();
  return !frag.querySelector?.("img, svg, figure, .fc-ph, math, hr, tr");
}

/** The last element that ends before `pos` inside `root` (walking back), ignoring empty text. */
function lastElementBefore(root, pos) {
  let node = pos.node, offset = pos.offset;
  // the node just before the position
  let cur = node.nodeType === 3 ? (offset > 0 && node.data.slice(0, offset).trim() ? null : node.previousSibling ?? node.parentNode) : (offset > 0 ? node.childNodes[offset - 1] : node);
  if (cur === null) return null;
  while (cur && cur !== root) {
    if (cur.nodeType === 3 && !cur.data.trim()) { cur = cur.previousSibling ?? cur.parentNode; continue; }
    if (cur.nodeType === 1 && cur === node && offset === 0) { cur = cur.previousSibling ?? cur.parentNode; continue; }
    if (cur.nodeType === 1) {
      if (cur.matches(KEEP_WITH_NEXT)) return cur;
      // descend into its last child to find a trailing heading
      const last = cur.lastChild;
      if (last && cur.contains(node) === false && !cur.matches(ATOMIC)) { cur = last; continue; }
      return cur;
    }
    return null;
  }
  return null;
}

/** The first character of `t` whose box goes below `limit`, or -1. Lines run top to bottom. */
function firstOverflowChar(t, limit) {
  const r = document.createRange();
  const bottom = i => { r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect(); return b.height ? b.bottom : -Infinity; };
  let last = t.data.length - 1;
  while (last >= 0 && /\s/.test(t.data[last])) last--;
  if (last < 0 || bottom(last) <= limit) return -1;
  let lo = 0, hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let k = mid;
    while (k < hi && /\s/.test(t.data[k])) k++;
    if (bottom(k) > limit) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Where to split `root` so that what comes before ends above `limit`; null when nothing fits. */
function findSplit(root, limit) {
  const scan = node => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) {
        if (!n.data.trim()) continue;
        const i = firstOverflowChar(n, limit);
        if (i === -1) continue;
        let k = i;
        while (k > 0 && !/\s/.test(n.data[k - 1]) && n.data[k - 1] !== "­") k--;
        return { node: n, offset: k };
      }
      if (n.nodeType !== 1) continue;
      const box = n.getBoundingClientRect();
      if (box.bottom <= limit + 0.5) continue;
      if (isCols(n)) {
        const pos = colSplit(n, limit);
        if (pos) return pos;
        continue;
      }
      if (n.matches(ATOMIC) || getComputedStyle(n).display === "inline-block") {
        // a figure in a row of figures: the whole row moves
        let el = n;
        const parent = n.parentElement;
        if (parent && getComputedStyle(parent).flexWrap === "wrap") {
          const top = n.getBoundingClientRect().top;
          for (let p = n.previousElementSibling; p && Math.abs(p.getBoundingClientRect().top - top) < 2; p = p.previousElementSibling) el = p;
        }
        return before(el);
      }
      const inner = scan(n);
      if (inner) return inner;
    }
    return null;
  };
  let pos = scan(root);
  if (!pos) return null;
  for (let guard = 0; guard < 20; guard++) {
    pos = liftStart(pos, root);
    if (pos.node === root && pos.offset === 0) return null;
    if (emptyBefore(root, pos)) return null;
    // a heading or a box title never ends a page
    const prev = lastElementBefore(root, pos);
    if (prev && prev.matches(KEEP_WITH_NEXT) && root.contains(prev) && prev !== root) { pos = before(prev); continue; }
    return pos;
  }
  return null;
}

/** In a two-column block: fill column 1 then 2 down to `limit`, split before the first item that does not fit. */
function colSplit(el, limit) {
  const top = el.getBoundingClientRect().top;
  const avail = limit - top;
  const items = [...el.children];
  if (!items.length) return null;
  if (avail < 24) return before(items[0]);
  el.classList.add("fc-filled");
  el.style.height = `${avail}px`;
  el.dataset.fill = String(avail);
  const right = el.getBoundingClientRect().right;
  const out = items.find(c => { const b = c.getBoundingClientRect(); return b.left >= right - 2 || b.bottom > limit + 0.5; });
  el.classList.remove("fc-filled");
  el.style.height = "";
  return out ? before(out) : before(items[items.length - 1]);
}

/** Splits `root` at `pos`: what comes before goes into a copy inserted before it. → the copy. */
function splitAt(root, pos) {
  const chain = [];
  for (let n = pos.node.nodeType === 3 ? pos.node.parentNode : pos.node; n && n !== root.parentNode; n = n.parentNode) chain.unshift(n);
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(pos.node, pos.offset);
  const frag = r.extractContents();
  const first = root.cloneNode(false);
  first.append(frag);
  root.before(first);
  // mark both sides of each split element
  let c = first;
  for (let i = 0; i < chain.length; i++) {
    const rest = chain[i];
    if (i > 0) c = c?.lastChild;
    if (!c || c.nodeType !== 1 || rest.nodeType !== 1) break;
    c.classList.add("cont-a");
    rest.classList.add("cont-b");
    if (rest.localName === "ol") {
      const start = Number(rest.getAttribute("start")) || 1;
      const n = [...c.children].filter(x => x.localName === "li").length;
      rest.setAttribute("start", String(start + n - (rest.firstElementChild?.classList.contains("cont-b") ? 1 : 0)));
    }
    if (rest.localName === "table" && c.querySelector(":scope > thead") && !rest.querySelector(":scope > thead")) rest.prepend(c.querySelector(":scope > thead").cloneNode(true));
  }
  first.classList.add("cont-a");
  root.classList.add("cont-b");
  return first;
}

class Book {
  constructor(stage, running) { this.stage = stage; this.running = running; this.pages = []; }

  page({ left = "", plain = false, roman: isRoman = false, cls = "" } = {}) {
    const page = h("div", `fc-page ${plain ? "fc-plain" : ""} ${isRoman ? "fc-roman" : ""} ${cls}`);
    page.innerHTML = `<div class="fc-head"><span class="l">${esc(left)}</span><span class="r">${esc(this.running)}</span></div><div class="fc-body"></div><div class="fc-foot"></div>`;
    page.dataset.roman = isRoman ? "1" : "";
    this.stage.append(page);
    this.pages.push(page);
    return page;
  }

  /** Flows `blocks` into new pages; the first one has no running header. */
  flow(blocks, opts) {
    let page = this.page({ ...opts, plain: true });
    let body = page.querySelector(".fc-body");
    const next = () => { page = this.page(opts); body = page.querySelector(".fc-body"); };
    const bottom = () => body.getBoundingClientRect().bottom;
    const used = () => { const l = body.lastElementChild; return l ? l.getBoundingClientRect().bottom : body.getBoundingClientRect().top; };
    const fits = node => node.getBoundingClientRect().bottom <= bottom() + 0.5;
    const queue = [...blocks].filter(b => b.nodeType === 1 || (b.nodeType === 3 && b.data.trim()));
    let loops = 0;
    while (queue.length) {
      if (++loops > 20000) break; // never hang on something unexpected
      let node = queue.shift();
      if (node.nodeType === 3) { const p = h("p"); p.append(node); node = p; }
      const need = Number(node.dataset?.need || 0);
      if (need && body.childElementCount && bottom() - used() < need) next();
      body.append(node);
      if (fits(node)) continue;
      // too long for what is left of the page
      let pos = null;
      for (const back of [0, 4, 8, 14]) {
        pos = findSplit(node, bottom() - back * PT);
        if (pos || back === 14) break;
      }
      if (!pos) {
        if (body.firstElementChild === node) { this.shrink(node, body); continue; }
        // headings left at the bottom go with it
        const carry = [node];
        let prev = node.previousElementSibling;
        while (prev && prev.matches(KEEP_WITH_NEXT) && prev !== body.firstElementChild) { carry.unshift(prev); prev = prev.previousElementSibling; }
        for (const c of carry) c.remove();
        next();
        queue.unshift(...carry);
        continue;
      }
      const first = splitAt(node, pos);
      // a box cut at the page's foot runs down to it, open, as tcolorbox draws it
      const cols = first.querySelector(".fc-cols") || (isCols(first) ? first : null);
      if (cols && cols.classList.contains("cont-a")) {
        cols.classList.add("fc-filled");
        cols.style.height = `${Number(cols.dataset.fill) || bottom() - cols.getBoundingClientRect().top}px`;
      }
      for (const c of [node, ...node.querySelectorAll(".fc-cols")]) delete c.dataset?.fill;
      for (const b of [first, ...first.querySelectorAll(".box.cont-a")].filter(b => b.classList.contains("box") && b.classList.contains("cont-a"))) {
        b.style.minHeight = `${bottom() - b.getBoundingClientRect().top}px`;
      }
      node.remove();
      next();
      queue.unshift(node);
    }
    return this;
  }

  /** Something taller than a page on its own: scale images down so it fits; else leave it cut. */
  shrink(node, body) {
    const imgs = node.querySelectorAll("img, svg, .fc-ph");
    if (!imgs.length) return;
    const over = node.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
    for (const im of imgs) {
      const hgt = im.getBoundingClientRect().height;
      im.style.maxHeight = `${Math.max(40, hgt - over / imgs.length - 4)}px`;
      im.style.width = "auto";
      im.style.margin = "0 auto";
    }
  }
}

// ---------------------------------------------------------------- the whole sheet

function frontBlocks(front, ctx, f) {
  const { L } = ctx;
  const blocks = [];
  const head = h("h1", "fc-ch unnum", `<span class="t">${esc(L.howto)}</span>`);
  head.dataset.toc = "howto";
  blocks.push(head);
  const howto = front?.querySelector("section.howto");
  if (howto) blocks.push(...howto.childNodes);
  else blocks.push(h("p", "", `<b>${f.options?.language === "fr" ? "Deux usages." : "Two uses."}</b> ${esc(f.options?.language === "fr"
    ? "Pendant la lecture des diapositives : la référence [Clé page] après chaque fait indique la diapositive à ouvrir. Pour réviser : lisez un chapitre, regardez ses figures clés, puis faites ses QCM (réponses à la fin)."
    : "While reading the slides: the tag [Key page] after each fact tells you which slide to open; annotate freely. For revision: read a chapter, look at its key figures, then do its MCQs (answers at the end).")}`));
  // colour code
  blocks.push(h("h2", "fc-front-h", esc(L.colourCode)));
  const code = h("div", "fc-code");
  const types = ["def", "mech", "clin", "num", "meth", "math", "prof", "trap", "warn", "added"];
  if (f.options?.include?.draw) types.push("draw");
  for (const t of types) {
    const [what, text] = L.code[t];
    const box = h("div", `box ${t} has-t`);
    const tn = h("span", "", esc(what));
    box.append(boxTitle(t, what ? tn : null, L), h("span", "", esc(text)));
    code.append(box);
  }
  code.style.gridTemplateRows = `repeat(${Math.ceil(types.length / 2)}, auto)`;
  blocks.push(code);
  const [g1, num, g2, link, g3, minor, g4] = L.legend;
  blocks.push(h("p", "fc-legend", `<span class="must"></span>${esc(g1)} · <span class="num">${esc(num)}</span> ${esc(g2)} · <span class="see">${esc(link)}</span> ${esc(g3)} · <span class="mauvetag">${esc(minor)}</span> ${esc(g4)}`));
  // lecture index, from the lecture cards
  const ih = h("h2", "fc-front-h", esc(L.lectureIndex));
  ih.dataset.toc = "index";
  blocks.push(ih);
  const table = h("table", "fc-index");
  table.innerHTML = `<thead><tr>${L.indexCols.map(c => `<td>${esc(c)}</td>`).join("")}</tr></thead>`;
  const tb = h("tbody");
  for (const [key, info] of Object.entries(ctx.keys)) {
    const card = ctx.cards[key];
    tb.append(h("tr", "", `<td>${esc(key)}</td><td>${esc(card?.title || info.title)}</td><td>${esc(card?.who || "")}</td><td>${esc((card?.chapters || []).join(", "))}</td><td>${esc(info.file || "")}</td>`));
  }
  table.append(tb);
  blocks.push(table);
  const nc = front?.querySelector("p.notcovered");
  if (nc) blocks.push(nc);
  const tools = front?.querySelector("section.toolbox");
  if (tools && tools.textContent.trim()) {
    const th = h("h2", "fc-front-h", esc(L.toolbox));
    th.dataset.toc = "toolbox";
    blocks.push(th, ...tools.childNodes);
  }
  return blocks;
}

function titleBlock(front, f, L) {
  const tp = front?.querySelector("header.titlepage");
  const pick = sel => tp?.querySelector(sel)?.innerHTML || "";
  const title = tp?.querySelector("h1")?.innerHTML || esc(f.title);
  const box = h("div", "fc-tp");
  box.innerHTML = `<div class="fc-tp-top"></div><div class="fc-tp-rule"></div>
    <h1>${title}</h1>${pick(".subtitle") ? `<p class="subtitle">${pick(".subtitle")}</p>` : ""}
    ${pick(".course") ? `<p class="course">${pick(".course")}</p>` : ""}${pick(".topics") ? `<p class="topics">${pick(".topics")}</p>` : ""}
    <div class="fill"></div>${pick(".built") ? `<p class="built">${pick(".built")}</p>` : ""}<div class="fc-tp-rule"></div>`;
  return box;
}

function tocBlocks(L, entries) {
  const out = [h("h1", "fc-ch unnum", `<span class="t">${esc(L.contents)}</span>`)];
  let firstCh = true;
  for (const e of entries) {
    const cls = e.level === "part" ? "fc-toc-part" : e.level === "ch" ? `fc-toc-ch${firstCh ? " first" : ""}` : "fc-toc-sec";
    if (e.level === "ch") firstCh = false;
    const row = h("div", cls, `<span class="n">${esc(e.n || "")}</span><span class="t"><span>${esc(e.title)}</span></span><span class="p">${esc(e.page)}</span>`);
    row.dataset.goto = "page";
    row.dataset.target = e.id;
    out.push(row);
  }
  return out;
}

/**
 * Lays fiche `id` out in an off-screen stage. → { pages: [page elements, in order], title, dispose() }.
 * Throws a message she can read when there is nothing to show.
 */
export async function renderFiche(id) {
  const f = D.fiches?.[id];
  if (!f) throw new Error("This fiche no longer exists.");
  await ensureCss();
  const L = labelsFor(f.options?.language);
  const { chapters, hasFront } = await chapterList(id);
  if (!chapters.length) throw new Error("Nothing is written yet.");
  const keys = {};
  for (const lid of f.lectures || []) {
    const key = f.keys?.[lid];
    const it = D.items[lid];
    if (key) keys[key] = { lecture: lid, title: it?.title || key, file: it?.pdf?.name || "", pages: f.slides?.[key] || 0 };
  }
  const front = hasFront ? h("div") : null;
  if (front) {
    front.append(sanitize(await readFicheFile(id, "front.html")));
    for (const box of front.querySelectorAll("div.box")) normBox(box, L);
    for (const p of front.querySelectorAll("p.minor")) p.prepend(h("b", "fc-label", esc(L.minor)));
    linkCites(front, keys);
  }
  const running = front?.querySelector("header.titlepage .running")?.textContent.trim() || f.title;

  const stage = h("div", "fiche fc-stage");
  stage.lang = f.options?.language === "fr" ? "fr" : "en";
  stage.style.cssText = "position:absolute;left:-30000px;top:0;";
  document.body.append(stage);
  const ctx = { L, keys, answers: [], parts: 0, cards: {} };
  try {
    // the chapters
    const chs = [];
    for (const [k, c] of chapters.entries()) {
      const html = await readFicheFile(id, c.file);
      const ch = normChapter(sanitize(html || ""), k + 1, c.title || `Chapter ${k + 1}`, ctx);
      for (const l of ch.lectures) {
        const card = ctx.cards[l.key] ??= { title: l.title, who: l.who, chapters: [] };
        card.who ||= l.who;
        card.chapters.push(k + 1);
      }
      chs.push(ch);
    }
    const holder = h("div");
    for (const ch of chs) holder.append(...ch.blocks.map(b => (b.nodeType ? b : h("p"))));
    stage.append(holder);
    await fillSlides(id, holder);
    holder.remove();

    const main = new Book(stage, running);
    for (const ch of chs) main.flow(ch.blocks, { left: `${ch.number} ${ch.title}` });
    let answers = null;
    if (ctx.answers.length) {
      const ah = h("h1", "fc-ch unnum", `<span class="t">${esc(L.answers)}</span>`);
      ah.dataset.toc = "answers";
      const cols = h("div", "fc-cols fc-answers");
      for (const a of ctx.answers) {
        const row = h("div", "fc-ans", `<b class="qn">${a.qn}</b><div><span class="a">${a.a}</span> — </div>`);
        row.lastElementChild.append(...a.why);
        cols.append(row);
      }
      linkCites(cols, keys);
      answers = [ah, cols];
      main.flow(answers, { left: L.answers });
    }
    main.pages.forEach((p, i) => { p.querySelector(".fc-foot").textContent = String(i + 1); });

    // the front matter, then the table of contents with the page numbers now known
    const fm = new Book(stage, running);
    fm.flow(frontBlocks(front, ctx, f), { left: L.howto, roman: true });
    const entries = [];
    const add = (level, n, title, el, page, idTarget) => entries.push({ level, n, title, page, id: idTarget });
    const fmEl = s => [...fm.pages].map(p => p.querySelector(`[data-toc="${s}"]`)).find(Boolean);
    const fmPage = s => { const el = fmEl(s); return el ? roman(fm.pages.indexOf(el.closest(".fc-page")) + 1) : ""; };
    add("ch", "", L.howto, null, fmPage("howto"), "howto");
    if (fmEl("index")) add("sec", "", L.lectureIndex, null, fmPage("index"), "index");
    if (fmEl("toolbox")) add("sec", "", L.toolbox, null, fmPage("toolbox"), "toolbox");
    const mainPage = s => { const el = main.pages.map(p => p.querySelector(`[data-toc="${s}"]`)).find(Boolean); return el ? String(main.pages.indexOf(el.closest(".fc-page")) + 1) : ""; };
    for (const ch of chs) {
      if (ch.part) add("part", `${L.part} ${roman(ch.part.no).toUpperCase()}`, ch.part.title, null, mainPage(`c${ch.number}`), `c${ch.number}`);
      add("ch", String(ch.number), ch.title, null, mainPage(`c${ch.number}`), `c${ch.number}`);
      for (const s of ch.sections) add("sec", s.no, s.title, null, mainPage(s.id), s.id);
    }
    if (answers) add("ch", "", L.answers, null, mainPage("answers"), "answers");
    const toc = new Book(stage, running);
    toc.flow(tocBlocks(L, entries), { left: L.contents.toUpperCase(), roman: true });
    [...fm.pages, ...toc.pages].forEach((p, i) => { p.querySelector(".fc-foot").textContent = roman(i + 1); });

    // the title page
    const tp = new Book(stage, running);
    const tpage = tp.page({ plain: true, cls: "fc-titlepage" });
    tpage.querySelector(".fc-body").append(titleBlock(front, f, L));
    tpage.querySelector(".fc-foot").textContent = "";

    const pages = [tpage, ...fm.pages, ...toc.pages, ...main.pages];
    for (const p of pages) stage.append(p);
    return { pages, stage, title: f.title, dispose: () => stage.remove() };
  } catch (e) {
    stage.remove();
    throw e;
  }
}

// ---------------------------------------------------------------- the viewer and the export

let open = null; // { id, el, onKey }

function closeFiche() {
  if (!open) return;
  document.removeEventListener("keydown", open.onKey, true);
  document.documentElement.classList.remove("fiche-printing");
  open.el.remove();
  open = null;
}

async function gotoSlide(id, key, page) {
  const f = D.fiches?.[id];
  const lid = Object.entries(f?.keys || {}).find(([, k]) => k === key)?.[0];
  const it = lid && D.items[lid];
  if (!it?.pdf) { toast("The PDF of this lecture is not in Bloom any more.", "error"); return; }
  try { openViewer(it.title, await pdfUrl(it.pdf.id), Number(page) || null, { notes: lid }); }
  catch { toast("This PDF could not be opened. Attach it again from Courses.", "error"); }
}

function fit(scroll, pagesEl) {
  const w = scroll.clientWidth - 48;
  const pagePx = 210 / 25.4 * 96;
  const k = Math.max(0.3, Math.min(1.6, w / pagePx));
  pagesEl.style.zoom = String(k);
}

/** Opens generated fiche `id` over the whole window. */
export async function openFiche(id) {
  closeFiche();
  const f = D.fiches?.[id];
  if (!f) return;
  const el = h("div", "", "");
  el.id = "fiche-viewer";
  el.innerHTML = `<div class="fv" role="dialog" aria-modal="true" aria-label="${esc(f.title)}">
    <header class="fv-bar"><b class="fv-t">${esc(f.title)}</b><span class="muted small fv-info">Laying out the pages…</span><span class="grow"></span>
      <button type="button" class="btn soft small" data-fv="print" disabled>${icon("arrow", 15)} Export PDF</button>
      <button type="button" class="iconbtn" data-fv="close" aria-label="Close">${icon("close")}</button></header>
    <div class="fv-scroll"><div class="fv-wait"><span class="nb-spin" aria-hidden="true"></span></div></div></div>`;
  document.body.append(el);
  document.documentElement.classList.add("fiche-printing");
  const onKey = e => {
    if (e.key === "Escape" && document.getElementById("viewer")?.hidden !== false && document.getElementById("modal")?.hidden !== false) { e.preventDefault(); e.stopImmediatePropagation(); closeFiche(); }
  };
  document.addEventListener("keydown", onKey, true);
  open = { id, el, onKey };
  el.querySelector("[data-fv=close]").focus();
  const scroll = el.querySelector(".fv-scroll");
  el.addEventListener("click", async e => {
    const act = e.target.closest("[data-fv]")?.dataset.fv;
    if (act === "close" || e.target === el) return closeFiche();
    if (act === "print") return exportPdf();
    const go = e.target.closest("[data-goto]");
    if (!go) return;
    if (go.dataset.goto === "slide") return gotoSlide(id, go.dataset.key, go.dataset.page);
    if (go.dataset.goto === "page") {
      const target = scroll.querySelector(`[data-toc="${go.dataset.target}"]`);
      target?.closest(".fc-page")?.scrollIntoView({ block: "start" });
    }
  });
  try {
    const book = await renderFiche(id);
    if (open?.el !== el) { book.dispose(); return; }
    const pagesEl = h("div", "fv-pages fiche");
    pagesEl.lang = book.stage.lang;
    pagesEl.append(...book.pages);
    book.dispose();
    scroll.replaceChildren(pagesEl);
    fit(scroll, pagesEl);
    new ResizeObserver(() => fit(scroll, pagesEl)).observe(scroll);
    el.querySelector(".fv-info").textContent = `${book.pages.length} pages · A4`;
    el.querySelector("[data-fv=print]").disabled = false;
    if (f.pages !== book.pages.length) { f.pages = book.pages.length; (await import("./store.js")).save(); }
  } catch (e) {
    if (open?.el !== el) return;
    scroll.replaceChildren(h("div", "fv-wait", `<p class="lead">${esc(e?.message || String(e))}</p>`));
    el.querySelector(".fv-info").textContent = "";
  }
}

/** Prints the open fiche (the print dialog saves it as an A4 PDF). */
export async function exportPdf() {
  if (!open) return;
  // html.fiche-printing is set while the viewer is open: the print layout (only the pages) holds
  // however long the native print dialog stays up
  try {
    await printPage();
  } catch (e) {
    toast(e?.message || "Could not open the print dialog.", "error");
  }
}

export const isFicheOpen = () => Boolean(open);
