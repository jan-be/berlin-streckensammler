import { describe, expect, test } from 'bun:test';
import { openDb, newCode, normalizeCode } from './db';

describe('codes', () => {
  test('a new code reads back the same however it is typed', () => {
    const c = newCode();
    expect(c).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeCode(c.toLowerCase().replace(/-/g, ' '))).toBe(c);
    expect(normalizeCode('too short')).toBeNull();
    expect(normalizeCode('OOOO-OOOO-OOOO-OOOO')).toBeNull(); // O is not in the alphabet
  });
});

describe('store', () => {
  test('visits are kept per station and mode', () => {
    const s = openDb(':memory:');
    const u = s.createUser();
    expect(s.userForToken(u.token)?.id).toBe(u.id);
    s.setVisit(u.id, 'a', 'U', '2026-10-01');
    s.setVisit(u.id, 'a', 'S', '2026-10-02');
    s.setVisit(u.id, 'a', 'U', '2026-10-03'); // same pair again: new date
    expect(s.visits(u.id)).toEqual([
      { station: 'a', mode: 'U', date: '2026-10-03' },
      { station: 'a', mode: 'S', date: '2026-10-02' },
    ]);
    s.deleteVisit(u.id, 'a', 'S');
    expect(s.visits(u.id).length).toBe(1);
  });

  test('signing in elsewhere merges, keeping the earlier date', () => {
    const s = openDb(':memory:');
    const phone = s.createUser(), laptop = s.createUser();
    s.setVisit(phone.id, 'a', 'U', '2026-09-01');
    s.setVisit(laptop.id, 'a', 'U', '2026-10-01');
    s.setVisit(laptop.id, 'b', 'S', '2026-10-02');
    s.mergeInto(laptop.id, phone.id);
    expect(s.visits(phone.id).sort((x, y) => x.station.localeCompare(y.station))).toEqual([
      { station: 'a', mode: 'U', date: '2026-09-01' },
      { station: 'b', mode: 'S', date: '2026-10-02' },
    ]);
    expect(s.userForToken(laptop.token)).toBeNull(); // its account is gone with its sessions
  });

  test('deleting the account deletes its visits and sessions', () => {
    const s = openDb(':memory:');
    const u = s.createUser();
    s.setVisit(u.id, 'a', 'U', '2026-10-01');
    s.deleteUser(u.id);
    expect(s.userForToken(u.token)).toBeNull();
    expect(s.visits(u.id)).toEqual([]);
  });
});
