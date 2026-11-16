// Exact matches can be used automatically. Abbreviations and lookalike names
// are evidence for the reviewer, never authorization to merge two builds.
const generic = /^(timeline photos|mobile uploads|profile pictures|cover photos|untitled album|instagram photos|photos from .*)$/i;
const branding = /^(profile pictures|cover photos)$/i;
const words = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normalize = name => words(String(name || '').replace(/\s*[-–:(]\s*(photos|progress|updates)\)?\s*$/i, ''));

export function albumCollectionKind(name) {
  const title = String(name || '').trim();
  return branding.test(title) ? 'branding' : generic.test(title) ? 'generic' : 'project';
}

// One spelling edit is a review hint only; never use it as an automatic match.
function nearWord(a, b) {
  if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.length === long.length ? short.slice(i + 1) === long.slice(i + 1)
    : short.slice(i) === long.slice(i + 1);
}

export function classifyAlbum(name, targets, genericWords) {
  const title = normalize(name);
  const tokens = title.split(' ').filter(Boolean);
  const collection = albumCollectionKind(name);
  if (collection !== 'project') return { kind: collection, candidates: [] };
  if (!tokens.length) return { kind: 'unmatched', candidates: [] };
  const exact = targets.filter(t => normalize(t.name) === title);
  if (exact.length) return { kind: exact.length === 1 && tokens.length > 1 ? 'exact' : 'review', candidates: exact };
  const anchors = tokens.filter(w => w.length >= 3 && !genericWords.has(w));
  const related = anchors.length ? targets.map(t => {
    const target = new Set(normalize(t.name).split(' '));
    const exactAnchors = anchors.filter(w => target.has(w)).length;
    const shared = tokens.filter(w => target.has(w)).length;
    const spellingHint = anchors.some(a => [...target].some(w => !genericWords.has(w) && nearWord(a, w)));
    return { t, exactAnchors, shared, spellingHint };
  }).filter(c => c.exactAnchors > 0 || c.spellingHint).sort((a,b) => b.shared-a.shared || b.exactAnchors-a.exactAnchors || a.t.name.localeCompare(b.t.name)).map(c => c.t) : [];
  return { kind: related.length ? 'review' : 'unmatched', candidates: related };
}
