// Keep the slug itself below the common 255-byte filesystem component limit.
// works-/notes- plus .html consume 11 bytes, while atomic writes temporarily add
// .tmp-<pid>-<UUID> (up to about 52 bytes). 180 leaves roughly 12 bytes of extra
// headroom after both wrappers and still reserves space for unique suffixes.
const MAX_SLUG_BYTES = 180;

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

function truncateSlug(slug, maxBytes = MAX_SLUG_BYTES) {
  if (Buffer.byteLength(slug, 'utf8') <= maxBytes) return slug;
  let truncated = '';
  for (const character of slug) {
    if (Buffer.byteLength(truncated + character, 'utf8') > maxBytes) break;
    truncated += character;
  }
  return truncated.replace(/-+$/g, '') || 'content';
}

function createUniqueSlug(title, usedSlugs = new Set()) {
  const base = truncateSlug(baseSlug(title));
  let candidate = base;
  let suffix = 2;
  while (usedSlugs.has(candidate)) {
    const uniqueSuffix = `-${suffix}`;
    candidate = `${truncateSlug(base, MAX_SLUG_BYTES - Buffer.byteLength(uniqueSuffix, 'utf8'))}${uniqueSuffix}`;
    suffix += 1;
  }
  return candidate;
}

// Slugs are assigned only when a work, note or lab project is created. Title edits
// must not recalculate them: previously shared URLs remain stable.
module.exports = {
  MAX_SLUG_BYTES,
  baseSlug,
  createUniqueSlug,
  truncateSlug,
};
