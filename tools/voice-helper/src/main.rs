// Supporters Voice: reads new-supporter announcements aloud, and can open your two portable OBS windows.
//
// Why a separate app: OBS's browser source cannot do text-to-speech. This program connects to the same
// announcement feed as the overlay and speaks with Windows' own voices. Because the sound comes from THIS
// one program, OBS can pick it up on its own with "Application Audio Capture" instead of all Desktop Audio.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod proto;

use eframe::egui;
use proto::{base64_decode, elevate_script, json_str, obs_args, obs_args_installed, redact, sentence, stream_url, synth_body, Settings, Sse};
use std::io::BufRead;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Things threads tell the window.
enum Msg {
    Status(String),
    Log(String),
    Voices(Vec<String>),
}

/// Things the speaking thread is told to do.
enum Cmd {
    Speak(String),
    Config(Settings),
}

fn config_path() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_else(|| PathBuf::from("."));
    dir.join("voice-helper.ini")
}

fn now() -> String {
    // Seconds since midnight UTC is enough to order log lines; no time crate needed.
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{:02}:{:02}:{:02}", (s / 3600) % 24, (s / 60) % 60, s % 60)
}

// ---------------------------------------------------------------- speaking

/// Asks Google Cloud Text-to-Speech for the audio (a WAV file) of one sentence.
fn google_audio(agent: &ureq::Agent, st: &Settings, text: &str) -> Result<Vec<u8>, String> {
    let url = format!("https://texttospeech.googleapis.com/v1/text:synthesize?key={}", st.google_key);
    let body = synth_body(text, &st.google_voice, st.rate);
    let resp = match agent.post(&url).set("Content-Type", "application/json").send_string(&body) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_string().unwrap_or_default();
            let msg = json_str(&detail, "message").unwrap_or_else(|| detail.chars().take(200).collect());
            return Err(format!("Google answered {code}: {msg}"));
        }
        Err(e) => return Err(redact(&e.to_string(), &st.google_key)),
    };
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let b64 = json_str(&text, "audioContent").ok_or("Google sent no audio")?;
    base64_decode(&b64).ok_or_else(|| "Google audio could not be decoded".to_string())
}

/// Plays a WAV in this process (so the sound belongs to this app) and waits until it ends.
fn play_wav(bytes: Vec<u8>, volume: i32) -> Result<(), String> {
    let (_stream, handle) = rodio::OutputStream::try_default().map_err(|e| e.to_string())?;
    let sink = rodio::Sink::try_new(&handle).map_err(|e| e.to_string())?;
    let source = rodio::Decoder::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    sink.set_volume(volume.clamp(0, 100) as f32 / 100.0);
    sink.append(source);
    sink.sleep_until_end();
    Ok(())
}

