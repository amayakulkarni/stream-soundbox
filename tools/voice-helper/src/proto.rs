//! Pure, dependency-free pieces: SSE line parsing, a tiny JSON string reader, text clean-up,
//! and the settings file. Kept separate so it can be unit-tested with plain `rustc --test`.

/// Incremental Server-Sent-Events parser. Feed it one line at a time (without the newline).
#[derive(Default)]
pub struct Sse {
    event: String,
    data: String,
}

impl Sse {
    /// Returns `Some((event, data))` when a blank line completes an event.
    pub fn line(&mut self, raw: &str) -> Option<(String, String)> {
        let line = raw.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            let had = !self.event.is_empty() || !self.data.is_empty();
            let ev = std::mem::take(&mut self.event);
            let data = std::mem::take(&mut self.data);
            if !had {
                return None;
            }
            return Some((if ev.is_empty() { "message".to_string() } else { ev }, data));
        }
        if line.starts_with(':') {
            return None; // comment / heartbeat
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value);
            }
            _ => {}
        }
        None
    }
}

/// Reads a top-level string field out of a flat JSON object, e.g. `json_str(r#"{"a":"b"}"#, "a")`.
pub fn json_str(src: &str, key: &str) -> Option<String> {
    let c: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut depth = 0i32;
    while i < c.len() {
        match c[i] {
            '{' | '[' => {
                depth += 1;
                i += 1;
            }
            '}' | ']' => {
                depth -= 1;
                i += 1;
            }
            '"' => {
                let (s, next) = read_string(&c, i)?;
                i = next;
                let mut j = i;
                while j < c.len() && c[j].is_whitespace() {
                    j += 1;
                }
                if depth == 1 && j < c.len() && c[j] == ':' && s == key {
                    j += 1;
                    while j < c.len() && c[j].is_whitespace() {
                        j += 1;
                    }
                    if j < c.len() && c[j] == '"' {
                        return read_string(&c, j).map(|(v, _)| v);
                    }
                    return None; // present but not a string
                }
            }
            _ => i += 1,
        }
    }
    None
}

