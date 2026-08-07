function baseSlug(title) {
  const source = String(title ?? '').normalize('NFKC').trim().toLowerCase();
  const pieces = [];
  let ascii = '';

  function flushAscii() {
    const normalized = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (normalized) pieces.push(normalized);
    ascii = '';
  }

  for (const character of source) {
    if (/^[a-z0-9]$/.test(character)) {
      ascii += character;
    } else if (/^[\s_-]$/.test(character)) {
      ascii += '-';
    } else {
      flushAscii();
      pieces.push(`u${character.codePointAt(0).toString(16)}`);
    }
  }
  flushAscii();
  return pieces.join('-').replace(/-+/g, '-') || 'content';
}

function createUniqueSlug(title, usedSlugs = new Set()) {
  const base = baseSlug(title);
  let candidate = base;
  let suffix = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

module.exports = { baseSlug, createUniqueSlug };
