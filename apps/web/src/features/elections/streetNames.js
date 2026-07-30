/**
 * Ukrainian street-name formatting.
 *
 * OpenStreetMap stores `addr:street` in full, and Ukrainian puts the type word
 * on either side of the name — «вулиця Якуба Коласа» but «Жмеринська вулиця».
 * The UI needs a short form for dense lists, so the type word is abbreviated
 * wherever it happens to sit instead of being stripped from a fixed position.
 */

/** Type word → abbreviation. Words with no accepted short form map to `null`. */
const STREET_TYPE_ABBREVIATIONS = {
  вулиця: 'вул.',
  проспект: 'просп.',
  бульвар: 'бул.',
  провулок: 'пров.',
  площа: 'пл.',
  набережна: 'наб.',
  дорога: 'дор.',
  тупик: 'туп.',
  проїзд: 'проїзд',
  узвіз: 'узвіз',
  шосе: 'шосе',
  алея: 'алея',
  масив: 'масив',
  квартал: 'кв-л',
  лінія: 'лінія',
  селище: 'сел.',
};

const STREET_TYPE_PATTERN = new RegExp(
  `(^|\\s)(${Object.keys(STREET_TYPE_ABBREVIATIONS).join('|')})(\\s|$)`,
  'iu',
);

/** «Жмеринська вулиця» → «Жмеринська вул.», «вулиця Зодчих» → «вул. Зодчих». */
export function abbreviateStreet(street) {
  const name = String(street ?? '').trim();

  if (!name) {
    return '';
  }

  return name.replace(STREET_TYPE_PATTERN, (match, before, typeWord, after) => {
    const abbreviation = STREET_TYPE_ABBREVIATIONS[typeWord.toLowerCase()];

    return abbreviation ? `${before}${abbreviation}${after}` : match;
  });
}

/**
 * Sort key that ignores the type word, so «вулиця Зодчих» and «Зарічна вулиця»
 * both sort under their actual name rather than clumping every street under «в».
 */
export function streetSortKey(street) {
  return String(street ?? '')
    .replace(STREET_TYPE_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('uk');
}

/** Orders street names the way a Ukrainian reader expects them in a select. */
export function compareStreetNames(first, second) {
  return streetSortKey(first).localeCompare(streetSortKey(second), 'uk');
}
