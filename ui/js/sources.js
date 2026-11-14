// What a quiz can be about: a lecture (its id in D.items) or a fiche ("fiche:<id>", D.fiches).
// Both keep a question bank of the same shape; this is the one place that tells them apart.
import { D } from "./store.js";

export const FICHE = "fiche:";
export const isFicheSrc = s => typeof s === "string" && s.startsWith(FICHE);
export const ficheSrc = id => FICHE + id;
export const ficheIdOf = s => (isFicheSrc(s) ? s.slice(FICHE.length) : null);
/** The fiche behind source `s`, or null (a lecture, or a deleted fiche). */
export const srcFiche = s => (isFicheSrc(s) ? D.fiches?.[ficheIdOf(s)] || null : null);
export const srcExists = s => (isFicheSrc(s) ? Boolean(srcFiche(s)) : Boolean(D.items[s]));
export const srcTitle = s => (isFicheSrc(s) ? srcFiche(s)?.title ?? "A deleted fiche" : D.items[s]?.title ?? "A deleted lecture");
/** The module ids of source `s`: a lecture's module, or the modules a fiche covers. */
export const srcModules = s => (isFicheSrc(s) ? srcFiche(s)?.modules || [] : D.items[s]?.module ? [D.items[s].module] : []);

/** Whether a fiche can be quizzed: an uploaded PDF, or a generated sheet that is written. */
export const ficheQuizzable = f => Boolean(f && (f.source === "uploaded" ? f.pdf : f.status === "done"));
/** Whether source `s` can get new questions now. */
export const srcQuizzable = s => (isFicheSrc(s) ? ficheQuizzable(srcFiche(s)) : Boolean(D.items[s]?.pdf));

/** "3 lectures", "1 fiche", "2 lectures and 1 fiche" for a list of sources. */
export function srcCount(ids) {
  const f = ids.filter(isFicheSrc).length, l = ids.length - f;
  const part = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return [l && part(l, "lecture"), f && part(f, "fiche")].filter(Boolean).join(" and ") || "0 lectures";
}