fn speaker(rx: Receiver<Cmd>, ui: Sender<Msg>, ctx: egui::Context) {
    let say = |m: String| {
        let _ = ui.send(Msg::Log(m));
        ctx.request_repaint();
    };
    let mut tts = match tts::Tts::default() {
        Ok(t) => Some(t),
        Err(e) => {
            say(format!("Windows voices are not available: {e}"));
            None
        }
    };
    let voices = tts.as_ref().and_then(|t| t.voices().ok()).unwrap_or_default();
    let _ = ui.send(Msg::Voices(voices.iter().map(|v| v.name()).collect()));
    ctx.request_repaint();
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(30)).build();
    let mut cur = Settings::default();

    for cmd in rx {
        match cmd {
            Cmd::Config(st) => {
                if let Some(tts) = tts.as_mut() {
                    if !st.voice.is_empty() {
                        if let Some(v) = voices.iter().find(|v| v.name() == st.voice) {
                            let _ = tts.set_voice(v);
                        }
                    }
                    let (mn, mx, nm) = (tts.min_rate(), tts.max_rate(), tts.normal_rate());
                    let f = st.rate as f32 / 10.0;
                    let r = if f >= 0.0 { nm + f * (mx - nm) } else { nm + f * (nm - mn) };
                    let _ = tts.set_rate(r.clamp(mn, mx));
                    let (vmin, vmax) = (tts.min_volume(), tts.max_volume());
                    let _ = tts.set_volume(vmin + (st.volume as f32 / 100.0) * (vmax - vmin));
                }
                cur = st;
            }
            Cmd::Speak(text) => {
                let mut spoken = false;
                if cur.use_google && !cur.google_key.is_empty() {
                    say(format!("saying (Google {}): {text}", cur.google_voice));
                    match google_audio(&agent, &cur, &text).and_then(|wav| play_wav(wav, cur.volume)) {
                        Ok(()) => spoken = true,
                        Err(e) => say(format!("Google voice failed, using Windows voice instead: {e}")),
                    }
                }
                if !spoken {
                    match tts.as_mut() {
                        Some(t) => {
                            say(format!("saying: {text}"));
                            if let Err(e) = t.speak(text, false) {
                                say(format!("could not speak: {e}"));
                            }
                        }
                        None => say("nothing available to speak with".to_string()),
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- live feed

fn sleep_while_current(ms: u64, gen: &AtomicU64, mine: u64) {
    let mut left = ms;
    while left > 0 && gen.load(Ordering::SeqCst) == mine {
        let step = left.min(200);
        thread::sleep(Duration::from_millis(step));
        left -= step;
    }
}

#[allow(clippy::too_many_arguments)]
fn feed(s: Settings, mine: u64, gen: Arc<AtomicU64>, ui: Sender<Msg>, speak: Sender<Cmd>, ctx: egui::Context, muted: Arc<std::sync::atomic::AtomicBool>) {
    let note = |m: String| {
        let _ = ui.send(Msg::Log(m));
        ctx.request_repaint();
    };
    let status = |m: String| {
        let _ = ui.send(Msg::Status(m));
        ctx.request_repaint();
    };
    let url = stream_url(&s.url, &s.name, &s.key);
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(60)).build();
    let mut failures = 0u32;

    while gen.load(Ordering::SeqCst) == mine {
        status("Connecting…".into());
        let result: Result<(), String> = (|| {
            let resp = match agent.get(&url).set("Accept", "text/event-stream").call() {
                Ok(r) => r,
                Err(ureq::Error::Status(code, _)) => {
                    return Err(format!("server answered {code}{}", if code == 403 { " (wrong or missing overlay key)" } else { "" }));
                }
                Err(e) => return Err(e.to_string()),
            };
            failures = 0;
            status(format!("Connected to {}", s.url));
            note(format!("connected to {}", s.url));
            let mut reader = std::io::BufReader::new(resp.into_reader());
            let mut sse = Sse::default();
            let mut line = String::new();
            loop {
                if gen.load(Ordering::SeqCst) != mine {
                    return Ok(());
                }
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => return Err("connection closed".into()),
                    Ok(_) => {}
                    Err(e) => return Err(e.to_string()), // includes the 60 s silence timeout (server pings every 20 s)
                }
                if let Some((event, data)) = sse.line(&line) {
                    if event == "alert" {
                        if let Some(text) = sentence(&data) {
                            if muted.load(Ordering::SeqCst) {
                                note(format!("muted, skipped: {text}"));
                            } else {
                                sleep_while_current(s.delay_ms, &gen, mine); // let the chime finish first
                                if gen.load(Ordering::SeqCst) == mine {
                                    let _ = speak.send(Cmd::Speak(text));
                                }
                            }
                        }
                    }
                }
            }
        })();

        if gen.load(Ordering::SeqCst) != mine {
            break;
        }
        if let Err(e) = result {
            failures += 1;
            let wait = (2000u64 << failures.saturating_sub(1).min(5)).min(60_000);
            status(format!("Reconnecting in {}s ({e})", wait / 1000));
            note(format!("{e}. Reconnecting in {}s", wait / 1000));
            sleep_while_current(wait, &gen, mine);
        }
    }
}

// ---------------------------------------------------------------- OBS

/// Finds the installed (not portable) OBS: the path in settings, else the usual Program Files folders.
fn find_installed_obs(s: &Settings) -> Option<PathBuf> {
    if !s.obs_installed.trim().is_empty() {
        let p = PathBuf::from(s.obs_installed.trim());
        return if p.exists() { Some(p) } else { None };
    }
    ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .map(|root| PathBuf::from(root).join("obs-studio").join("bin").join("64bit").join("obs64.exe"))
        .find(|p| p.exists())
}

/// Runs a command without flashing a console window.
fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Opens OBS #1 (the installed one) normally, then OBS #2 (the portable one) as administrator.
/// Runs on its own thread so the window stays responsive.
fn launch_obs(s: Settings, ui: Sender<Msg>, ctx: egui::Context) {
    thread::spawn(move || {
        let say = |m: String| {
            let _ = ui.send(Msg::Log(m));
            ctx.request_repaint();
        };

        // 1. installed OBS
        match find_installed_obs(&s) {
            Some(exe) => {
                let dir = exe.parent().map(|d| d.to_path_buf()).unwrap_or_default();
                let args = obs_args_installed(&s.obs1_args);
                match Command::new(&exe).current_dir(&dir).args(&args).spawn() {
                    Ok(_) => say(format!("started installed OBS ({})", exe.display())),
                    Err(e) => say(format!("could not start installed OBS: {e}")),
                }
            }
            None => say("Installed OBS not found. Install OBS, or type the path to its obs64.exe in the app.".into()),
        }
        thread::sleep(Duration::from_secs(2));

        // 2. portable OBS, as administrator
        let bin = PathBuf::from(&s.obs_dir).join("bin").join("64bit");
        let exe = bin.join("obs64.exe");
        if !exe.exists() {
            say(format!("Portable OBS not found at {}. Set the portable OBS folder in this app.", exe.display()));
            return;
        }
        // portable_mode.txt makes OBS keep its settings inside that folder instead of %APPDATA%.
        let flag = PathBuf::from(&s.obs_dir).join("portable_mode.txt");
        if !flag.exists() {
            let _ = std::fs::write(&flag, "");
        }
        let args = obs_args(&s.obs2_args);
        let script = elevate_script(&exe.to_string_lossy(), &bin.to_string_lossy(), &args);
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", &script]);
        match quiet(&mut cmd).output() {
            Ok(o) if o.status.success() => say("started portable OBS as administrator (approve the Windows prompt if it appears)".into()),
            Ok(o) => say(format!("portable OBS was not started (prompt declined?): {}", String::from_utf8_lossy(&o.stderr).trim().chars().take(200).collect::<String>())),
            Err(e) => say(format!("could not start portable OBS: {e}")),
        }
    });
}

// ---------------------------------------------------------------- window

struct App {
    s: Settings,
    saved: Settings,
    ctx: egui::Context,
    gen: Arc<AtomicU64>,
    muted: Arc<std::sync::atomic::AtomicBool>,
    ui_tx: Sender<Msg>,
    ui_rx: Receiver<Msg>,
    speak_tx: Sender<Cmd>,
    voices: Vec<String>,
    status: String,
    log: Vec<String>,
    test_text: String,
}

impl App {
    fn new(cc: &eframe::CreationContext<'_>) -> App {
        let mut s = std::fs::read_to_string(config_path()).map(|t| Settings::parse(&t)).unwrap_or_default();
        let args: Vec<String> = std::env::args().skip(1).collect();
        s.apply_args(&args);

        let (ui_tx, ui_rx) = channel();
        let (speak_tx, speak_rx) = channel();
        let ctx = cc.egui_ctx.clone();
        {
            let (ui, c) = (ui_tx.clone(), ctx.clone());
            thread::spawn(move || speaker(speak_rx, ui, c));
        }
        let mut app = App {
            saved: s.clone(),
            s,
            ctx,
            gen: Arc::new(AtomicU64::new(0)),
            muted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ui_tx,
            ui_rx,
            speak_tx,
            voices: Vec::new(),
            status: "Starting…".into(),
            log: Vec::new(),
            test_text: "Hello, this is a test announcement".into(),
        };
        app.push_voice_config();
        app.reconnect();
        if app.s.auto_obs {
            launch_obs(app.s.clone(), app.ui_tx.clone(), app.ctx.clone());
        }
        app
    }

    fn push_voice_config(&self) {
        let _ = self.speak_tx.send(Cmd::Config(self.s.clone()));
    }

    fn reconnect(&mut self) {
        let mine = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        let (s, g, ui, sp, c, m) = (self.s.clone(), self.gen.clone(), self.ui_tx.clone(), self.speak_tx.clone(), self.ctx.clone(), self.muted.clone());
        thread::spawn(move || feed(s, mine, g, ui, sp, c, m));
    }

    fn save(&mut self) {
        match std::fs::write(config_path(), self.s.render()) {
            Ok(_) => self.saved = self.s.clone(),
            Err(e) => self.log.push(format!("{} could not save settings: {e}", now())),
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        while let Ok(m) = self.ui_rx.try_recv() {
            match m {
                Msg::Status(t) => self.status = t,
                Msg::Log(t) => {
                    self.log.push(format!("{}  {}", now(), t));
                    if self.log.len() > 200 {
                        self.log.remove(0);
                    }
                }
                Msg::Voices(v) => self.voices = v,
            }
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Supporters Voice");
            ui.label("In OBS: add a source of type Application Audio Capture and pick Supporters Voice.");
            ui.add_space(6.0);
            ui.label(format!("Status: {}", self.status));
            ui.separator();

            egui::Grid::new("form").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                ui.label("Overlay address");
                ui.add(egui::TextEdit::singleline(&mut self.s.url).desired_width(340.0));
                ui.end_row();
                ui.label("Overlay key");
                ui.add(egui::TextEdit::singleline(&mut self.s.key).password(true).desired_width(340.0));
                ui.end_row();
                ui.label("Name in /admin");
                ui.add(egui::TextEdit::singleline(&mut self.s.name).desired_width(340.0));
                ui.end_row();
            });
            ui.horizontal(|ui| {
                if ui.button("Save and reconnect").clicked() {
                    self.save();
                    self.reconnect();
                }
                let mut muted = self.muted.load(Ordering::SeqCst);
                if ui.checkbox(&mut muted, "Mute").changed() {
                    self.muted.store(muted, Ordering::SeqCst);
                }
            });
            ui.separator();

            let mut changed = false;
            let shown = if self.s.voice.is_empty() { "Windows default".to_string() } else { self.s.voice.clone() };
            egui::ComboBox::from_label("Voice").selected_text(shown).width(300.0).show_ui(ui, |ui| {
                if ui.selectable_label(self.s.voice.is_empty(), "Windows default").clicked() {
                    self.s.voice.clear();
                    changed = true;
                }
                for v in self.voices.clone() {
                    if ui.selectable_label(self.s.voice == v, &v).clicked() {
                        self.s.voice = v;
                        changed = true;
                    }
                }
            });
            changed |= ui.add(egui::Slider::new(&mut self.s.rate, -10..=10).text("Speed")).changed();
            changed |= ui.add(egui::Slider::new(&mut self.s.volume, 0..=100).text("Volume")).changed();
            if changed {
                self.push_voice_config();
                self.save();
            }
            let mut g = ui.checkbox(&mut self.s.use_google, "Use a Google Cloud voice (falls back to the Windows voice if it fails)").changed();
            if self.s.use_google {
                egui::Grid::new("google").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                    ui.label("Google API key");
                    g |= ui.add(egui::TextEdit::singleline(&mut self.s.google_key).password(true).desired_width(340.0)).changed();
                    ui.end_row();
                    ui.label("Google voice");
                    g |= ui.add(egui::TextEdit::singleline(&mut self.s.google_voice).hint_text("en-IN-Neural2-A").desired_width(340.0)).changed();
                    ui.end_row();
                });
            }
            if g {
                self.push_voice_config();
                self.save();
            }
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.test_text).desired_width(300.0));
                if ui.button("Test voice").clicked() {
                    self.push_voice_config();
                    let _ = self.speak_tx.send(Cmd::Speak(self.test_text.clone()));
                }
            });
            ui.separator();

            ui.label("OBS #1 is the installed OBS (found automatically). OBS #2 is the portable one, opened as administrator.");
            egui::Grid::new("obs").num_columns(2).spacing([10.0, 6.0]).show(ui, |ui| {
                ui.label("Installed obs64.exe");
                ui.add(egui::TextEdit::singleline(&mut self.s.obs_installed).hint_text("leave empty to find it").desired_width(340.0));
                ui.end_row();
                ui.label("Portable OBS folder");
                ui.add(egui::TextEdit::singleline(&mut self.s.obs_dir).desired_width(340.0));
                ui.end_row();
                ui.label("OBS #1 extra options");
                ui.add(egui::TextEdit::singleline(&mut self.s.obs1_args).hint_text("--profile HDR --collection HDR").desired_width(340.0));
                ui.end_row();
                ui.label("OBS #2 extra options");
                ui.add(egui::TextEdit::singleline(&mut self.s.obs2_args).hint_text("--profile HD --collection HD").desired_width(340.0));
                ui.end_row();
            });
            ui.horizontal(|ui| {
                if ui.button("Open both OBS windows").clicked() {
                    self.save();
                    launch_obs(self.s.clone(), self.ui_tx.clone(), self.ctx.clone());
                }
                let before = self.s.auto_obs;
                ui.checkbox(&mut self.s.auto_obs, "Open them when this app starts");
                if before != self.s.auto_obs {
                    self.save();
                }
            });
            if self.s != self.saved {
                ui.weak("Unsaved changes: press 'Save and reconnect' or 'Open both OBS windows'.");
            }
            ui.separator();

            egui::ScrollArea::vertical().stick_to_bottom(true).auto_shrink([false, false]).show(ui, |ui| {
                for l in &self.log {
                    ui.monospace(l);
                }
            });
        });
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([560.0, 640.0]).with_title("Supporters Voice"),
        ..Default::default()
    };
    eframe::run_native("Supporters Voice", options, Box::new(|cc| Ok(Box::new(App::new(cc)))))
}
