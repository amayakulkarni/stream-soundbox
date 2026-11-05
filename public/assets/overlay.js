(() => {
  'use strict';

  const qs = new URLSearchParams(location.search);
  const path = location.pathname.replace(/\/+$/, '');
  const last = path.split('/').pop();
  const view = { counters: 'counters', alerts: 'alerts', chat: 'chat', comments: 'chat', goal: 'goal', status: 'status', latest: 'latest' }[last] || 'all';
  const solo = ['goal', 'status', 'latest'].includes(view);
  const key = qs.get('key');
  const demo = qs.get('demo') === '1';

  // Look & placement, all optional URL parameters:
  //   ?layout=row|column   ?cpos=top-left|top-center|top-right|bottom-…   ?apos=bottom-center|top-center|middle-center|…
  //   ?scale=1.25          ?preview=1 (dark backdrop for designing)       ?demo=1 (fake data, no server needed)
  const b = document.body;
  b.dataset.layout = qs.get('layout') === 'column' ? 'column' : 'row';
  b.dataset.cpos = qs.get('cpos') || 'top-left';
  b.dataset.apos = qs.get('apos') || 'bottom-center';
  b.dataset.view = view;
  b.dataset.pos = qs.get('pos') || (view === 'status' ? 'top-right' : view === 'latest' ? 'bottom-left' : 'top-center');
  b.dataset.chatpos = qs.get('chatpos') === 'left' ? 'left' : 'right';
  if (qs.get('chat') === '0') b.dataset.chat = '0';
  if (qs.get('blur') === '0') document.documentElement.style.setProperty('--blur', '0px');
  // Panel opacity (0-100): ?glass= wins over the dashboard setting
  const glassParam = qs.get('glass') !== null ? parseFloat(qs.get('glass')) : NaN;
  function applyStyle(st) {
    const pct = Number.isFinite(glassParam) ? glassParam : st && Number.isFinite(st.panelOpacity) ? st.panelOpacity : 94;
    document.documentElement.style.setProperty('--glass-a', String(Math.min(100, Math.max(0, pct)) / 100));
  }
  applyStyle(null);
  if (qs.get('preview') === '1') b.classList.add('preview');
  const scale = parseFloat(qs.get('scale'));
  if (scale > 0.3 && scale < 4) document.documentElement.style.setProperty('--s', String(scale));

  const COUNTERS = [
    { k: 'ytSubs', src: 'yt', who: 'YouTube', what: 'subscribers' },
    { k: 'ytMembers', src: 'yt', who: 'YouTube', what: 'members' },
    { k: 'twFollowers', src: 'tw', who: 'Twitch', what: 'followers' },
    { k: 'twSubs', src: 'tw', who: 'Twitch', what: 'subscribers' },
    { k: 'bmcMembers', src: 'bmc', who: 'Compute', what: 'members' },
    { k: 'bmcCoffees', src: 'bmc', who: 'Compute', what: 'bought' },
  ];

  const SVG = {
    bow: '<svg class="bow" viewBox="0 0 62 40" stroke="#2a0a22" stroke-width="3" stroke-linejoin="round"><path d="M31 20C22 4 4 2 3 14c-1 12 16 14 28 6z" fill="#ffb3d4"/><path d="M31 20c9-16 27-18 28-6 1 12-16 14-28 6z" fill="#ffb3d4"/><circle cx="31" cy="20" r="6.5" fill="#ff1f7d"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="#2a0a22" stroke-width="1.6" stroke-linejoin="round"><path d="M12 1.5c.9 5.6 4.9 9.6 10.5 10.5-5.6.9-9.6 4.9-10.5 10.5C11.1 16.9 7.1 12.9 1.5 12 7.1 11.1 11.1 7.1 12 1.5z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10-6.5a1 1 0 0 0 0-1.8l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>',
    twitch: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h17v11.5l-5 5h-4l-3 3v-3H4zM7 6v10h3.5v1.5L12 16h4l2-2V6z" fill-rule="evenodd"/></svg>',
    bubble: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-6l-5 4v-4H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.2 2.8 4.5 6.4 4.5c2 0 3.7 1.1 4.6 2.7h2c.9-1.6 2.6-2.7 4.6-2.7 3.6 0 5.5 3.7 4 7.3C19.5 16.4 12 21 12 21z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.7 5.9 6.4.7-4.8 4.3 1.4 6.3L12 16.7 6.3 20l1.4-6.3L2.9 9.4l6.4-.7z"/></svg>',
    cup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3c0 1.2 1.2 1.2 1.2 2.4M12 3c0 1.2 1.2 1.2 1.2 2.4"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20"/><path d="M12 8.5C10 8.500 7.500 7.500 8 5.500 8.500 3.500 11.500 4.500 12 8.500zM12 8.5C14 8.5 16.500 7.500 16 5.500 15.500 3.500 12.500 4.500 12 8.500z"/></svg>',
  };

  /* ───────── counters ───────── */
  const countersEl = document.getElementById('counters');
  const cards = {};
  for (const c of COUNTERS) {
    const el = document.createElement('div');
    el.className = `stat src-${c.src}`;
    el.hidden = true;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '–';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = c.who;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = c.what;
    el.append(who, num, what);
    countersEl.append(el);
    cards[c.k] = { el, num, shown: null, raf: 0 };
  }
  if (view === 'alerts') countersEl.hidden = true;

  const fmt = (n) => n.toLocaleString('en-US');

  function setValue(k, target, hiddenFlag) {
    const c = cards[k];
    if (!c) return;
    if (target === null || target === undefined) {
      cancelAnimationFrame(c.raf);
      c.num.textContent = hiddenFlag ? 'hidden' : '–';
      c.shown = null;
      return;
    }
    if (c.shown === target) return;
    const from = c.shown === null ? target : c.shown;
    c.shown = target;
    cancelAnimationFrame(c.raf);
    if (from === target) {
      c.num.textContent = fmt(target);
      return;
    }
    if (target > from) {
      c.el.classList.remove('bump');
      void c.el.offsetWidth; // restart the animation
      c.el.classList.add('bump');
    }
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 900);
      const e = 1 - Math.pow(1 - p, 3);
      c.num.textContent = fmt(Math.round(from + (target - from) * e));
      if (p < 1) c.raf = requestAnimationFrame(step);
    };
    c.raf = requestAnimationFrame(step);
  }

  function applyCounters(snap) {
    let anyVisible = false;
    for (const { k } of COUNTERS) {
      const show = snap.show[k] !== false;
      cards[k].el.hidden = !show;
      if (show) anyVisible = true;
      setValue(k, snap.values[k], k === 'ytSubs' && snap.hidden && snap.hidden.ytSubs);
    }
    if (view !== 'alerts') countersEl.hidden = !anyVisible;
  }

  /* ───────── sound + voice ───────── */
  // ?sound=0 mutes this source (handy if you have two overlays open), ?volume=0-100 overrides the dashboard.
  const soundOff = qs.get('sound') === '0';
  const volumeParam = qs.get('volume') !== null ? parseFloat(qs.get('volume')) : NaN;
  let soundCfg = { enabled: true, volume: 70, speak: false, speakRate: 100, types: {} };
  const FALLBACK_SOUND = 'sparkle';
  const hint = document.getElementById('sound-hint');

  function announceAudio(a) {
    if (soundOff || !window.Sounds || !soundCfg.enabled || !(view === 'all' || view === 'alerts')) return;
    const volume = Number.isFinite(volumeParam) ? volumeParam : soundCfg.volume;
    const ref = (soundCfg.types && soundCfg.types[a.type]) || (soundCfg.types && a.type in soundCfg.types ? 'none' : FALLBACK_SOUND);
    Sounds.play(ref, { volume, keyQuery: key ? `?key=${encodeURIComponent(key)}` : '' })
      .then((played) => {
        if (!played && Sounds.state() === 'suspended' && ref !== 'none') hint.hidden = false;
      })
      .catch(() => {});
    if (soundCfg.speak) setTimeout(() => Sounds.speak(`${a.name}, ${a.label}${a.platform ? ` on ${a.platform}` : ''}`, soundCfg.speakRate, volume), 700);
  }
  const unlockAudio = () => {
    if (window.Sounds && Sounds.unlock() === 'running') hint.hidden = true;
  };
  hint.addEventListener('click', unlockAudio);
  window.addEventListener('pointerdown', unlockAudio, { once: false });
  window.addEventListener('keydown', unlockAudio);

  /* ───────── announcements ───────── */
  const layer = document.getElementById('alert-layer');

  function showAlert(a) {
    announceAudio(a);
    layer.querySelectorAll('.alert').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = `alert src-${String(a.type || '').split('.')[0]}`;
    el.style.setProperty('--dur', `${a.durationMs}ms`);

    const badge = document.createElement('div');
    badge.className = 'badge';
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.innerHTML = SVG[a.icon] || SVG.heart; // static markup only
    badge.append(icon);
    badge.insertAdjacentHTML('beforeend', SVG.bow); // static markup only

    const body = document.createElement('div');
    body.className = 'body';
    const kicker = document.createElement('div');
    kicker.className = 'kicker';
    kicker.textContent = `${a.label} on ${a.platform}`;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.name;
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = a.detail || '';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = a.message || '';
    body.append(kicker, name, detail, msg);

    const bar = document.createElement('div');
    bar.className = 'bar';
    el.append(badge, body, bar);
    for (const c of ['a', 'b', 'c']) el.insertAdjacentHTML('beforeend', `<span class="spark ${c}">${SVG.spark}</span>`); // static markup only
    layer.append(el);

    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => el.classList.add('out'), Math.max(600, a.durationMs - 430));
    setTimeout(() => el.remove(), a.durationMs + 100);
  }

  /* ───────── chat feed ───────── */
  const chatEl = document.getElementById('chat');
  const chatCfg = { max: 10, ttlSec: 60 };
  const rows = new Map(); // id -> { el, timer }

  function removeRow(id) {
    const r = rows.get(id);
    if (!r) return;
    rows.delete(id);
    clearTimeout(r.timer);
    r.el.classList.add('out');
    setTimeout(() => r.el.remove(), 400);
  }

  function addChat(m, instant) {
    if (rows.has(m.id)) return;
    const el = document.createElement('div');
    el.className = `msg-row ${m.source}${m.kind !== 'message' ? ` ${m.kind}` : ''}`;
    const src = document.createElement('span');
    src.className = `src ${m.source}`;
    src.innerHTML = m.source === 'youtube' ? SVG.play : m.source === 'twitch' ? SVG.twitch : SVG.bubble; // static markup only
    const body = document.createElement('div');
    body.className = 'cbody';
    for (const bd of m.badges || []) {
      const t = document.createElement('span');
      t.className = `tag ${bd}`;
      t.textContent = bd;
      body.append(t);
    }
    if (m.amount) {
      const a = document.createElement('span');
      a.className = 'amount';
      a.textContent = m.amount;
      body.append(a);
    }
    const nm = document.createElement('span');
    nm.className = 'cname';
    nm.textContent = m.name;
    body.append(nm);
    for (const p of m.parts || []) {
      if (p.t === 'emoji') {
        const img = document.createElement('img');
        img.className = 'emoji';
        img.alt = `:${p.name}:`;
        img.src = p.url;
        body.append(img);
      } else body.append(document.createTextNode(p.v));
    }
    el.append(src, body);
    chatEl.append(el);
    const rec = { el, timer: 0 };
    rows.set(m.id, rec);
    if (instant) el.classList.add('in');
    else requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('in')));
    if (chatCfg.ttlSec > 0) {
      const left = Math.max(1000, chatCfg.ttlSec * 1000 - (Date.now() - (m.ts || Date.now())));
      rec.timer = setTimeout(() => removeRow(m.id), left);
    }
    while (rows.size > chatCfg.max) removeRow(rows.keys().next().value);
  }

  function resetChat(chat) {
    for (const id of [...rows.keys()]) {
      clearTimeout(rows.get(id).timer);
      rows.get(id).el.remove();
      rows.delete(id);
    }
    if (chat && chat.settings) Object.assign(chatCfg, chat.settings);
    for (const m of (chat && chat.recent) || []) addChat(m, true);
  }

  /* ───────── goal / status / latest ───────── */
  let lastVals = null;
  let goalCfg = null;
  const goalEl = document.getElementById('goal');
  function renderGoal() {
    if (view !== 'goal' || !goalCfg || !lastVals) return;
    const v = lastVals;
    const cur = goalCfg.counter === 'followers' ? (v.ytSubs || 0) + (v.twFollowers || 0) : v[goalCfg.counter] || 0;
    const pct = Math.max(0, Math.min(100, (cur / Math.max(1, goalCfg.target)) * 100));
    document.getElementById('goal-title').textContent = goalCfg.title || 'Goal';
    document.getElementById('goal-nums').textContent = `${fmt(cur)} / ${fmt(goalCfg.target)}`;
    document.getElementById('goal-fill').style.width = `${pct}%`;
    goalEl.classList.toggle('done', cur >= goalCfg.target);
    goalEl.hidden = false;
  }

  const live = { youtube: 'off', twitch: 'off', discord: 'off' };
  const statusEl = document.getElementById('status');
  function renderStatus() {
    if (view !== 'status') return;
    const pills = [];
    const add = (name, text, cls) => {
      const p = document.createElement('span');
      p.className = `pill ${cls}`;
      p.append(document.createElement('i'), document.createTextNode(`${name} ${text}`));
      pills.push(p);
    };
    const y = live.youtube;
    if (y !== 'off') add('YouTube', y === 'live' || y === 'paused' ? 'live' : y === 'error' ? 'reconnecting' : 'offline', y === 'live' || y === 'paused' ? 'on' : y === 'error' ? 'warn' : '');
    const tw = live.twitch;
    if (tw && tw !== 'off') add('Twitch chat', tw === 'online' ? 'connected' : tw === 'connecting' ? 'connecting' : 'reconnecting', tw === 'online' ? 'on' : 'warn');
    const d = live.discord;
    if (d !== 'off') add('Discord', d === 'online' ? 'connected' : d === 'starting' ? 'connecting' : 'reconnecting', d === 'online' ? 'on' : 'warn');
    statusEl.replaceChildren(...pills);
    statusEl.hidden = !pills.length;
  }

  const latestEl = document.getElementById('latest');
  function renderLatest(l) {
    if (view !== 'latest' || !l) return;
    document.getElementById('latest-kicker').textContent = `latest ${l.label || 'supporter'}${l.platform ? ` on ${l.platform}` : ''}`;
    document.getElementById('latest-name').textContent = l.name;
    latestEl.querySelector('.latest-badge').innerHTML = SVG.heart; // static markup only
    latestEl.hidden = false;
    latestEl.classList.remove('bump');
    void latestEl.offsetWidth;
    latestEl.classList.add('bump');
  }

  /* ───────── data source ───────── */
  function connect() {
    const label = qs.get('name');
    const url = `/api/stream?view=${view}${key ? `&key=${encodeURIComponent(key)}` : ''}${label ? `&name=${encodeURIComponent(label)}` : ''}`;
    const es = new EventSource(url);
    es.addEventListener('snapshot', (e) => {
      const d = JSON.parse(e.data);
      if (view !== 'chat' && !solo) applyCounters(d.counters);
      lastVals = d.counters.values;
      goalCfg = d.goal;
      if (d.sound) soundCfg = d.sound;
      renderGoal();
      if (d.live) Object.assign(live, d.live);
      renderStatus();
      renderLatest(d.latest);
      applyStyle(d.style);
      resetChat(d.chat);
    });
    es.addEventListener('look', (e) => {
      const d = JSON.parse(e.data);
      applyStyle(d.style);
      if (d.goal) { goalCfg = d.goal; renderGoal(); }
      if (d.sound) soundCfg = d.sound;
      if (d.chat && d.chat.settings) Object.assign(chatCfg, d.chat.settings);
      while (rows.size > chatCfg.max) removeRow(rows.keys().next().value);
    });
    es.addEventListener('chat', (e) => addChat(JSON.parse(e.data)));
    es.addEventListener('chatdel', (e) => removeRow(JSON.parse(e.data).id));
    es.addEventListener('chatclear', () => resetChat(null));
    es.addEventListener('counters', (e) => {
      const d = JSON.parse(e.data);
      lastVals = d.values;
      renderGoal();
      if (view !== 'chat' && !solo) applyCounters(d);
    });
    es.addEventListener('livestatus', (e) => {
      Object.assign(live, JSON.parse(e.data));
      renderStatus();
    });
    es.addEventListener('latest', (e) => renderLatest(JSON.parse(e.data)));
    es.addEventListener('alert', (e) => showAlert(JSON.parse(e.data)));
    es.onerror = () => {
      // The browser retries by itself; if the server answered with an error it closes for good.
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
  }

  function runChatDemo() {
    const T = (v) => [{ t: 'text', v }];
    const lines = [
      { source: 'youtube', name: 'Marigold Rose', parts: T('omg the new setup is so pretty'), badges: [], kind: 'message' },
      { source: 'discord', name: 'pastel_pixie', parts: T('is it gonna be a long stream today?'), badges: ['mod'], kind: 'message' },
      { source: 'youtube', name: 'Ananya', parts: T('your streams make my evenings!'), badges: ['member'], kind: 'superchat', amount: '$5.00' },
      { source: 'twitch', name: 'cosmo_kitten', parts: T('first time catching you live!'), badges: ['member'], kind: 'message' },
      { source: 'discord', name: 'velvet_moth', parts: T('just got home, what did I miss'), badges: [], kind: 'message' },
      { source: 'youtube', name: 'cherry_blossom', parts: T('hi from Tokyo'), badges: [], kind: 'message' },
      { source: 'discord', name: 'Kai', parts: T('new background looks so good with the pink'), badges: [], kind: 'message' },
    ];
    let n = 0;
    const next = () => addChat({ ...lines[n % lines.length], id: `demo-${n++}`, ts: Date.now() });
    for (let i = 0; i < 4; i++) next();
    setInterval(next, 3500);
  }

  function runDemo() {
    const vals = { ytSubs: 842, ytMembers: 17, twFollowers: 1264, twSubs: 58, bmcMembers: 9, bmcCoffees: 143 };
    const show = { ytSubs: true, ytMembers: true, twFollowers: true, twSubs: true, bmcMembers: true, bmcCoffees: true };
    if (view !== 'alerts' && view !== 'chat' && !solo) applyCounters({ values: vals, show, hidden: {} });
    if (view === 'goal') { goalCfg = { title: 'Follower goal', counter: 'followers', target: 2500 }; lastVals = vals; renderGoal(); return; }
    if (view === 'status') { Object.assign(live, { youtube: 'live', twitch: 'online', discord: 'online' }); renderStatus(); return; }
    if (view === 'latest') { renderLatest({ name: 'Marigold Rose', label: 'subscriber', platform: 'YouTube' }); return; }
    if (view === 'all' || view === 'chat') runChatDemo();
    if (view === 'counters' || view === 'chat') return;
    const samples = [
      { type: 'twitch.follow', platform: 'Twitch', label: 'new follower', icon: 'heart', name: 'pastel_pixie', detail: '' },
      { type: 'youtube.subscriber', platform: 'YouTube', label: 'new subscriber', icon: 'heart', name: 'Marigold Rose', detail: '' },
      { type: 'bmc.donation', platform: 'Buy Me a Coffee', label: 'bought compute', icon: 'cup', name: 'Ananya', detail: '$5 · 1 compute', message: 'your streams make my evenings, thank you!' },
      { type: 'twitch.sub', platform: 'Twitch', label: 'new subscriber', icon: 'star', name: 'velvet_moth', detail: 'Tier 1' },
    ];
    let i = 0;
    const fire = () => {
      showAlert({ ...samples[i % samples.length], durationMs: 4200 });
      const bump = ['twFollowers', 'ytSubs', 'bmcCoffees', 'twSubs'][i % 4];
      vals[bump] += 1;
      if (view !== 'alerts') applyCounters({ values: vals, show, hidden: {} });
      i += 1;
    };
    fire();
    setInterval(fire, 5000);
  }

  if (demo) runDemo();
  else connect();
})();
