/*
 * The banquet list arrives packed (049): a sixth of the size, because 400
 * people opening the page at once put the free plan's server into swap on the
 * 13 Oct load test. This turns it back into the cards the page always had.
 *
 *   {"n": [names], "b": base, "w": with group, "o": with yours, "c": [cards]}
 *   card: [uid, grp if w, flags if o, posted, [entered by], [claimed by] or 0,
 *          full [by, at] or 0, not yet [by, at] or 0, open [by, at] or 0,
 *          likes before [n, by, at] or 0, likes now [n, by, at] or 0]
 *
 * A reply with no `packed` (an older database) is left as it is.
 */
export function unpack(data, key) {
  if (!data?.packed) return data;
  const cards = data.packed.flatMap(({ n, b, w, o, c }) => {
    const at = (t) => new Date((b + t) * 1000).toISOString();
    const mark = (x) => (x ? { by: n[x[0]], at: at(x[1]) } : null);
    const likes = (x) => (x ? { n: x[0], by: n[x[1]], at: at(x[2]) } : null);
    return c.map((v) => {
      let i = 0;
      const card = { uid: String(v[i++]) };
      if (w) card.grp = v[i++];
      if (o) { const f = v[i++] ?? 0; card.claimed = !!(f & 1); card.mine_site = !!(f & 2); }
      const [posted, entered = [], claimed = 0, full = 0, notYet = 0, open = 0, before = 0, now = 0] = v.slice(i);
      const claimedBy = claimed ? claimed.map((x) => n[x]) : [];
      return Object.assign(card, {
        posted: at(posted),
        entered_by: entered.map((x) => n[x]),
        claims: claimedBy.length,
        claimed_by: claimedBy,
        full: full ? n[full[0]] : null,
        full_at: full ? at(full[1]) : null,
        not_yet: mark(notYet),
        open: mark(open),
        likes_before: likes(before),
        likes_now: likes(now),
      });
    });
  });
  const { packed, ...rest } = data;
  return { ...rest, [key]: [...(rest[key] ?? []), ...cards] };
}
