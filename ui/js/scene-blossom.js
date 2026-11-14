// The second backdrop: a pastel dusk with a flowering cherry branch and petals drifting down.
// Like the meadow it is purely decorative, drawn here with no image files, and moves only with
// CSS animations (the browser stops them when the window is hidden; reduced motion pauses them).

const rand = (a, b) => a + Math.random() * (b - a);

/** A repeatable random sequence, so the branch looks the same at every launch. */
function seeded(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

/** One cherry petal pointing up from the origin, with the little notch at its tip. */
const PETAL = "M0 0C-7-3-9.5-13-5-20.5-3.2-23-1.4-23.4 0-20.6 1.4-23.4 3.2-23 5-20.5 9.5-13 7-3 0 0z";

function flower(x, y, size, turn, deep) {
  const petals = Array.from({ length: 5 }, (_, k) =>
    `<path d="${PETAL}" transform="rotate(${k * 72})" fill="url(#bl-pt${deep ? "d" : ""})"/>`).join("");
  const stamens = Array.from({ length: 7 }, (_, k) => {
    const a = (k / 7) * Math.PI * 2, r = 6.5;
    return `<line x2="${(Math.cos(a) * r).toFixed(1)}" y2="${(Math.sin(a) * r).toFixed(1)}"/><circle cx="${(Math.cos(a) * r).toFixed(1)}" cy="${(Math.sin(a) * r).toFixed(1)}" r="1.1"/>`;
  }).join("");
  return `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) rotate(${turn.toFixed(0)}) scale(${(size / 22).toFixed(2)})">${petals}<g class="bl-stamen">${stamens}</g><circle r="2.6" class="bl-heart"/></g>`;
}

function bud(x, y, turn) {
  return `<g transform="translate(${x.toFixed(0)} ${y.toFixed(0)}) rotate(${turn.toFixed(0)})"><path d="M0 0C-4-3-4.5-9 0-13 4.5-9 4-3 0 0z" fill="url(#bl-ptd)"/><path d="M0 1C-2.5-1-3-4-1.5-5.5M0 1C2.5-1 3-4 1.5-5.5" class="bl-sepal"/></g>`;
}

/** Points where the blossoms cluster along the branch (in the branch's 640×440 drawing). */
const CLUSTERS = [
  [520, 70, 4], [430, 92, 5], [345, 128, 5], [262, 172, 4], [190, 214, 4], [118, 246, 3],
  [455, 168, 4], [395, 214, 3], [300, 60, 4], [228, 34, 3], [560, 150, 3], [600, 205, 3],
];

function branch() {
  const next = seeded(11);
  let flowers = "", buds = "";
  for (const [cx, cy, n] of CLUSTERS) {
    for (let k = 0; k < n; k++) {
      const x = cx + (next() - 0.5) * 46, y = cy + (next() - 0.5) * 34;
      if (next() < 0.22) buds += bud(x, y, (next() - 0.5) * 80);
      else flowers += flower(x, y, 15 + next() * 9, next() * 72, next() < 0.35);
    }
  }
  return `<svg class="bl-branch" viewBox="0 0 640 440" preserveAspectRatio="xMaxYMin meet">
    <g class="bl-wood">
      <path d="M660 18C590 30 520 56 446 86 370 118 300 150 236 196 186 232 140 250 96 262" stroke-width="13"/>
      <path d="M446 86C470 120 470 150 452 176 438 196 412 210 392 222" stroke-width="7"/>
      <path d="M352 126C336 96 312 76 286 62 262 50 238 40 214 34" stroke-width="6"/>
      <path d="M560 52C574 90 588 128 598 160 604 182 606 200 604 214" stroke-width="7"/>
      <path d="M236 196C224 214 214 226 196 236" stroke-width="4"/>
      <path d="M300 152C312 172 316 186 312 200" stroke-width="3.5"/>
    </g>
    <g class="bl-buds">${buds}</g>
    <g class="bl-flowers">${flowers}</g>
  </svg>`;
}

const SKY = `<svg class="bl-sky" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMax slice">
  <defs>
    <linearGradient id="bl-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--bl-sky1)"/><stop offset=".5" style="stop-color:var(--bl-sky2)"/><stop offset=".85" style="stop-color:var(--bl-sky3)"/>
    </linearGradient>
    <linearGradient id="bl-haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--bl-sky3)" stop-opacity="0"/><stop offset="1" style="stop-color:var(--bl-sky3)" stop-opacity=".7"/></linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#bl-sky)"/>
  <g class="bl-trees" transform="translate(0 -18)">
    <path d="M60 612c-10-30 26-48 48-36 14-26 60-24 70 4 30-6 46 22 30 40V680H60z"/>
    <path d="M300 600c-8-24 20-40 40-30 12-22 50-20 58 4 26-4 38 18 24 32V680H300z"/>
    <path d="M820 586c-10-28 24-46 46-34 14-24 56-22 66 4 28-4 44 20 28 38V680H820z"/>
    <path d="M1040 584c-8-22 18-36 36-28 10-18 44-16 52 4 22-4 32 16 20 28V680H1040z"/>
  </g>
  <path class="bl-far" d="M0 640C140 590 260 612 380 588 520 560 640 604 800 578 960 552 1080 590 1200 566V800H0z"/>
  <rect y="540" width="1200" height="260" fill="url(#bl-haze)"/>
  <path class="bl-near" d="M0 720C220 676 430 734 680 700 900 670 1060 716 1200 696V800H0z"/>
</svg>`;

/** Thin evening clouds, on their own layer so they can drift without repainting the sky. */
const WISPS = `<svg class="bl-wisps" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMax slice">
  <path d="M60 300c60-14 150-12 240 0 30 4 20 14-10 14H70c-26 0-34-10-10-14z"/>
  <path d="M760 250c50-10 120-9 190 0 24 3 16 11-8 11H770c-22 0-28-8-10-11z" opacity=".75"/>
  <path d="M480 150c36-8 90-7 140 0 18 3 12 9-6 9H488c-16 0-20-6-8-9z" opacity=".6"/>
  <path d="M960 420c30-7 76-6 118 0 15 2 10 8-5 8H968c-14 0-17-5-8-8z" opacity=".5"/>
</svg>`;

const DEFS = `<svg width="0" height="0" style="position:absolute"><defs>
  <radialGradient id="bl-pt" cx=".5" cy="1" r="1.05"><stop offset="0" style="stop-color:var(--bl-petal-in)"/><stop offset="1" style="stop-color:var(--bl-petal-out)"/></radialGradient>
  <radialGradient id="bl-ptd" cx=".5" cy="1" r="1.05"><stop offset="0" style="stop-color:var(--bl-petal-deep-in)"/><stop offset="1" style="stop-color:var(--bl-petal-deep-out)"/></radialGradient>
</defs></svg>`;

/** A single falling petal: fall (outer), sway (middle) and tumble (the petal itself). */
function petal(i, count) {
  // most leave from the branch on the right, a few from anywhere along the top
  const left = i % 3 ? rand(38, 104) : rand(4, 70);
  const size = rand(9, 18);
  const fall = rand(20, 34), sway = rand(3.6, 6.4), tumble = rand(4.5, 9);
  const deep = Math.random() < 0.4;
  return `<div class="bl-petal" style="left:${left.toFixed(1)}%;animation-duration:${fall.toFixed(1)}s;animation-delay:${(-(fall * i) / count - rand(0, 3)).toFixed(1)}s">
    <div class="bl-sway" style="animation-duration:${sway.toFixed(1)}s;animation-delay:${(-rand(0, sway)).toFixed(1)}s">
      <svg class="bl-tumble" viewBox="-11 -24 22 26" style="width:${size.toFixed(0)}px;animation-duration:${tumble.toFixed(1)}s;animation-delay:${(-rand(0, tumble)).toFixed(1)}s"><path d="${PETAL}" fill="url(#bl-pt${deep ? "d" : ""})"/></svg>
    </div>
  </div>`;
}

/** Draw the cherry blossoms into one layer of #scene; returns what undoes it. */
export function mountBlossom(layer, count = 12) {
  layer.innerHTML = DEFS + SKY + `<div class="bl-glow"></div>` + WISPS + branch() + Array.from({ length: count }, (_, i) => petal(i, count)).join("");
  return () => {};
}
