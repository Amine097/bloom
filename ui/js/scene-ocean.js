// The third backdrop: a calm sea at sunset seen from the dunes (by night, the moon over the same
// sea). Like the others it is purely decorative and drawn here with no image files.
//
// Light on the CPU: the still picture is one SVG; only small pieces move, each in its own element
// and only with CSS transform/opacity animations (the browser stops them when the window is
// hidden; reduced motion pauses them). Those pieces are placed in the same 1200×800 drawing as
// the still picture with `.oc-at` (styles.css), which follows the picture's "slice" scaling, so a
// glint stays on the sun's path and a wave on the sea at any window size.

/** A repeatable random sequence, so the sea looks the same at every launch. */
function seeded(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

const HORIZON = 520;
const SUN_X = 800;
/** Where the sea meets the sand, at each x of the drawing. */
const shore = x => 698 + 0.03 * x + 7 * Math.sin(x / 150 + 1);

/** A smooth path through points (quadratic curves through the midpoints). */
function smooth(points) {
  let d = `M${points[0][0]} ${points[0][1].toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i], [nx, ny] = points[i + 1];
    d += `Q${x} ${y.toFixed(1)} ${((x + nx) / 2).toFixed(1)} ${((y + ny) / 2).toFixed(1)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return d + `L${lx} ${ly.toFixed(1)}`;
}

const SHORE_POINTS = Array.from({ length: 31 }, (_, i) => [i * 40, shore(i * 40)]);
const SHORE_LINE = smooth(SHORE_POINTS);

/** A piece of the drawing placed over the still picture: x, y, width, height in drawing units. */
const at = (x, y, w, h, extra = "") => `class="oc-at${extra ? " " + extra : ""}" style="--x:${x};--y:${y};--w:${w};--h:${h}"`;

function stars() {
  const next = seeded(23);
  let out = "";
  for (let i = 0; i < 90; i++) {
    const x = next() * 1200, y = 40 + Math.pow(next(), 1.4) * 440;
    out += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(0.5 + next() * 1.1).toFixed(1)}" opacity="${(0.25 + next() * 0.6).toFixed(2)}"/>`;
  }
  return out;
}

const BACK = `<svg class="oc-back" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMax slice">
  <defs>
    <linearGradient id="oc-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style="stop-color:var(--oc-sky1)"/><stop offset=".32" style="stop-color:var(--oc-sky2)"/>
      <stop offset=".56" style="stop-color:var(--oc-sky3)"/><stop offset=".8" style="stop-color:var(--oc-sky4)"/><stop offset=".98" style="stop-color:var(--oc-sky5)"/>
    </linearGradient>
    <linearGradient id="oc-sea" x1="0" y1="${HORIZON}" x2="0" y2="760" gradientUnits="userSpaceOnUse">
      <stop offset="0" style="stop-color:var(--oc-sea1)"/><stop offset=".35" style="stop-color:var(--oc-sea2)"/><stop offset="1" style="stop-color:var(--oc-sea3)"/>
    </linearGradient>
    <radialGradient id="oc-glow"><stop offset="0" style="stop-color:var(--oc-glow)" stop-opacity=".85"/><stop offset=".3" style="stop-color:var(--oc-glow)" stop-opacity=".35"/><stop offset="1" style="stop-color:var(--oc-glow)" stop-opacity="0"/></radialGradient>
    <filter id="oc-soft" x="-.3" y="-.1" width="1.6" height="1.2"><feGaussianBlur stdDeviation="9"/></filter>
    <radialGradient id="oc-disc"><stop offset=".3" style="stop-color:var(--oc-sun)"/><stop offset="1" style="stop-color:var(--oc-sun-rim)"/></radialGradient>
    <radialGradient id="oc-seaglow"><stop offset="0" style="stop-color:var(--oc-glow)" stop-opacity=".7"/><stop offset="1" style="stop-color:var(--oc-glow)" stop-opacity="0"/></radialGradient>
    <linearGradient id="oc-path" x1="0" y1="${HORIZON}" x2="0" y2="730" gradientUnits="userSpaceOnUse">
      <stop offset="0" style="stop-color:var(--oc-glint)" stop-opacity=".75"/><stop offset="1" style="stop-color:var(--oc-glint)" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="oc-sand" x1="0" y1="680" x2="0" y2="800" gradientUnits="userSpaceOnUse">
      <stop offset="0" style="stop-color:var(--oc-sand1)"/><stop offset="1" style="stop-color:var(--oc-sand2)"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="${HORIZON + 2}" fill="url(#oc-sky)"/>
  <g class="oc-stars">${stars()}</g>
  <g class="oc-sun">
    <circle cx="${SUN_X}" cy="${HORIZON - 30}" r="270" fill="url(#oc-glow)"/>
    <circle cx="${SUN_X}" cy="${HORIZON - 4}" r="40" fill="url(#oc-disc)"/>
  </g>
  <g class="oc-moon">
    <circle cx="${SUN_X}" cy="250" r="170" fill="url(#oc-glow)"/>
    <circle cx="${SUN_X}" cy="250" r="25" fill="url(#oc-disc)"/>
    <g style="fill:var(--oc-crater)"><circle cx="${SUN_X - 8}" cy="244" r="6"/><circle cx="${SUN_X + 9}" cy="257" r="4.5"/><circle cx="${SUN_X + 6}" cy="240" r="2.6"/><circle cx="${SUN_X - 6}" cy="262" r="2.2"/></g>
  </g>
  <path style="fill:var(--oc-far)" d="M0 ${HORIZON + 1}V496C46 488 98 489 146 498 196 506 232 514 300 ${HORIZON + 1}z"/>
  <path style="fill:var(--oc-far2)" d="M0 ${HORIZON + 1}V506C60 501 120 504 176 512 200 515 216 518 236 ${HORIZON + 1}z"/>
  <path style="fill:var(--oc-far)" d="M1062 ${HORIZON + 1}C1080 512 1104 509 1124 511 1140 513 1150 517 1158 ${HORIZON + 1}z" opacity=".8"/>
  <rect y="${HORIZON}" width="1200" height="${800 - HORIZON}" fill="url(#oc-sea)"/>
  <ellipse cx="${SUN_X}" cy="${HORIZON + 14}" rx="420" ry="70" fill="url(#oc-seaglow)"/>
  <path d="M${SUN_X - 18} ${HORIZON + 1}H${SUN_X + 18}L${SUN_X + 110} 730H${SUN_X - 110}z" fill="url(#oc-path)" opacity=".6" filter="url(#oc-soft)"/>
  <rect y="${HORIZON - 1}" width="1200" height="2.5" style="fill:var(--oc-line)"/>
  <path d="${SHORE_LINE}V800H0z" fill="url(#oc-sand)"/>
  <path d="${SHORE_LINE}" fill="none" style="stroke:var(--oc-wet)" stroke-width="14" transform="translate(0 6)"/>
</svg>`;

/** Short arcs on the water, smaller and denser toward the horizon; two layers drift apart slowly. */
function waves() {
  const next = seeded(5);
  const layers = ["", ""];
  for (let i = 0; i < 260; i++) {
    const t = next(), x = next() * 1200;
    const y = HORIZON + 4 + Math.pow(t, 1.6) * 210;
    if (y > shore(x) - 8) continue;
    const p = (y - HORIZON) / 210;
    const len = 12 + p * 70 + next() * 24, amp = 0.6 + p * 3.4, sw = (0.5 + p * 1.7).toFixed(2);
    const arc = (dy, cls) => `<path class="${cls}" stroke-width="${sw}" d="M${(x - len / 2).toFixed(0)} ${(y + dy).toFixed(1)}q${(len / 4).toFixed(1)} ${(-amp).toFixed(1)} ${(len / 2).toFixed(1)} 0t${(len / 2).toFixed(1)} 0"/>`;
    layers[i % 2] += arc(0, "oc-crest") + (next() < 0.55 ? arc(1.4 + p * 3, "oc-trough") : "");
  }
  const box = (k, svg) => `<svg ${at(0, HORIZON, 1200, 230, `oc-waves oc-waves-${k}`)} viewBox="0 ${HORIZON} 1200 230" preserveAspectRatio="none">${svg}</svg>`;
  return box("a", layers[0]) + box("b", layers[1]);
}

/** The sun's (or moon's) path on the water: short glints in three layers that shimmer in turn. */
function glints() {
  const next = seeded(41);
  const layers = ["", "", ""];
  for (let y = HORIZON + 2; y < 730;) {
    const p = (y - HORIZON) / 210, half = 12 + p * 118;
    for (let k = 0; k < 2 + Math.floor(p * 4); k++) {
      const x = SUN_X + (next() + next() - 1) * half;
      if (y > shore(x) - 5) continue;
      const len = (3 + p * 24) * (0.5 + next());
      layers[Math.floor(next() * 3)] += `<line x1="${(x - len / 2).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + len / 2).toFixed(1)}" y2="${y.toFixed(1)}" stroke-width="${(0.9 + p * 2.4).toFixed(2)}"/>`;
    }
    y += 2.2 + p * 7 + next() * 2;
  }
  return layers.map((g, k) => `<svg ${at(SUN_X - 160, HORIZON, 320, 215, `oc-glints oc-glints-${k}`)} viewBox="${SUN_X - 160} ${HORIZON} 320 215" preserveAspectRatio="none">${g}</svg>`).join("");
}

/** A long low cloud: a flat base with a few soft humps, and a brighter rim where the sun lights it. */
function cloud(x, y, w, h, o = 1) {
  const p = (fx, fy) => `${(x + w * fx).toFixed(0)} ${(y - h * fy).toFixed(1)}`;
  return `<g opacity="${o}"><path class="oc-cl" d="M${p(0, 0)}C${p(.08, .4)} ${p(.18, .85)} ${p(.3, .7)}C${p(.38, 1.25)} ${p(.56, 1.2)} ${p(.63, .7)}C${p(.72, .95)} ${p(.88, .65)} ${p(1, 0)}z"/>`
    + `<path class="oc-cl-lit" d="M${p(.08, .16)}C${p(.3, .3)} ${p(.7, .3)} ${p(.97, .1)}L${p(1, 0)}H${(x + w * .05).toFixed(0)}z"/></g>`;
}

/** Long thin evening clouds lit from below, drifting on their own layer. */
const CLOUDS = `<svg ${at(0, 120, 1200, 380, "oc-clouds")} viewBox="0 120 1200 380" preserveAspectRatio="none">
  ${cloud(60, 236, 330, 20)}${cloud(660, 186, 260, 15, 0.8)}${cloud(330, 330, 230, 13, 0.75)}${cloud(930, 300, 250, 16, 0.85)}
  ${cloud(560, 438, 360, 9, 0.9)}${cloud(150, 412, 200, 7, 0.6)}${cloud(980, 462, 200, 6, 0.7)}
</svg>`;

/** Brighter stars that twinkle (night only). */
function twinkles() {
  const next = seeded(61);
  const groups = ["", ""];
  for (let i = 0; i < 16; i++) {
    const x = next() * 1200, y = 70 + next() * 360, s = 2.4 + next() * 3;
    if (Math.abs(x - SUN_X) < 60 && Math.abs(y - 250) < 60) continue; // not over the moon
    groups[i % 2] += `<path d="M${x.toFixed(0)} ${(y - s).toFixed(1)}Q${x.toFixed(0)} ${y.toFixed(0)} ${(x + s).toFixed(1)} ${y.toFixed(0)}Q${x.toFixed(0)} ${y.toFixed(0)} ${x.toFixed(0)} ${(y + s).toFixed(1)}Q${x.toFixed(0)} ${y.toFixed(0)} ${(x - s).toFixed(1)} ${y.toFixed(0)}Q${x.toFixed(0)} ${y.toFixed(0)} ${x.toFixed(0)} ${(y - s).toFixed(1)}z"/>`;
  }
  return groups.map((g, k) => `<svg ${at(0, 60, 1200, 380, `oc-twinkle oc-twinkle-${k}`)} viewBox="0 60 1200 380" preserveAspectRatio="none">${g}</svg>`).join("");
}

/** A small sailboat far out, drifting along the horizon and rocking a little. */
const BOAT = `<div ${at(350, HORIZON - 40, 46, 44, "oc-boat")}><svg viewBox="0 0 46 44" preserveAspectRatio="none">
  <path d="M22 4V36" style="stroke:var(--oc-boat)" stroke-width="1.2"/>
  <path d="M23.5 6C30 14 36 24 39 34H23.5z" style="fill:var(--oc-sail)"/>
  <path d="M20.5 10C15 18 11 26 8 34H20.5z" style="fill:var(--oc-sail)" opacity=".85"/>
  <path d="M5 36H42L37 41H10z" style="fill:var(--oc-boat)"/>
  <circle class="oc-lantern" cx="22" cy="20" r="1.6"/>
</svg></div>`;

/** Seagulls far away: each glides along its own slow loop and beats its wings now and then. */
const GULLS = [[300, 250, 1], [356, 226, 0.75], [990, 190, 0.9], [560, 330, 0.6]];
const GULL = `<path d="M-13 1C-9-4-4-5 0 0 4-5 9-4 13 1" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`;
function gulls() {
  const next = seeded(3);
  return GULLS.map(([x, y, k], i) => {
    const glide = (34 + next() * 26).toFixed(0), flap = (5 + next() * 4).toFixed(1);
    return `<div ${at(x, y, (28 * k).toFixed(1), (11 * k).toFixed(1), "oc-gull")}><div class="oc-glide" style="animation-duration:${glide}s;animation-delay:-${(next() * 30).toFixed(0)}s;--gx:${((i % 2 ? -1 : 1) * (260 + next() * 240)).toFixed(0)}%">
      <svg viewBox="-14 -6 28 11" preserveAspectRatio="none" style="animation-duration:${flap}s;animation-delay:-${(next() * 5).toFixed(1)}s">${GULL}</svg></div></div>`;
  }).join("");
}

/** The edge of each wave washing up the sand and back. */
const FOAM = `<svg ${at(0, 670, 1200, 100, "oc-foam")} viewBox="0 670 1200 100" preserveAspectRatio="none">
  <path d="${SHORE_LINE}" fill="none" class="oc-foam-edge" stroke-width="3.2" stroke-linecap="round"/>
  <path d="${SHORE_LINE}" fill="none" class="oc-foam-lace" stroke-width="1.4" stroke-dasharray="26 9 6 12" transform="translate(0 4.5)"/>
</svg>`;

/** Marram grass: a tuft of blades from (x, y). */
function tuft(next, x, y, n, h) {
  let out = "";
  for (let k = 0; k < n; k++) {
    const lean = (next() - 0.5) * h * 0.9, tall = h * (0.55 + next() * 0.5), bx = x + (next() - 0.5) * 10;
    out += `<path d="M${bx.toFixed(1)} ${y}q${(lean * 0.2).toFixed(1)} ${(-tall * 0.6).toFixed(1)} ${lean.toFixed(1)} ${(-tall).toFixed(1)}"/>`;
  }
  return out;
}

/** The dunes in front: a big one bottom left with grass and an old fence, a small one bottom right. */
function dunes() {
  const next = seeded(17);
  const grassL = tuft(next, 34, 612, 9, 40) + tuft(next, 98, 606, 8, 34) + tuft(next, 168, 618, 7, 30) + tuft(next, 226, 650, 6, 24) + tuft(next, 282, 690, 4, 18);
  const grassR = tuft(next, 1066, 730, 6, 26) + tuft(next, 1112, 718, 7, 30) + tuft(next, 1170, 714, 5, 22);
  const posts = [[262, 650, 24], [298, 674, 22], [334, 701, 20], [370, 729, 18], [404, 754, 16]];
  const fence = posts.map(([x, y, h]) => `<path d="M${x} ${y + 3}l2 ${-h}"/>`).join("")
    + `<path class="oc-rope" d="${posts.map(([x, y, h], k) => {
      const tx = x + 1.5, ty = y + 3 - h * 0.72;
      if (!k) return `M${tx} ${ty}`;
      const [px, py, ph] = posts[k - 1], sx = px + 1.5, sy = py + 3 - ph * 0.72;
      return `Q${(sx + tx) / 2} ${((sy + ty) / 2 + 4).toFixed(1)} ${tx} ${ty}`; // the rope sags between posts
    }).join("")}"/>`;
  return `<svg ${at(0, 560, 520, 240, "oc-dune")} viewBox="0 560 520 240" preserveAspectRatio="none">
    <path class="oc-dune-back" d="M0 800V600C44 588 96 588 146 600 210 616 262 646 312 684 352 714 388 744 424 768 446 782 470 792 500 800z"/>
    <path class="oc-dune-front" d="M0 800V628C50 610 106 608 156 620 214 634 254 664 292 698 324 728 350 760 372 800z"/>
    <path class="oc-dune-shade" d="M156 620C214 634 254 664 292 698 324 728 350 760 372 800H318C300 760 270 720 236 690 210 666 186 640 156 620z"/>
    <g class="oc-fence">${fence}</g>
    <g class="oc-grass">${grassL}</g>
  </svg>
  <svg ${at(940, 660, 300, 140, "oc-dune")} viewBox="940 660 300 140" preserveAspectRatio="none">
    <path class="oc-dune-back" d="M950 800C990 770 1030 740 1070 726 1110 712 1160 710 1240 716V800z"/>
    <path class="oc-dune-front" d="M1010 800C1040 780 1070 762 1104 752 1140 742 1190 740 1240 744V800z"/>
    <g class="oc-grass">${grassR}</g>
  </svg>`;
}

/** Draw the ocean into one layer of #scene; returns what undoes it. */
export function mountOcean(layer) {
  layer.classList.add("oc");
  layer.innerHTML = BACK + CLOUDS + twinkles() + `<div ${at(SUN_X - 300, HORIZON - 320, 600, 600, "oc-shine")}></div>` + gulls() + BOAT + waves() + glints() + FOAM + dunes();
  return () => {};
}
