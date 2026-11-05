(() => {
  'use strict';

  let S = null; // last full state from /admin/api/state

  /* ───────── helpers (all text goes through textContent: supporter names are untrusted) ───────── */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }

  const toastEl = document.getElementById('toast');
  let toastTimer;
  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.className = `toast show${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = 'toast'), 2600);
  }

  async function api(path, body) {
    const res = await fetch(`/admin/api/${path}`, {
      method: body === undefined && !path.startsWith('state') ? 'POST' : body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      location.reload();
      throw new Error('signed out');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  const act = (fn, okMsg) => async (ev) => {
    const btn = ev && ev.currentTarget;
    if (btn) btn.disabled = true;
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Copy failed. Select the text and copy it by hand.', true);
    }
  }

  function copyRow(value) {
    const input = h('input', { type: 'text', class: 'url', value, readOnly: true, 'aria-label': 'URL' });
    input.addEventListener('focus', () => input.select());
    return h('div', { class: 'copyrow' }, input, h('button', { class: 'btn soft', onclick: () => copy(value) }, 'Copy'));
  }

  async function save(partial, msg = 'Saved') {
    const r = await api('settings', partial);
    S.settings = r.settings;
    toast(msg);
  }

  // Panels are rebuilt from state, but never while you are typing in them.
  function mount(id, build) {
    const host = document.getElementById(id);
    if (host.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
    host.replaceChildren(...build());
  }

  /* ───────── panels ───────── */

  // Every connected source plays every announcement, so the setup itself can make one supporter appear twice.
  function doubleAlertWarnings() {
    const listening = S.overlays.list.filter((o) => o.view === 'all' || o.view === 'alerts');
    const voices = listening.filter((o) => o.name === 'voice-helper').length;
    const screens = listening.length - voices;
    const out = [];
    if (screens > 1) out.push(`${screens} sources are showing announcements, so each supporter appears ${screens} times. Keep one, and use the Counters only link for the others (or add ?sound=0 if you only hear it twice).`);
    if (voices > 1) out.push(`${voices} voice helpers are running, so each name is read ${voices} times. Close all but one.`);
    if (voices && S.settings.sound.speak && screens) out.push('The voice helper and "Read the name aloud" are both on, so names can be read twice. Turn one off.');
    return out;
  }

  function panelLinks() {
    const mk = (label, key, hint) =>
      h('div', { class: 'row' }, h('div', { class: 'stack' }, h('span', { class: 'label' }, label), h('span', { class: 'muted' }, hint), copyRow(S.urls.public[key])));
    return [
      h('header', {}, h('h2', {}, 'OBS sources'), h('span', { class: 'muted' }, 'Add each as a Browser source. 1920 × 1080 is a good size; leave Custom CSS empty.')),
      mk('Counters and announcements together', 'all', 'One source with everything.'),
      mk('Counters only', 'counters', 'Place it wherever you want the numbers.'),
      mk('Announcements only', 'alerts', 'Place it wherever you want new supporters to pop up.'),
      mk('Comments', 'comments', 'YouTube, Twitch and Discord chat only, on the right of the screen.'),
      mk('Goal bar', 'goal', 'A progress bar toward a target. Set it under Look and goal.'),
      mk('Live status', 'status', 'Small badges showing whether YouTube is live and Discord is connected.'),
      mk('Latest supporter', 'latest', 'Keeps showing the newest follower, subscriber or compute purchase.'),
      h('div', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, 'Open right now'), h('div', { class: 'muted' }, 'Each OBS source that is connected. Add ?name=hdr-youtube to a source link to label it, so you can tell your streams apart.')),
        h('div', { class: 'stack' }, S.overlays.list.length
          ? S.overlays.list.map((o) => h('div', {}, chip(o.view === 'all' ? 'everything' : o.view, 'ok'), ' ', o.name ? h('b', {}, o.name) : h('span', { class: 'muted' }, 'unnamed'), ' ', h('span', { class: 'muted' }, `connected ${ago(o.since)}`)))
          : h('span', { class: 'muted' }, 'None. If OBS is running, the source is not loading the page.'))),
      ...doubleAlertWarnings().map((text) => h('p', { class: 'warn' }, text)),
      h('p', { class: 'muted' }, `Running this app on your own computer instead? Use ${S.urls.local.all.replace(/\?key=.*/, '')}. Add ?layout=column, ?scale=1.2, ?apos=top-center, ?chatpos=left, ?chat=0 (hide chat), ?glass=40 (panel opacity) or ?pos=bottom-right (goal, status and latest) to change the look.`),
    ];
  }

  const COUNTER_LABELS = {
    ytSubs: 'YouTube subscribers',
    ytMembers: 'YouTube members',
    twFollowers: 'Twitch followers',
    twSubs: 'Twitch subscribers',
    bmcMembers: 'Buy Me a Coffee members',
    bmcCoffees: 'Compute bought',
  };

  function panelCounters() {
    const snap = S.counters.snapshot;
    const rows = S.counterKeys.map((k) => {
      const v = snap.values[k];
      const offset = h('input', { type: 'number', value: String(S.settings.offsets[k] || 0), 'aria-label': `${COUNTER_LABELS[k]} adjustment` });
      offset.addEventListener('change', () => save({ offsets: { [k]: Number(offset.value) || 0 } }).catch((e) => toast(e.message, true)));
      const show = h('input', { type: 'checkbox', checked: S.settings.show[k] !== false, 'aria-label': `Show ${COUNTER_LABELS[k]}` });
      show.addEventListener('change', () => save({ show: { [k]: show.checked } }).catch((e) => toast(e.message, true)));
      return h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'label' }, COUNTER_LABELS[k]), h('div', { class: 'muted' }, `updated ${ago(snap.updatedAt[k])}`)),
        h('span', { class: 'big' }, v === null ? '–' : v.toLocaleString('en-US')),
        h('label', { class: 'muted' }, 'adjust ', offset),
        h('label', { class: 'switch' }, show, h('span', {}))
      );
    });
    return [
      h('header', {}, h('h2', {}, 'Counters'), h('span', { class: 'muted' }, 'Adjust adds or subtracts a fixed number. The switch shows or hides it on screen.')),
      ...rows,
      h(
        'div',
        { class: 'btns', style: 'margin-top:14px' },
        h('button', { class: 'btn soft', onclick: act(async () => { await api('refresh/youtube', {}); await load(); }, 'YouTube refreshed') }, 'Refresh YouTube'),
        h('button', { class: 'btn soft', onclick: act(async () => { await api('refresh/twitch', {}); await load(); }, 'Twitch refreshed') }, 'Refresh Twitch')
      ),
    ];
  }

  function panelAnnounce() {
    const st = S.settings;
    const secs = (key, label, min, max) => {
      const i = h('input', { type: 'number', min: String(min), max: String(max), step: '0.5', value: String(st[key] / 1000), 'aria-label': label });
      i.addEventListener('change', () => save({ [key]: Math.round(Number(i.value) * 1000) }).then(load).catch((e) => toast(e.message, true)));
      return h('label', { class: 'row' }, h('span', { class: 'grow label' }, label), i, h('span', { class: 'muted' }, 'seconds'));
    };
    const hold = h('input', { type: 'checkbox', checked: st.holdWhenNoOverlay });
    hold.addEventListener('change', () => save({ holdWhenNoOverlay: hold.checked }).catch((e) => toast(e.message, true)));

    const q = S.queue;
    const list = q.items.length
      ? h('ul', { class: 'queue' }, q.items.map((a) => h('li', {}, h('span', { class: 'nm' }, a.name), a.detail && h('span', { class: 'muted' }, a.detail), h('span', { class: 'pl' }, `${a.label}${a.test ? ' · test' : ''}`))))
      : h('p', { class: 'muted', style: 'margin:12px 0' }, 'Nobody is waiting. New supporters appear here until their turn.');

    const type = h('select', { 'aria-label': 'Test announcement type' }, Object.entries(S.types).map(([k, t]) => h('option', { value: k }, `${t.platform}: ${t.label}`)));
    const nameIn = h('input', { type: 'text', placeholder: 'Name', value: 'Test supporter', 'aria-label': 'Test name', maxLength: 40 });
    const countIn = h('input', { type: 'number', min: '1', max: '10', value: '1', 'aria-label': 'How many' });

    return [
      h('header', {}, h('h2', {}, 'Announcements')),
      secs('alertIntervalMs', 'Time between announcements', 1, 60),
      secs('alertDurationMs', 'Time each one stays on screen', 1, 15),
      h('label', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, 'Wait for OBS'), h('div', { class: 'muted' }, 'Keep the line while no overlay is open.')), h('span', { class: 'switch' }, hold, h('span', {}))),
      h('div', { class: 'row' }, h('span', { class: 'grow label' }, `${q.length} waiting`),
        h('button', { class: 'btn soft', onclick: act(() => api('queue/skip', {}), 'Skipped') }, 'Skip next'),
        h('button', { class: 'btn ghost', onclick: act(() => api('queue/clear', {}), 'Cleared') }, 'Clear line')),
      list,
      h('div', { class: 'row' }, h('span', { class: 'grow label' }, 'Send a test')),
      h('div', { class: 'row' }, type, nameIn, countIn,
        h('button', { class: 'btn primary', onclick: act(() => api('test', { type: type.value, name: nameIn.value, count: Number(countIn.value) || 1 }), 'Test queued') }, 'Send test')),
    ];
  }

  function chip(text, kind) {
    return h('span', { class: `chip${kind ? ` ${kind}` : ''}` }, text);
  }

  const stateChip = (s) => ({ live: chip('Live', 'ok'), online: chip('Listening', 'ok'), connecting: chip('Connecting', 'warn'), idle: chip('Waiting for a stream', 'warn'), paused: chip('Live, waiting for OBS', 'warn'), starting: chip('Connecting', 'warn'), error: chip('Retrying', 'bad'), off: chip('Off') })[s] || chip(s);

  function panelChat() {
    const c = S.settings.chat;
    const cs = S.chat;
    const sw = (key, label, hint) => {
      const i = h('input', { type: 'checkbox', checked: c[key], 'aria-label': label });
      i.addEventListener('change', () => save({ chat: { [key]: i.checked } }).then(load).catch((e) => toast(e.message, true)));
      return h('label', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, label), hint && h('div', { class: 'muted' }, hint)), h('span', { class: 'switch' }, i, h('span', {})));
    };
    const num = (key, label, min, max, unit) => {
      const i = h('input', { type: 'number', min: String(min), max: String(max), value: String(c[key]), 'aria-label': label });
      i.addEventListener('change', () => save({ chat: { [key]: Number(i.value) } }).then(load).catch((e) => toast(e.message, true)));
      return h('label', { class: 'row' }, h('span', { class: 'grow label' }, label), i, h('span', { class: 'muted' }, unit));
    };
    const blocked = h('input', { type: 'text', value: c.blocked, placeholder: 'word, another word', maxLength: 500, 'aria-label': 'Hidden words' });
    blocked.addEventListener('change', () => save({ chat: { blocked: blocked.value } }).catch((e) => toast(e.message, true)));

    const y = cs.youtube;
    const d = cs.discord;
    const tw = cs.twitch;
    const status = h('div', { class: 'conn2' },
      h('div', {}, h('div', { class: 'row', style: 'border:0;padding:0' }, h('h3', {}, 'YouTube chat'), stateChip(y.state)), h('p', { class: 'muted' }, y.detail), y.lastError && h('p', { class: 'muted', style: 'color:#b0123f' }, y.lastError),
        h('p', { class: 'muted' }, `Costs about ${y.quotaPerHourWhileLive.toLocaleString('en-US')} of your 10,000 daily YouTube API units per hour while live; nothing while you are offline except one cheap check per interval.`)),
      h('div', {}, h('div', { class: 'row', style: 'border:0;padding:0' }, h('h3', {}, 'Twitch chat'), stateChip(tw.state)), h('p', { class: 'muted' }, tw.detail), tw.lastError && tw.state === 'error' && h('p', { class: 'muted', style: 'color:#b0123f' }, tw.lastError)),
      h('div', {}, h('div', { class: 'row', style: 'border:0;padding:0' }, h('h3', {}, 'Discord chat'), stateChip(d.state)), h('p', { class: 'muted' }, d.detail),
        d.channels.filter((x) => x.error).map((x) => h('p', { class: 'muted', style: 'color:#b0123f' }, `#${x.name || x.id}: ${x.error}`))));

    const testName = h('input', { type: 'text', value: 'Test viewer', maxLength: 32, 'aria-label': 'Test name' });
    const testSrc = h('select', { 'aria-label': 'Test source' }, h('option', { value: 'youtube' }, 'YouTube'), h('option', { value: 'twitch' }, 'Twitch'), h('option', { value: 'discord' }, 'Discord'));
    const testKind = h('select', { 'aria-label': 'Test kind' }, h('option', { value: 'message' }, 'Message'), h('option', { value: 'superchat' }, 'Super Chat'), h('option', { value: 'member' }, 'New member'));

    return [
      h('header', {}, h('h2', {}, 'Chat feed'), h('span', { class: 'muted' }, cs.overlays ? `${cs.overlays} overlay${cs.overlays === 1 ? '' : 's'} showing chat` : 'No overlay with chat is open.')),
      status,
      sw('enabled', 'Show chat on screen'),
      sw('youtube', 'YouTube chat', 'Reads your live chat while you are live and looks again by itself after each stream.'),
      sw('twitch', 'Twitch chat', 'Reads your channel chat. Works whether or not you are live.'),
      sw('discord', 'Discord chat', 'Channels come from DISCORD_CHANNEL_IDS in .env.'),
      sw('hideBots', 'Hide bots'),
      sw('hideCommands', 'Hide commands', 'Messages that start with !'),
      num('max', 'Messages on screen', 1, 30, 'messages'),
      num('ttlSec', 'Fade messages after', 0, 3600, 'seconds (0 = keep)'),
      num('ytSearchSec', 'Look for a YouTube stream every', 30, 900, 'seconds'),
      num('ytMinPollSec', 'Read YouTube chat at most every', 5, 120, 'seconds'),
      h('label', { class: 'row' }, h('span', { class: 'label' }, 'Hidden words'), blocked),
      h('div', { class: 'row' }, testSrc, testKind, testName,
        h('button', { class: 'btn primary', onclick: act(() => api('chat/test', { source: testSrc.value, kind: testKind.value, name: testName.value }), 'Test sent') }, 'Send test')),
      h('div', { class: 'btns', style: 'margin-top:12px' },
        h('button', { class: 'btn soft', onclick: act(() => api('chat/retry', {}), 'Checking now') }, 'Check now'),
        h('button', { class: 'btn ghost', onclick: act(() => api('chat/clear', {}), 'Chat cleared') }, 'Clear feed')),
    ];
  }

  function goalControls() {
    const g = S.settings.goal;
    const title = h('input', { type: 'text', value: g.title, maxLength: 40, 'aria-label': 'Goal title' });
    const target = h('input', { type: 'number', min: '1', value: String(g.target), 'aria-label': 'Goal target' });
    const labels = { followers: 'YouTube subscribers + Twitch followers', ...COUNTER_LABELS };
    const counter = h('select', { 'aria-label': 'Goal counts' }, Object.entries(labels).map(([k, t]) => h('option', { value: k }, t)));
    counter.value = g.counter;
    const go = () => save({ goal: { title: title.value, target: Number(target.value), counter: counter.value } }).catch((e) => toast(e.message, true));
    for (const el of [title, target, counter]) el.addEventListener('change', go);
    return [
      h('div', { class: 'row' }, h('span', { class: 'grow label' }, 'Goal title'), title),
      h('div', { class: 'row' }, h('span', { class: 'grow label' }, 'Goal target'), target),
      h('div', { class: 'row' }, h('span', { class: 'grow label' }, 'Counts'), counter),
    ];
  }

  function panelSound() {
    const so = S.settings.sound;
    const files = S.sounds.files;
    const opts = [['none', 'Silent'], ...S.sounds.builtin.map((b) => [b.id, b.name]), ...files.map((f) => [`file:${f.name}`, `Your file: ${f.name}`])];
    const prev = (ref, vol) => Sounds.play(ref, { volume: vol, keyQuery: S.sounds.keyQuery }).then((ok) => !ok && toast('Your browser blocked the sound. Click anywhere on the page and try again.', true)).catch((e) => toast(e.message, true));
    const sw = (key, label, hint) => {
      const i = h('input', { type: 'checkbox', checked: so[key], 'aria-label': label });
      i.addEventListener('change', () => save({ sound: { [key]: i.checked } }).catch((e) => toast(e.message, true)));
      return h('label', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, label), hint && h('div', { class: 'muted' }, hint)), h('span', { class: 'switch' }, i, h('span', {})));
    };
    const vol = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(so.volume), 'aria-label': 'Volume' });
    const volVal = h('span', { class: 'muted' }, `${so.volume}%`);
    vol.addEventListener('input', () => (volVal.textContent = `${vol.value}%`));
    vol.addEventListener('change', () => save({ sound: { volume: Number(vol.value) } }).catch((e) => toast(e.message, true)));
    const rate = h('input', { type: 'range', min: '60', max: '160', step: '10', value: String(so.speakRate), 'aria-label': 'Voice speed' });
    rate.addEventListener('change', () => save({ sound: { speakRate: Number(rate.value) } }).catch((e) => toast(e.message, true)));

    const rows = Object.entries(S.types).map(([k, t]) => {
      const sel = h('select', { 'aria-label': `Sound for ${t.platform} ${t.label}` }, opts.map(([v, n]) => h('option', { value: v }, n)));
      sel.value = so.types[k];
      sel.addEventListener('change', () => save({ sound: { types: { [k]: sel.value } } }).catch((e) => toast(e.message, true)));
      return h('div', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, t.label), ' ', h('span', { class: 'muted' }, t.platform)), sel,
        h('button', { class: 'btn soft', onclick: () => prev(sel.value, Number(vol.value)) }, 'Play'));
    });

    const pick = h('input', { type: 'file', accept: '.mp3,.wav,.ogg,.m4a,audio/*', 'aria-label': 'Sound file' });
    const upload = act(async () => {
      const f = pick.files[0];
      if (!f) throw new Error('Choose a sound file first.');
      if (f.size > 3 * 1024 * 1024) throw new Error('Keep sound files under 3 MB.');
      const res = await fetch(`/admin/api/sounds?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `upload failed (${res.status})`);
      await load();
    }, 'Sound added. Pick it from the lists above.');

    return [
      h('header', {}, h('h2', {}, 'Sounds'), h('span', { class: 'muted' }, 'Plays on the announcements overlay when someone new arrives.')),
      sw('enabled', 'Play sounds'),
      h('label', { class: 'row' }, h('span', { class: 'grow label' }, 'Volume'), vol, volVal),
      sw('speak', 'Read the name aloud', 'Works in a normal browser only. OBS cannot speak, so for OBS run the voice helper on your PC (tools/speak.js) and keep this off.'),
      h('label', { class: 'row' }, h('span', { class: 'grow label' }, 'Voice speed'), rate),
      h('div', { class: 'row' }, h('span', { class: 'grow label' }, 'Sound for each announcement')),
      ...rows,
      h('div', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, 'Add your own'), h('div', { class: 'muted' }, 'mp3, wav, ogg or m4a, up to 3 MB.')), pick, h('button', { class: 'btn primary', onclick: upload }, 'Upload')),
      ...files.map((f) => h('div', { class: 'row' }, h('span', { class: 'grow' }, f.name, ' ', h('span', { class: 'muted' }, `${Math.max(1, Math.round(f.size / 1024))} KB`)),
        h('button', { class: 'btn soft', onclick: () => prev(`file:${f.name}`, Number(vol.value)) }, 'Play'),
        h('button', { class: 'btn ghost', onclick: act(async () => { await api('sounds/delete', { name: f.name }); await load(); }, 'Sound deleted') }, 'Delete'))),
      h('p', { class: 'muted', style: 'margin-top:12px' }, 'If you use two overlay sources, add ?sound=0 to one so it does not play twice. Add ?volume=40 to a link to override the volume for that source.'),
    ];
  }

  function panelLook() {
    const val = h('span', { class: 'muted' }, `${S.settings.style.panelOpacity}%`);
    const slider = h('input', { type: 'range', min: '0', max: '100', step: '5', value: String(S.settings.style.panelOpacity), 'aria-label': 'Panel opacity' });
    slider.addEventListener('input', () => (val.textContent = `${slider.value}%`));
    slider.addEventListener('change', () => save({ style: { panelOpacity: Number(slider.value) } }).catch((e) => toast(e.message, true)));
    return [
      h('header', {}, h('h2', {}, 'Look and goal')),
      h('p', { class: 'muted' }, 'The overlay page itself is always transparent, so your stream shows through. This sets how see-through the pink pills and chat bubbles are.'),
      h('label', { class: 'row' }, h('span', { class: 'grow label' }, 'Panel opacity'), slider, val),
      h('p', { class: 'muted' }, 'Lower is clearer, higher is easier to read over busy scenes. A link can override it with ?glass=40.'),
      ...goalControls(),
    ];
  }

  function panelConnections() {
    const { youtube: y, twitch: t, bmc: b } = S.status;
    const st = S.settings;
    const pollIn = (key, label, min) => {
      const i = h('input', { type: 'number', min: String(min), max: '3600', value: String(st[key]), 'aria-label': label });
      i.addEventListener('change', () => save({ [key]: Number(i.value) }).catch((e) => toast(e.message, true)));
      return h('label', { class: 'muted' }, label, ' ', i, ' s');
    };
    const problems = (s) => [s.lastError && h('p', { class: 'muted', style: 'color:#b0123f' }, s.lastError), s.warnings && s.warnings.length ? h('ul', {}, s.warnings.map((w) => h('li', {}, w))) : null];

    const yt = h('div', {},
      h('div', { class: 'row', style: 'border:0;padding:0' }, h('h3', {}, 'YouTube'), y.connected ? chip(`Connected: ${y.account || 'channel'}`, 'ok') : chip(y.configured ? 'Not connected' : 'Needs client ID', y.configured ? 'warn' : 'bad')),
      h('p', { class: 'muted' }, y.connected ? `Last checked ${ago(y.lastOkAt)}.` : 'Reads subscribers, members and new subscriber names.'),
      ...problems(y),
      pollIn('youtubePollSec', 'Check every', 30),
      h('div', { class: 'btns' },
        h('a', { class: 'btn primary', href: '/admin/auth/youtube' }, y.connected ? 'Reconnect' : 'Connect YouTube'),
        y.connected && h('button', { class: 'btn ghost', onclick: act(async () => { await api('disconnect/youtube', {}); await load(); }, 'YouTube disconnected') }, 'Disconnect')),
      h('p', { class: 'muted' }, 'Redirect URI for Google:'), copyRow(y.redirectUri));

    const es = t.eventsub;
    const tw = h('div', {},
      h('div', { class: 'row', style: 'border:0;padding:0' }, h('h3', {}, 'Twitch'), t.connected ? chip(`Connected: ${t.account}`, 'ok') : chip(t.configured ? 'Not connected' : 'Needs client ID', t.configured ? 'warn' : 'bad')),
      h('p', { class: 'muted' }, t.connected ? `Counts checked ${ago(t.lastOkAt)}. Webhooks received: ${t.webhooksReceived}${t.lastWebhookAt ? `, last ${ago(t.lastWebhookAt)}` : ''}.` : 'Reads followers and subscribers, and listens for new ones.'),
      ...problems(t),
      es && h('ul', {}, es.result.map((r) => h('li', {}, `${r.type}: ${r.status}${r.error ? ` (${r.error})` : ''}`))),
      pollIn('twitchPollSec', 'Check every', 15),
      h('label', { class: 'row', style: 'border:0;padding:0' }, h('span', { class: 'grow muted' }, 'Also catch new followers by checking'),
        (() => { const c = h('input', { type: 'checkbox', checked: st.twitchPollFollowers }); c.addEventListener('change', () => save({ twitchPollFollowers: c.checked }).catch((e) => toast(e.message, true))); return h('span', { class: 'switch' }, c, h('span', {})); })()),
      h('div', { class: 'btns' },
        h('a', { class: 'btn primary', href: '/admin/auth/twitch' }, t.connected ? 'Reconnect' : 'Connect Twitch'),
        t.connected && h('button', { class: 'btn soft', onclick: act(async () => { await api('twitch/sync', {}); await load(); }, 'Webhooks are set up') }, 'Set up webhooks'),
        t.connected && h('button', { class: 'btn ghost', onclick: act(async () => { await api('disconnect/twitch', {}); await load(); }, 'Twitch disconnected') }, 'Disconnect')),
      !t.webhookSecretSet && h('p', { class: 'muted', style: 'color:#b0123f' }, 'Set TWITCH_EVENTSUB_SECRET in .env, then restart.'),
      h('p', { class: 'muted' }, 'Redirect URI for Twitch:'), copyRow(t.redirectUri));

    const money = Object.entries(b.totals).map(([c, v]) => `${v.toLocaleString('en-US')} ${c}`).join(', ');
    const bm = h('div', {},
      h('div', { class: 'row', style: 'border:0;padding:0' }, h('h3', {}, 'Buy Me a Coffee'), b.configured ? chip('Webhook ready', 'ok') : chip('Needs secret or token', 'bad')),
      h('p', { class: 'muted' }, b.lastAt ? `Last event: ${b.lastType || 'unknown'}, ${ago(b.lastAt)}. ` : 'No events yet. ', `${b.donations} compute purchases tracked${money ? ` (${money})` : ''}, ${b.activeMembers} active members.`),
      b.lastRejectedAt && h('p', { class: 'muted', style: 'color:#b0123f' }, `A request was rejected ${ago(b.lastRejectedAt)}. Check the token or secret.`),
      h('p', { class: 'muted' }, 'Paste this webhook URL into Buy Me a Coffee (Settings → Webhooks):'), copyRow(b.webhookUrl),
      h('p', { class: 'muted' }, `Signature secret ${b.secretSet ? 'is set' : 'is not set'}; URL token ${b.tokenSet ? 'is set' : 'is not set'}. Members from before the webhook existed can be added with Adjust.`));

    return [h('header', {}, h('h2', {}, 'Connections')), h('div', { class: 'conn' }, yt, tw, bm)];
  }

  function panelTypes() {
    return [
      h('header', {}, h('h2', {}, 'What gets announced')),
      ...Object.entries(S.types).map(([k, t]) => {
        const c = h('input', { type: 'checkbox', checked: S.settings.alerts[k] !== false, 'aria-label': `${t.platform} ${t.label}` });
        c.addEventListener('change', () => save({ alerts: { [k]: c.checked } }).catch((e) => toast(e.message, true)));
        return h('label', { class: 'row' }, h('span', { class: 'grow' }, h('span', { class: 'label' }, t.label), ' ', h('span', { class: 'muted' }, t.platform)), h('span', { class: 'switch' }, c, h('span', {})));
      }),
    ];
  }

  function panelActivity() {
    return [
      h('header', {}, h('h2', {}, 'Activity'), h('span', { class: 'muted' }, 'Most recent first')),
      S.recent.length
        ? h('ul', { class: 'log' }, S.recent.map((e) => h('li', {}, h('time', {}, clock(e.ts)), h('span', { class: e.type === 'note' ? 'dt' : 'nm' }, e.name), e.detail && h('span', { class: 'dt' }, e.detail), h('span', { class: 'tg' }, e.type === 'note' ? chip('note') : e.test ? chip('test') : e.queued ? chip('announced', 'ok') : chip('logged')))))
        : h('p', { class: 'muted' }, 'Nothing yet. New followers, subscribers and compute purchases will show up here.'),
    ];
  }

  function render() {
    mount('p-links', panelLinks);
    mount('p-counters', panelCounters);
    mount('p-announce', panelAnnounce);
    mount('p-chat', panelChat);
    mount('p-look', panelLook);
    mount('p-sound', panelSound);
    mount('p-connections', panelConnections);
    mount('p-types', panelTypes);
    mount('p-activity', panelActivity);
    document.getElementById('overlays').textContent = S.overlays.listeningForAlerts
      ? `${S.overlays.connected} overlay${S.overlays.connected === 1 ? '' : 's'} open`
      : 'No overlay open. Announcements will wait.';
  }

  async function load() {
    S = await api('state');
    render();
  }

  /* ───────── live updates ───────── */
  const liveEl = document.getElementById('live');
  function setLive(on) {
    liveEl.className = `live ${on ? 'on' : 'off'}`;
    liveEl.lastChild.textContent = on ? 'live' : 'reconnecting';
  }

  function stream() {
    const es = new EventSource('/admin/api/stream');
    es.addEventListener('hello', () => setLive(true));
    es.addEventListener('counters', (e) => {
      if (!S) return;
      S.counters.snapshot = JSON.parse(e.data);
      mount('p-counters', panelCounters);
    });
    es.addEventListener('queue', (e) => {
      if (!S) return;
      S.queue = JSON.parse(e.data);
      mount('p-announce', panelAnnounce);
    });
    es.addEventListener('overlays', (e) => {
      if (!S) return;
      S.overlays.list = JSON.parse(e.data);
      S.overlays.connected = S.overlays.list.length;
      mount('p-links', panelLinks);
    });
    es.addEventListener('chatstatus', (e) => {
      if (!S) return;
      Object.assign(S.chat, JSON.parse(e.data));
      mount('p-chat', panelChat);
    });
    es.addEventListener('log', (e) => {
      if (!S) return;
      S.recent.unshift(JSON.parse(e.data));
      S.recent.length = Math.min(S.recent.length, 60);
      mount('p-activity', panelActivity);
    });
    es.onerror = () => {
      setLive(false);
      if (es.readyState === EventSource.CLOSED) setTimeout(stream, 3000);
    };
  }

  const notice = new URLSearchParams(location.search).get('notice');
  if (notice) {
    const el = document.getElementById('notice');
    el.textContent = notice;
    el.hidden = false;
    history.replaceState(null, '', '/admin');
  }

  load().then(stream).catch((e) => toast(e.message, true));
  setInterval(() => load().catch(() => {}), 12000);
})();
