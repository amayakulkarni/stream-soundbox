#!/usr/bin/env bash
# Installer / updater for Debian/Ubuntu.
#
#   sudo ./deploy/install.sh [--email you@example.com] [--domain supporters.amayakulkarni.com]
#       First install (also safe to re-run). Sets up the app, systemd, nginx and a TLS certificate.
#
#   sudo ./deploy/install.sh update [--from /path/to/supporters-overlay.zip|/path/to/folder]
#       Update an existing install in place. Keeps your .env and data/, adds any new .env settings,
#       backs up the old version, restarts, checks that the app answers, and rolls back by itself if it does not.
#       Without --from it uses the folder this script is in.
#
#   sudo ./deploy/install.sh rollback
#       Put the most recent backup back.
set -euo pipefail

MODE="install"
case "${1:-}" in
  update|rollback) MODE="$1"; shift ;;
esac

DOMAIN=""
EMAIL=""
FROM=""
APP_DIR="${SUPPORTERS_APP_DIR:-/opt/supporters-overlay}"
APP_USER="supporters"
BACKUP_DIR="${SUPPORTERS_BACKUP_DIR:-/var/backups/supporters-overlay}"
APP_ITEMS=(src public scripts deploy docs package.json package-lock.json README.md .env.example)
# Merged into the install rather than replaced, because they also hold what setup generated (see sync_extras).
EXTRA_DIRS=(config audio)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"


say() { printf '\n\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

env_get() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true; }

health_check() {
  local port url i
  port="$(env_get PORT)"; port="${port:-42001}"
  url="http://127.0.0.1:$port/healthz"
  for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.75
  done
  return 1
}

backup_app() {
  mkdir -p "$BACKUP_DIR"
  local ts file
  ts="$(date +%Y%m%d-%H%M%S)"
  file="$BACKUP_DIR/app-$ts.tar.gz"
  # code only: data/ and .env stay in place and are never touched by an update
  tar -czf "$file" -C "$APP_DIR" --ignore-failed-read "${APP_ITEMS[@]}" 2>/dev/null || true
  ls -1t "$BACKUP_DIR"/app-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
  echo "$file"
}

restore_backup() {
  local file="$1"
  [[ -f "$file" ]] || die "no backup to restore"
  for item in "${APP_ITEMS[@]}"; do rm -rf "${APP_DIR:?}/$item"; done
  tar -xzf "$file" -C "$APP_DIR"
  install_packages || true
  chown -R root:"$APP_USER" "$APP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR/data"
  systemctl restart supporters
}

# New files are added and shipped files updated, but config/discord-tiers.json, your own ambience and pomodoro
# settings, and any sound you added stay as they are.
sync_extras() {
  local dir
  for dir in "${EXTRA_DIRS[@]}"; do
    [[ -d "$SRC/$dir" ]] || continue
    mkdir -p "$APP_DIR/$dir"
    if [[ "$dir" == config ]]; then
      cp -an "$SRC/$dir/." "$APP_DIR/$dir/"
      cp -a "$SRC/$dir/"*.example.json "$SRC/$dir/server-template.json" "$APP_DIR/$dir/" 2>/dev/null || true
    else
      cp -an "$SRC/$dir/." "$APP_DIR/$dir/"
    fi
  done
}

install_packages() {
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
}

