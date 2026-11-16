#!/usr/bin/env sh
# install.sh — Install a prebuilt losql release binary for Linux or macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/DennisLoska/losql/master/install.sh | sh
#   ./install.sh [--version v0.2.0] [--bin-dir ~/.local/bin]

set -eu

REPO="${LOSQL_REPO:-DennisLoska/losql}"
BIN_DIR="${LOSQL_BIN_DIR:-$HOME/.local/bin}"
VERSION="${LOSQL_VERSION:-latest}"
BASE_URL="${LOSQL_RELEASE_BASE_URL:-https://github.com/$REPO/releases}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Downloads, verifies (SHA-256), and installs the prebuilt losql binary for your OS and CPU architecture.

Options:
  -v, --version <vX.Y.Z|latest>  Release version to install (default: latest)
  -b, --bin-dir <dir>            Installation directory (default: ~/.local/bin)
  -h, --help                     Show this help message and exit

Environment overrides:
  LOSQL_VERSION                  Same as --version
  LOSQL_BIN_DIR                  Same as --bin-dir
  LOSQL_REPO                     GitHub owner/repo (default: DennisLoska/losql)
  LOSQL_RELEASE_BASE_URL         Override releases base URL (for mirrors or offline tests)
EOF
}

say() {
  printf 'losql-install: %s\n' "$*"
}

err() {
  printf 'losql-install: error: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--version)
      [ $# -ge 2 ] || err "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    -b|--bin-dir)
      [ $# -ge 2 ] || err "--bin-dir requires a directory path"
      BIN_DIR="$2"
      shift 2
      ;;
    --bin-dir=*)
      BIN_DIR="${1#--bin-dir=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "unknown argument: $1 (run with --help for usage)"
      ;;
  esac
done

OS_RAW="$(uname -s 2>/dev/null || echo unknown)"
case "$OS_RAW" in
  Linux|linux) OS="linux" ;;
  Darwin|darwin) OS="darwin" ;;
  *) err "unsupported operating system: $OS_RAW (losql supports Linux and macOS)" ;;
esac

ARCH_RAW="$(uname -m 2>/dev/null || echo unknown)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) err "unsupported CPU architecture: $ARCH_RAW (losql supports x86_64 and arm64)" ;;
esac

TARGET="${OS}-${ARCH}"
ARCHIVE="losql-${TARGET}.tar.gz"

if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_BASE="${BASE_URL}/latest/download"
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
  DOWNLOAD_BASE="${BASE_URL}/download/${TAG}"
fi

fetch_file() {
  url="$1"
  dest="$2"
  case "$url" in
    file://*)
      local_path="${url#file://}"
      [ -f "$local_path" ] || err "local release asset not found: $local_path"
      cp "$local_path" "$dest"
      ;;
    *)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$dest" || err "failed to download $url"
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$dest" "$url" || err "failed to download $url"
      else
        err "neither curl nor wget is installed"
      fi
      ;;
  esac
}

compute_sha256() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
  else
    err "no SHA-256 tool found (expected sha256sum, shasum, or openssl)"
  fi
}

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t losql-install)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

ARCHIVE_PATH="${TMP_DIR}/${ARCHIVE}"
CHECKSUMS_PATH="${TMP_DIR}/SHA256SUMS.txt"

say "downloading ${ARCHIVE} from ${DOWNLOAD_BASE}..."
fetch_file "${DOWNLOAD_BASE}/${ARCHIVE}" "$ARCHIVE_PATH"
fetch_file "${DOWNLOAD_BASE}/SHA256SUMS.txt" "$CHECKSUMS_PATH"

EXPECTED_HASH="$(awk -v name="$ARCHIVE" '$2 == name || $2 == ("*" name) { print $1; exit }' "$CHECKSUMS_PATH")"
[ -n "$EXPECTED_HASH" ] || err "checksum for ${ARCHIVE} not found in SHA256SUMS.txt"

ACTUAL_HASH="$(compute_sha256 "$ARCHIVE_PATH")"
if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  err "SHA-256 checksum mismatch for ${ARCHIVE}: expected ${EXPECTED_HASH}, got ${ACTUAL_HASH}"
fi
say "verified SHA-256 checksum (${ACTUAL_HASH})"

tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR"
[ -f "${TMP_DIR}/losql" ] || err "extracted archive did not contain losql binary"

mkdir -p "$BIN_DIR"
DEST="${BIN_DIR}/losql"
cp "${TMP_DIR}/losql" "$DEST"
chmod 755 "$DEST"

INSTALLED_VERSION="$("$DEST" --version 2>/dev/null || echo "losql")"
say "installed ${INSTALLED_VERSION} to ${DEST}"

case ":${PATH:-}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    say "note: ${BIN_DIR} is not on your PATH. Add it with:"
    say "  export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac
