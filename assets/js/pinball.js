/*
 * Mad Invention pinball: what a stack of pinballs is actually worth.
 *
 * The board is a flat lottery. Every ball rolls once against the table below,
 * and the multiplier is not a bonus -- one push at x40 spends 40 balls and pays
 * 40 times, which averages out to the same yield as forty pushes at x1. So the
 * multiplier never changes what a stack is worth on average, which is worth
 * saying out loud: "x40" reads like a bonus, and players hoard balls waiting to
 * earn one.
 *
 * What it does change is the spread, and that is not a footnote. A x40 push
 * drops ONE ball and pays its slot forty times -- it is not forty balls. So a
 * stack spent at x40 is a hundred-odd rolls of the dice rather than a few
 * thousand, and the swing on anything rare grows by the square root of the
 * multiplier. Same average, six times the variance. Candy barely notices;
 * Camp raids swing from a third to nearly double. That trade is the only real
 * decision the board offers, so the page prices it.
 *
 * The odds and the payouts were read off the in-game tooltips by hand (tap a
 * slot and it tells you its chance), not off any wiki -- the event is not
 * documented anywhere. They sum to exactly 100%, which is the one thing that
 * says the table is complete rather than merely plausible, so the page checks
 * that sum and complains when an edit breaks it.
 *
 * Payouts scale with something -- level, or the event -- so every number here is
 * a default in an editable field rather than a constant. Next event the shape
 * of the board will be the same and the numbers will not.
 */

/* Read off the board in game, 2026-09-10, at x1.

   `per` is how many of `token` one hit grants; the board draws that as a little
   bubble above the slot (x4, x1, x1). The two specials carry no fixed payout at
   all -- see the note on each -- so they count hits and nothing else, which is
   exactly what you want to know about them anyway. */
export const OUTCOMES = [
  { key: 'slot1', label: 'Slot 1', candy: 230, token: 'lightbulb', per: 4, chance: 25.5 },
  { key: 'slot2', label: 'Slot 2', candy: 460, token: 'pickaxe', per: 1, chance: 22 },
  /* The "?" slot. Grants a chance to raid a friend's Camp -- a chance at a
     chance, and what the raid itself pays depends on the friend. Hits only. */
  { key: 'raid', label: 'Slot 3 "?"', candy: 0, token: 'raid', per: 1, chance: 1.7 },
  { key: 'slot4', label: 'Slot 4', candy: 460, token: 'energy', per: 1, chance: 22 },
  { key: 'slot5', label: 'Slot 5', candy: 230, token: null, per: 0, chance: 25.5 },
  /* The gift box in the middle of the playfield, not one of the five slots.
     Grants a Reward Card, whose contents vary. Hits only. */
  { key: 'card', label: 'Gift box', candy: 0, token: 'card', per: 1, chance: 3.3 },
];

/* Everything a hit can hand you that is not candy, in the order the page lists
   it: the three you get a fixed count of, then the two you can only count. */
export const TOKENS = [
  { key: 'lightbulb', label: 'Lightbulbs', note: 'the event bar' },
  { key: 'pickaxe', label: 'Pickaxes', note: '' },
  { key: 'energy', label: 'Energy Drinks', note: '' },
  { key: 'card', label: 'Reward Cards', note: 'contents vary' },
  { key: 'raid', label: 'Camp raids', note: 'contents vary' },
];

export const totalChance = (outcomes = OUTCOMES) =>
  outcomes.reduce((sum, o) => sum + o.chance, 0);

/*
 * What `balls` balls are worth on average. The multiplier is deliberately not a
 * parameter: it cannot move any of these, and taking it would invite the belief
 * that it could. See spread() for the half of the answer it does move.
 */
export function expected(balls, outcomes = OUTCOMES) {
  const out = { candy: 0, hits: {} };
  for (const t of TOKENS) out[t.key] = 0;
  for (const o of outcomes) {
    const hits = balls * (o.chance / 100);
    out.hits[o.key] = hits;
    out.candy += hits * o.candy;
    if (o.token) out[o.token] += hits * o.per;
  }
  return out;
}

/*
 * How far a real run lands from expected(), as one standard deviation.
 *
 * A push is one roll of the table paid `mult` times over, so a stack of `balls`
 * is floor(balls / mult) independent rolls -- not `balls` of them. Each roll is
 * the same lottery, so the totals are a sum of independent draws: the variance
 * adds, and the deviation is mult * sqrt(rolls) * sigma-of-one-roll. That works
 * out to sigma scaling with sqrt(mult * balls), which is the whole finding in
 * one line -- x40 is a little over six times the swing of x1 on the same stack,
 * for exactly the same average.
 *
 * One sigma, not two: about two runs in three land inside it. It is the honest
 * width of "give or take", which is the question being asked, and a 95% band
 * would be wide enough to read as though the page knew nothing.
 */
