#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
signing_identity="${METERM_LOCAL_SIGNING_IDENTITY:-MeTerm Dev Local Signing}"
open_after_build=1

case "${1:-}" in
  '') ;;
  --no-open) open_after_build=0 ;;
  -h|--help)
    printf 'Usage: %s [--no-open]\n' "$(basename -- "$0")"
    printf 'Build and locally sign MeTerm Dev, then restart or open it by default.\n'
    exit 0
    ;;
  *)
    printf 'Unknown option: %s\n' "$1" >&2
    printf 'Usage: %s [--no-open]\n' "$(basename -- "$0")" >&2
    exit 2
    ;;
esac

printf 'Building MeTerm Dev with local signing identity: %s\n' "$signing_identity"
make -C "$script_dir" \
  METERM_LOCAL_SIGNING_IDENTITY="$signing_identity" \
  desktop-build-local

app_path="$script_dir/desktop/src-tauri/target/debug/bundle/macos/MeTerm Dev.app"
printf '\nBuild complete:\n%s\n' "$app_path"

if (( open_after_build )); then
  app_executable="$app_path/Contents/MacOS/meterm"
  if pgrep -f "$app_executable" >/dev/null 2>&1; then
    printf '\nRestarting MeTerm Dev...\n'
    osascript -e 'tell application id "com.meterm.dev" to quit' >/dev/null
    for _ in {1..50}; do
      if ! pgrep -f "$app_executable" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if pgrep -f "$app_executable" >/dev/null 2>&1; then
      printf 'MeTerm Dev did not exit cleanly; the new build was not opened.\n' >&2
      exit 1
    fi
  else
    printf '\nOpening MeTerm Dev...\n'
  fi
  open -n "$app_path"
fi
