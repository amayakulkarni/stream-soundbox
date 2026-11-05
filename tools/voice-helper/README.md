# Supporters Voice (Rust)

A small Windows app that:

1. **Reads announcements aloud** ("Ada, subscribed on YouTube") using Windows' own voices.
2. **Opens two OBS windows** with one click: your installed OBS, and the portable one as administrator.

Because the speech comes from this one program, OBS can capture **only its audio** instead of all Desktop Audio.

> **Not compiled by the author.** The sandbox this was written in cannot reach crates.io, so the
> window/speech/HTTP part has never been built or run. The logic underneath (`src/proto.rs`: feed parsing,
> settings, OBS arguments) is unit-tested (`rustc --edition 2021 --test src/proto.rs`). If `cargo build` shows
> an error, send it over and it is a quick fix. `tools/speak.js` still works as a fallback.

## Build (once)

Install Rust from https://rustup.rs (with the Visual Studio C++ build tools), then:

```
cd tools\voice-helper
cargo build --release
```

The program is `target\release\supporters-voice.exe`. Copy it anywhere (for example next to your OBS folder).
It saves its settings in `voice-helper.ini` beside the exe.

## Use

1. Start `supporters-voice.exe`. Fill in the overlay address and **overlay key**, press *Save and reconnect*.
   Status should say *Connected*. *Test voice* should speak.
2. In each OBS: **Sources → + → Application Audio Capture**, pick **Supporters Voice** (the window title).
   Keep Desktop Audio off, or use it only for what you want mixed in.
3. Press **Open both OBS windows** (details below), or tick *Open them when this app starts*.

### Google voices (optional)

Chrome's "Google" voices only exist inside Chrome. To get Google voices in this app, use Google Cloud Text-to-Speech:

1. In https://console.cloud.google.com create (or pick) a project and enable **Cloud Text-to-Speech API** (billing must be on; short announcements stay inside the monthly free allowance, check Google's current pricing page).
2. APIs & Services → Credentials → **Create credentials → API key**. Restrict it to the Cloud Text-to-Speech API.
3. In this app tick *Use a Google Cloud voice*, paste the key, and type a voice name, for example `en-IN-Neural2-A`, `en-US-Neural2-F` or `en-GB-Wavenet-B`
   (list: https://cloud.google.com/text-to-speech/docs/voices). Press *Test voice*.

The audio is fetched and played inside this app, so OBS still captures it with Application Audio Capture. If Google is unreachable or the key is wrong, the app logs why and speaks with the Windows voice instead. The key is saved in `voice-helper.ini` next to the exe, so do not share that file.

### The two OBS windows

*Open both OBS windows* starts:

1. **OBS #1: your installed OBS.** Found automatically in `Program Files\obs-studio` (or type the path to its `obs64.exe`). Started normally with `--multi`; it keeps using its usual settings in `%APPDATA%\obs-studio`.
2. **OBS #2: the portable OBS, as administrator.** Started from `<portable folder>\bin\64bit` with `--portable --multi`. Windows shows its permission (UAC) prompt; approve it. Its settings stay inside the portable folder.

The two keep separate settings, so no profile juggling is needed. The extra-options boxes are optional (for example `--profile HDR --collection HDR`).

Notes: this app itself runs as a normal user (an administrator OBS can capture its audio, but not the other way round). Run `allow-firewall.ps1` once for the portable exe, and Windows may ask separately about the installed one.

Command line overrides (optional): `--url`, `--key`, `--voice`, `--rate`, `--volume`, `--name`, `--delay`, `--launch-obs`.