# Adds settings that exist in .env.example but not yet in your .env (never changes values you already have).
merge_env() {
  local added=() key line
  while IFS= read -r line; do
    key="${line%%=*}"
    if ! grep -qE "^$key=" "$APP_DIR/.env"; then
      printf '%s\n' "$line" >> "$APP_DIR/.env"
      added+=("$key")
    fi
  done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$SRC/.env.example")
  if ((${#added[@]})); then
    echo "Added new settings to $APP_DIR/.env (all off or empty until you fill them in): ${added[*]}"
  else
    echo "$APP_DIR/.env already has every setting."
  fi
}

sync_files() {
  for item in "${APP_ITEMS[@]}"; do
    [[ -e "$SRC/$item" ]] || continue
    rm -rf "${APP_DIR:?}/$item"
    cp -a "$SRC/$item" "$APP_DIR/$item"
  done
  sync_extras
  chown -R root:"$APP_USER" "$APP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR/data"
  chmod 750 "$APP_DIR"
  [[ -f "$APP_DIR/.env" ]] && chmod 640 "$APP_DIR/.env"
  chmod 700 "$APP_DIR/data"
}

refresh_service_and_nginx() {
  sed "s|__NODE__|$NODE_BIN|" "$SRC/deploy/systemd/supporters.service" > /etc/systemd/system/supporters.service
  systemctl daemon-reload
  local dom="$1"
  if [[ -n "$dom" && -f "/etc/letsencrypt/live/$dom/fullchain.pem" ]]; then
    local avail="/etc/nginx/sites-available/$dom.conf"
    cp -a "$avail" "$avail.prev" 2>/dev/null || true
    sed "s/supporters\.amayakulkarni\.com/$dom/g" "$SRC/deploy/nginx/supporters.amayakulkarni.com.conf" > "$avail"
    if nginx -t 2>/dev/null; then systemctl reload nginx; else echo "nginx config did not validate; keeping the previous one."; mv -f "$avail.prev" "$avail" 2>/dev/null || true; fi
  fi
}

# ── Node ──
command -v node >/dev/null || { echo "Node.js 20+ is required (https://nodejs.org or NodeSource). Install it and re-run." >&2; exit 1; }
NODE_BIN="$(command -v node)"
(( $(node -p 'process.versions.node.split(".")[0]') >= 20 )) || { echo "Node 20+ required, found $(node -v)." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required for the Discord bot's packages. Install it and re-run." >&2; exit 1; }


# ── rollback ──
if [[ "$MODE" == "rollback" ]]; then
  LATEST="$(ls -1t "$BACKUP_DIR"/app-*.tar.gz 2>/dev/null | head -1 || true)"
  [[ -n "$LATEST" ]] || die "no backups in $BACKUP_DIR"
  say "Restoring $LATEST"
  restore_backup "$LATEST"
  health_check && say "Rolled back. The app is answering." || die "restored, but the app is not answering: journalctl -u supporters -n 50"
  exit 0
fi

# ── update ──
if [[ "$MODE" == "update" ]]; then
  [[ -f "$APP_DIR/.env" ]] || die "$APP_DIR is not installed yet. Run without 'update' first."
  command -v curl >/dev/null || die "curl is required for the health check (apt install curl)."
  if [[ -n "$FROM" ]]; then
    if [[ -f "$FROM" && "$FROM" == *.zip ]]; then
      command -v unzip >/dev/null || { apt-get update -qq && apt-get install -y -qq unzip >/dev/null; }
      TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
      unzip -q "$FROM" -d "$TMP"
      SRC="$(dirname "$(find "$TMP" -maxdepth 3 -path '*/src/server.js' | head -1)")/.."
      SRC="$(cd "$SRC" 2>/dev/null && pwd)" || die "that zip does not contain src/server.js"
    elif [[ -d "$FROM" ]]; then
      SRC="$(cd "$FROM" && pwd)"
    else
      die "--from must be a .zip file or a folder"
    fi
  fi
  [[ -f "$SRC/src/server.js" ]] || die "$SRC does not look like the app (no src/server.js)"
  [[ -z "$DOMAIN" ]] && DOMAIN="$(env_get PUBLIC_URL | sed -E 's#^https?://##; s#/.*$##')"

  say "Backing up the current version"
  BACKUP="$(backup_app)"; echo "$BACKUP"
  say "Updating the app"
  sync_files
  merge_env
  refresh_service_and_nginx "$DOMAIN"
  PACKAGES_OK=1
  say "Installing packages"
  install_packages || PACKAGES_OK=0
  chown -R root:"$APP_USER" "$APP_DIR"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR/data"
  systemctl restart supporters
  if [[ $PACKAGES_OK -eq 1 ]] && health_check; then
    say "Updated. The app is answering."
    echo "Version files are in $APP_DIR. Your .env and data were left alone."
    echo "Undo with: sudo $0 rollback"
  else
    say "The new version did not start. Rolling back."
    journalctl -u supporters -n 25 --no-pager || true
    restore_backup "$BACKUP"
    health_check && die "rolled back to the previous version (it is running). Check the log above." || die "rollback done but the app still does not answer: journalctl -u supporters -n 50"
  fi
  exit 0
fi

# ── first install: domain default ──
DOMAIN="${DOMAIN:-supporters.amayakulkarni.com}"

# ── Packages ──
say "Installing nginx and certbot"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot openssl curl unzip >/dev/null

# ── User and files ──
say "Installing the app into $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
for item in "${APP_ITEMS[@]}"; do
  [[ -e "$SRC/$item" ]] || continue
  rm -rf "${APP_DIR:?}/$item"
  cp -a "$SRC/$item" "$APP_DIR/$item"
done
sync_extras
say "Installing packages"
install_packages

NEW_ENV=0
if [[ ! -f "$APP_DIR/.env" ]]; then
  NEW_ENV=1
  cp "$SRC/.env.example" "$APP_DIR/.env"
  ADMIN_PW="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  OVERLAY_KEY="$(openssl rand -hex 12)"
  set_env() { sed -i "s|^$1=.*|$1=$2|" "$APP_DIR/.env"; }
  set_env ADMIN_PASSWORD "$ADMIN_PW"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env OVERLAY_KEY "$OVERLAY_KEY"
  set_env TWITCH_EVENTSUB_SECRET "$(openssl rand -hex 24)"
  set_env BMC_WEBHOOK_SECRET "$(openssl rand -hex 24)"
  set_env BMC_WEBHOOK_TOKEN "$(openssl rand -hex 20)"
  set_env PUBLIC_URL "https://$DOMAIN"
fi
chown -R root:"$APP_USER" "$APP_DIR"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR/data"
chmod 750 "$APP_DIR"
chmod 640 "$APP_DIR/.env"
chmod 700 "$APP_DIR/data"

# ── systemd ──
say "Installing the systemd service"
sed "s|__NODE__|$NODE_BIN|" "$SRC/deploy/systemd/supporters.service" > /etc/systemd/system/supporters.service
systemctl daemon-reload
systemctl enable supporters >/dev/null
systemctl restart supporters
sleep 1
systemctl is-active --quiet supporters || { journalctl -u supporters -n 30 --no-pager; exit 1; }

# ── nginx + TLS ──
say "Configuring nginx for $DOMAIN"
mkdir -p /var/www/certbot
CONF_AVAIL="/etc/nginx/sites-available/$DOMAIN.conf"
CONF_LINK="/etc/nginx/sites-enabled/$DOMAIN.conf"
sed "s/supporters\.amayakulkarni\.com/$DOMAIN/g" "$SRC/deploy/nginx/supporters.amayakulkarni.com.bootstrap.conf" > "$CONF_AVAIL"
ln -sf "$CONF_AVAIL" "$CONF_LINK"
nginx -t && systemctl reload nginx

CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
TLS_OK=0
if [[ -f "$CERT" ]]; then
  TLS_OK=1
else
  say "Requesting a Let's Encrypt certificate (DNS for $DOMAIN must already point at this server)"
  CERTBOT_ARGS=(certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos)
  if [[ -n "$EMAIL" ]]; then CERTBOT_ARGS+=(-m "$EMAIL"); else CERTBOT_ARGS+=(--register-unsafely-without-email); fi
  if certbot "${CERTBOT_ARGS[@]}"; then TLS_OK=1; else echo "Certificate request failed. Fix DNS / port 80, then re-run this script."; fi
fi

if [[ $TLS_OK -eq 1 ]]; then
  sed "s/supporters\.amayakulkarni\.com/$DOMAIN/g" "$SRC/deploy/nginx/supporters.amayakulkarni.com.conf" > "$CONF_AVAIL"
  nginx -t && systemctl reload nginx
  # certbot's systemd timer renews; reload nginx after each renewal
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
fi

# ── Summary ──
say "Done"
SCHEME=$([[ $TLS_OK -eq 1 ]] && echo https || echo http)
echo "Service:   systemctl status supporters   (logs: journalctl -u supporters -f)"
echo "Admin:     $SCHEME://$DOMAIN/admin"
if [[ $NEW_ENV -eq 1 ]]; then
  echo "Password:  $ADMIN_PW        <- shown once; it is also in $APP_DIR/.env"
  echo "Overlay:   $SCHEME://$DOMAIN/overlay?key=$OVERLAY_KEY"
else
  echo "Kept your existing $APP_DIR/.env. The overlay URLs are listed in the admin dashboard."
fi
echo
echo "Next: add YouTube / Twitch client IDs to $APP_DIR/.env, run 'systemctl restart supporters', then open /admin."
