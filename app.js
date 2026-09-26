'use strict';

/* ============================================================
 * 衝動タイマー
 * データは localStorage のみ。外部通信なし。
 * ============================================================ */

const STORAGE_KEY = 'impulse-timer.v1';

const DEFAULTS = {
  moods: [
    { id: 'drunk',   label: 'Drunk🍺',               minutes: 10 },
    { id: 'cannot',  label: 'Cannot stop eating🤮', minutes: 15 },
    { id: 'stress',  label: 'Stress😤',              minutes: 10 },
    { id: 'nantonaku', label: 'なんとなく',           minutes: 10 },
  ],
  snacks: ['ナッツ', 'ヨーグルト', '白湯'],
  night: { start: 22, end: 5 },
  // 日付付きの記録。type: 'challenge'（タイマー起動）| 'resisted'（「いいえ」）
  events: [],
  // 実行中／回答待ちのタイマー。{ label, endAt, phase: 'running' | 'done' }
  active: null,
};

/* ---------- storage ---------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    return {
      moods: Array.isArray(data.moods) ? data.moods : structuredClone(DEFAULTS.moods),
      snacks: Array.isArray(data.snacks) ? data.snacks : structuredClone(DEFAULTS.snacks),
      night: data.night && typeof data.night === 'object' ? data.night : { ...DEFAULTS.night },
      events: Array.isArray(data.events) ? data.events : [],
      active: data.active || null,
    };
  } catch (e) {
    return structuredClone(DEFAULTS);
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) { /* 保存できなくても動作は継続 */ }
}

const state = load();

function record(type) {
  state.events.push({ type, at: new Date().toISOString() });
  save();
}

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clampHour(v, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(23, Math.max(0, n));
}

function vibrate() {
  try {
    if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 600]);
  } catch (e) { /* 非対応端末では何もしない */ }
}

/* ---------- 通知音（Web Audio API） ----------
 * iOS Safari では、ユーザー操作（タップ）の中で AudioContext を作成・再開して
 * おかないと後から音を鳴らせないため、タイマー開始のタップ時に unlockAudio() を呼ぶ。
 */

let audioCtx = null;

function unlockAudio() {
  try {
    // 再生中の音楽（Apple Music など）を止めずに重ねて鳴らす
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state !== 'running') audioCtx.resume();
    // 無音を一瞬再生して iOS の再生制限を解除する
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (e) { /* 非対応環境では何もしない */ }
}

function playChime() {
  if (!audioCtx) return;
  const play = () => {
    const t0 = audioCtx.currentTime + 0.05;
    // 2音のチャイムを2回（約1.3秒）
    const notes = [880, 1318.5, 880, 1318.5];
    notes.forEach((freq, i) => {
      const start = t0 + i * 0.32;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.5, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
  };
  try {
    if (audioCtx.state === 'running') play();
    else audioCtx.resume().then(play).catch(() => {});
  } catch (e) { /* noop */ }
}

/* ---------- screens ---------- */

const SCREENS = ['home', 'mood', 'timer', 'done', 'snack', 'summary', 'settings'];

function show(name) {
  for (const s of SCREENS) {
    $('#screen-' + s).hidden = s !== name;
  }
  if (name === 'mood') renderMoods();
  if (name === 'summary') renderSummary();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

document.querySelectorAll('[data-go]').forEach((el) => {
  el.addEventListener('click', () => show(el.dataset.go));
});

/* ---------- 1. ホーム ---------- */

$('#btn-want').addEventListener('click', () => show('mood'));

/* ---------- 2. 気分選択 ---------- */

function renderMoods() {
  const list = $('#mood-list');
  list.textContent = '';
  for (const mood of state.moods) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-mood';
    const label = document.createElement('span');
    label.textContent = mood.label || '（無題）';
    const min = document.createElement('span');
    min.className = 'min';
    min.textContent = `${mood.minutes}分`;
    btn.append(label, min);
    btn.addEventListener('click', () => startTimer(mood));
    list.appendChild(btn);
  }
}

/* ---------- 3. タイマー ---------- */

let tickHandle = null;
let wakeLock = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* 取得できなくても続行 */ }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* noop */ }
  wakeLock = null;
}

function startTimer(mood) {
  unlockAudio(); // 気分ボタンのタップ内で呼ぶ必要がある
  const minutes = Math.max(1, Number(mood.minutes) || 10);
  state.active = {
    label: mood.label,
    endAt: Date.now() + minutes * 60 * 1000,
    phase: 'running',
  };
  record('challenge'); // 挑戦した回数 = タイマーを起動した総回数
  enterTimer();
}

