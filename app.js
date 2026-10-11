/* TAGOPA — 광역버스 승차 여유 예측
 * 하단 표: 정류장 × 대표 운행편, 칸 = 대표 시각 + 2×2 네 분류. 카드: 두 가지 보기 — ① 실시간 조회(경기도 공식 버스도착정보 API를 브라우저에서 직접 호출, 사용자가 입력한 Decoding 키) ② 예시 보기(가상 출근·퇴근 시나리오).
 * 실시간 빈자리는 조회 시점 차내 빈자리이며 하단 표의 예상 승차 여유(과거 기록 기반)와 다른 값이다. 두 모드 모두 도착 예정 시각에 가장 가까운 과거 대표편을 같은 connectBus()로 찾아 통계적 참고자료로 연결한다(같은 실제 차량·운행편으로 확정한 것이 아님).
 * 자료: data/app/recent/ (meta → 인덱스 → 유형별 격자 → 슬롯별 상세, trial.json 예시 시나리오, operating_day.json 운행일 기준). 서버·프록시 없음. 인증키는 코드·자료·콘솔에 두지 않는다. */
(function () {
  'use strict';

  var WD = ['월', '화', '수', '목', '금', '토', '일'];
  var BASE = 'data/app/recent/';
  // state.type holds a DAY GROUP id: 월 화 수 목 금 토 일·공휴일 (each aggregated on its own dates; holidays only in 일·공휴일)
  var TYPES = ['월', '화', '수', '목', '금', '토', '일·공휴일'];
  var TYPE_LABEL = { '월': '월요일', '화': '화요일', '수': '수요일', '목': '목요일', '금': '금요일', '토': '토요일', '일·공휴일': '일·공휴일' };
  function gType(g) { return g === '일·공휴일' ? 'holiday_block' : (g === '토' ? 'saturday' : 'normal_weekday'); }   // file family of a group (slot list is shared by 월~금)
  var KLASS = { regular: '일반 정규편', charter_am: '출근 전세편(동탄·지정 출발 → 서울 편도)', charter_pm: '퇴근 전세편(서울 → 동탄 편도)', unconfirmed: '미확정 편' };
  var KIND_TXT = { a: '도착형 시각', d: '출발형 시각', u: '시점 미판별 시각', arrival: '도착형 시각', departure: '출발형 시각', unclassified: '시점 미판별 시각' };
  var QC = {
    r: { name: '빠듯해요', short: '빨', def: '탈 자리가 적고, 사람들이 타면 거의 다 차는 편이에요. (승차 전 여유 R 중앙값 10명 미만, 그리고 승차 후 남는 자리 F가 4석 이하인 기록이 1/3 이상)' },
    o: { name: '북적여요', short: '주', def: '탈 자리는 넉넉해도, 사람들이 타면 거의 다 차는 편이에요. (R 중앙값 10명 이상, F 4석 이하 기록이 1/3 이상)' },
    y: { name: '조금 남아요', short: '노', def: '탈 자리는 적지만, 사람들이 타고도 조금 남는 편이에요. (R 중앙값 10명 미만, F 4석 이하 기록이 1/3 미만)' },
    g: { name: '여유로워요', short: '초', def: '탈 자리가 넉넉하고, 사람들이 타고도 남는 편이에요. (R 중앙값 10명 이상, F 4석 이하 기록이 1/3 미만)' }
  };
  var QWHY = { F_missing: 'F(출발 후 잔여)가 없음', R_missing: 'R(승차 전 여유) 미계산', no_records: '기록 없음' };
  var WHY = {
    arrival_field_matches: '도착 시각 필드와 RArrivalDate가 같아 도착형으로 읽음 (시각 필드의 일치이며 잔여석을 잰 순간을 직접 확인한 것은 아님)',
    origin_departure_only: '기점의 출발 시각만 있는 기록 → 출발형', confirmed_midstart_departure_only: '확인된 중간 출발편의 출발 시각 기록 → 출발형',
    nonorigin_departure_only_not_promoted: '기점이 아닌 정류장의 출발 시각만 있는 기록: 미판별로 둠(자동으로 출발형이 되지 않음)',
    time_fields_mismatch: '시각 필드가 서로 맞지 않아 미판별', remain_missing: '잔여석 값이 없어 미판별', no_time_field: '시각 필드가 없어 미판별', unclassified_combination: '미판별'
  };
  var CELL_SHORT = { not_target: '영업 대상 아님', beyond_last: '관측 구간 밖', before_seoul_start: '운행 안 함', not_operating: '운행 안 함', origin_record_missing: '기점 기록 누락', lead_gap: '기록 누락', trail_gap: '기록 누락', no_record: '기록 누락', start_missing_ms: '출발 기록 누락', trail_blocked: '이어지지 않음', beyond_turn: '회차 이후', beyond_last: '관측 밖', origin_unknown: '시작 위치 미확정', gap_before_first: '기록 누락', origin_missing_basis: '기점 기록 누락', slot_absent: '대응 없음' };

  var state = {
    meta: null, route: 'M4130', dir: 'down', stop: null, type: 'normal_weekday', showAll: false, showIncomplete: false, showMore: false,
    hl: null, detail: null, detailOpen: false, trigger: null, focusClose: false, popStop: null, loadErr: null, loaded: [],
    dev: { on: false, caseId: 'A', fixtures: null }, buses: null, busesAt: null,
    trial: { id: 'commute_am', custom: false },
    mode: 'example', live: { status: 'idle', tok: 0, buses: [], flag: '', at: '', why: '' }, liveAuto: { last: 0, idle: false, stopped: false, fails: 0, active: Date.now() }
  };
  var TRIAL = null, OPDAY = null;
  // ---- real-time arrival (official Gyeonggi bus-arrival API v2, item lookup). The key lives only in this variable (and, if the user asks for it, localStorage).
  var API_URL = 'https://apis.data.go.kr/6410000/busarrivalservice/v2/getBusArrivalItemv2';
  var ROUTE_IDS = { M4130: '234001577', M4137: '234001622' };   // GBIS routeId (verified against the stored routeStations responses); stationId and staOrder come from meta.json
  var LS_KEY = 'tagopa.apikey', apiKey = null, liveTimer = null, autoTimer = null, liveBgInflight = false;
  var AUTO_MS = 60000, IDLE_MS = 600000, FAIL_MAX = 5;   // automatic refresh interval; pause after 10 minutes without interaction; stop after 5 failures in a row
  var LOWPLATE = { 0: '일반버스', 1: '저상버스', 2: '2층버스', 5: '전세버스', 6: '예약버스', 7: '트롤리' };   // official code list; unlisted values are not shown
  var DOW_DATE = { '월': '2026-09-28', '화': '2026-10-06', '수': '2026-09-30', '목': '2026-10-01', '금': '2026-10-02', '토': '2026-10-10', '일': '2026-10-04' };   // calendar dates used only to place a development weekday on the calendar
  var cache = { index: {}, grid: {}, detail: {}, pending: {} };

  // ---------------------------------------------------------------- helpers
  function $(s) { return document.querySelector(s); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(m) { m = Math.round(m); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }   // continuous clock: 24:15 = 00:15 of the next calendar day
  function num(x, d) { return x == null ? '없음' : (Math.round(x * Math.pow(10, d || 0)) / Math.pow(10, d || 0)); }
  function param(k) { var m = new RegExp('[?&]' + k + '=([^&]*)').exec(location.search); return m ? decodeURIComponent(m[1]) : null; }
  function typeOfWd(wd) { var i = WD.indexOf(wd); return i < 0 ? '일·공휴일' : (i <= 5 ? WD[i] : '일·공휴일'); }
  function hm2m(t) { var p = t.split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
  function isoAdd(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function isoDow(iso) { return (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7; }   // 0 = Monday
  // ---- operating day (운행일): the day group belongs to the KD OPERATING day, not to the calendar date (data/analysis/2026-10_operating_day/README.md)
  function dayClass(iso) { return (OPDAY.holidays[iso] || isoDow(iso) === 6) ? 'holiday' : 'normal'; }
  function groupOfDate(iso) { if (OPDAY.holidays[iso] || isoDow(iso) === 6) return '일·공휴일'; return isoDow(iso) === 5 ? '토' : WD[isoDow(iso)]; }
  function opDay(route, iso, t) {   // calendar date + minute of day of an arrival -> { date, cont, group } or null (undetermined)
    var r = OPDAY.routes[route];
    if (t >= r.first_dep[dayClass(iso)]) return { date: iso, cont: t, group: groupOfDate(iso) };
    if (1440 + t <= r.latest_record_min) { var pv = isoAdd(iso, -1); return { date: pv, cont: 1440 + t, group: groupOfDate(pv) }; }
    return null;
  }

  function kstNow() { var d = new Date(Date.now() + 9 * 3600000), iso = d.toISOString(); return { date: iso.slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), sec: d.getUTCSeconds(), wd: (d.getUTCDay() + 6) % 7 }; }
  function now() {
    if (state.mode === 'live') { var k = kstNow(); return { wd: k.wd, minutes: k.minutes, date: k.date, fake: false }; }
    if (state.dev.on && state.dev.fixtures) {
      var c = caseById(state.dev.caseId);
      return { wd: WD.indexOf(c.now.weekday), minutes: hm2m(c.now.hhmm), date: DOW_DATE[c.now.weekday], fake: true };
    }
    var sc = scenarioById(state.trial.id);
    return { wd: WD.indexOf(TRIAL.weekday), minutes: hm2m(sc.now), date: TRIAL.date, fake: true };
  }
  function scenarioById(id) { return TRIAL.scenarios.filter(function (x) { return x.id === id; })[0]; }
  function caseById(id) { return state.dev.fixtures.cases.filter(function (c) { return c.id === id; })[0]; }

  // ---------------------------------------------------------------- data loading (split files; failures are shown, never replaced)
  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      state.loaded.push({ url: url, bytes: new TextEncoder().encode(t).length });
      return JSON.parse(t);
    });
  }
  function once(bucket, key, url) {
    if (cache[bucket][key]) return Promise.resolve(cache[bucket][key]);
    if (cache.pending[bucket + key]) return cache.pending[bucket + key];
    var p = fetchJson(url).then(function (j) { cache[bucket][key] = j; delete cache.pending[bucket + key]; return j; }, function (e) { delete cache.pending[bucket + key]; throw e; });
    cache.pending[bucket + key] = p;
    return p;
  }
  function ensureIndex(route, g) { return once('index', route + '|' + gType(g), BASE + 'index/' + route + '_' + gType(g) + '.json'); }
  function ensureGrid(route, g) { return once('grid', route + '|' + g, BASE + 'grid/' + route + '_' + gType(g) + '_' + encodeURIComponent(g) + '.json'); }
  function ensureDetail(file) { return once('detail', file, BASE + 'detail/' + encodeURIComponent(file) + '.json'); }
  function getIndex(route, g) { return cache.index[(route || state.route) + '|' + gType(g || state.type)]; }
  function getGrid(route, type) { return cache.grid[(route || state.route) + '|' + (type || state.type)]; }
  function typeDates(g) { var x = state.meta.day_groups.filter(function (d) { return d.id === g; })[0]; return x ? x.dates : []; }
  function hasData(type) { return typeDates(type).length > 0; }
  function loadType(route, type) { if (!hasData(type)) return Promise.resolve(); return Promise.all([ensureIndex(route, type), ensureGrid(route, type)]); }
  function loadView() { return loadType(state.route, state.type); }
  function viewKey() { return [state.route, state.dir, state.type, state.stop].join('|'); }
  function loadViewAndRender() { var my = viewKey(); return loadView().then(function () { if (my !== viewKey()) return; renderStats(); renderCard(); }).catch(showLoadError); }   // a late response never repaints a newer selection
  function showLoadError(err) {
    state.loadErr = err;
    $('#grid').innerHTML = '';
    $('#colinfo').innerHTML = '<div class="loaderr"><b>새 시간표 자료를 불러오지 못했습니다.</b><br>' + esc(err && err.message ? err.message : err) + '<br><span class="small">이전(2025-05 시험) 값으로 대체하지 않았습니다. 로컬 서버에서 열었는지 확인하세요.</span></div>';
  }

  // ---------------------------------------------------------------- route / direction / stops
  function routeMeta() { return state.meta.routes.filter(function (r) { return r.id === state.route; })[0]; }
  function dirMeta() { return routeMeta().directions.filter(function (d) { return d.id === state.dir; })[0]; }
  function stopByOrder(o) { return state.meta.stops[state.route].filter(function (s) { return s.order === o; })[0]; }
  function dirStops() { return dirMeta().stops.map(stopByOrder); }
  function dirLabel(d) { return state.meta.directions[d].label; }
  function defaultStop() { var l = dirMeta().stops; return l[Math.min(2, l.length - 1)]; }
  function savePrefs() { /* nothing is stored in the browser */ }
  function refStopName() { var r = state.meta.directions[state.dir].ref_stop[state.route], s = stopByOrder(r); return s ? s.name : ''; }

  // ---------------------------------------------------------------- columns (one column = one representative run, the same for every stop row)
  function isIncomplete(s, group, view) { return !!(s.hide && s.hide[group] && s.hide[group][view]); }
  function viewSlots() {
    var ix = getIndex(); if (!ix) return { shown: [], hidden: 0, applicable: 0, incomplete: 0 };
    var view = state.dir;
    var app = ix.slots.filter(function (s) { return s.sort && s.sort[view] && (!s.views || s.views.indexOf(view) >= 0); });   // a slot whose runs carry no boarding candidates in this direction is not listed at all (also not under 모두 보기)
    var has = function (s) { return s.present && s.present[state.type] && s.present[state.type][view] > 0; };
    var inc = function (s) { return has(s) && isIncomplete(s, state.type, view); };
    var shown = app.filter(function (s) { return (state.showAll || has(s)) && (state.showIncomplete || !inc(s)); });
    shown.sort(function (a, b) {
      var x = a.sort[view].minute, y = b.sort[view].minute;
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x - y;
    });
    return { shown: shown, hidden: app.length - app.filter(has).length, applicable: app.length, incomplete: app.filter(inc).length };
  }
  function refText(s) {   // time at the SORT REFERENCE stop (not the selected stop)
    var k = s.sort[state.dir];
    if (k && k.basis && k.basis.indexOf('observed') === 0 && k.minute != null) return hm(k.minute) + '경';
    return '없음';
  }
  function cellAt(slotId, type, order) { var g = getGrid(state.route, type || state.type); return g && g.slots[slotId] && g.slots[slotId][String(order)]; }
  function selCell(slotId, type) { return cellAt(slotId, type, state.stop); }
  function matchText(st) {
    if (!st) return '';
    if (st.indexOf('multi-date') === 0) return '여러 날짜 기록';
    var m = /planned trip (\d\d:\d\d)/.exec(st);
    if (st.indexOf('observed on 1 date; planned trip') === 0) return '1일만 관측 · 시간표(예정 ' + (m ? m[1] : '') + ') 근거 있음 · 다른 날짜와의 대응은 미확인';
    if (st.indexOf('observed on 1 date; no planned') === 0) return '1일만 관측 · 본표에 없는 편(전세·중간 출발 등, 미확정)';
    if (st.indexOf('correspondence unclear') === 0) return '날짜 간 대응 불명확 (8분 안에 후보가 있으나 서로 최선이 아님)';
    if (st.indexOf('possible delay') === 0) return '지연 등 다른 원인 가능 (후보가 9~15분 떨어져 있어 합치지 않음)';
    if (st.indexOf('observed only') === 0) return '1일만 관측 (15분 안에 호환되는 대표편 없음)';
    return '관측 날짜 적음, 호환되는 대표편 없음';
  }

  // ---------------------------------------------------------------- real-time card (development fixture only)
  function resolveOperatingDay(bus, nowI) {   // development fixtures: arrival = clock + minutes on the calendar; the operating day comes from the KD first / last trip rule
    var total = nowI.minutes + bus.minutes, dayOff = Math.floor(total / 1440), arrMin = total % 1440, cal = isoAdd(nowI.date, dayOff);
    var out = { hhmm: pad(Math.floor(arrMin / 60)) + ':' + pad(arrMin % 60), dayOff: dayOff, cal: cal };
    if (bus.operatingDay) { out.known = true; out.wd = bus.operatingDay.weekday; out.group = typeOfWd(bus.operatingDay.weekday); out.hour = bus.operatingDay.hour; out.how = '시험용 운행일 확인값'; out.cont = bus.operatingDay.hour * 60 + (arrMin % 60); return out; }
    var r = opDay(state.route, cal, arrMin);
    if (!r) { out.known = false; out.reason = '소속 운행일을 판별할 근거가 없는 시각이에요.'; return out; }
    out.known = true; out.date = r.date; out.group = r.group; out.wd = WD[isoDow(r.date)]; out.cont = r.cont; out.hour = Math.floor(r.cont / 60);
    out.how = r.date === cal ? '그 날짜의 운행일' : '전날 운행일의 ' + Math.floor(r.cont / 60) + '시대';
    return out;
  }
  function refreshBuses() {
    state.hl = null;
    if (state.mode === 'live') { state.buses = null; state.busesAt = null; liveSchedule(); return; }
    if (state.dev.on && state.dev.fixtures) {
      var c = caseById(state.dev.caseId), nI = now();
      state.buses = c.buses.map(function (b, i) { return { idx: i + 1, minutes: b.minutes, seats: b.seats, op: resolveOperatingDay(b, nI) }; });
      state.busesAt = hm(nI.minutes);
      return;
    }
    if (!TRIAL) { state.buses = null; state.busesAt = null; return; }
    // trial replay: the next two stored records of the replay date at THIS stop after the scenario clock (nothing is invented; another stop gets its own records)
    var sc = scenarioById(state.trial.id), nm = hm2m(sc.now), lst = ((TRIAL.replay[state.route] || {})[state.dir] || {})[String(state.stop)] || [];
    state.buses = lst.filter(function (x) { return x[0] > nm; }).slice(0, 2).map(function (x, i) {
      var arr = Math.round(x[0]);
      return { idx: i + 1, minutes: arr - nm, seats: x[1], op: { known: true, wd: TRIAL.weekday, group: typeOfWd(TRIAL.weekday), cont: x[0], hour: Math.floor(x[0] / 60), hhmm: hm(arr), how: '재생 기록의 원래 운행일' } };
    });
    state.busesAt = sc.now;
  }
  function loadFixtures() { return Promise.reject(new Error('disabled')); }
  function setDev(on, caseId) {
    if (!on) { state.dev.on = false; refreshBuses(); renderAll(); return Promise.resolve(); }
    return loadFixtures().then(function () { state.dev.on = true; if (caseId) state.dev.caseId = caseId; refreshBuses(); renderAll(); prefetchBusGrids(); });
  }
  function curBuses() { return state.mode === 'live' ? (state.live.buses || []) : (state.buses || []); }   // the buses of the card that is shown (example scenario or live answer)
  function prefetchBusGrids() {
    var bl = curBuses();
    if (!bl.length) return;
    bl.forEach(function (b) {
      if (!b.op.known) return;
      var t = b.op.group || typeOfWd(b.op.wd);
      if (hasData(t)) loadType(state.route, t).then(function () { renderCard(state.mode === 'live'); }).catch(showLoadError);   // live: a refresh must not re-centre the stop list
    });
  }
  // The past reference is NOT an identification of the same physical bus: it is the past representative run whose time AT THE SELECTED STOP is nearest to the expected arrival.
  // Same route, same direction (view), same day type, the run must have an observed time at the selected stop. No distance limit; ties: more observed dates, earlier time, id.
  function connectBus(b) {
    var o = b.op;
    if (!o.known) return { kind: 'hold', reason: o.reason };
    var type = o.group || typeOfWd(o.wd);
    if (!hasData(type)) return { kind: 'none', type: type, reason: type === '토' ? '이번 자료에는 공휴일이 아닌 토요일 기록이 없어요.' : '이 요일의 기록이 없어요.' };
    var ix = getIndex(state.route, type), g = getGrid(state.route, type);
    if (!ix || !g) return { kind: 'loading' };
    var cands = [];
    ix.slots.forEach(function (s) {
      if (!s.sort || !s.sort[state.dir] || isIncomplete(s, type, state.dir)) return;
      var c = g.slots[s.id] && g.slots[s.id][String(state.stop)];
      if (!c || !c.t) return;
      cands.push({ slot: s, cell: c, gap: c.t[1] - o.cont });
    });
    if (!cands.length) return { kind: 'none', type: type, reason: '이 정류장을 지나는 과거 대표편 기록이 없어요.' };
    cands.sort(function (a, b) {
      var d = Math.abs(a.gap) - Math.abs(b.gap); if (d) return d;
      d = b.cell.t[2] - a.cell.t[2]; if (d) return d;
      d = a.cell.t[1] - b.cell.t[1]; if (d) return d;
      return a.slot.id < b.slot.id ? -1 : 1;
    });
    var best = cands[0], tie = cands.filter(function (c) { return Math.abs(c.gap) === Math.abs(best.gap); }).length > 1;
    return { kind: 'linked', type: type, slot: best.slot, cell: best.cell, gap: best.gap, tie: tie, nCands: cands.length, cls: best.cell.q && best.cell.q[0] ? best.cell.q[0] : null };
  }
  // 줄 순서 안내: N = floor(R of the linked past run). A display rule, not a statistically verified safe lower bound.
  function guidanceHtml(link, live) {
    var r = link.cell && link.cell.r;
    var qc = link.cls ? ' q-' + link.cls : '';   // the colour of the referenced timetable cell; neutral when that cell cannot be classified
    var refl = live ? refLineHtml(link) : '';
    if (!r) return '<div class="bus-guide none' + qc + '">' + (live ? '예상 승차 여유 정보 없음' : '예상 승차 여유 정보가 아직 없어요.') + refl + '</div>';
    var deck = link.slot && link.slot.ref_C === 70 ? ' <span class="deck">2층 기준</span>' : '';
    var sfx = live ? ' <span class="small">(과거 기록 참고)</span>' : '';
    var n = Math.floor(r[0]);
    if (n <= 0) return '<div class="bus-guide' + qc + '"><div class="gl1">예상 승차 여유 <b>' + (r[0] > 0 ? '1명 미만' : '0명') + '</b>' + deck + sfx + '</div>' + refl + '</div>';
    return '<div class="bus-guide' + qc + '"><div class="gl1">예상 승차 여유 약 <b>' + n + '명</b>' + deck + sfx + '</div>' + refl + '</div>';
  }
  // live card only: which past representative run was used. It is the nearest past run by time, not the same physical bus; a large gap is stated.
  function refLineHtml(link) {
    var g = Math.round(Math.abs(link.gap)), far = g >= 10;
    return '<div class="small gl-ref">가장 가까운 과거 참고편 ' + esc(hm(link.cell.t[1])) + '경' + (far ? ' · 예상 도착과 ' + g + '분 차이' : '') + '</div>';
  }
  // ---------------------------------------------------------------- live lookup (one call per explicit user action; no automatic repetition)
  function lsGet() { try { return window.localStorage.getItem(LS_KEY); } catch (e) { return null; } }
  function lsSet(v) { try { if (v == null) window.localStorage.removeItem(LS_KEY); else window.localStorage.setItem(LS_KEY, v); return true; } catch (e) { return false; } }
  function toN(v) { return (v === '' || v == null || isNaN(Number(v))) ? null : Number(v); }
  // ---- automatic refresh: every AUTO_MS while the live view is open, the tab is visible and the user is active. One timer only; never while a request is running.
  // Call protection (public key quota ~1,000/day): paused when the tab is hidden, the settings page is open, or no interaction for IDLE_MS; stopped on key / quota errors; backed off on network errors.
  function liveAutoOk() { var A = state.liveAuto; return state.mode === 'live' && !!apiKey && !A.stopped && !A.idle && document.visibilityState === 'visible' && $('#settings').hidden; }
  function liveAutoArm(ms) {
    clearTimeout(autoTimer); autoTimer = null;
    if (!liveAutoOk()) return;
    var A = state.liveAuto, every = AUTO_MS * (1 + Math.min(A.fails, 4));   // 1 min, then 2, 3, 4, 5 min after consecutive failures
    autoTimer = setTimeout(liveAutoTick, ms != null ? ms : Math.max(1000, every - (Date.now() - A.last)));
  }
  function liveAutoTick() {
    autoTimer = null;
    if (!liveAutoOk()) return;
    var A = state.liveAuto;
    if (Date.now() - A.active > IDLE_MS) { A.idle = true; renderCard(true); return; }   // a forgotten tab stops calling
    if (state.live.status === 'loading' || liveBgInflight) { liveAutoArm(5000); return; }
    if (state.live.status === 'nokey' || state.live.status === 'idle') return;
    liveBgInflight = true; liveQuery(true);
  }
  function liveAutoResume() {   // after coming back (tab visible, settings closed, activity after a pause): refresh only when the last answer is a minute old
    if (!liveAutoOk()) return;
    var st = state.live.status;
    if (st === 'loading' || st === 'nokey' || st === 'idle' || liveBgInflight) return;   // a first / selection query is the one that starts the cycle
    if (Date.now() - state.liveAuto.last >= AUTO_MS) { liveBgInflight = true; liveQuery(true); } else liveAutoArm();
  }
  function liveAutoReset() { var A = state.liveAuto; A.idle = false; A.stopped = false; A.fails = 0; A.active = Date.now(); }
  function liveMarkActive() { var A = state.liveAuto; A.active = Date.now(); if (A.idle) { A.idle = false; if (state.mode === 'live') { renderCard(true); liveAutoResume(); } } }
  function liveAutoNote() { var A = state.liveAuto; return A.stopped ? ' · 자동 갱신 중지' : (A.idle ? ' · 자동 갱신 일시정지' : ' · 1분마다 자동 갱신'); }
  function liveSchedule() {
    clearTimeout(liveTimer); clearTimeout(autoTimer); autoTimer = null;
    var tok = ++state.live.tok;
    if (!apiKey) { state.live = { status: 'nokey', tok: tok, buses: [], flag: '', at: '', why: '' }; return; }
    state.live = { status: 'loading', tok: tok, buses: [], flag: '', at: '', why: '' };
    liveTimer = setTimeout(liveQuery, 450);   // a short wait so that several quick stop changes make one call
  }
  function liveFail(tok, why, fatal, bg) {
    if (tok !== state.live.tok) return;
    var A = state.liveAuto;
    state.live = { status: 'error', tok: tok, buses: [], flag: '', at: '', why: why };
    A.last = Date.now(); A.fails++;
    if (fatal || A.fails >= FAIL_MAX) A.stopped = true;   // key / quota error, or repeated failures: no more automatic calls until the user acts
    renderCard(bg); liveAutoArm();
  }
  function liveQuery(bg) {
    var tok = state.live.tok, st = stopByOrder(state.stop), rid = ROUTE_IDS[state.route];
    if (!apiKey || !st || !rid) { liveBgInflight = false; liveFail(tok, '조회할 정류장 정보를 찾지 못했어요.', true, bg); return; }
    var qs = new URLSearchParams({ format: 'json', serviceKey: apiKey, stationId: String(st.id), routeId: rid, staOrder: String(state.stop) });   // the raw (Decoding) key is encoded exactly once here
    fetch(API_URL + '?' + qs.toString(), { cache: 'no-store', credentials: 'omit' }).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, text: t }; });
    }).then(function (x) {
      if (bg) liveBgInflight = false;
      if (tok !== state.live.tok) return;
      var p = liveParse(x.status, x.text);
      if (p.kind === 'ok' || p.kind === 'none') {
        var k = kstNow();
        (p.buses || []).forEach(function (b) {   // arrival = response time + ETA (seconds when given), fixed now: later clock changes or day tabs never move the reference run
          var etaSec = b.sec != null ? b.sec : b.minutes * 60;
          b.op = resolveOperatingDay({ minutes: Math.round((k.sec + etaSec) / 60) }, { minutes: k.minutes, date: k.date });
        });
        state.live = { status: p.kind, tok: tok, buses: p.buses || [], flag: p.flag || '', at: pad(Math.floor(k.minutes / 60)) + ':' + pad(k.minutes % 60) + ':' + pad(k.sec), atMin: k.minutes, why: '' };
        if (!bg) state.hl = null;   // an automatic refresh keeps the table highlight the user is looking at
        var A = state.liveAuto; A.last = Date.now(); A.fails = 0; A.stopped = false;
        renderCard(bg); prefetchBusGrids(); liveAutoArm();
      } else liveFail(tok, p.why, p.fatal, bg);
    }, function () { if (bg) liveBgInflight = false; liveFail(tok, '연결에 실패했어요. 네트워크 상태를 확인해 주세요. 브라우저가 요청을 막았을 수도 있어요.', false, bg); });
  }
  function liveParse(httpStatus, text) {
    var j; try { j = JSON.parse(text); } catch (e) { return { kind: 'err', why: '응답을 읽지 못했어요(HTTP ' + httpStatus + ').' }; }
    var g = j && j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader;
    if (g) {
      var c = String(g.returnReasonCode);
      if (c === '22') return { kind: 'err', fatal: true, why: '오늘 호출 한도를 넘었어요. 내일 다시 시도해 주세요.' };
      if (c === '23') return { kind: 'err', why: '짧은 시간에 요청이 많았어요. 잠시 뒤 다시 눌러 주세요.' };
      if (c === '20' || c === '30' || c === '31' || c === '32') return { kind: 'err', fatal: true, why: '인증키를 확인해 주세요. Decoding(원본키)인지, 사용 신청이 승인됐는지 확인해 보세요. (오류 코드 ' + c + ')' };
      return { kind: 'err', why: '조회하지 못했어요. (오류 코드 ' + c + ')' };
    }
    var r = j && j.response, h = r && r.msgHeader;
    if (!h) return { kind: 'err', why: '예상하지 못한 응답 형식이에요(HTTP ' + httpStatus + ').' };
    var rc = toN(h.resultCode);
    if (rc === 4) return { kind: 'none', buses: [], flag: '' };
    if (rc !== 0) return { kind: 'err', why: '조회하지 못했어요. (결과 코드 ' + esc(String(h.resultCode)) + ')' };
    var it = r.msgBody && r.msgBody.busArrivalItem;
    if (Array.isArray(it)) it = it[0];
    if (!it) return { kind: 'none', buses: [], flag: '' };
    var buses = [];
    [1, 2].forEach(function (i) {
      var pt = toN(it['predictTime' + i]), ps = toN(it['predictTimeSec' + i]);
      if (pt == null && ps == null) return;
      var min = pt != null ? pt : Math.ceil(ps / 60);
      buses.push({ idx: buses.length + 1, minutes: min, sec: ps, seats: toN(it['remainSeatCnt' + i]), loc: toN(it['locationNo' + i]), low: toN(it['lowPlate' + i]) });
    });
    var flag = it.flag == null ? '' : String(it.flag);
    return { kind: buses.length ? 'ok' : 'none', buses: buses, flag: flag };
  }
  function liveBusHtml(b) {
    var names = ['첫 번째 버스', '두 번째 버스'], o = b.op, link = connectBus(b);
    var eta = b.minutes <= 0 || (b.sec != null && b.sec < 60) ? '곧 도착' : b.minutes + '분 후';
    var seats = (b.seats == null || b.seats < 0) ? '<span class="small">빈자리 정보 없음</span>' : '현재 빈자리 <b>' + b.seats + '석</b>';
    var extra = [];
    if (b.loc != null && b.loc >= 0) extra.push(b.loc === 0 ? '이 정류장 도착' : b.loc + '정류장 전');
    if (b.low != null && LOWPLATE[b.low]) extra.push(LOWPLATE[b.low]);
    var h = '<div class="bus live' + (link.kind === 'linked' && link.cls ? ' qa-' + link.cls : '') + '" data-bus="' + b.idx + '"><div class="bus-head"><span>' + (b.idx === 1 ? '①' : '②') + ' ' + names[b.idx - 1] + ' · <b>' + eta + '</b> <span class="eta">(' + o.hhmm + '경 도착 예정)</span></span></div>' +
      '<div class="bus-obs">' + seats + (b.seats != null && b.seats >= 0 ? ' <span class="small">· ' + esc(state.live.at.slice(0, 5)) + ' 조회 기준</span>' : '') + '</div>' +
      (extra.length ? '<div class="bus-ref live-extra">' + esc(extra.join(' · ')) + '</div>' : '');
    if (link.kind === 'loading') h += '<div class="bus-guide none">불러오는 중…</div>';
    else if (link.kind === 'hold') h += '<div class="bus-guide none">참고할 과거 기록을 고르지 못했어요.<div class="small">' + esc(link.reason) + '</div></div>';
    else if (link.kind === 'none') h += '<div class="bus-guide none">' + (hasData(link.type) ? '참고할 과거 기록이 없어요.<div class="small">' + esc(link.reason) + '</div>' : '해당 요일의 과거 기록이 없습니다.') + '</div>';
    else h += guidanceHtml(link, true) + '<div class="bus-ref"><button class="btn primary bus-go" data-go="' + b.idx + '">시간표에서 보기 ▸</button></div>';
    return h + '</div>';
  }  function liveBodyHtml() {
    var L = state.live;
    if (L.status === 'nokey') return '<div class="rt-empty">실시간 조회에는 인증키가 필요해요. <button type="button" class="btn primary" data-act="open-key">인증키 입력</button><div class="small">키 없이는 \'예시 보기\'를 이용할 수 있어요.</div></div>';
    if (L.status === 'loading' || L.status === 'idle') return '<div class="rt-empty">조회 중…</div>';
    if (L.status === 'error') return '<div class="rt-empty live-err" role="alert"><b>조회하지 못했어요.</b><br>' + esc(L.why) + '<div><button type="button" class="btn" data-act="refresh">다시 조회</button></div></div>';
    var h = '';
    if (L.status === 'none' || !L.buses.length) {
      var fl = L.flag === 'STOP' ? ' <span class="small">(운행 종료 상태)</span>' : (L.flag === 'WAIT' ? ' <span class="small">(회차 대기 중)</span>' : '');
      return '<div class="rt-empty">현재 도착 예정 버스가 없습니다.' + fl + '</div>';
    }
    return L.buses.map(liveBusHtml).join('');
  }
  function modeBarHtml() {
    return '<div class="modes" role="tablist" aria-label="보기 방식">' + [['live', '실시간 조회'], ['example', '예시 보기']].map(function (m) {
      return '<button type="button" role="tab" class="mode-btn' + (state.mode === m[0] ? ' on' : '') + '" data-mode="' + m[0] + '" aria-selected="' + (state.mode === m[0]) + '">' + m[1] + '</button>';
    }).join('') + '</div>';
  }
  function liveMetaHtml() {
    var L = state.live, busy = L.status === 'loading';
    var t = L.at ? '마지막 조회 ' + esc(L.at.slice(0, 5)) : (busy ? '조회 중…' : (L.status === 'error' ? '조회 실패' : '아직 조회하지 않았어요'));
    return '<div class="trial-meta"><span>공식 도착정보 · ' + t + (apiKey ? liveAutoNote() : '') + '</span>' + (apiKey ? '<button type="button" class="btn" data-act="refresh"' + (busy ? ' disabled' : '') + '>새로고침</button>' : '') + '</div>';
  }
  function setMode(m) {
    if (m === state.mode) return;
    state.mode = m;
    if (m === 'example') { clearTimeout(autoTimer); autoTimer = null; selectScenario(state.trial.id); return; }   // the example view never calls the API
    liveAutoReset();
    state.detail = null; state.detailOpen = false; refreshBuses(); renderCard(); renderStats(); renderDetail();
  }

  // ---------------------------------------------------------------- controls
  function renderControls() {
    $('#sel-route').innerHTML = state.meta.routes.map(function (r) { return '<option value="' + r.id + '"' + (r.id === state.route ? ' selected' : '') + '>' + r.id + '</option>'; }).join('');
    $('#sel-dir').innerHTML = routeMeta().directions.map(function (d) { return '<option value="' + d.id + '"' + (d.id === state.dir ? ' selected' : '') + '>' + esc(d.label) + '</option>'; }).join('');
  }
  function stopListHtml() {
    var list = dirStops();
    var h = '<nav class="stoplist" aria-label="내 정류장 선택(노선 순서)"><div class="sl-title">내 정류장 <span class="small">탑승 후보 ' + list.length + '곳 · 노선 순서</span></div><ol>';
    list.forEach(function (s, i) {
      var sel = s.order === state.stop;
      h += '<li class="' + (i === 0 ? 'first ' : '') + (i === list.length - 1 ? 'last ' : '') + (sel ? 'sel' : '') + '"><button type="button" class="stop-btn" data-stop="' + s.order + '" aria-pressed="' + sel + '">' +
        '<span class="dot" aria-hidden="true"></span><span class="sn"><span class="nm">' + esc(s.name) + '</span>' + (s.turn ? '<span class="meta">회차</span>' : '') + '</span></button></li>';
    });
    var nb = dirMeta().no_boarding || [];
    if (nb.length) h += '</ol><div class="small nb-note">' + nb.map(function (x) { return esc(sname(x.order)) + '은(는) 승차 금지 정류장이라 승차 목록에서 뺐어요 <span class="small">(사용자 제공 운영 정보, 공식 확인 안 함)</span>'; }).join('<br>') + '</div></nav>';
    else h += '</ol></nav>';
    return h;
  }
  function scenarioBarHtml() {
    var sc = scenarioById(state.trial.id), nI = now();
    var h = '<div class="scen" role="group" aria-label="예시 상황 선택">' + TRIAL.scenarios.map(function (x) {
      var on = x.id === state.trial.id && !state.trial.custom;
      return '<button type="button" class="scen-btn' + (on ? ' on' : '') + '" data-scen="' + x.id + '" aria-pressed="' + on + '"><b>' + esc(String(x.label).replace(/ 체험$/, ' 예시')) + '</b><span>' + esc(x.sub).replace(' · ', '<br>') + '</span></button>';
    }).join('') + '</div>';
    return h + '<div class="trial-meta"><span class="pill-demo">가상 예시</span> <span>' + TYPE_LABEL[typeOfWd(TRIAL.weekday)] + ' ' + esc(sc.now) + ' 기준 도착정보</span></div>';
  }
  function renderCard(keep) {   // keep = automatic refresh: keep the stop-list scroll position and the keyboard focus
    var el = $('#card'), s = stopByOrder(state.stop), live = state.mode === 'live';
    var oldOl = keep ? el.querySelector('.stoplist ol') : null, keepTop = oldOl ? oldOl.scrollTop : null, fsel = null, ae = document.activeElement;
    if (keep && ae && el.contains(ae)) fsel = ae.hasAttribute('data-stop') ? '.stop-btn[data-stop="' + ae.getAttribute('data-stop') + '"]' : (ae.hasAttribute('data-go') ? '.bus-go[data-go="' + ae.getAttribute('data-go') + '"]' : (ae.hasAttribute('data-act') ? '[data-act="' + ae.getAttribute('data-act') + '"]' : (ae.hasAttribute('data-mode') ? '[data-mode="' + ae.getAttribute('data-mode') + '"]' : null)));
    var head = '<div class="card-head"><div><h2>다가오는 버스</h2><div class="sub">' + esc(state.route) + ' ' + esc(dirLabel(state.dir)) + ' · ' + esc(s ? s.name : '') + '</div></div></div>';
    var banner = '', buses = '';
    if (live) buses = liveBodyHtml();
    else if (!state.buses || !state.buses.length) buses = '<div class="rt-empty">이 정류장에는 예시 도착정보가 없어요. 다른 정류장을 선택해 보세요.</div>';
    else buses = state.buses.map(busHtml).join('');
    el.innerHTML = modeBarHtml() + (live ? liveMetaHtml() : scenarioBarHtml()) + head + banner + '<div class="rt-wrap"><div class="rt-buses">' + buses + '</div>' + stopListHtml() + '</div>';
    var sl = el.querySelector('.stoplist li.sel'), ol = el.querySelector('.stoplist ol');
    if (keepTop != null && ol) ol.scrollTop = keepTop;
    else if (sl && ol && ol.scrollHeight > ol.clientHeight) ol.scrollTop = Math.max(0, ol.scrollTop + (sl.getBoundingClientRect().top - ol.getBoundingClientRect().top) - ol.clientHeight / 2 + sl.offsetHeight / 2);
    if (fsel) { var fe = el.querySelector(fsel); if (fe) { try { fe.focus({ preventScroll: true }); } catch (e) { fe.focus(); } } }
  }
  function busHtml(b) {
    var names = ['첫 번째 버스', '두 번째 버스'], o = b.op, link = connectBus(b);
    var h = '<div class="bus' + (link.kind === 'linked' && link.cls ? ' qa-' + link.cls : '') + '" data-bus="' + b.idx + '"><div class="bus-head"><span>' + (b.idx === 1 ? '①' : '②') + ' ' + names[b.idx - 1] + ' · <b>' + b.minutes + '분 후</b> <span class="eta">(' + o.hhmm + ' 도착 예정)</span></span></div>' +
      '<div class="bus-obs">예시 빈자리 <b>' + b.seats + '석</b></div>';
    if (link.kind === 'loading') h += '<div class="bus-guide none">불러오는 중…</div>';
    else if (link.kind === 'hold') h += '<div class="bus-guide none">참고할 과거 기록을 고르지 못했어요.<div class="small">' + esc(link.reason) + '</div></div>';
    else if (link.kind === 'none') h += '<div class="bus-guide none">참고할 과거 기록이 없어요.<div class="small">' + esc(link.reason) + '</div></div>';
    else h += guidanceHtml(link) + '<div class="bus-ref"><button class="btn primary bus-go" data-go="' + b.idx + '">시간표에서 보기 ▸</button></div>';
    return h + '</div>';
  }
  function selectScenario(id) {
    var sc = scenarioById(id);
    state.trial = { id: id, custom: false };
    state.route = sc.route; state.dir = sc.dir; state.stop = sc.stop; state.type = typeOfWd(TRIAL.weekday);
    resetAfterSelectionChange(); renderAll();
    return loadViewAndRender().then(function () { scrollToDefault(); prefetchBusGrids(); });
  }
  function goBus(idx) {
    var b = curBuses().filter(function (x) { return x.idx === idx; })[0];
    if (!b) return;
    var link = connectBus(b);
    if (link.kind === 'loading') { loadType(state.route, b.op.group || typeOfWd(b.op.wd)).then(function () { renderCard(); goBus(idx); }).catch(showLoadError); return; }
    if (link.kind !== 'linked') return;
    state.type = link.type;
    var my = viewKey();
    var idxs = curBuses().filter(function (x) { var l = connectBus(x); return l.kind === 'linked' && l.slot.id === link.slot.id && l.type === link.type; }).map(function (x) { return x.idx; });
    state.hl = { idxs: idxs, clicked: idx, slot: link.slot.id, stop: state.stop, type: link.type, route: state.route, dir: state.dir };
    loadView().then(function () {
      if (my !== viewKey()) return;
      if (!viewSlots().shown.some(function (s) { return s.id === link.slot.id; })) { state.showMore = true; state.showAll = true; }   // the referenced column must be visible
      openDetail({ slot: link.slot.id, order: state.stop, type: link.type, fromBus: idx }, { k: 'bus', idx: idx });
      renderStats(); renderDetail(); scrollToCell(link.slot.id, state.stop);
    }).catch(showLoadError);
  }

  // ---------------------------------------------------------------- stats area
  function renderTypes() {
    $('#types').innerHTML = TYPES.map(function (t) {
      var lab = t === '일·공휴일' ? '일·<small>공휴일</small>' : t;
      return '<button class="seg" role="tab" data-type="' + t + '" aria-label="' + TYPE_LABEL[t] + '" aria-selected="' + (t === state.type) + '">' + lab + (hasData(t) ? '' : '<i class="soon" title="공휴일이 아닌 토요일 기록 없음"></i>') + '</button>';
    }).join('');
  }
  function datesList(type) {
    var info = state.meta.date_info;
    return typeDates(type).map(function (d) { var x = info[d]; return d.slice(5) + ' ' + x.wd + (x.cls !== '정상 평일' ? '(' + x.cls + (x.name ? ' ' + x.name : '') + ')' : ''); }).join(' · ');
  }
  function renderBasis() {
    var ds = typeDates(state.type);
    $('#basis').innerHTML = ds.length ? '<b>' + TYPE_LABEL[state.type] + '</b> 최근 기록 ' + ds.length + '일 <details class="inl"><summary>날짜 보기</summary><div class="small">' + esc(datesList(state.type)) + '<br>' + esc(state.type === '일·공휴일' ? state.meta.types.holiday_block.note : '이 요일의 공휴일이 아닌 날짜만 쓰고 다른 요일과 섞지 않아요.') + '</div></details>' : '';
  }
  function renderColInfo() {
    var el = $('#colinfo');
    if (!hasData(state.type)) {
      el.innerHTML = '<div class="nodata-box"><b>정상 토요일 기록이 없어요.</b> 이번 자료에는 공휴일이 아닌 토요일이 없어요. 공휴일인 토요일은 \'일·공휴일\'에 들어 있고, 일반 토요일 기록처럼 보여주지 않아요.</div>';
      return;
    }
    var vs = viewSlots(), more = '';
    if (vs.hidden > 0 || vs.incomplete > 0) {
      more = '<button type="button" class="btn more-btn" id="btn-more" aria-expanded="' + !!state.showMore + '">기록 더 보기 ' + (state.showMore ? '▴' : '▾') + '</button>';
      if (state.showMore) {
        more += '<div class="more-panel">' +
          (vs.hidden > 0 ? '<div class="more-row"><span>기록이 부족한 편 <b>' + vs.hidden + '개</b></span><button type="button" class="btn" id="btn-showall">' + (state.showAll ? '숨기기' : '표시') + '</button></div>' : '') +
          (vs.incomplete > 0 ? '<div class="more-row"><span>불완전 기록 <b>' + vs.incomplete + '개</b></span><button type="button" class="btn" id="btn-showinc">' + (state.showIncomplete ? '숨기기' : '확인하기') + '</button></div>' : '') + '</div>';
      }
    }
    el.innerHTML = more;
  }
  function renderStats() { renderTypes(); renderBasis(); renderColInfo(); renderGrid(); renderLegend(); }
  // run-kind mark of a column header: only what the data derived for the SELECTED weekday group and direction (index.kinds): c = 전세 (출근 전세는 동탄→서울 열에만, 퇴근 전세는 서울→동탄 열에만 나타남), m = 전세(중간) with the
  // designated start (existing ms_text), t = 임시 추정 (reserved: only with positive evidence of an extra trip; none is derived). Regular, mixed and unconfirmed columns get no mark; the front end never infers a kind.
  var KIND_TITLE = '전세 시간표(2026-09-30 본문 이미지) 대응 운행 · 정상 평일 전체에 적용한 가정 · 적용 기간 미확인';
  function runKindMark(s) {
    var k = s.kinds && s.kinds[state.type] && s.kinds[state.type][state.dir];
    if (k === 'c') return '<i class="ms" title="' + esc(KIND_TITLE) + '">전세</i>';
    if (k === 'm') return '<i class="ms" title="' + esc(KIND_TITLE) + '">전세(중간) ' + esc(s.ms_text) + '</i>';
    if (k === 't') return '<i class="ms">임시 추정</i>';
    return '';
  }
  function renderGrid() {
    var tbl = $('#grid');
    if (!hasData(state.type) || !getIndex() || !getGrid()) { tbl.innerHTML = ''; return; }
    var vs = viewSlots(), stops = dirStops(), ndw = typeDates(state.type).length;
    var h = '<thead><tr><th class="corner">정류장</th>';
    vs.shown.forEach(function (s, i) {
      var hl = state.hl && state.hl.slot === s.id && state.hl.type === state.type;
      // the column header carries no time: the time of a representative run differs by stop and is not a timetable (departure) time; the time of each stop is in its cell. The column ORDER (sort key) is unchanged.
      h += '<th class="col' + (hl ? ' hl' : '') + '" data-slot="' + esc(s.id) + '">' +
        '<span class="bd">' + runKindMark(s) + (s.ref_C === 70 ? '<i class="deck">2층 기준</i>' : '') + '</span></th>';
    });
    h += '</tr></thead><tbody>';
    stops.forEach(function (st) {
      var mine = st.order === state.stop;
      h += '<tr class="' + (mine ? 'mine' : '') + '" data-stop="' + st.order + '"><th class="stop" scope="row" data-stop="' + st.order + '"><span class="nm">' + (mine ? '▶ ' : '') + esc(st.name) + '</span>' + (st.turn ? '<span class="ord">회차</span>' : '') + '</th>';
      vs.shown.forEach(function (s) { h += cellHtml(s, st, ndw); });
      h += '</tr>';
    });
    tbl.innerHTML = h + '</tbody>';
  }
  function peopleText(c) {   // second line of a cell and the card use the same R (median over the records that have R); R = 0 and 0 < R < 1 are different; missing is never 0
    var r = c && c.r;
    if (!r) return '(—)';
    if (r[0] >= 1) return '(' + Math.floor(r[0]) + '명)';
    return r[0] > 0 ? '(1명 미만)' : '(0명)';
  }
  var MODE_NOTE = { b: '인원·색: 이 요일에 기준 차종 기록이 없어 같은 배차 유형의 다른 날짜 기록 참고', n: '인원·색: 같은 운행의 앞뒤 기록으로 보완', c: '인원·색: 같은 정류장·배차 유형·차종에서 가장 가까운 시각의 다른 대표편 기록 참고', f: '일부 F: 2025년 승하차 통계 기반 추정' };
  function suppNote(c) {
    var a = [];
    if (!c.t && c.u && c.u[1] != null) a.push('시각: 과거 기록 기반 보완값(관측 없음)');
    if (c.m && MODE_NOTE[c.m]) a.push(MODE_NOTE[c.m] + (c.bd && c.bd.length ? ' (' + c.bd.join(', ') + ')' : '') + (c.sr ? ' (' + (c.sr[0] ? c.sr[0] + ', 시각차 ' + c.sr[1] + '분, ' : '') + c.sr[2].join(', ') + ')' : ''));
    if (c.fs && c.m !== 'f') a.push('일부 F: 2025년 승하차 통계 기반 추정');
    return a;
  }
  function cellHtml(s, st, ndw) {
    var g = getGrid(), gs = g.slots[s.id], c = gs && gs[String(st.order)];
    var sel = state.detail && state.detail.slot === s.id && state.detail.order === st.order && state.detail.type === state.type ? ' sel' : '';
    var hl = state.hl && state.hl.slot === s.id && state.hl.stop === st.order && state.hl.type === state.type && state.hl.route === state.route && state.hl.dir === state.dir;
    var mk = hl ? '<span class="mk">' + state.hl.idxs.map(function (i) { return i === 1 ? '①' : '②'; }).join('') + '</span>' : '';
    var attrs = ' data-slot="' + esc(s.id) + '" data-stop="' + st.order + '"';
    var q = c && c.q && c.q[0] ? c.q[0] : null;
    var qcls = q ? ' q-' + q : '';
    var qb = q ? '' : (c && c.q && (c.t || c.r) ? '<b class="qb na" title="분류 불가">불가</b>' : '');   // the cell colour and the title / aria-label carry the class; only "불가" stays as text
    var qtxt = q ? ' · ' + QC[q].name : (c && c.q ? ' · 분류 불가' : '');
    var notes = c ? suppNote(c) : [];
    var sp = notes.length ? '<b class="sp" title="' + esc(notes.join(' · ')) + '">＋</b>' : '';
    var hasT = c && c.t, supT = c && !c.t && c.u && c.u[1] != null;
    if (c && (hasT || supT || (c.r && c.q))) {
      var k = hasT ? c.t[0] : 'a', main = hasT ? hm(c.t[1]) : (supT ? hm(c.u[1]) : '—');
      var tag = k === 'u' ? '<i class="tg">?</i>' : '';
      var marks = (c.c ? '<b class="mc" title="해석 주의 사례 포함">◆</b>' : '') + (c.p ? '<b class="mp" title="해석 주의 사례의 연결 기록">◇</b>' : '');
      var title = st.name + ' ' + main + ' ' + peopleText(c).replace(/[()]/g, '') + qtxt + (notes.length ? ' · ＋ 보완값 포함' : '') + (c.c ? ' · ◆ 해석 주의' : '');
      return '<td class="k-' + k + qcls + sel + (hl ? ' bus' : '') + '"' + attrs + ' title="' + esc(title) + '" aria-label="' + esc(title) + '">' + mk + marks + sp + '<span class="tm">' + main + tag + '</span><span class="sm pp">' + peopleText(c) + '</span>' + qb + '</td>';
    }
    var short = c ? shortStatus(c.s) : CELL_SHORT.slot_absent;
    var tt = st.name + ' · ' + (c ? statusText(c.s) : '이 요일에는 이 대표편에 대응하는 운행 기록이 없어요') + qtxt;
    return '<td class="st' + qcls + sel + '"' + attrs + ' title="' + esc(tt) + '" aria-label="' + esc(tt) + '">' + mk + sp + '<span class="sm">' + esc(short) + '</span>' + qb + '</td>';
  }
  function shortStatus(s) {
    var order = ['before_seoul_start', 'not_operating', 'origin_record_missing', 'start_missing_ms', 'lead_gap', 'gap_before_first', 'trail_gap', 'no_record', 'trail_blocked', 'beyond_turn', 'beyond_last', 'origin_unknown', 'origin_missing_basis', 'beyond_last', 'not_target', 'slot_absent'];
    for (var i = 0; i < order.length; i++) if (s[order[i]]) return CELL_SHORT[order[i]];
    return '기록 없음';
  }
  // user-facing wording of a cell state. The internal codes are NOT merged: before_seoul_start (demonstration start chosen from the first observation; actual service unknown) and not_operating (designated mid-start run, evidenced) keep their own codes.
  var STATUS_UX = {
    before_seoul_start: ['운행 안 함', '적용 운행 기준상 영업 대상 아님 (실제 운행 여부 미확인)'],
    not_operating: ['운행 안 함', '이 편은 이 정류장에서 운행하지 않아요(지정 중간 출발편).'],
    not_target: ['영업 대상 아님', '이 방향에서는 승차 안내를 하지 않는 운행이에요.'],
    beyond_last: ['관측 밖', '이 운행의 마지막 기록 이후라 값을 만들지 않았어요.'],
    origin_unknown: ['시작 위치 미확정', '이 운행의 시작 위치를 알 수 없어 값을 만들지 않았어요.'],
    gap_before_first: ['기록 없음', '이 정류장 기록이 없어요.'], lead_gap: ['기록 없음', '이 정류장 기록이 없어요.'], trail_gap: ['기록 없음', '이 정류장 기록이 없어요.'], no_record: ['기록 없음', '이 정류장 기록이 없어요.'],
    origin_record_missing: ['기록 없음', '출발지 기록이 없어요.'], origin_missing_basis: ['기록 없음', '출발지 기록이 없어요.'], start_missing_ms: ['기록 없음', '출발 정류장 기록이 없어요.'],
    trail_blocked: ['이어지지 않음', '기록이 이어지지 않는 운행 조각이에요.'], slot_absent: ['대응 없음', '이 요일에는 이 대표편에 해당하는 운행 기록이 없어요.']
  };
  function uxStatus(code) { var x = STATUS_UX[code]; return x ? x : [state.meta.status_codes[code] || code, '']; }
  function statusText(s) { return Object.keys(s).filter(function (k) { return k !== 'rec'; }).map(function (k) { return uxStatus(k)[0]; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' · '); }
  function scrollToCell(slotId, order) {
    var sc = $('#grid-scroll'), td = document.querySelector('#grid td[data-slot="' + slotId + '"][data-stop="' + order + '"]');
    if (!td) return;
    var stopW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--stopw'), 10) || 112;
    var tr = td.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    sc.scrollLeft = Math.max(0, sc.scrollLeft + (tr.left - sr.left) - stopW - 8);
    sc.scrollTop = Math.max(0, sc.scrollTop + (tr.top - sr.top) - headH() - 12);
  }
  function headH() { var th = document.querySelector('#grid thead th'); return th ? th.offsetHeight : 40; }      // sticky header height (the grid header holds no time, only the 2층/중간출발 marks)
  function renderLegend() {
    var sw = ['r', 'o', 'y', 'g'].map(function (k) { return '<div class="lg"><i class="sw q-' + k + '"></i><span><b>' + QC[k].name + '</b></span></div>'; }).join('');
    $('#legend').innerHTML = '<div class="lgrid">' + sw + '</div>';
  }
  function calcHtml(evHtml) {   // the ONE explanation, shown only in the cell detail drawer ("어떻게 계산했나요?"); concept only, details stay in the analysis documents
    var sw = function (k) { return '<span class="sw q-' + k + '"></span>' + QC[k].name; };
    return '<div class="calc">' + (evHtml || '') +
      '<div class="cs"><b>승차 여유 계산</b><p class="fm">R = V + A</p><p class="fm">F = R − B</p>' +
      '<ul class="vars"><li><b>V</b> 도착 시 빈자리</li><li><b>A</b> 예상 하차 인원</li><li><b>B</b> 예상 승차 인원</li><li><b>R</b> 승차 전 여유</li><li><b>F</b> 승차 후 빈자리</li></ul>' +
      '<p class="fd">A·B: 과거 운행기록 및 승하차 통계 기반 추정값 (실제 측정 인원 아님)<br>칸의 숫자: R 중앙값 (소수점 버림)</p></div>' +
      '<div class="cs"><b>색상 분류</b><p class="fd">R 중앙값 10명 기준 · q = F가 4석 이하인 기록 비율 (경계 1/3)</p>' +
      '<table class="qt"><thead><tr><th></th><th>q ≥ 1/3</th><th>q &lt; 1/3</th></tr></thead><tbody>' +
      '<tr><th>R &lt; 10명</th><td>' + sw('r') + '</td><td>' + sw('y') + '</td></tr>' +
      '<tr><th>R ≥ 10명</th><td>' + sw('o') + '</td><td>' + sw('g') + '</td></tr></tbody></table>' +
      '<p class="fd">혼잡 색상: 과거 기록 기반 분류 (실제 탑승 확률 아님)</p></div>' +
      '<p class="fd sym">＋ 보완값 · ◆ 해석 주의 · 24 자정 이후 운행</p></div>';
  }

  // ---------------------------------------------------------------- detail (loaded per representative run, on demand)
  function dlist(a) { return (a || []).map(function (x) { var p = x.split('-'); return parseInt(p[1], 10) + '/' + parseInt(p[2], 10); }).join(', '); }
  function refHtml(agg, group, slot) {
    var r = agg && agg.ref;
    if (!r) return '';
    var deck = r.C ? (r.C === 70 ? '2층 70석' : '일반 45석') : '미정';
    var h = '<div class="refdeck"><b>기준 차종</b>: ' + deck + '<div class="small">시각: ' + (r.time_dates.length ? r.time_dates.length + '일 (' + esc(dlist(r.time_dates)) + ')' : '선택한 요일 직접 관측 없음 · 과거 기록 기반 보완값(＋)') + '</div>';
    var pd = r.people_dates.length + '일 (' + esc(dlist(r.people_dates)) + ')';
    if (r.mode === 's') h += '<div class="small">예상 인원·색: ' + pd + '</div>';
    else if (r.mode === 'f') h += '<div class="small">예상 인원·색: ' + pd + ' · 이 중 ' + (agg.Fcsv || 0) + '건: F 없음 → 2025년 승하차 통계 기반 추정 F (관측·다음 정류장 연결값 아님)</div>';
    else if (r.mode === 'b') h += '<div class="small"><b>보완</b> 예상 인원·색: 선택한 요일 기준 차종 기록 없음 → 같은 배차 유형 다른 날짜 ' + pd + '의 같은 대표편·같은 차종 기록 참고 (관측 날짜 수 제외)</div>';
    else if (r.mode === 'n') h += '<div class="small"><b>보완</b> 예상 인원·색: 동일 운행의 앞뒤 기록 기반 보완값 (' + pd + ', 관측 날짜 수 제외)</div>';
    else if (r.mode === 'c') h += '<div class="small"><b>보완</b> 예상 인원·색: 같은 정류장·배차 유형·차종에서 가장 가까운 시각의 대표편(' + esc(r.src ? r.src.slot : '') + ', 시각 차이 ' + (r.src && r.src.gap_min != null ? Math.abs(r.src.gap_min) : '') + '분, ' + esc(r.src ? ({ 'same weekday': '같은 요일의 기록', 'other dates of the type': '같은 유형의 다른 날짜 기록' }[r.src.scope] || '') : '') + ')의 실제 기록 ' + pd + ' 참고 (날짜별 한 번씩만 사용, 이 대표편의 관측 날짜 수 제외)</div>';
    else if (r.mode === 'x') h += '<div class="small">예상 인원·색: 기준 차종 기록 없음 (계산 불가)</div>';
    return h + '</div>';      // the excluded other-deck dates stay in the data (ref.other_capacity) and in the analysis files; the drawer no longer prints them
  }
  function sname(o) { var x = stopByOrder(o); return x ? x.name : o + '번'; }
  function isDesk() { return window.matchMedia('(min-width: 1000px)').matches; }
  function syncScrim() { var sc = $('#scrim'); if (sc) sc.hidden = !(isDesk() && state.detail && state.detailOpen); }
  function openDetail(det, trigger) { state.detail = det; state.detailOpen = true; state.trigger = trigger; state.focusClose = true; }
  function restoreFocus() {
    var t = state.trigger, el = null;
    if (t) el = t.k === 'bus' ? document.querySelector('#card .bus-go[data-go="' + t.idx + '"]') : document.querySelector('#grid td[data-slot="' + t.slot + '"][data-stop="' + t.stop + '"]');
    if (!el) return;
    if (el.tagName === 'TD' && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  function closeDetail() {
    if (!state.detail) return;
    if (isDesk()) { state.detailOpen = false; renderDetail(); restoreFocus(); }      // desktop: the drawer slides away; the selected cell and the grid scroll position stay
    else { state.detail = null; state.detailOpen = false; renderGrid(); renderDetail(); }   // phone: unchanged bottom-sheet behaviour
  }
  function fmtD(day) { var a = day.split('-'); return parseInt(a[1], 10) + '/' + parseInt(a[2], 10); }
  function datesTxt(a) { return (a || []).map(fmtD).join(', '); }
  function sameSet(a, b) { a = a || []; b = b || []; return a.length === b.length && a.every(function (x) { return b.indexOf(x) >= 0; }); }
  function renderDetail() { renderDetailInner(); syncScrim(); }
  function renderDetailInner() {
    var el = $('#detail');
    if (!state.detail) {
      el.classList.remove('open');
      el.innerHTML = '<div class="empty">표의 칸을 누르면 예상 승차 여유와 근거가 여기에 나와요.</div>';
      return;
    }
    var d = state.detail, ix = getIndex(state.route, d.type), slot = ix && ix.slots.filter(function (s) { return s.id === d.slot; })[0];
    el.classList.toggle('open', isDesk() ? !!state.detailOpen : true);
    if (!slot) { el.innerHTML = '<button class="btn close" id="btn-close">닫기</button><div class="empty">' + (ix ? '이 칸의 정보를 찾지 못했어요.' : '불러오는 중…') + '</div>'; return; }
    var cached = cache.detail[slot.file];
    if (!cached) {
      el.innerHTML = '<button class="btn close" id="btn-close">닫기</button><div class="empty">불러오는 중…</div>';
      ensureDetail(slot.file).then(function () { if (state.detail === d) renderDetail(); }).catch(function (e) { el.innerHTML = '<button class="btn close" id="btn-close">닫기</button><div class="loaderr">' + esc(e.message) + '</div>'; });
      return;
    }
    var st = stopByOrder(d.order), cell = cached.cells[String(d.order)], ds = typeDates(d.type), vs = viewSlots(), rank = vs.shown.indexOf(slot) + 1;
    var agg = cell.wk[d.type], gc = cellAt(slot.id, d.type, d.order);
    var hasT = gc && gc.t, tt = hasT ? hm(gc.t[1]) + (gc.t[0] === 'd' ? ' 출발' : '') : (gc && gc.u && gc.u[1] != null ? hm(gc.u[1]) : null);
    var q = gc && gc.q && gc.q[0] ? gc.q : (agg && agg.q && agg.q[0] ? agg.q : (gc && gc.qs && gc.qs[0] ? gc.qs : null));
    var r = gc && gc.r, ref = agg && agg.ref;
    var h = '<button class="btn close" id="btn-close">닫기</button><h3><span class="h3n">' + esc(st.name) + '</span></h3><div class="dsub">' + esc(state.route) + ' · ' + TYPE_LABEL[d.type] + (tt ? ' <b>' + tt + '</b>' : '') + '</div>';
    if (d.fromBus) h += '<div class="dfrom">' + (d.fromBus === 1 ? '① 첫 번째' : '② 두 번째') + ' 버스가 참고한 기록</div>';
    var plus = suppNote(gc || {}).length > 0;
    if (!r && !q && !hasT) {   // grey cell: no time, no number
      var codes = Object.keys(cell.st || {}).map(function (k) { return cell.st[k]; }).filter(function (c) { return c && c !== 'rec' && c !== 'slot_absent'; });
      if (!codes.length) codes = ['slot_absent'];
      var u = uxStatus(codes[0]);
      h += '<div class="dq q-na"><b>' + esc(u[0]) + '</b></div>' + (u[1] ? '<p class="dnote2">' + esc(u[1]) + '</p>' : '');
    } else {
      if (q) h += '<div class="dq q-' + q[0] + '"><b>' + QC[q[0]].name + '</b></div>';
      else h += '<div class="dq q-na"><b>분류 불가</b></div><p class="dnote2">' + esc(q === null && agg && agg.q ? (QWHY[agg.q[1]] || '') : 'F(승차 후 빈자리) 기록이 없어 분류하지 않았어요.') + '</p>';
      if (r) h += '<div class="dbig">예상 승차 여유 ' + (r[0] >= 1 ? '약 <b>' + Math.floor(r[0]) + '명</b>' : (r[0] > 0 ? '<b>1명 미만</b>' : '<b>0명</b>')) + '</div>';
      else h += '<div class="dbig na">예상 승차 여유 계산 불가</div>';
      var facts = '';
      if (ref) {
        var pd = ref.people_dates || [], td = ref.time_dates || [], borrowed = ['b', 'n', 'c'].indexOf(ref.mode) >= 0;
        if (ref.mode === 'x') facts += '<li>인원·색: 계산할 기록 없음</li>';
        else if (borrowed) {   // same frame as an observed cell; the dates themselves are in "어떻게 계산했나요?"
          facts += '<li>참고 기록 <b>다른 날짜 보완값 사용</b></li><li>' + (td.length ? '인원·색: ' : '') + '선택한 요일 직접 관측 기록 없음</li>'; plus = true;
          if (td.length) facts += '<li>시각 근거 <b>' + td.length + '일</b></li>';
          else if (!hasT) facts += '<li>시각: 과거 기록 기반 보완값</li>';
        }
        else {
          var K = r ? r[2] : null;
          facts += '<li>참고 기록 <b>' + pd.length + '일</b>' + (K != null && K !== pd.length ? ' · ' + K + '건' : '') + '</li>';
          if (td.length && !sameSet(td, pd)) facts += '<li>시각 근거 <b>' + td.length + '일</b></li>';
          if (!td.length && !hasT) facts += '<li>시각: 과거 기록 기반 보완값</li>';
        }
        facts += '<li>기준 차종 <b>' + (ref.C === 70 ? '2층 70석' : (ref.C ? '일반 ' + ref.C + '석' : '미정')) + '</b></li>';
      }
      if (facts) h += '<ul class="dfacts">' + facts + '</ul>';
      h += '<div class="dnote">과거 기록 기반 추정' + (plus ? ' <span class="plus">＋ 보완값 사용</span>' : '') + ((gc && (gc.c || gc.p)) ? ' <span class="plus">◆ 해석 주의</span>' : '') + '</div>';
    }
    // minimal evidence + the shared explanation
    var ev = '';
    if (ref) ev += refHtml(agg, d.type, slot);      // dates behind the number / colour and behind the time, reference deck, supplement mode (moved here from the top of the drawer)
    if (q) ev +='<div class="cs ev1"><b>이 칸의 분류</b><div>R 중앙값 <b>' + num(q[1], 1) + '명</b> → ' + (q[1] < 10 ? '10명 미만' : '10명 이상') + '</div><div>F 4석 이하 <b>' + q[5] + '/' + q[4] + '건</b> → q ' + (q[5] / q[4] >= 1 / 3 ? '≥' : '<') + ' 1/3</div><div>→ <span class="dq q-' + q[0] + '"><b>' + QC[q[0]].name + '</b></span></div></div>';
    if (r || q || hasT) h += '<details class="evid"><summary>어떻게 계산했나요?</summary>' + calcHtml(ev) + '</details>';
    el.innerHTML = h;
    el.scrollTop = 0;
    if (state.focusClose && isDesk() && state.detailOpen) { state.focusClose = false; var cb = $('#btn-close'); if (cb) { try { cb.focus({ preventScroll: true }); } catch (e) { cb.focus(); } } }
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    var el = $('#settings'), m = state.meta;
    var dates = Object.keys(m.date_info).sort(), routes = m.routes.map(function (r) { return r.id; }).join('·');
    var groups = m.day_groups.map(function (g) { return g.id + ' ' + (g.dates.length ? g.dates.length + '일' : '기록 없음'); }).join(' · ');
    var sat = hasData('토') ? '공휴일이 아닌 토요일 기록 ' + typeDates('토').length + '일' : '공휴일이 아닌 토요일 기록 없음';
    el.innerHTML =
      '<div class="panel"><button class="btn" id="btn-back">← 돌아가기</button><h2 style="margin-top:8px">설정·안내</h2></div>' +
      '<div class="panel"><h2>서비스 소개</h2><p>과거 버스 기록으로 정류장별 승차 여유를 비교하고, 공식 도착정보로 지금 오는 버스를 확인하는 서비스입니다.</p></div>' +
      keyPanelHtml() +
      '<div class="panel"><h2>자료</h2><ul class="plain"><li>대상: ' + esc(routes) + ' (동탄→서울, 서울→동탄)</li><li>과거 기록: ' + esc(dates[0]) + ' ~ ' + esc(dates[dates.length - 1]) + ' (달력상 ' + dates.length + '일 범위 · 요일별 기록 일수 상이)</li><li>예시 보기: 가상 예시 도착정보 · 예상 승차 여유: 과거 기록 기반 추정</li>' +
      '<li>승하차 인원 참고값: 경기도 공공데이터(공공데이터포털, 이용허락범위 제한 없음) 가공</li><li>버스 도착·잔여석 기록: 경기버스정보(GBIS) 과거 도착정보 가공 자료</li><li>배차 정보: 운수회사 배차표 (노선·차종 대응 참고)</li>' +
      '<li>요일별 기록: ' + esc(groups) + ' (기록 일수가 적어 참고용)</li><li>일·공휴일: 일요일·공휴일 통합 집계</li><li>' + esc(sat) + '</li></ul></div>' +
      '<div class="panel"><h2>참고</h2><ul class="plain"><li>\'예시 보기\'의 도착정보는 가상 시나리오이고, \'실시간 조회\'는 경기도 버스도착정보 API의 응답입니다.</li><li>예상값은 실제 탑승을 보장하지 않습니다.</li><li>실시간 조회의 \'현재 빈자리\'는 조회 시점의 값이고 \'예상 승차 여유\'는 과거 기록에서 계산한 값입니다. 과거 참고편은 같은 버스가 아니라 도착 시각이 가장 가까운 대표편입니다.</li><li>실시간 조회는 화면이 열려 있는 동안 1분마다 자동 갱신하며, 탭이 숨겨지거나 10분 이상 조작이 없으면 멈춥니다.</li><li>자료 제공기관은 TAGOPA의 예상 결과와 무관하며 이를 보증하지 않습니다.</li><li>기준 차종: 관측 기록과 배차표를 참고한 집계 기준(정원)</li><li>예상 승하차 인원(A·B): 2025년 승하차 공공데이터 기반 추정값</li></ul></div>' +
      '';
  }
  function keyPanelHtml() {
    var stored = lsGet() != null;
    return '<div class="panel" id="key-panel"><h2>실시간 조회 인증키</h2>' +
      '<p class="small">공공데이터포털에서 발급받은 <b>Decoding(원본키)</b>을 입력하세요. (경기도_버스도착정보 조회 서비스, 무료 · 하루 1,000회)</p>' +
      '<div class="key-row"><input type="password" id="inp-key" autocomplete="off" spellcheck="false" placeholder="Decoding 인증키" aria-label="인증키"><button type="button" class="btn primary" id="btn-key-apply">사용</button></div>' +
      '<label class="key-rem"><input type="checkbox" id="chk-remember"' + (stored ? ' checked' : '') + '> 이 브라우저에 기억하기</label>' +
      '<div class="small" id="key-msg" role="status">' + (apiKey ? (stored ? '키를 사용 중이에요(이 브라우저에 저장됨).' : '키를 사용 중이에요(이 페이지를 닫으면 지워져요).') : (stored ? '저장된 키가 있어요.' : '키가 없어요.')) + '</div>' +
      (stored || apiKey ? '<button type="button" class="btn" id="btn-key-clear">' + (stored ? '저장된 키 삭제' : '키 지우기') + '</button>' : '') +
      '<p class="small">기본은 이 페이지에서만 쓰고 저장하지 않아요. 기억하기를 고르면 이 브라우저의 localStorage에 저장돼요. 편의 기능일 뿐 안전한 비밀 저장소가 아니니 공용 기기에서는 쓰지 마세요. 키는 서버나 개발자에게 전송되지 않고 공식 API로만 전달돼요.</p></div>';
  }
  function applyKey() {
    var inp = $('#inp-key'), msg = $('#key-msg'), v = (inp.value || '').trim();
    inp.value = '';
    if (!v) { msg.textContent = '키를 입력해 주세요.'; return; }
    if (/\s/.test(v) || /%[0-9A-Fa-f]{2}/.test(v)) { msg.textContent = '인코딩된 키(Encoding)이거나 형식이 맞지 않아요. 공공데이터포털의 Decoding(원본키)을 입력해 주세요.'; return; }
    apiKey = v; liveAutoReset();
    if ($('#chk-remember').checked) { if (!lsSet(v)) msg.textContent = '브라우저가 저장을 막아 이 페이지에서만 사용해요.'; } else lsSet(null);
    showSettings(false, true);
    if (state.mode !== 'live') setMode('live'); else { refreshBuses(); renderCard(); }
  }
  function clearKey() {
    apiKey = null; lsSet(null); clearTimeout(liveTimer); clearTimeout(autoTimer); autoTimer = null;
    renderSettings();
    if (state.mode === 'live') { refreshBuses(); renderCard(); }
  }

  function showSettings(on, noResume) {
    $('#settings').hidden = !on; $('#main').hidden = on;
    if (on) { clearTimeout(autoTimer); autoTimer = null; renderSettings(); }   // paused while the settings page is open
    else if (state.mode === 'live' && !noResume) liveAutoResume();
  }

  // ---------------------------------------------------------------- popover for choosing the stop from a grid row
  function openPopover(order, x, y) {
    var s = stopByOrder(order), p = $('#popover');
    state.popStop = order;
    p.innerHTML = '<div class="nm">' + esc(s.name) + '</div><button class="btn" id="pop-set">이 정류장을 내 정류장으로</button><button class="btn" id="pop-close">닫기</button>';
    p.hidden = false;
    p.style.left = Math.min(x, window.innerWidth - 210) + 'px';
    p.style.top = Math.min(y, window.innerHeight - 110) + 'px';
  }
  function closePopover() { $('#popover').hidden = true; state.popStop = null; }

  // ---------------------------------------------------------------- render all and events
  function renderAll() { renderControls(); renderCard(); renderStats(); renderDetail(); }
  function setStop(order) {
    state.stop = order; state.hl = null; refreshBuses(); savePrefs(); renderCard(); renderStats();
    prefetchBusGrids();
    var row = document.querySelector('#grid tr.mine'), sc = $('#grid-scroll');
    if (row && sc) {
      var rr = row.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      if (rr.top < sr.top + headH()) sc.scrollTop -= (sr.top + headH() - rr.top) + 4;
      else if (rr.bottom > sr.bottom) sc.scrollTop += (rr.bottom - sr.bottom) + 4;
    }
    var b = document.querySelector('#card .stop-btn[data-stop="' + order + '"]'); if (b && b.focus) { try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); } }
  }
  function scrollToDefault() {
    var sc = $('#grid-scroll'); if (!sc) return;
    var nI = now(), target = typeOfWd(WD[nI.wd]) === state.type ? nI.minutes : 7 * 60, ths = document.querySelectorAll('#grid thead th.col'), pick = null, vs = viewSlots();
    for (var i = 0; i < vs.shown.length; i++) { var k = vs.shown[i].sort[state.dir]; if (k && k.minute != null && k.minute >= target - 5) { pick = ths[i]; break; } }
    var stopW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--stopw'), 10) || 112;
    sc.scrollLeft = pick ? Math.max(0, pick.offsetLeft - stopW) : 0;
    var row = document.querySelector('#grid tr.mine');
    if (row) sc.scrollTop = Math.max(0, row.offsetTop - headH() - 42);
  }
  function resetAfterSelectionChange() { state.hl = null; state.detail = null; state.detailOpen = false; state.showAll = false; state.showIncomplete = false; state.showMore = false; refreshBuses(); savePrefs(); }
  function bind() {
    $('#sel-route').addEventListener('change', function (e) {
      state.trial.custom = true; state.route = e.target.value; state.dir = routeMeta().directions[0].id; state.stop = defaultStop(); resetAfterSelectionChange(); renderAll();
      loadViewAndRender().then(function () { scrollToDefault(); prefetchBusGrids(); });
    });
    $('#sel-dir').addEventListener('change', function (e) {
      state.trial.custom = true; state.dir = e.target.value; state.stop = defaultStop(); resetAfterSelectionChange(); renderAll();
      loadViewAndRender().then(function () { scrollToDefault(); prefetchBusGrids(); });
    });
    $('#types').addEventListener('click', function (e) {
      var b = e.target.closest('.seg'); if (!b) return;
      state.type = b.getAttribute('data-type'); state.hl = null; state.detail = null; state.detailOpen = false; state.showAll = false; state.showIncomplete = false; state.showMore = false;
      renderStats(); renderDetail(); loadViewAndRender().then(scrollToDefault);       // the top card (real-time) is NOT changed by browsing the table
    });
    $('#colinfo').addEventListener('click', function (e) {
      var id = e.target.id;
      if (id === 'btn-more') { state.showMore = !state.showMore; if (!state.showMore) { state.showAll = false; state.showIncomplete = false; } renderColInfo(); renderGrid(); return; }   // folding returns to the default table
      if (id === 'btn-showinc') { state.showIncomplete = !state.showIncomplete; renderColInfo(); renderGrid(); return; }
      if (id === 'btn-showall') { state.showAll = !state.showAll; renderColInfo(); renderGrid(); }
    });
    $('#card').addEventListener('click', function (e) {
      var md = e.target.closest('[data-mode]');
      if (md) { setMode(md.getAttribute('data-mode')); return; }
      var ac = e.target.closest('[data-act]');
      if (ac) {
        var act = ac.getAttribute('data-act');
        if (act === 'open-key') { showSettings(true); var kp = $('#key-panel'); if (kp && kp.scrollIntoView) kp.scrollIntoView(); }
        if (act === 'refresh' && state.mode === 'live' && apiKey && state.live.status !== 'loading' && !liveBgInflight) {   // not while a request is already running; the answer resets the automatic timer
          clearTimeout(liveTimer); clearTimeout(autoTimer); autoTimer = null; liveAutoReset();
          state.live.status = 'loading'; state.live.tok++; renderCard(); liveQuery(false);
        }
        return;
      }
      var sc = e.target.closest('[data-scen]');
      if (sc) { selectScenario(sc.getAttribute('data-scen')); return; }
      var sb = e.target.closest('.stop-btn');
      if (sb) { var o = parseInt(sb.getAttribute('data-stop'), 10); if (o !== state.stop) setStop(o); return; }
      var go = e.target.closest('[data-go]');
      if (go) { goBus(parseInt(go.getAttribute('data-go'), 10)); return; }
    });
    $('#grid').addEventListener('click', function (e) {
      var td = e.target.closest('td'), th = e.target.closest('th.stop');
      if (td) { openDetail({ slot: td.getAttribute('data-slot'), order: parseInt(td.getAttribute('data-stop'), 10), type: state.type }, { k: 'cell', slot: td.getAttribute('data-slot'), stop: td.getAttribute('data-stop') }); renderGrid(); renderDetail(); return; }
      if (th) { var r = th.getBoundingClientRect(); openPopover(parseInt(th.getAttribute('data-stop'), 10), r.right + 6, r.top); }
    });
    $('#detail').addEventListener('click', function (e) { if (e.target.id === 'btn-close') closeDetail(); });
    $('#scrim').addEventListener('click', closeDetail);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.detail && (!isDesk() || state.detailOpen)) closeDetail(); });
    window.addEventListener('resize', function () { if (state.detail) renderDetail(); else syncScrim(); });
    $('#popover').addEventListener('click', function (e) {
      if (e.target.id === 'pop-set') { var o = state.popStop; closePopover(); setStop(o); }
      if (e.target.id === 'pop-close') closePopover();
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('#popover') && !e.target.closest('th.stop')) closePopover(); });
    $('#btn-settings').addEventListener('click', function () { showSettings(true); });
    document.addEventListener('visibilitychange', function () {   // hidden tab: no automatic calls; back: refresh only if the last answer is a minute old
      if (document.visibilityState === 'hidden') { clearTimeout(autoTimer); autoTimer = null; return; }
      liveMarkActive(); liveAutoResume();
    });
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (ev) { document.addEventListener(ev, liveMarkActive, { passive: true }); });
    $('#settings').addEventListener('click', function (e) {
      var id = e.target.id;
      if (id === 'btn-back') showSettings(false);
      if (id === 'btn-key-apply') applyKey();
      if (id === 'btn-key-clear') clearKey();
    });
    $('#settings').addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'inp-key') { e.preventDefault(); applyKey(); } });
    $('#settings').addEventListener('change', function (e) {
    });
  }

  // ---------------------------------------------------------------- start (URL parameters are only a development convenience for deep links / captures)
  function start() {
    Promise.all([fetchJson(BASE + 'meta.json'), fetchJson(BASE + 'trial.json'), fetchJson(BASE + 'operating_day.json')]).then(function (all) {
      var meta = all[0]; TRIAL = all[1]; OPDAY = all[2];
      state.meta = meta;
      var tp = param('trial'), sid = tp === 'pm' ? 'commute_pm' : (tp === 'am' ? 'commute_am' : 'commute_am'), sc = scenarioById(sid);
      state.trial = { id: sid, custom: false };
      state.route = sc.route; state.dir = sc.dir; state.stop = sc.stop; state.type = typeOfWd(TRIAL.weekday);
      var pr = param('route'), pd = param('dir'), ps = param('stop') ? parseInt(param('stop'), 10) : null;      // URL parameters: only for deep links and captures
      if (pr && meta.routes.some(function (r) { return r.id === pr; })) { state.route = pr; state.trial.custom = true; if (pd && routeMeta().directions.some(function (d) { return d.id === pd; })) state.dir = pd; else state.dir = routeMeta().directions[0].id; state.stop = defaultStop(); }
      if (ps && dirMeta().stops.indexOf(ps) >= 0) { state.stop = ps; }
      if (param('type') && TYPE_LABEL[param('type')]) state.type = param('type');
      apiKey = lsGet();                                                    // only a key that the user chose to remember
      if (apiKey && param('mode') !== 'example') { state.mode = 'live'; var tg = groupOfDate(kstNow().date); if (!param('type') && hasData(tg)) state.type = tg; }   // a remembered key opens the live view first
      refreshBuses();
      bind(); renderAll();
      return loadView().then(function () { renderStats(); renderCard(); scrollToDefault(); prefetchBusGrids(); });
    }).then(function () {
      var chain = Promise.resolve();
      return chain.then(function () {
        if (param('slot')) { openDetail({ slot: param('slot'), order: state.stop, type: state.type }, { k: 'cell', slot: param('slot'), stop: String(state.stop) }); renderGrid(); renderDetail(); scrollToCell(param('slot'), state.stop); }
        if (param('go')) goBus(parseInt(param('go'), 10));
      });
    }).catch(function (err) {
      $('#card').innerHTML = '<div class="loaderr"><b>시간표 자료를 불러오지 못했습니다.</b><br>' + esc(err.message) + '<br><span class="small">다른 값으로 대체하지 않았습니다. 웹 서버(또는 GitHub Pages)에서 열어 주세요.</span></div>';
    });
  }
  window.__app = { state: state, cache: cache, connectBus: connectBus, goBus: goBus, guidanceHtml: guidanceHtml, opDay: opDay, selectScenario: selectScenario };
  start();
})();
