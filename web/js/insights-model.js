/* Insights model for the admin Insights tab (web/js/admin/insights.js), Phase A.
   Pure functions only: no DOM and no network. Loads as window.InsightsModel in the browser and as
   module.exports in Node (tests/web/insights-model.test.js).

   The forecast runs on the numbers admin_insights_forecast returns (supabase/migrations/20261024100025_insights.sql):
     pace     calls a day over the last 7 days (days with no calls count, so weekends off are in the pace);
     pickup   share of calls someone answers, split into evening (7–9 pm) and the rest of the day;
     value    per picked-up call: what is got at once (₹ paid, or good results) plus promises × the share kept;
     promises open promises add their value × the share kept on their date.
   likely = got so far + open promises × kept + days left × pace × pickup × value per picked-up call, never more
   than the cap (amount due, or the number of leads). The low–high range is about 80% likely: it widens with
   few calls, few good results, few judged promises and an uneven pace.
   The What-if sliders change callers, calls per caller per day and the evening share; the same forecast runs
   again, so the sliders at their starting values give exactly the forecast. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InsightsModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN_CALLS = 50;             // under this, "Not enough data"
  const WINDOW_DAYS = 7;            // pace is measured over the last 7 days
  const Z80 = 1.2816;               // 80% range
  const MODEL_ERROR = 0.1;          // the model itself is rough: at least ±10% on what is still to come
  const KEPT_PRIOR = 0.6;           // promises kept, before there is data (shrunk towards this)
  const KEPT_PRIOR_WEIGHT = 4;
  const MIN_EVENING_CALLS = 10;     // fewer evening calls than this: evening pickup = all-day pickup
  const EVENING_HOURS = [19, 20];
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];   // isodow 1..7
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const share = (k, n) => (n > 0 ? k / n : null);

  // ---------- dates ('YYYY-MM-DD', calendar days, no time zone surprises) ----------

  function dayNumber(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 864e5) : null;
  }
  function fromDayNumber(n) {
    const d = new Date(n * 864e5);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  const addDays = (ymd, n) => fromDayNumber(dayNumber(ymd) + n);
  const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);

  // ---------- small statistics ----------

  // Relative standard error of a share k/n (0 when there is nothing to measure).
  function relErrShare(k, n) {
    if (!(n > 0) || !(k > 0)) return 0;
    const p = k / n;
    return Math.sqrt(p * (1 - p) / n) / p;
  }

  // Wilson interval of a share, for "how sure" text. z defaults to the 80% range.
  function wilson(k, n, z) {
    if (!(n > 0)) return { low: 0, high: 1 };
    const zz = z || Z80;
    const p = k / n;
    const d = 1 + zz * zz / n;
    const c = (p + zz * zz / (2 * n)) / d;
    const h = (zz * Math.sqrt(p * (1 - p) / n + zz * zz / (4 * n * n))) / d;
    return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
  }

  // ---------- from the server numbers to the model's starting values ----------

  // data: what admin_insights_forecast returns. Returns everything forecast() needs, plus the slider defaults.
  function baseline(data) {
    const d = data || {};
    const st = d.stats || {};
    const calls = num(st.calls), picked = num(st.picked);
    const daily = Array.isArray(d.daily) ? d.daily : [];
    const today = d.today;
    const win = daily.filter((r) => { const age = daysBetween(r.day, today); return age >= 0 && age < WINDOW_DAYS; });
    const windowDays = Math.max(1, Math.min(WINDOW_DAYS, win.length || 1));
    const calls7 = win.reduce((s, r) => s + num(r.calls), 0);
    const active = win.filter((r) => num(r.calls) > 0);
    const callerDays = active.reduce((s, r) => s + Math.max(1, num(r.callers)), 0);
    const pace = calls7 / windowDays;
    const callers = Math.max(1, num(d.callers) || Math.max(0, ...active.map((r) => num(r.callers))) || 1);
    const perCaller = callerDays > 0 ? calls7 / callerDays : 0;
    // Uneven pace: spread of the daily calls in the window.
    const mean = calls7 / windowDays;
    const varDaily = win.reduce((s, r) => s + (num(r.calls) - mean) ** 2, 0) / Math.max(1, windowDays - 1);
    const paceRelErr = mean > 0 ? Math.sqrt(varDaily / windowDays) / mean : 0;

    const eveCalls = num(st.evening_calls), evePicked = num(st.evening_picked);
    const dayCalls = calls - eveCalls, dayPicked = picked - evePicked;
    const pickupAll = share(picked, calls) || 0;
    const eveningKnown = eveCalls >= MIN_EVENING_CALLS && dayCalls >= MIN_EVENING_CALLS;
    const pickupEvening = eveningKnown ? evePicked / eveCalls : pickupAll;
    const pickupDay = eveningKnown ? dayPicked / dayCalls : pickupAll;
    const eveningShare = share(eveCalls, calls) || 0;

    const pr = d.promises || {};
    const judged = num(pr.judged), kept = num(pr.kept);
    const keptRate = (kept + KEPT_PRIOR * KEPT_PRIOR_WEIGHT) / (judged + KEPT_PRIOR_WEIGHT);
    const promisesMade = num(st.promises_made);

    return {
      kind: d.kind === 'amount' ? 'amount' : 'count',
      typeKey: d.call_type_key || '',
      today, startDate: d.start_date || today, endDate: d.end_date || null,
      calls, picked, good: num(st.good),
      enoughData: calls >= MIN_CALLS,
      current: num(st.direct_value),
      cap: d.cap === null || d.cap === undefined ? null : num(d.cap),
      target: d.target === null || d.target === undefined ? null : num(d.target),
      pace, paceRelErr, windowDays, activeShare: active.length / windowDays,
      callers, perCaller,
      pickupDay, pickupEvening, pickupAll, eveningShare, eveningKnown,
      directPerPicked: picked > 0 ? num(st.direct_value) / picked : 0,
      promisePerPicked: picked > 0 ? num(st.promise_value_made) / picked : 0,
      goodDirect: Math.max(0, num(st.good) - promisesMade),
      keptRate, judged, keptCount: kept,
      broken: num(pr.broken), brokenValue: num(pr.broken_value),
      openPromises: (Array.isArray(d.open_promises) ? d.open_promises : []).map((p) => ({ date: p.date, value: num(p.value) })),
      daily: daily.map((r) => ({ day: r.day, calls: num(r.calls), value: num(r.value) })),
      hours: Array.isArray(d.hours) ? d.hours : [],
    };
  }

  // The slider values that reproduce the forecast.
  function defaultPlan(base) {
    return { callers: base.callers, perCaller: base.perCaller, eveningShare: base.eveningShare };
  }

  // Calls a day for the campaign with this plan. At the defaults it is the measured pace.
  function paceFor(base, plan) {
    const p = plan || defaultPlan(base);
    if (base.callers > 0 && base.perCaller > 0 && base.pace > 0) {
      return base.pace * (num(p.callers) / base.callers) * (num(p.perCaller) / base.perCaller);
    }
    // No calls in the last week: assume callers call on most days.
    return num(p.callers) * num(p.perCaller) * (6 / 7);
  }

  function pickupFor(base, plan) {
    const es = clamp(num((plan || {}).eveningShare === undefined ? base.eveningShare : plan.eveningShare), 0, 1);
    return es * base.pickupEvening + (1 - es) * base.pickupDay;
  }

  // ---------- the forecast ----------

  // Returns { ok, reason, likely, low, high, target, gap, pct, reachDate, reachesBeforeEnd, daysLeft,
  //           perDay, path: [{day, value}], current, cap }. ok false with reason 'no_end' or 'no_data'.
  function forecast(base, plan) {
    const out = { ok: false, reason: null, current: base.current, target: base.target, cap: base.cap };
    if (!base.endDate) { out.reason = 'no_end'; return out; }
    if (!base.enoughData) { out.reason = 'no_data'; }
    const p = plan || defaultPlan(base);
    const daysLeft = Math.max(0, daysBetween(base.today, base.endDate));
    const pace = paceFor(base, p);
    const pickup = pickupFor(base, p);
    const perPicked = base.directPerPicked + base.promisePerPicked * base.keptRate;
    const perDay = pace * pickup * perPicked;
    const capped = (v) => (base.cap === null ? v : Math.min(base.cap, v));

    // Open promises: expected value on their date (only dates up to the end count for the forecast).
    const promiseOn = (dayIndex) => base.openPromises
      .filter((o) => { const k = daysBetween(base.today, o.date); return k >= 0 && k <= dayIndex; })
      .reduce((s, o) => s + o.value * base.keptRate, 0);
    const valueAt = (k) => capped(base.current + promiseOn(k) + perDay * k);

    const future = perDay * daysLeft;
    const fromPromises = promiseOn(daysLeft);
    const likely = valueAt(daysLeft);

    // Range: errors on pace, pickup, value per picked-up call and kept share, plus model error.
    const relFuture = Math.sqrt(
      base.paceRelErr ** 2 +
      relErrShare(base.picked, base.calls) ** 2 +
      (base.good > 0 ? 1 / base.good : 1) +
      MODEL_ERROR ** 2);
    const relKept = Math.max(relErrShare(base.keptCount, base.judged), base.judged > 0 ? 0 : 0.5);
    const sd = Math.sqrt((future * relFuture) ** 2 + (fromPromises * relKept) ** 2);
    const low = Math.max(base.current, capped(likely - Z80 * sd));
    const high = Math.max(likely, capped(likely + Z80 * sd));

    // When the target is reached (searched up to a year after today).
    let reachDate = null;
    if (base.target !== null && base.target > 0) {
      for (let k = 0; k <= Math.max(daysLeft, 0) + 365; k++) {
        if (valueAt(k) >= base.target) { reachDate = addDays(base.today, k); break; }
        if (perDay <= 0 && k > daysLeft) break;
      }
    }
    const path = [];
    for (let k = 0; k <= daysLeft; k++) path.push({ day: addDays(base.today, k), value: valueAt(k) });

    return Object.assign(out, {
      ok: out.reason === null,
      likely, low, high, daysLeft, perDay, pace, pickup, path,
      gap: base.target !== null ? Math.max(0, base.target - likely) : null,
      pct: base.target ? likely / base.target : null,
      reachDate,
      reachesBeforeEnd: reachDate !== null && daysBetween(reachDate, base.endDate) >= 0,
    });
  }

  // The collected-so-far line for the chart: cumulative value per day up to today.
  function pastPath(base) {
    let total = 0;
    const rows = base.daily.map((r) => { total += r.value; return { day: r.day, value: total }; });
    // The server sums by day; the last point is today's total. Keep it in line with "got so far".
    if (rows.length) rows[rows.length - 1].value = base.current;
    return rows;
  }

  // ---------- "What closes the gap" ----------

  // The calls per caller per day that reach the target (searched up to 500), or null.
  function perCallerForTarget(base, plan) {
    if (base.target === null) return null;
    const p = Object.assign({}, plan || defaultPlan(base));
    if (forecast(base, p).likely >= base.target) return p.perCaller;
    let lo = Math.max(1, p.perCaller), hi = 500;
    if (forecast(base, Object.assign({}, p, { perCaller: hi })).likely < base.target) return null;
    for (let i = 0; i < 40 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2;
      if (forecast(base, Object.assign({}, p, { perCaller: mid })).likely >= base.target) hi = mid; else lo = mid;
    }
    let n = Math.ceil(hi);
    while (n - 1 >= 1 && forecast(base, Object.assign({}, p, { perCaller: n - 1 })).likely >= base.target) n--;
    return n;
  }

  // Suggestions, biggest gain first: [{ id, gain, plan (slider values to try, or null), ...numbers for the text }].
  function gapSuggestions(base, plan) {
    const p = plan || defaultPlan(base);
    const now = forecast(base, p);
    if (!now.ok || base.target === null || now.likely >= base.target) return [];
    const list = [];
    const gainOf = (q) => forecast(base, q).likely - now.likely;

    if (base.broken > 0) {
      // A broken promise is worth calling again: reached about as often as any call, then kept like a promise.
      const gain = Math.min(base.brokenValue * base.pickupAll * base.keptRate, now.gap);
      list.push({ id: 'broken', gain, plan: null, count: base.broken });
    }
    if (base.eveningKnown && base.pickupEvening > base.pickupDay + 0.05 && p.eveningShare < 0.7) {
      const q = Object.assign({}, p, { eveningShare: Math.min(0.8, Math.max(0.5, p.eveningShare + 0.3)) });
      list.push({ id: 'evening', gain: gainOf(q), plan: q, share: q.eveningShare,
        pickupEvening: base.pickupEvening, pickupDay: base.pickupDay });
    }
    const need = perCallerForTarget(base, p);
    const more = need !== null ? need : p.perCaller * 2;
    if (more > p.perCaller) {
      const q = Object.assign({}, p, { perCaller: more });
      const extra = Math.round(paceFor(base, q) - paceFor(base, p));
      if (extra > 0) list.push({ id: 'calls', gain: gainOf(q), plan: q, extraCalls: extra, reaches: need !== null });
    }
    const q2 = Object.assign({}, p, { callers: p.callers + 1 });
    list.push({ id: 'caller', gain: gainOf(q2), plan: q2, callers: q2.callers });
    return list.filter((s) => s.gain > 0).sort((a, b) => b.gain - a.gain);
  }

  // ---------- best time to call ----------

  // rows: [{dow 1-7, hour 0-23, calls, picked}]. Returns { days, hours, cell(dow, hour), overall, total }.
  function heatGrid(rows, opts) {
    const minCalls = (opts && opts.minCalls) || 5;
    const map = new Map();
    let calls = 0, picked = 0;
    (rows || []).forEach((r) => {
      const c = num(r.calls), pk = num(r.picked);
      map.set(num(r.dow) + ':' + num(r.hour), { dow: num(r.dow), hour: num(r.hour), calls: c, picked: pk,
        rate: c >= minCalls ? pk / c : null });
      calls += c; picked += pk;
    });
    const hoursSeen = [...map.values()].map((c) => c.hour);
    const lo = hoursSeen.length ? Math.min(...hoursSeen) : 9;
    const hi = hoursSeen.length ? Math.max(...hoursSeen) : 20;
    const hours = [];
    for (let h = lo; h <= hi; h++) hours.push(h);
    return {
      days: [1, 2, 3, 4, 5, 6, 7], hours, minCalls, total: calls,
      overall: share(picked, calls),
      cell: (dow, hour) => map.get(dow + ':' + hour) || { dow, hour, calls: 0, picked: 0, rate: null },
      cells: () => [...map.values()],
    };
  }

  // The best hours with enough calls, best first.
  function bestCells(grid, n) {
    return grid.cells().filter((c) => c.rate !== null).sort((a, b) => b.rate - a.rate || b.calls - a.calls).slice(0, n || 3);
  }

  // call_hours for the campaign: per day, the hours where pickup is at least the overall rate (enough calls).
  // { tz, days: { mon: [18, 19] … }, source: 'insights' }, or null when no hour qualifies.
  function callHoursFromGrid(grid, tz) {
    if (grid.overall === null) return null;
    const days = {};
    grid.days.forEach((dow) => {
      const hrs = grid.hours.filter((h) => { const c = grid.cell(dow, h); return c.rate !== null && c.rate >= grid.overall; });
      if (hrs.length) days[DAY_KEYS[dow - 1]] = hrs;
    });
    if (!Object.keys(days).length) return null;
    const out = { days, source: 'insights' };
    if (tz) out.tz = String(tz).slice(0, 60);
    return out;
  }

  // '7 pm', '12 pm', '10 am'; with a range: '7–9 pm'.
  function hourText(h) {
    const hh = ((num(h) % 24) + 24) % 24;
    return (hh % 12 || 12) + (hh < 12 ? ' am' : ' pm');
  }
  function hourRange(a, b) {
    const s = hourText(a), e = hourText(b);
    return s.slice(-2) === e.slice(-2) ? s.slice(0, -3) + '–' + e : s + '–' + e;
  }
  // campaigns.call_hours in words: 'Mon 7–9 pm, Sat 10 am–12 pm'. Days with the same hours are joined:
  // 'Mon, Tue 7–9 pm'. Null or empty: 'Any time'.
  function callHoursText(ch) {
    const days = ch && ch.days && typeof ch.days === 'object' ? ch.days : null;
    if (!days) return 'Any time';
    const groups = [];
    DAY_KEYS.forEach((k, i) => {
      const hrs = Array.isArray(days[k]) ? days[k].map(num).sort((a, b) => a - b) : [];
      if (!hrs.length) return;
      const runs = [];
      hrs.forEach((hr) => {
        const last = runs[runs.length - 1];
        if (last && hr === last[1]) last[1] = hr + 1; else runs.push([hr, hr + 1]);
      });
      const text = runs.map((r) => hourRange(r[0], r[1])).join(', ');
      const same = groups.find((g) => g.text === text);
      if (same) same.days.push(DAY_NAMES[i]); else groups.push({ days: [DAY_NAMES[i]], text });
    });
    return groups.length ? groups.map((g) => g.days.join(', ') + ' ' + g.text).join('; ') : 'Any time';
  }
  const dayName = (dow) => DAY_NAMES[num(dow) - 1] || '';
  const pctText = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '–' : Math.round(Number(v) * 100) + '%');

  // A one-line tip: where people pick up most, and where most calls are made when that differs.
  function heatTip(grid) {
    const best = bestCells(grid, 3);
    if (!best.length) return null;
    const parts = best.map((c) => dayName(c.dow) + ' ' + hourText(c.hour) + ' (' + pctText(c.rate) + ')');
    let text = 'Most people pick up on ' + parts.join(', ') + '.';
    const busiest = grid.cells().filter((c) => c.rate !== null).sort((a, b) => b.calls - a.calls)[0];
    if (busiest && best[0].rate - busiest.rate >= 0.1) {
      text += ' Most calls are made on ' + dayName(busiest.dow) + ' ' + hourText(busiest.hour) + ' (' + pctText(busiest.rate) + ').';
    }
    return text;
  }

  // Level 0-5 of a value in [lo, hi], for colour plus lightness. null stays null ("too few calls").
  function level(v, lo, hi, levels) {
    if (v === null || v === undefined) return null;
    const n = levels || 6;
    if (!(hi > lo)) return n - 1;
    return clamp(Math.floor(((v - lo) / (hi - lo)) * n), 0, n - 1);
  }

  // ---------- where calls end, promises, coaching ----------

  function callEnds(rows) {
    const list = (rows || []).map((r) => ({ step: r.step, label: r.step_label || r.step || 'Not recorded', calls: num(r.calls) }));
    const total = list.reduce((s, r) => s + r.calls, 0);
    list.forEach((r) => { r.share = share(r.calls, total); });
    const top = list.slice().sort((a, b) => b.calls - a.calls)[0] || null;
    return { rows: list, total, top };
  }

  // Phase A.2: promises measured against the fee ledger. pvp: promises_vs_payments(p_campaign). Returns null
  // when no promise of the campaign can be checked in the ledger (no lead linked to a student), so the page uses
  // the caller-reported method. Otherwise { buckets, kept, partPaid, broken, waiting, judged, noStudent, promises }:
  // buckets in the shape of admin_insights_promises (for promiseBuckets), by days from the call to the promised
  // date; judged = kept + part paid + broken (part paid counts as not kept). Buckets use the rows sent (newest 500).
  const LEDGER_BUCKETS = [['1–3 days', 1, -100000, 3], ['4–7 days', 2, 4, 7], ['8–14 days', 3, 8, 14], ['15+ days', 4, 15, 100000]];
  function ledgerPromises(pvp) {
    const d = pvp || {};
    const promises = num(d.promises), noStudent = num(d.no_student);
    if (!(promises - noStudent > 0)) return null;
    const buckets = LEDGER_BUCKETS.map(([bucket, order]) => ({ bucket, bucket_order: order, promises: 0, kept: 0, waiting: 0 }));
    (Array.isArray(d.rows) ? d.rows : []).forEach((r) => {
      if (!r || r.state === 'no_student' || !r.promised_on || !r.promised_date) return;
      const away = daysBetween(String(r.promised_on).slice(0, 10), String(r.promised_date).slice(0, 10));
      const i = LEDGER_BUCKETS.findIndex((b) => away >= b[2] && away <= b[3]);
      if (i < 0) return;
      if (r.state === 'waiting') buckets[i].waiting++;
      else buckets[i].promises++;
      if (r.state === 'kept') buckets[i].kept++;
    });
    const kept = num(d.kept), partPaid = num(d.part_paid), broken = num(d.broken);
    return { buckets, kept, partPaid, broken, waiting: num(d.waiting), judged: kept + partPaid + broken, noStudent, promises };
  }

  // rows from admin_insights_promises. Adds the kept share; tip when far dates are kept clearly less often.
  function promiseBuckets(rows) {
    const list = (rows || []).map((r) => ({ bucket: r.bucket, order: num(r.bucket_order), promises: num(r.promises),
      kept: num(r.kept), waiting: num(r.waiting) }));
    list.forEach((r) => { r.rate = share(r.kept, r.promises); });
    const near = list.filter((r) => r.order <= 2), far = list.filter((r) => r.order >= 3);
    const sum = (xs, k) => xs.reduce((s, r) => s + r[k], 0);
    const nearRate = share(sum(near, 'kept'), sum(near, 'promises'));
    const farRate = share(sum(far, 'kept'), sum(far, 'promises'));
    const judged = sum(list, 'promises');
    let tip = null;
    if (nearRate !== null && farRate !== null && sum(far, 'promises') >= 5 && nearRate - farRate >= 0.1) {
      tip = 'Ask callers to get a date within 7 days. Dates within a week are kept ' + pctText(nearRate) +
        ' of the time; dates further away ' + pctText(farRate) + '.';
    }
    return { rows: list, judged, nearRate, farRate, tip };
  }

  // rows from admin_insights_coaching. Good results per 100 picked-up calls, and the team average.
  function coaching(rows, opts) {
    const minPicked = (opts && opts.minPicked) || 10;
    const list = (rows || []).map((r) => {
      const picked = num(r.picked), good = num(r.good);
      return { seatId: r.seat_id, label: r.label, calls: num(r.calls), picked, good,
        per100: picked >= minPicked ? Math.round((good / picked) * 100) : null };
    });
    const tp = list.reduce((s, r) => s + r.picked, 0), tg = list.reduce((s, r) => s + r.good, 0);
    const team = tp > 0 ? Math.round((tg / tp) * 100) : null;
    list.sort((a, b) => (b.per100 === null ? -1 : b.per100) - (a.per100 === null ? -1 : a.per100) || String(a.label).localeCompare(String(b.label)));
    return { rows: list, team, minPicked };
  }

  // '25 sec', '1 min', '1 min 30 sec'.
  function durationText(sec) {
    const s = Math.round(num(sec));
    if (s < 60) return s + ' sec';
    const m = Math.floor(s / 60), r = s % 60;
    return m + ' min' + (r ? ' ' + r + ' sec' : '');
  }

  // rows from admin_insights_step_coaching (seat_id null = team). For each caller, at most one tip: the step
  // they skip most more than the team, else the step they are slowest on compared with the team.
  // Returns [{ seatId, label, kind: 'skip'|'slow', step, stepLabel, mine, team, text }].
  function stepTips(rows, opts) {
    const minTimed = (opts && opts.minTimed) || 5;
    const team = new Map(), bySeat = new Map();
    (rows || []).forEach((r) => {
      const row = { step: r.step, stepLabel: r.step_label || r.step, timed: num(r.timed_calls),
        withStep: num(r.calls_with_step), secs: r.avg_seconds === null ? null : num(r.avg_seconds), label: r.label };
      row.skip = row.timed > 0 ? 1 - row.withStep / row.timed : null;
      if (!r.seat_id) team.set(r.step, row);
      else {
        if (!bySeat.has(r.seat_id)) bySeat.set(r.seat_id, []);
        bySeat.get(r.seat_id).push(row);
      }
    });
    const tips = [];
    bySeat.forEach((steps, seatId) => {
      const label = steps[0].label;
      if (!steps.length || steps[0].timed < minTimed) return;
      // Steps the team passes in at least half its calls, but this caller passes clearly less often.
      let skip = null;
      team.forEach((t) => {
        if (t.skip === null || t.skip > 0.5) return;
        const mine = steps.find((s) => s.step === t.step);
        const mySkip = mine ? mine.skip : 1;
        if (mySkip - t.skip >= 0.2 && (!skip || mySkip - t.skip > skip.mine - skip.team)) {
          skip = { step: t.step, stepLabel: t.stepLabel, mine: mySkip, team: t.skip };
        }
      });
      if (skip) {
        tips.push({ seatId, label, kind: 'skip', step: skip.step, stepLabel: skip.stepLabel, mine: skip.mine, team: skip.team,
          text: label + ' skips the ' + skip.stepLabel + ' step in ' + pctText(skip.mine) + ' of calls (team: ' + pctText(skip.team) + ').' });
        return;
      }
      let slow = null;
      steps.forEach((s) => {
        const t = team.get(s.step);
        if (!t || s.secs === null || t.secs === null || !(t.secs > 0) || s.withStep < 3) return;
        if (s.secs >= t.secs * 1.5 && s.secs - t.secs >= 15 && (!slow || s.secs / t.secs > slow.mine / slow.team)) {
          slow = { step: s.step, stepLabel: t.stepLabel, mine: s.secs, team: t.secs };
        }
      });
      if (slow) {
        tips.push({ seatId, label, kind: 'slow', step: slow.step, stepLabel: slow.stepLabel, mine: slow.mine, team: slow.team,
          text: label + ' spends ' + durationText(slow.mine) + ' on the ' + slow.stepLabel + ' step (team: ' + durationText(slow.team) + ').' });
      }
    });
    return tips;
  }

  // Time per step for the team, in script order: [{ step, stepLabel, secs, passShare }].
  function teamSteps(rows) {
    return (rows || []).filter((r) => !r.seat_id).map((r) => ({
      step: r.step, stepLabel: r.step_label || r.step, order: r.step_order === null || r.step_order === undefined ? 9999 : num(r.step_order),
      secs: r.avg_seconds === null ? null : num(r.avg_seconds), passShare: share(num(r.calls_with_step), num(r.timed_calls)),
    })).sort((a, b) => a.order - b.order || String(a.step).localeCompare(String(b.step)));
  }

  // ---------- compare ----------

  // a, b: rows from admin_insights_summary. Headline numbers side by side, higher is better for all four.
  function compare(a, b) {
    const m = (r) => {
      const x = r || {};
      return {
        pickup: share(num(x.picked), num(x.calls)),
        good: num(x.picked) > 0 ? (num(x.good) / num(x.picked)) * 100 : null,
        kept: share(num(x.promises_kept), num(x.promises_judged)),
        pace: num(x.active_days) > 0 ? num(x.calls) / num(x.active_days) : null,
      };
    };
    const ma = m(a), mb = m(b);
    return [
      { key: 'pickup', label: 'Pickup rate', a: ma.pickup, b: mb.pickup, unit: 'pct' },
      { key: 'good', label: 'Good results per 100 picked up', a: ma.good, b: mb.good, unit: 'num' },
      { key: 'kept', label: 'Promises kept', a: ma.kept, b: mb.kept, unit: 'pct' },
      { key: 'pace', label: 'Calls a calling day', a: ma.pace, b: mb.pace, unit: 'num' },
    ].map((r) => Object.assign(r, { delta: r.a !== null && r.b !== null ? r.a - r.b : null }));
  }

  // What one unit of the forecast is called.
  function unitLabel(typeKey, kind) {
    if (kind === 'amount') return '₹';
    return ({ fees: 'payments', sales: 'joinings', admission: 'visits and forms', renewal: 'renewals', event: 'coming',
      follow_up: 'confirmed', absence: 'reasons', feedback: 'ratings' })[typeKey] || 'good results';
  }

  return {
    MIN_CALLS, WINDOW_DAYS, EVENING_HOURS, DAY_KEYS, DAY_NAMES,
    dayNumber, addDays, daysBetween, wilson, relErrShare,
    baseline, defaultPlan, paceFor, pickupFor, forecast, pastPath, perCallerForTarget, gapSuggestions,
    heatGrid, bestCells, callHoursFromGrid, hourText, hourRange, callHoursText, dayName, pctText, heatTip, level,
    callEnds, promiseBuckets, ledgerPromises, coaching, durationText, stepTips, teamSteps, compare, unitLabel,
  };
}));
