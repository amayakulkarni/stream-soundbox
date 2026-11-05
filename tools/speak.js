#!/usr/bin/env node
'use strict';

// Voice helper: reads each new-supporter announcement aloud on THIS computer.
//
// OBS's built-in browser cannot do text-to-speech, so this small program runs next to OBS instead:
// it listens to the same live announcement feed as the overlay and speaks with the computer's own
// voices (Windows built-in "Zira" etc.; macOS `say`). OBS picks the sound up through Desktop Audio.
// No installs, no dependencies: only Node 20+.
//
//   node tools/speak.js --url https://supporters.amayakulkarni.com --key YOUR_OVERLAY_KEY
//   node tools/speak.js --list-voices
//
// Options:  --voice "Microsoft Zira Desktop"   --rate 0 (-10 slow … 10 fast)   --volume 100
//           --name voice-helper (label shown in /admin)   --delay 700 (ms after the chime)   --dry-run (print only)

const { spawn, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const PS_SPEAK = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:SPEAK_VOICE) { try { $s.SelectVoice($env:SPEAK_VOICE) } catch { Write-Host "voice not found: $env:SPEAK_VOICE" } }
$s.Rate = [int]$env:SPEAK_RATE
$s.Volume = [int]$env:SPEAK_VOLUME
$s.Speak($env:SPEAK_TEXT)
`;
const PS_LIST = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '  (' + $_.VoiceInfo.Culture + ', ' + $_.VoiceInfo.Gender + ')' }`;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

if (flag('list-voices')) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_LIST], { encoding: 'utf8' });
    console.log(r.stdout || r.stderr || 'no voices found');
  } else if (process.platform === 'darwin') {
    console.log(spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout);
  } else {
    console.log('Voice listing is only supported on Windows and macOS.');
  }
  process.exit(0);
}

const base = opt('url', 'http://localhost:42001').replace(/\/+$/, '');
const key = opt('key', process.env.OVERLAY_KEY || '');
const voice = opt('voice', '');
const rate = Math.max(-10, Math.min(10, parseInt(opt('rate', '0'), 10) || 0));
const volume = Math.max(0, Math.min(100, parseInt(opt('volume', '100'), 10) || 100));
const label = opt('name', 'voice-helper');
const delay = Math.max(0, parseInt(opt('delay', '700'), 10) || 0);
const dry = flag('dry-run');

if (!dry && !['win32', 'darwin'].includes(process.platform)) {
  console.error('Speaking is supported on Windows and macOS. Use --dry-run to test the connection only.');
  process.exit(1);
}

const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

// One announcement at a time, in order.
const queue = [];
let speaking = false;
function say(text) {
  queue.push(text);
  pump();
}
function pump() {
  if (speaking || !queue.length) return;
  speaking = true;
  const text = queue.shift();
  log(dry ? 'would say:' : 'saying:', text);
  if (dry) {
    speaking = false;
    return pump();
  }
  const done = () => {
    speaking = false;
    pump();
  };
  const child =
    process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SPEAK], { env: { ...process.env, SPEAK_TEXT: text, SPEAK_VOICE: voice, SPEAK_RATE: String(rate), SPEAK_VOLUME: String(volume) }, stdio: ['ignore', 'inherit', 'inherit'] })
      : spawn('say', [...(voice ? ['-v', voice] : []), '-r', String(175 + rate * 12), '--', text], { stdio: 'ignore' });
  child.on('error', (e) => {
    log('could not speak:', e.message);
    done();
  });
  child.on('exit', done);
  return undefined;
}

// Live feed, with automatic reconnect.
let failures = 0;
async function connect() {
  const url = `${base}/api/stream?view=alerts&name=${encodeURIComponent(label)}${key ? `&key=${encodeURIComponent(key)}` : ''}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
    if (!res.ok) throw new Error(`server answered ${res.status}${res.status === 403 ? ' (wrong or missing --key)' : ''}`);
    log('connected to', base);
    failures = 0;
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (event !== 'alert' || !data) continue;
        try {
          const a = JSON.parse(data);
          const text = clean(`${a.name}, ${a.label}${a.platform ? ` on ${a.platform}` : ''}`);
          if (text) setTimeout(() => say(text), delay);
        } catch {
          /* ignore a malformed event */
        }
      }
    }
    throw new Error('connection closed');
  } catch (e) {
    failures += 1;
    const wait = Math.min(2000 * 2 ** Math.min(failures - 1, 5), 60000);
    log(`${e.message}. Reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(connect, wait);
  }
}

log(`voice helper starting${dry ? ' (dry run: nothing will be spoken)' : ''}`);
connect();
