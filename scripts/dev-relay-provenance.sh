#!/usr/bin/env bash
#
# Resolve the local development signing provenance used by `make desktop-dev`
# and `make desktop-build-dev`.
#
# The expected Apple Development certificate CN embeds a personal Apple ID, and
# its Team ID (the certificate subject's OU) is account specific, so neither
# value may live in the published source tree. The Rust dev-relay module reads
# both with `option_env!` and fails closed when either is missing, which means
# every development build has to pass both through.
#
# Usage: bash scripts/dev-relay-provenance.sh [MODE]
#
#   --check      (default) resolve and validate the identity, report to stderr
#   --cn         print the certificate common name and nothing else
#   --identity   print the SHA-1 fingerprint to pass to `codesign --sign`
#   --team-id    print the certificate team ID (subject OU) and nothing else
#   -h, --help   print this help
#
# Environment:
#   METERM_DEV_SIGNER_CN  Signing identity to use. Defaults to the first
#                         `Apple Development:` identity in the keychain.
#   METERM_DEV_TEAM_ID    Expectation to check. When set it must equal the team
#                         ID carried by the resolved certificate.
#
# The certificate is read from the default keychain search list. Both the
# LibreSSL `/usr/bin/openssl` and Homebrew's OpenSSL print a subject this
# parser understands. `--cn` and `--team-id` write only the requested value to
# stdout so callers can capture it directly.

set -eu

usage() {
    sed -n '2,/^$/p' "$0" | sed -e 's/^#\{1,\} \{0,1\}//'
}

die() {
    printf 'dev-relay-provenance: %s\n' "$*" >&2
    exit 1
}

mode=check
while [ "$#" -gt 0 ]; do
    case "$1" in
        --check) mode=check ;;
        --cn) mode=cn ;;
        --identity) mode=identity ;;
        --team-id) mode=team-id ;;
        -h|--help) usage; exit 0 ;;
        *) die "unsupported argument: $1 (try --help)" ;;
    esac
    shift
done

command -v security >/dev/null 2>&1 || die "the macOS 'security' tool is not available in PATH"
command -v openssl >/dev/null 2>&1 || die "openssl is not available in PATH"

identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
[ -n "$identities" ] \
    || die "the keychain reported no code-signing identities; unlock the login keychain and retry"

detected_cn="$(printf '%s\n' "$identities" | awk -F'"' '/Apple Development:/ { print $2; exit }')"
if [ -n "${METERM_DEV_SIGNER_CN:-}" ]; then
    cn="$METERM_DEV_SIGNER_CN"
else
    cn="$detected_cn"
fi
[ -n "$cn" ] \
    || die "no 'Apple Development' signing identity found; create one in Xcode, or set METERM_DEV_SIGNER_CN"

case "$cn" in
    "Apple Development:"*) ;;
    *) die "METERM_DEV_SIGNER_CN must name an 'Apple Development:' certificate, got: $cn" ;;
esac

# The identity has to be usable for code signing, not merely present in the
# keychain, so require it to appear in the policy-filtered identity list. The
# fingerprint that list reports is what `codesign --sign` accepts, and using it
# keeps the signing step on the exact certificate resolved here.
identity="$(printf '%s\n' "$identities" | awk -v cn="$cn" 'index($0, "\"" cn "\"") { print tolower($2); exit }')"
[ -n "$identity" ] \
    || die "the keychain holds no usable code-signing identity for: $cn"

pem="$(security find-certificate -c "$cn" -p 2>/dev/null || true)"
if [ -z "$pem" ]; then
    # Fall back to selecting the PEM block by the identity's SHA-1 fingerprint,
    # which avoids depending on how 'security -c' matches the common name.
    pem="$(security find-certificate -a -Z -p 2>/dev/null | awk -v want="$identity" '
        $1 == "SHA-1" && $2 == "hash:" { grab = (tolower($3) == want); next }
        /^-----BEGIN CERTIFICATE-----/ { inside = 1 }
        inside && grab { print }
        /^-----END CERTIFICATE-----/ { inside = 0; if (grab) { exit } }
    ' || true)"
fi
[ -n "$pem" ] || die "could not read the code-signing certificate for: $cn"

# The subject of an Apple Development certificate carries the Team ID as its OU.
team_id="$(printf '%s\n' "$pem" \
    | openssl x509 -noout -subject 2>/dev/null \
    | tr '/,' '\n\n' \
    | sed -n 's/^[[:space:]]*OU[[:space:]]*=[[:space:]]*//p' \
    | head -n 1 \
    | tr -d '[:space:]')"

case "$team_id" in
    [0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]) ;;
    *) die "certificate team ID (subject OU) is not a 10-character Apple team identifier: '$team_id'" ;;
esac

if [ -n "${METERM_DEV_TEAM_ID:-}" ] && [ "$METERM_DEV_TEAM_ID" != "$team_id" ]; then
    die "METERM_DEV_TEAM_ID=$METERM_DEV_TEAM_ID does not match the certificate team ID $team_id"
fi

case "$mode" in
    cn) printf '%s\n' "$cn" ;;
    identity) printf '%s\n' "$identity" ;;
    team-id) printf '%s\n' "$team_id" ;;
    check)
        printf 'dev-relay-provenance: resolved\n' >&2
        printf '  signer CN: %s\n' "$cn" >&2
        printf '  team ID:   %s\n' "$team_id" >&2
        printf '  identity:  %s\n' "$identity" >&2
        ;;
esac
