// File ownership. Agents cooperate by not overlapping, so a claim is granted
// or refused - never negotiated. This is the scope fence: work outside your
// claim is drift, and it is detectable rather than discovered at merge time.
//
// Two patterns conflict when SOME path could match both. That is a language
// intersection question, and it is answered here symbolically - no filesystem,
// no expansion, so the same answer comes back for a repo that does not exist
// yet as for one that does.

export function claimFiles(claims, agentId, patterns) {
  const conflicts = [];
  for (const [holder, held] of Object.entries(claims)) {
    if (holder === agentId) continue;
    for (const pattern of patterns) {
      for (const existing of held) {
        if (patternsOverlap(existing, pattern)) conflicts.push({ holder, pattern, existing });
      }
    }
  }
  if (conflicts.length > 0) return { claims, granted: false, conflicts };
  return { claims: { ...claims, [agentId]: patterns.slice() }, granted: true, conflicts };
}

export function releaseClaim(claims, agentId) {
  const next = { ...claims };
  delete next[agentId];
  return next;
}

export function holderOf(claims, filePath) {
  for (const [agentId, patterns] of Object.entries(claims)) {
    if (patterns.some((pattern) => matchesPattern(pattern, filePath))) return agentId;
  }
  return null;
}

// True when the agent may touch this path: either it holds it, or nobody does.
export function checkFence(claims, agentId, filePath) {
  const holder = holderOf(claims, filePath);
  return holder === null || holder === agentId;
}

// A concrete path is a pattern that matches exactly one string, so matching is
// the same question as overlapping. One algorithm, one set of edge cases.
export function matchesPattern(pattern, filePath) {
  return patternsOverlap(pattern, String(filePath ?? ''));
}

export function patternsOverlap(a, b) {
  return segmentsOverlap(splitPattern(a), splitPattern(b), new Set());
}

// `src/` means the directory and everything under it. Anything else is taken
// literally, so `src/replay` never silently claims `src/replay-old`.
function splitPattern(pattern) {
  const text = String(pattern ?? '').replace(/^\.\//, '');
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.');
  return /\/$/.test(text) && segments.length > 0 ? [...segments, '**'] : segments;
}

// `**` matches zero or more whole segments, so it has to try both.
function segmentsOverlap(a, b, seen) {
  const key = `${a.length}|${b.length}|${a.join('/')}|${b.join('/')}`;
  if (seen.has(key)) return false;
  seen.add(key);

  if (a.length === 0) return b.every(isDoubleStar);
  if (b.length === 0) return a.every(isDoubleStar);

  if (isDoubleStar(a[0])) {
    return segmentsOverlap(a.slice(1), b, seen) || segmentsOverlap(a, b.slice(1), seen);
  }
  if (isDoubleStar(b[0])) {
    return segmentsOverlap(a, b.slice(1), seen) || segmentsOverlap(a.slice(1), b, seen);
  }
  return segmentsIntersect(a[0], b[0]) && segmentsOverlap(a.slice(1), b.slice(1), seen);
}

function isDoubleStar(segment) {
  return segment === '**';
}

// Do two single-segment globs share any string? `*` stands for any run of
// characters inside one segment, `?` for exactly one. Walking both patterns
// together answers it without ever building a candidate string.
function segmentsIntersect(x, y) {
  const memo = new Set();

  const walk = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return false;
    memo.add(key);

    if (i === x.length && j === y.length) return true;
    if (i === x.length) return restIsStars(y, j);
    if (j === y.length) return restIsStars(x, i);

    // A star absorbs nothing, or one more character from the other side.
    if (x[i] === '*') return walk(i + 1, j) || walk(i, j + 1);
    if (y[j] === '*') return walk(i, j + 1) || walk(i + 1, j);

    if (x[i] === '?' || y[j] === '?') return walk(i + 1, j + 1);
    return x[i] === y[j] && walk(i + 1, j + 1);
  };

  return walk(0, 0);
}

function restIsStars(pattern, from) {
  for (let i = from; i < pattern.length; i += 1) if (pattern[i] !== '*') return false;
  return true;
}