// c[start] is the opening quote. Returns the decoded string and the index after the closing quote.
fn read_string(c: &[char], start: usize) -> Option<(String, usize)> {
    let mut out = String::new();
    let mut i = start + 1;
    while i < c.len() {
        match c[i] {
            '"' => return Some((out, i + 1)),
            '\\' => {
                i += 1;
                match *c.get(i)? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    'r' => out.push('\r'),
                    'b' => out.push('\u{8}'),
                    'f' => out.push('\u{c}'),
                    'u' => {
                        let hi = hex4(c, i + 1)?;
                        i += 4;
                        if (0xD800..0xDC00).contains(&hi) && c.get(i + 1) == Some(&'\\') && c.get(i + 2) == Some(&'u') {
                            let lo = hex4(c, i + 3)?;
                            if (0xDC00..0xE000).contains(&lo) {
                                let cp = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                                i += 6;
                            } else {
                                out.push('\u{fffd}');
                            }
                        } else {
                            out.push(char::from_u32(hi).unwrap_or('\u{fffd}'));
                        }
                    }
                    other => out.push(other), // \" \\ \/
                }
                i += 1;
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    None
}

fn hex4(c: &[char], at: usize) -> Option<u32> {
    let s: String = c.get(at..at + 4)?.iter().collect();
    u32::from_str_radix(&s, 16).ok()
}

/// Strips control and direction-override characters, collapses spaces, caps the length.
pub fn clean(s: &str) -> String {
    let mapped: String = s
        .chars()
        .map(|ch| {
            let bad = ch.is_control() || ('\u{202a}'..='\u{202e}').contains(&ch) || ('\u{2066}'..='\u{2069}').contains(&ch);
            if bad { ' ' } else { ch }
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect()
}

/// What gets spoken for one `alert` event. None when there is nothing sensible to say.
pub fn sentence(data: &str) -> Option<String> {
    let name = json_str(data, "name").unwrap_or_default();
    let label = json_str(data, "label").unwrap_or_default();
    let platform = json_str(data, "platform").unwrap_or_default();
    let text = if platform.is_empty() { format!("{}, {}", name, label) } else { format!("{}, {} on {}", name, label, platform) };
    let text = clean(&text);
    if text.is_empty() || text == "," { None } else { Some(text) }
}

pub fn stream_url(base: &str, name: &str, key: &str) -> String {
    let mut u = format!("{}/api/stream?view=alerts&name={}", base.trim_end_matches('/'), pct(name));
    if !key.is_empty() {
        u.push_str("&key=");
        u.push_str(&pct(key));
    }
    u
}

fn pct(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

/// Splits a command line the way a shell would for simple cases: spaces separate, "double quotes" group.
pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for ch in s.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

/// Arguments for one OBS instance: always portable + multi, then the user's extras (no duplicates).
pub fn obs_args(extra: &str) -> Vec<String> {
    let mut v = vec!["--portable".to_string(), "--multi".to_string()];
    for a in split_args(extra) {
        if a != "--portable" && a != "--multi" {
            v.push(a);
        }
    }
    v
}

/// JSON string escaping (without the surrounding quotes).
pub fn json_escape(s: &str) -> String {
    let mut o = String::new();
    for ch in s.chars() {
        match ch {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

/// "en-IN-Neural2-A" -> "en-IN" (Google wants the language code next to the voice name).
pub fn lang_of(voice: &str) -> String {
    let mut it = voice.split('-');
    match (it.next(), it.next()) {
        (Some(a), Some(b)) if !a.is_empty() && !b.is_empty() => format!("{}-{}", a, b),
        _ => "en-US".to_string(),
    }
}

/// Request body for Google Cloud Text-to-Speech `text:synthesize`. `rate` is -10..10.
pub fn synth_body(text: &str, voice: &str, rate: i32) -> String {
    let speaking = 1.0 + (rate.clamp(-10, 10) as f32) * 0.05;
    format!(
        r#"{{"input":{{"text":"{}"}},"voice":{{"languageCode":"{}","name":"{}"}},"audioConfig":{{"audioEncoding":"LINEAR16","speakingRate":{:.2}}}}}"#,
        json_escape(text),
        json_escape(&lang_of(voice)),
        json_escape(voice),
        speaking
    )
}

pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Replaces every occurrence of a secret in text meant for the log.
pub fn redact(text: &str, secret: &str) -> String {
    if secret.is_empty() { text.to_string() } else { text.replace(secret, "***") }
}

/// Arguments for the INSTALLED OBS: no --portable (it keeps its settings in %APPDATA%), still --multi.
pub fn obs_args_installed(extra: &str) -> Vec<String> {
    let mut v = vec!["--multi".to_string()];
    for a in split_args(extra) {
        if a != "--portable" && a != "--multi" {
            v.push(a);
        }
    }
    v
}

/// Single-quote a value for PowerShell.
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// PowerShell script that starts a program as administrator (Windows shows the UAC prompt).
pub fn elevate_script(exe: &str, dir: &str, args: &[String]) -> String {
    let list: Vec<String> = args.iter().map(|a| ps_quote(a)).collect();
    format!("Start-Process -FilePath {} -WorkingDirectory {} -ArgumentList @({}) -Verb RunAs", ps_quote(exe), ps_quote(dir), list.join(","))
}

/// Settings, stored as plain `key=value` lines next to the exe.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub url: String,
    pub key: String,
    pub name: String,
    pub voice: String,
    pub rate: i32,   // -10 slow .. 10 fast
    pub volume: i32, // 0 .. 100
    pub delay_ms: u64,
    pub obs_dir: String,   // the portable OBS folder (the one holding bin\64bit\obs64.exe)
    pub obs1_args: String, // extra arguments for the first OBS, e.g. --profile HDR --collection HDR
    pub obs2_args: String,
    pub auto_obs: bool,    // start both OBS windows when this app starts
    pub obs_installed: String, // optional full path to obs64.exe of the installed OBS; empty = find it
    pub use_google: bool,  // speak with a Google Cloud voice instead of a Windows one
    pub google_key: String,
    pub google_voice: String, // e.g. en-IN-Neural2-A
}

impl Default for Settings {
    fn default() -> Self {
        Settings { url: "https://supporters.amayakulkarni.com".into(), key: String::new(), name: "voice-helper".into(), voice: String::new(), rate: 0, volume: 100, delay_ms: 700,
            obs_dir: r"C:\Users\Amaya Kulkarni\ClosetRepublic\streaming-apps\OBS-Studio-33.0.1-Windows-x64".into(),
            obs1_args: String::new(), obs2_args: String::new(), auto_obs: false,
            obs_installed: String::new(), use_google: false, google_key: String::new(), google_voice: "en-IN-Neural2-A".into() }
    }
}

impl Settings {
    pub fn parse(text: &str) -> Settings {
        let mut s = Settings::default();
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                s.set(k.trim(), v.trim());
            }
        }
        s
    }

    pub fn set(&mut self, k: &str, v: &str) {
        match k {
            "url" => self.url = v.to_string(),
            "key" => self.key = v.to_string(),
            "name" => self.name = v.to_string(),
            "voice" => self.voice = v.to_string(),
            "rate" => self.rate = v.parse::<i32>().unwrap_or(0).clamp(-10, 10),
            "volume" => self.volume = v.parse::<i32>().unwrap_or(100).clamp(0, 100),
            "delay" => self.delay_ms = v.parse::<u64>().unwrap_or(700).min(10_000),
            "obs_dir" => self.obs_dir = v.to_string(),
            "obs1" => self.obs1_args = v.to_string(),
            "obs2" => self.obs2_args = v.to_string(),
            "obs_installed" => self.obs_installed = v.to_string(),
            "use_google" => self.use_google = matches!(v, "1" | "true" | "yes"),
            "google_key" => self.google_key = v.to_string(),
            "google_voice" => self.google_voice = v.to_string(),
            "auto_obs" => self.auto_obs = matches!(v, "1" | "true" | "yes"),
            _ => {}
        }
    }

    pub fn render(&self) -> String {
        format!(
            "url={}\nkey={}\nname={}\nvoice={}\nrate={}\nvolume={}\ndelay={}\nobs_dir={}\nobs1={}\nobs2={}\nauto_obs={}\nobs_installed={}\nuse_google={}\ngoogle_key={}\ngoogle_voice={}\n",
            self.url, self.key, self.name, self.voice, self.rate, self.volume, self.delay_ms, self.obs_dir, self.obs1_args, self.obs2_args, self.auto_obs as u8, self.obs_installed, self.use_google as u8, self.google_key, self.google_voice
        )
    }

    /// `--url X --key Y --voice Z --rate N --volume N --name N --delay N` override the file.
    pub fn apply_args(&mut self, args: &[String]) {
        if args.iter().any(|a| a == "--launch-obs") {
            self.auto_obs = true;
        }
        let mut i = 0;
        while i + 1 < args.len() {
            if let Some(k) = args[i].strip_prefix("--") {
                self.set(k, &args[i + 1]);
                i += 2;
            } else {
                i += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_events() {
        let mut p = Sse::default();
        assert_eq!(p.line("retry: 3000"), None);
        assert_eq!(p.line(""), None); // no event pending
        assert_eq!(p.line(": ping"), None);
        assert_eq!(p.line("event: alert\n"), None);
        assert_eq!(p.line("data: {\"a\":1}\r"), None);
        assert_eq!(p.line(""), Some(("alert".into(), "{\"a\":1}".into())));
        assert_eq!(p.line("data:x"), None);
        assert_eq!(p.line("data: y"), None);
        assert_eq!(p.line(""), Some(("message".into(), "x\ny".into())));
    }

    #[test]
    fn json_fields() {
        let d = r#"{"id":"1","type":"x","name":"Mi\"a é 😀","label":"followed","nested":{"name":"no"},"platform":"Twitch","n":5}"#;
        assert_eq!(json_str(d, "name").unwrap(), "Mi\"a é 😀");
        assert_eq!(json_str(d, "label").unwrap(), "followed");
        assert_eq!(json_str(d, "platform").unwrap(), "Twitch");
        assert_eq!(json_str(d, "n"), None);
        assert_eq!(json_str(d, "missing"), None);
        assert_eq!(json_str("not json", "name"), None);
        assert_eq!(json_str(r#"{"a":"unterminated"#, "a"), None);
    }

    #[test]
    fn sentences() {
        assert_eq!(sentence(r#"{"name":"Ada","label":"subscribed","platform":"YouTube"}"#).unwrap(), "Ada, subscribed on YouTube");
        assert_eq!(sentence(r#"{"name":"Ada","label":"bought compute"}"#).unwrap(), "Ada, bought compute");
        assert_eq!(sentence("{}"), None);
        assert_eq!(clean("a\u{202e}b\n\n  c\u{0}d"), "a b c d");
        assert_eq!(clean(&"x".repeat(500)).chars().count(), 160);
    }

    #[test]
    fn obs_arguments() {
        assert_eq!(split_args(r#"--profile "HDR YouTube" --collection x"#), vec!["--profile", "HDR YouTube", "--collection", "x"]);
        assert_eq!(split_args("  "), Vec::<String>::new());
        assert_eq!(obs_args(""), vec!["--portable", "--multi"]);
        assert_eq!(obs_args("--multi --profile A"), vec!["--portable", "--multi", "--profile", "A"]);
        let mut s = Settings::parse("obs_dir=C:\\a b\\OBS\nobs1=--profile A\nauto_obs=1\n");
        assert_eq!((s.obs_dir.as_str(), s.obs1_args.as_str(), s.auto_obs), ("C:\\a b\\OBS", "--profile A", true));
        s.auto_obs = false;
        s.apply_args(&["--launch-obs".into()]);
        assert!(s.auto_obs);
    }

    #[test]
    fn google_pieces() {
        assert_eq!(lang_of("en-IN-Neural2-A"), "en-IN");
        assert_eq!(lang_of("weird"), "en-US");
        assert_eq!(json_escape("a\"b\\c\nd\u{1}"), "a\\\"b\\\\c\\nd\\u0001");
        let b = synth_body("Hi \"you\"", "en-GB-Wavenet-B", 4);
        assert_eq!(b, r#"{"input":{"text":"Hi \"you\""},"voice":{"languageCode":"en-GB","name":"en-GB-Wavenet-B"},"audioConfig":{"audioEncoding":"LINEAR16","speakingRate":1.20}}"#);
        assert_eq!(base64_decode("SGVsbG8sIHdvcmxkIQ==").unwrap(), b"Hello, world!");
        assert_eq!(base64_decode("SGk=").unwrap(), b"Hi");
        assert_eq!(base64_decode("SG\nk=").unwrap(), b"Hi");
        assert_eq!(base64_decode("a$b"), None);
        let resp = r#"{"audioContent":"SGk="}"#;
        assert_eq!(base64_decode(&json_str(resp, "audioContent").unwrap()).unwrap(), b"Hi");
        assert_eq!(redact("GET /x?key=SECRET failed", "SECRET"), "GET /x?key=*** failed");
        let s = Settings::parse("use_google=1\ngoogle_key=abc\ngoogle_voice=en-US-Neural2-F\n");
        assert!(s.use_google && s.google_key == "abc");
        assert_eq!(Settings::parse(&s.render()), s);
    }

    #[test]
    fn elevation() {
        assert_eq!(obs_args_installed("--portable --profile A"), vec!["--multi", "--profile", "A"]);
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(
            elevate_script(r"C:\o b\obs64.exe", r"C:\o b", &["--portable".into(), "--multi".into()]),
            r"Start-Process -FilePath 'C:\o b\obs64.exe' -WorkingDirectory 'C:\o b' -ArgumentList @('--portable','--multi') -Verb RunAs"
        );
        let mut s = Settings::default();
        s.obs_installed = r"D:\obs\bin\64bit\obs64.exe".into();
        assert_eq!(Settings::parse(&s.render()), s);
    }

    #[test]
    fn urls() {
        assert_eq!(stream_url("https://h.example/", "voice helper", ""), "https://h.example/api/stream?view=alerts&name=voice%20helper");
        assert_eq!(stream_url("http://localhost:42001", "v", "a+b/c"), "http://localhost:42001/api/stream?view=alerts&name=v&key=a%2Bb%2Fc");
    }

    #[test]
    fn settings_roundtrip() {
        let mut s = Settings::default();
        s.key = "k".into();
        s.rate = 3;
        s.voice = "Microsoft Zira".into();
        assert_eq!(Settings::parse(&s.render()), s);
        let mut t = Settings::parse("# c\nrate=99\nvolume=-4\nbogus=1\n");
        assert_eq!((t.rate, t.volume), (10, 0));
        t.apply_args(&["--url".into(), "http://x".into(), "--rate".into(), "-2".into(), "--flag".into()]);
        assert_eq!((t.url.as_str(), t.rate), ("http://x", -2));
    }
}