function enterTimer() {
  $('#timer-mood').textContent = state.active.label || '';
  show('timer');
  requestWakeLock();
  tick();
  clearInterval(tickHandle);
  tickHandle = setInterval(tick, 250);
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function tick() {
  if (!state.active) return;
  const remaining = state.active.endAt - Date.now();
  $('#timer-count').textContent = formatRemaining(remaining);
  if (remaining <= 0) finishTimer();
}

function stopTicking() {
  clearInterval(tickHandle);
  tickHandle = null;
  releaseWakeLock();
}

function finishTimer() {
  stopTicking();
  state.active.phase = 'done';
  save();
  vibrate();
  playChime();
  show('done');
}

$('#btn-quit').addEventListener('click', () => {
  stopTicking();
  state.active = null;
  save();
  show('home');
});

/* ---------- 4. 終了 ---------- */

$('#btn-no').addEventListener('click', () => {
  record('resisted'); // 我慢できた回数
  state.active = null;
  save();
  show('home');
});

$('#btn-yes').addEventListener('click', () => {
  const snacks = state.snacks.map((s) => s.trim()).filter(Boolean);
  $('#snack-name').textContent = snacks.length
    ? snacks[Math.floor(Math.random() * snacks.length)]
    : '';
  state.active = null;
  save();
  show('snack');
});

// どちらを選んでも評価・コメントは出さず、そのままホームへ
$('#btn-eat').addEventListener('click', () => show('home'));
$('#btn-skip').addEventListener('click', () => show('home'));

/* ---------- 5. 週次サマリー ---------- */

function startOfWeek(d) {
  // 月曜 0:00 始まり
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

function countBetween(from, to) {
  let resisted = 0;
  let challenge = 0;
  for (const e of state.events) {
    const t = new Date(e.at).getTime();
    if ((from && t < from.getTime()) || (to && t >= to.getTime())) continue;
    if (e.type === 'resisted') resisted++;
    else if (e.type === 'challenge') challenge++;
  }
  return { resisted, challenge };
}

function renderSummary() {
  const thisWeek = startOfWeek(new Date());
  const lastWeek = new Date(thisWeek);
  lastWeek.setDate(lastWeek.getDate() - 7);

  const rows = [
    ['今週', countBetween(thisWeek, null)],
    ['先週', countBetween(lastWeek, thisWeek)],
    ['累計', countBetween(null, null)],
  ];

  const body = $('#summary-body');
  body.textContent = '';

  const head = document.createElement('div');
  head.className = 'summary-row';
  head.innerHTML = '<span class="label"></span><span class="label">我慢できた / 挑戦した</span>';
  body.appendChild(head);

  for (const [label, c] of rows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const n = document.createElement('span');
    n.className = 'nums';
    n.textContent = `${c.resisted} / ${c.challenge}`;
    row.append(l, n);
    body.appendChild(row);
  }
}

/* ---------- 6. 設定（入力は input イベントで保存） ---------- */

function makeDeleteButton(onDelete) {
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn-del';
  del.setAttribute('aria-label', '削除');
  del.textContent = '✕';
  del.addEventListener('click', onDelete);
  return del;
}

function renderSettings() {
  // 気分
  const moods = $('#set-moods');
  moods.textContent = '';
  state.moods.forEach((mood) => {
    const row = document.createElement('div');
    row.className = 'edit-row';

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'label';
    label.value = mood.label;
    label.placeholder = '気分の名前';
    label.addEventListener('input', () => {
      mood.label = label.value;
      save();
    });

    const minutes = document.createElement('input');
    minutes.type = 'number';
    minutes.inputMode = 'numeric';
    minutes.min = '1';
    minutes.max = '180';
    minutes.className = 'minutes';
    minutes.value = mood.minutes;
    minutes.addEventListener('input', () => {
      const n = parseInt(minutes.value, 10);
      if (!Number.isNaN(n) && n >= 1) {
        mood.minutes = Math.min(180, n);
        save();
      }
    });

    const del = makeDeleteButton(() => {
      state.moods = state.moods.filter((m) => m !== mood);
      save();
      renderSettings();
    });

    row.append(label, minutes, del);
    moods.appendChild(row);
  });

  // 代替スナック
  const snacks = $('#set-snacks');
  snacks.textContent = '';
  state.snacks.forEach((snack, i) => {
    const row = document.createElement('div');
    row.className = 'edit-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'label';
    input.value = snack;
    input.placeholder = 'スナック名';
    input.addEventListener('input', () => {
      state.snacks[i] = input.value;
      save();
    });

    const del = makeDeleteButton(() => {
      state.snacks.splice(i, 1);
      save();
      renderSettings();
    });

    row.append(input, del);
    snacks.appendChild(row);
  });

  // 深夜モード
  $('#set-night-start').value = state.night.start;
  $('#set-night-end').value = state.night.end;
}

$('#btn-add-mood').addEventListener('click', () => {
  state.moods.push({ id: uid(), label: '', minutes: 10 });
  save();
  renderSettings();
  const inputs = document.querySelectorAll('#set-moods input.label');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('#btn-add-snack').addEventListener('click', () => {
  state.snacks.push('');
  save();
  renderSettings();
  const inputs = document.querySelectorAll('#set-snacks input.label');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

$('#set-night-start').addEventListener('input', (e) => {
  if (e.target.value === '') return;
  state.night.start = clampHour(e.target.value, DEFAULTS.night.start);
  save();
  applyNightMode();
});

$('#set-night-end').addEventListener('input', (e) => {
  if (e.target.value === '') return;
  state.night.end = clampHour(e.target.value, DEFAULTS.night.end);
  save();
  applyNightMode();
});

/* ---------- 7. 深夜モード ---------- */

function isNight(now = new Date()) {
  const h = now.getHours();
  const { start, end } = state.night;
  if (start === end) return false;
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

function applyNightMode() {
  const night = isNight();
  document.body.classList.toggle('night', night);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', night ? '#000000' : '#FFF4E6');
}

/* ---------- 起動・復帰 ---------- */

function resume() {
  applyNightMode();
  if (!state.active) return;
  if (state.active.phase === 'done') {
    show('done');
    return;
  }
  if (Date.now() >= state.active.endAt) {
    finishTimer();
  } else if ($('#screen-timer').hidden || !tickHandle) {
    enterTimer();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    resume();
    if (tickHandle) requestWakeLock();
  }
});

setInterval(applyNightMode, 60 * 1000);

show('home');
resume();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
