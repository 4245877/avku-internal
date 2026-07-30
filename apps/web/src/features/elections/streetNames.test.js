import { describe, expect, it } from 'vitest';

import { abbreviateStreet, compareStreetNames, streetSortKey } from './streetNames.js';

describe('abbreviateStreet', () => {
  it('abbreviates a leading type word', () => {
    expect(abbreviateStreet('вулиця Якуба Коласа')).toBe('вул. Якуба Коласа');
    expect(abbreviateStreet('проспект Леся Курбаса')).toBe('просп. Леся Курбаса');
    expect(abbreviateStreet('бульвар Вацлава Гавела')).toBe('бул. Вацлава Гавела');
    expect(abbreviateStreet('провулок Зодчих')).toBe('пров. Зодчих');
  });

  it('abbreviates a trailing type word, which Ukrainian uses just as often', () => {
    expect(abbreviateStreet('Жмеринська вулиця')).toBe('Жмеринська вул.');
    expect(abbreviateStreet('Берестейський проспект')).toBe('Берестейський просп.');
    expect(abbreviateStreet('Кільцева дорога')).toBe('Кільцева дор.');
  });

  it('leaves names without an abbreviated form alone', () => {
    expect(abbreviateStreet('Кільцеве шосе')).toBe('Кільцеве шосе');
    expect(abbreviateStreet('Андріївський узвіз')).toBe('Андріївський узвіз');
  });

  it('does not touch a name that merely contains the type word', () => {
    expect(abbreviateStreet('Вулиценка')).toBe('Вулиценка');
  });

  it('handles missing values', () => {
    expect(abbreviateStreet(undefined)).toBe('');
    expect(abbreviateStreet('  ')).toBe('');
  });
});

describe('streetSortKey', () => {
  it('sorts by the name, not by the type word', () => {
    expect(streetSortKey('вулиця Зодчих')).toBe('зодчих');
    expect(streetSortKey('Зарічна вулиця')).toBe('зарічна');
  });
});

describe('compareStreetNames', () => {
  it('interleaves both word orders alphabetically', () => {
    const sorted = [
      'вулиця Якуба Коласа',
      'Зарічна вулиця',
      'проспект Леся Курбаса',
      'Жмеринська вулиця',
    ].sort(compareStreetNames);

    expect(sorted).toEqual([
      'Жмеринська вулиця',
      'Зарічна вулиця',
      'проспект Леся Курбаса',
      'вулиця Якуба Коласа',
    ]);
  });
});