export function spread(balls, mult = 1, outcomes = OUTCOMES) {
  const rolls = Math.floor(balls / Math.max(1, mult));
  const out = {};
  for (const key of ['candy', ...TOKENS.map((t) => t.key)]) {
    /* First and second moments of one roll's payout in this one resource. */
    let mean = 0;
    let square = 0;
    for (const o of outcomes) {
      const paid = key === 'candy' ? o.candy : (o.token === key ? o.per : 0);
      const p = o.chance / 100;
      mean += p * paid;
      square += p * paid * paid;
    }
    /* Clamped: a table edited to over 100% can push this a hair below zero. */
    const variance = Math.max(0, square - mean * mean);
    out[key] = mult * Math.sqrt(rolls * variance);
  }
  return out;
}

/*
 * The two specials, once you have measured them.
 *
 * A Reward Card and a Camp raid are each a second roll, and the page cannot know
 * what is inside one -- a raid can land on a whole minigame (a radish run pays
 * out on how many players guess right), and a card pays candy, pinballs and
 * energy cans in amounts nobody has written down. So the honest default is zero:
 * the headline figures are what the BOARD pays, and everything here is off by
 * however much the specials are worth.
 *
 * Rather than guess, this takes what you have seen. Open twenty cards, average
 * them, type the average in, and the numbers above stop being a floor. Zero
 * leaves them exactly as they were, which is why zero is the default and not a
 * placeholder pretending to be a measurement.
 *
 * The multiplier needs no special handling here. Whether a x40 gift box hands
 * you forty cards or one card paying forty times, the expected card COUNT
 * already carries the multiplier -- so the yield per card is a per-card number
 * either way, and multiplying twice would be the bug.
 */
export function withSpecials(ev, per) {
  const cards = ev.card ?? 0;
  const raids = ev.raid ?? 0;
  return {
    candy: ev.candy + cards * (per.cardCandy || 0) + raids * (per.raidCandy || 0),
    /* Pinballs a card hands back. Not folded into anything: they are stock, not
       yield, and what you do with them is another run of this same page. */
    balls: cards * (per.cardBalls || 0),
    energy: ev.energy + cards * (per.cardEnergy || 0),
  };
}

/*
 * The tree cap. Eight trees grow a harvest on a timer, and the game refuses the
 * claim while your stock is over the cap -- so a hoarded stack does not merely
 * sit there, it quietly turns the trees off. This says how far you have to spend
 * to switch them back on, and what that spending is worth on the way down.
 *
 * Nothing here caps the stock itself: 4687 balls on a 420 cap is a legal state,
 * it is just one where the trees have stopped.
 */
export function toCap({ stock, cap, mult }) {
  const over = Math.max(0, stock - cap);
  /* Pushes, not balls, because the button is what you actually press -- and the
     last push overshoots the cap rather than landing on it, which is fine and
     is why this rounds up. */
  const pushes = mult > 0 ? Math.ceil(over / mult) : 0;
  return { over, pushes, blocked: over > 0 };
}

/* ------------------------------------------------------------------ page */

const $ = (id) => document.getElementById(id);
const num = (n, dp = 0) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

/* Whole resources below a thousand read better with a decimal -- "0.2 pickaxes
   per ball" is the answer, "0 pickaxes" is not -- and above a thousand the
   decimal is noise. */
const smart = (n) => num(n, n < 1000 ? 1 : 0);

function board() {
  return OUTCOMES.map((o) => ({
    ...o,
    candy: Number($(`pb-candy-${o.key}`)?.value ?? o.candy) || 0,
    per: Number($(`pb-per-${o.key}`)?.value ?? o.per) || 0,
    chance: Number($(`pb-chance-${o.key}`)?.value ?? o.chance) || 0,
  }));
}

/*
 * How many balls one hold of the button launches.
 *
 * It is pure convenience -- fifteen separate drops resolved in one go, not a
 * fifteenth ball or a bonus -- so it never touches a total. It is here because
 * it is the difference between an evening of pressing and twenty seconds of it,
 * and because it explains a thing the board otherwise cannot: three Reward
 * Cards out of one pull is three of those fifteen balls finding the gift box.
 *
 * ponytail: a constant, not a field. Make it an input the day it turns out to
 * vary by level.
 */
const BALLS_PER_HOLD = 15;

