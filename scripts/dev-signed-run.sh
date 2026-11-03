#!/usr/bin/env bash
#
# Cargo target runner used by `make desktop-dev`.
#
# `tauri dev` launches the app through `cargo run`, and every rebuild links a
# new debug executable. Unsigned (linker ad-hoc signed) executables are known
# to the Keychain only by their cdhash, which changes with each build, so every
# rebuild asks for the login password again before a saved SSH credential can
# be read. Re-signing the executable with the local Apple Development
# certificate right before it starts gives it a stable designated requirement
# (identifier + certificate), so one "Always Allow" keeps working.
#
# Usage (set by the Makefile via CARGO_TARGET_<TRIPLE>_RUNNER):
#   dev-signed-run.sh <executable> [args...]
#
# Environment:
#   METERM_DEV_SIGN_IDENTITY  SHA-1 of the identity for `codesign --sign`.
#                             When empty the executable just runs unsigned.
#   METERM_DEV_BUNDLE_ID      Code-signing identifier (default com.meterm.dev).

set -u

bin="${1:?usage: dev-signed-run.sh <executable> [args...]}"
identity="${METERM_DEV_SIGN_IDENTITY:-}"

# Skip re-signing when the executable has not been rebuilt since the last
# successful signature (the stamp is newer than the binary), so a plain
# restart costs nothing; only an actual relink pays the ~0.2s codesign.
stamp="$bin.devsigned"
if [ -n "$identity" ] && [ -f "$stamp" ] && [ ! "$bin" -nt "$stamp" ] \
    && [ "$(cat "$stamp" 2>/dev/null)" = "$identity" ]; then
    identity=""
fi

if [ -n "$identity" ]; then
    if codesign --force --timestamp=none \
        --sign "$identity" \
        --identifier "${METERM_DEV_BUNDLE_ID:-com.meterm.dev}" \
        "$bin" >/dev/null 2>&1; then
        printf '%s' "$identity" > "$stamp" 2>/dev/null || true
        echo "dev-signed-run: signed $(basename "$bin") with the Apple Development identity" >&2
    else
        # Never block development on signing; the only cost is a Keychain prompt.
        echo "dev-signed-run: codesign failed; the Keychain may ask for the password again" >&2
    fi
fi

exec "$@"
