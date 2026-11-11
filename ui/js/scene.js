// The backdrop behind every view: a soft landscape and a few butterflies drifting across it.
// Purely decorative: it sits under the content, ignores the mouse, and stands still when the
// Mac is set to reduce motion. Everything is drawn here, so there are no image files to ship.

const rand = (a, b) => a + Math.random() * (b - a);

/** Meadow flowers: fixed positions so the picture does not change between launches. */
function flowers() {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let out = "";
  for (let i = 0; i < 70; i++) {
    const x = next() * 1200, y = 706 + next() * 90, r = 2 + next() * 3.2;
    const fill = ["#ffffff", "#ffd0df", "#f79cba", "#ffe9a8"][Math.floor(next() * 4)];
    out += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${fill}" opacity="${(0.55 + next() * 0.4).toFixed(2)}"/>`;
  }
  return out;
}

const LAND = `<svg class="land" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--sky1)"/><stop offset=".55" style="stop-color:var(--sky2)"/><stop offset=".8" style="stop-color:var(--sky3)"/>
    </linearGradient>
    <radialGradient id="sun"><stop offset="0" style="stop-color:var(--sun)" stop-opacity=".9"/><stop offset="1" style="stop-color:var(--sun)" stop-opacity="0"/></radialGradient>
    <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--sky3)" stop-opacity="0"/><stop offset="1" style="stop-color:var(--sky3)" stop-opacity=".55"/></linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#sky)"/>
  <circle cx="930" cy="330" r="260" fill="url(#sun)"/>
  <g style="fill:var(--cloud)">
    <path d="M140 250c0-22 20-38 44-34 10-24 46-30 64-10 26-6 48 12 46 34 18 4 20 30-4 32H150c-24 0-30-18-10-22z"/>
    <path d="M700 170c0-16 15-28 33-25 8-18 35-22 48-7 20-4 36 9 34 25 14 3 15 22-3 24H708c-18 0-22-13-8-17z" opacity=".8"/>
    <path d="M1000 300c0-13 12-23 27-20 6-15 28-18 39-6 16-4 29 7 28 20 11 3 12 18-2 20h-86c-14 0-18-11-6-14z" opacity=".7"/>
  </g>
  <path style="fill:var(--hill3)" d="M0 600C120 500 250 545 380 510 520 470 620 540 780 492 930 446 1070 520 1200 474V800H0z"/>
  <rect y="470" width="1200" height="200" fill="url(#mist)"/>
  <path style="fill:var(--hill2)" d="M0 660C180 590 360 668 590 622 800 580 990 664 1200 612V800H0z"/>
  <path style="fill:var(--hill1)" d="M0 730C240 676 480 746 750 706 950 678 1090 724 1200 704V800H0z"/>
  <g class="flowers">${flowers()}</g>
</svg>`;

/** One wing (drawn on the right of the body) with a few veins; the left wing is its mirror. */
const WING = `<path d="M0-3C8-38 44-46 49-24 52-8 26 3 0 2z"/><path d="M0 2C22 2 40 11 32 27 28 35 23 30 20 34 19 41 11 40 13 31 6 26 0 14 0 3z"/>
  <path class="vein" d="M2-2C14-18 28-27 44-28M2-1C16-8 30-10 46-16M2 3C12 8 20 14 26 26"/>`;

const TINTS = [
  ["#dc6f92", "#f2a3bb", "#f9d3de", "#fff3f6"],
  ["#e98aa9", "#f7bccd", "#fce3ea", "#ffffff"],
  ["#f0a5bd", "#fad3de", "#ffffff", "#fdeef2"],
  ["#cf5f85", "#ec98b2", "#f6c6d4", "#ffeaf0"],
];

function butterfly(i) {
  const [a1, a2, b1, b2] = TINTS[i % TINTS.length];
  const size = Math.round(rand(44, 78) * (i === 0 ? 1.35 : 1));
  const flap = rand(0.42, 0.8).toFixed(2);
  return `<div class="bf" style="width:${size}px;animation:bf-path-${i} ${rand(46, 80).toFixed(0)}s ease-in-out ${(-rand(0, 40)).toFixed(0)}s infinite alternate;opacity:${rand(0.7, 0.95).toFixed(2)}">
    <svg class="bob" viewBox="-56 -52 112 100" style="animation-duration:${rand(2.4, 4).toFixed(1)}s">
      <defs>
        <linearGradient id="bfa${i}" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a1}"/><stop offset="1" stop-color="${a2}"/></linearGradient>
        <linearGradient id="bfb${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${b1}"/><stop offset="1" stop-color="${b2}"/></linearGradient>
      </defs>
      <g class="wing" style="animation-duration:${flap}s" fill="url(#bfa${i})" stroke="${a1}"><g transform="scale(-1 1)">${WING}</g></g>
      <g class="wing" style="animation-duration:${flap}s;animation-delay:-.04s" fill="url(#bfb${i})" stroke="${a2}">${WING}</g>
      <path d="M-3-14C-6-26-12-32-17-34M3-14C6-26 12-32 17-34" fill="none" stroke="#b9627f" stroke-width="1" stroke-linecap="round"/>
      <ellipse rx="3" ry="13" fill="#d76a8c"/>
    </svg>
  </div>`;
}

/** A wandering loop: a handful of points across the window, each with a slight tilt. */
function pathKeyframes(i) {
  const points = Array.from({ length: 6 }, () => [rand(2, 88), rand(4, 82), rand(-28, 28)]);
  const steps = points.map(([x, y, r], k) =>
    `${Math.round((100 * k) / (points.length - 1))}%{transform:translate(${x.toFixed(1)}vw,${y.toFixed(1)}vh) rotate(${r.toFixed(0)}deg)}`);
  return `@keyframes bf-path-${i}{${steps.join("")}}`;
}

export function mountScene(count = 7) {
  const scene = document.getElementById("scene");
  const style = document.createElement("style");
  style.textContent = Array.from({ length: count }, (_, i) => pathKeyframes(i)).join("");
  document.head.append(style);
  scene.innerHTML = LAND + Array.from({ length: count }, (_, i) => butterfly(i)).join("");
}