function render() {
  const outcomes = board();
  /*
   * One number, two jobs: the step you pick is both what each ball costs you in
   * pinballs and the multiple printed on every slot. They are always equal --
   * which is why no step is ever a bargain, and why the value of a pinball is
   * the same 319.7 candy whatever you press.
   *
   * A draft of this page split them into separate fields on a misread, and
   * offered x60 as a four-to-one bargain. It is not. 11,000 balls spent for
   * ~3,000 pickaxes said so before anything else did.
   */
  const mult = Math.max(1, Number($('pb-mult').value) || 1);
  const stock = Math.max(0, Number($('pb-stock').value) || 0);

  /* A roll is one ball drop against the table. It costs `mult` pinballs and pays
     `mult` times, so a stack buys stock/mult of them and the remainder is only
     spendable at a smaller step. */
  const rolls = Math.floor(stock / mult);
  const spent = rolls * mult;
  const left = stock - spent;
  const holds = Math.ceil(rolls / BALLS_PER_HOLD);

  const ev = expected(spent, outcomes);
  const per = expected(1, outcomes);
  const sd = spread(spent, mult, outcomes);

  /*
   * The two specials are counted in landings, not in awards.
   *
   * At x40 a landing on the gift box pays forty Reward Cards, so the award count
   * is forty times the number of times the ball actually went there. For candy
   * that distinction does not matter -- candy is candy. For these two it is the
   * whole question: a landing is a thing that happens to you, a card to open or
   * a minigame to sit through, and ten of those is a different evening from 400
   * even when the loot is identical.
   *
   * `rolls` at x1 is exactly the landing count, which is why this is the same
   * two functions with the multiplier taken back out.
   */
  const lands = expected(rolls, outcomes);
  const landSd = spread(rolls, 1, outcomes);
  const LANDING = new Set(['card', 'raid']);

  /* "give or take", spelled out. Rendered as a band rather than a bare sigma
     because +/- 56 raids means nothing next to 79.6 until you see that it is
     24 to 135. Floored at zero: a band that dips negative is arithmetic
     showing through, not a possible run. */
  const band = (mean, dev) =>
    dev < 0.05 ? '' : `${smart(Math.max(0, mean - dev))} – ${smart(mean + dev)}`;

  $('pb-pushes').textContent =
    `${num(rolls)} ${rolls === 1 ? 'ball' : 'balls'} at ×${num(mult)}`;
  $('pb-left').textContent = left
    ? `${num(left)} pinball${left === 1 ? '' : 's'} left over — spend those at a smaller step`
    : 'nothing left over';

  $('pb-candy').textContent = num(Math.round(ev.candy));
  $('pb-candy-per').textContent = `${num(per.candy, 1)} per pinball`;
  $('pb-sd-candy').textContent = band(ev.candy, sd.candy);

  for (const t of TOKENS) {
    if (LANDING.has(t.key)) {
      $(`pb-out-${t.key}`).textContent = smart(lands[t.key]);
      /* "one every 30 balls" rather than a per-pinball decimal: same fact, but
         it does not move when the stack does, and it is the form you can picture
         while holding the button. */
      const every = lands[t.key] > 0 ? rolls / lands[t.key] : 0;
      $(`pb-per-out-${t.key}`).textContent = every
        ? `one every ${num(every, 0)} balls`
        : 'never lands';
      $(`pb-sd-${t.key}`).textContent = band(lands[t.key], landSd[t.key]);
    } else {
      $(`pb-out-${t.key}`).textContent = smart(ev[t.key]);
      $(`pb-per-out-${t.key}`).textContent = `${num(per[t.key], 2)} per pinball`;
      $(`pb-sd-${t.key}`).textContent = band(ev[t.key], sd[t.key]);
    }
  }

  /*
   * The verdict on the step. Never a bargain -- cost and payout are the same
   * number -- so the only thing left to report is the trade it does make: fewer,
   * bigger rolls, same average, wider swing. Plus the pressing, which is the
   * reason anybody reaches for a big step in the first place.
   */
  const risk = $('pb-risk');
  const press = `${num(holds)} ${holds === 1 ? 'hold' : 'holds'} of the button`
    + ` at ${num(BALLS_PER_HOLD)} balls a hold`;
  risk.dataset.state = '';
  risk.textContent = mult === 1
    ? `${num(mult)} pinball a ball, paid ×${num(mult)} — ${num(rolls)} rolls, `
      + `the tightest spread the board offers, and ${press}.`
    : `${num(mult)} pinballs a ball, paid ×${num(mult)} — same value per pinball as ×1, `
      + `but only ${num(rolls)} rolls instead of ${num(spent)}, so about `
      + `${num(Math.sqrt(mult), 1)}× the swing around the same average. ${press}.`;

  /* The specials, if you have measured any of them. Silent until you have:
     an "including specials" line that is identical to the line above it is
     noise, and worse, it reads as though the specials were worth nothing. */
  const perSpecial = {
    cardCandy: Math.max(0, Number($('pb-card-candy').value) || 0),
    cardBalls: Math.max(0, Number($('pb-card-balls').value) || 0),
    cardEnergy: Math.max(0, Number($('pb-card-energy').value) || 0),
    raidCandy: Math.max(0, Number($('pb-raid-candy').value) || 0),
  };
  const sp = withSpecials(ev, perSpecial);
  const specialsOut = $('pb-specials');
  if (!Object.values(perSpecial).some(Boolean)) {
    specialsOut.dataset.state = '';
    specialsOut.textContent =
      'Nothing measured yet, so nothing is folded in — every figure above is what the board '
      + 'alone pays, and the specials are on top of it.';
  } else {
    const bits = [`${num(Math.round(sp.candy))} candy`];
    if (sp.energy !== ev.energy) bits.push(`${smart(sp.energy)} Energy Drinks`);
    if (sp.balls) bits.push(`${smart(sp.balls)} pinballs back`);
    specialsOut.dataset.state = 'ok';
    specialsOut.textContent =
      `Folding the specials in: ${bits.join(', ')}. `
      + (sp.balls
        ? `Those returned pinballs are stock, not yield — spend them and this page applies again.`
        : `Card and raid contents vary, so this is an average of averages: treat it as a direction, not a total.`);
  }

  /* The event bar: how many balls until the Lightbulb requirement is met. Its
     own question, because it is the one people are actually asking during an
     event -- "am I done, or do I keep pushing?" */
  const have = Math.max(0, Number($('pb-bulb-have').value) || 0);
  const need = Math.max(0, Number($('pb-bulb-need').value) || 0);
  const short = Math.max(0, need - have);
  const bulbRate = per.lightbulb;
  const bar = $('pb-bar');
  if (!short) bar.textContent = 'Bar is full — every ball past this is candy and pickaxes.';
  else if (!bulbRate) bar.textContent = 'No slot grants Lightbulbs, so the bar cannot move.';
  else {
    const balls = Math.ceil(short / bulbRate);
    const share = stock ? ` — ${num((balls / stock) * 100, 1)}% of your stack` : '';
    bar.textContent = `${num(short)} Lightbulbs short: about ${num(balls)} balls${share}.`;
  }

  /* Cap */
  const cap = Math.max(0, Number($('pb-cap').value) || 0);
  const harvest = Math.max(0, Number($('pb-harvest').value) || 0);
  const { over, pushes: capPushes, blocked } = toCap({ stock, cap, mult });
  const capOut = $('pb-cap-out');
  if (!blocked) {
    capOut.dataset.state = 'ok';
    capOut.textContent =
      `Under the cap by ${num(cap - stock)}. Claim the trees now — you would land at ${num(stock + harvest)}.`;
  } else {
    const down = expected(over, outcomes);
    capOut.dataset.state = 'blocked';
    capOut.textContent =
      `Trees are blocked. Spend ${num(over)} pinballs (${num(capPushes)} balls at ×${num(mult)}) `
      + `to reach the cap — worth about ${num(Math.round(down.candy))} candy and `
      + `${smart(down.lightbulb)} Lightbulbs on the way down — then the ${num(harvest)}-ball harvest unlocks.`;
  }

  /* An edited table that no longer sums to 100 is not wrong, exactly -- the
     game may simply have another outcome this page has not seen -- but it does
     mean every number above is scaled off a table with a hole in it. */
  const sum = totalChance(outcomes);
  const warn = $('pb-sum');
  const off = Math.abs(sum - 100) > 0.05;
  warn.hidden = !off;
  if (off) warn.textContent = `Chances add up to ${num(sum, 1)}%, not 100% — the numbers above are off by the difference.`;
}

function wire() {
  /* One listener, delegated: every control on the page is an input that feeds
     the same recalculation, and there is nothing to save or submit. */
  document.addEventListener('input', render);
  $('pb-reset').addEventListener('click', () => {
    for (const o of OUTCOMES) {
      $(`pb-candy-${o.key}`).value = o.candy;
      $(`pb-per-${o.key}`).value = o.per;
      $(`pb-chance-${o.key}`).value = o.chance;
    }
    render();
  });
  render();
}

/* The pure half of this module is imported by logictest.html, which has none of
   the markup below -- and by node, which has no document at all. */
if (typeof document !== 'undefined' && document.querySelector('.pinball')) wire();
