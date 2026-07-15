#!/usr/bin/env sh
# Install the OPTIONAL media/subtitle binaries the Subtitle Intelligence module
# can use. Everything here is optional by design: without it the module still
# searches, scores, validates, installs, and can sync via a manual offset — it
# just cannot do audio-based automatic sync. Idempotent and safe to re-run.
#
#   mediainfo  — technical probe (already used by Media Manager); ~18 MB.
#   ffmpeg     — audio decode for automatic sync; ~large (~400 MB of deps).
#   ffsubsync  — audio-based automatic subtitle synchronization (pip; needs ffmpeg).
#
# Usage:
#   ops/scripts/install-subtitle-tools.sh              # install everything
#   WITH_FFSUBSYNC=0 ops/scripts/install-subtitle-tools.sh   # skip the heavy sync stack
#
# Honors an existing install: each tool is skipped when already on PATH.
set -eu

WITH_FFSUBSYNC="${WITH_FFSUBSYNC:-1}"
log() { printf '\033[36m[subtitle-tools]\033[0m %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- privilege + package manager detection --------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then SUDO="sudo"; else
    log "not root and no sudo — cannot install system packages"; exit 1
  fi
fi

if have apt-get; then PKG="apt"; elif have apk; then PKG="apk"; else
  log "unsupported package manager (need apt-get or apk)"; exit 1
fi

pkg_install() {
  if [ "$PKG" = "apt" ]; then
    $SUDO apt-get update
    $SUDO apt-get install -y --no-install-recommends "$@"
    $SUDO rm -rf /var/lib/apt/lists/* 2>/dev/null || true
  else
    $SUDO apk add --no-cache "$@"
  fi
}

# --- mediainfo -------------------------------------------------------------
if have mediainfo; then log "mediainfo already present ($(mediainfo --Version 2>/dev/null | head -1))"
else log "installing mediainfo"; pkg_install mediainfo; fi

# --- ffsubsync (+ ffmpeg + python) ----------------------------------------
if [ "$WITH_FFSUBSYNC" = "1" ]; then
  if have ffmpeg; then log "ffmpeg already present"
  else log "installing ffmpeg"; pkg_install ffmpeg; fi

  if have ffsubsync; then
    log "ffsubsync already present ($(ffsubsync --version 2>/dev/null | head -1))"
  else
    log "installing ffsubsync (pip)"
    if [ "$PKG" = "apt" ]; then pkg_install python3 python3-pip; else pkg_install python3 py3-pip; fi
    # PEP-668 marks system Python "externally managed"; --break-system-packages
    # is the documented escape for a container/appliance where the system Python
    # IS the app's Python. Fall back to a plain install for older pips.
    python3 -m pip install --no-cache-dir --break-system-packages ffsubsync 2>/dev/null \
      || python3 -m pip install --no-cache-dir ffsubsync
  fi
else
  log "WITH_FFSUBSYNC=0 — skipping ffmpeg + ffsubsync (manual-offset sync still works)"
fi

# --- verify ----------------------------------------------------------------
log "installed versions:"
have mediainfo && mediainfo --Version 2>/dev/null | head -1 || true
have ffmpeg    && ffmpeg -version 2>/dev/null | head -1 || true
have ffsubsync && printf 'ffsubsync %s\n' "$(ffsubsync --version 2>/dev/null | head -1)" || true
log "done."
