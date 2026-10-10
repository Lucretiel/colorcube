#!/usr/bin/env bash
# Full colorcube data pipeline: raw SQL dump -> web/public/assets/ (+ build/ intermediates).
# Usage (from anywhere):  pipeline/build.sh      (re-execs itself inside `nix develop`)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# COLORCUBE_DEVSHELL is exported by this flake's devShell; IN_NIX_SHELL alone would also
# be set by any other nix shell, which may lack the pipeline's python packages.
if [[ -z "${COLORCUBE_DEVSHELL:-}" ]]; then
  exec nix develop "$ROOT" -c "$ROOT/pipeline/build.sh" "$@"
fi
cd "$ROOT/pipeline"
if [[ ! -f "$ROOT/data/mainsurvey_sqldump.txt" ]]; then
  if [[ ! -f "$ROOT/colorsurvey.tar.gz" ]]; then
    echo "colorsurvey.tar.gz missing: download https://xkcd.com/color/colorsurvey.tar.gz into $ROOT" >&2
    exit 1
  fi
  echo "extracting mainsurvey_sqldump.txt from colorsurvey.tar.gz -> data/"
  mkdir -p "$ROOT/data"
  tar xzf "$ROOT/colorsurvey.tar.gz" -C "$ROOT/data" mainsurvey_sqldump.txt
fi
if [[ ! -d node_modules/meshoptimizer || package-lock.json -nt node_modules/.package-lock.json ]]; then
  npm ci --no-audit --no-fund
fi
step() { echo; echo "=== $* ==="; }
step "1/7 parse";      python3 parse.py
step "2/7 calibrate";  python3 calibrate.py
step "3/7 labels";     python3 labels.py
step "4/7 clean";      python3 clean.py
step "5/7 meshes";     python3 meshes.py
step "6/7 export";     python3 export.py
step "7/7 validate";   python3 validate.py
du -sh "$ROOT"/web/public/assets/*
