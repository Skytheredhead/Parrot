#!/usr/bin/env bash
set -euo pipefail

version="2.6.1"
release="https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}"
os="$(uname -s)"
arch="$(uname -m)"

case "${os}/${arch}" in
  Darwin/arm64)
    target="aarch64-apple-darwin"
    checksum="4736035e991bba6f416c99c08d02e5985534bf238732ea8464f199050e694f9f"
    ;;
  Darwin/x86_64)
    target="x86_64-apple-darwin"
    checksum="8d58ccc6762822710ce047dbf0d9d29ada95e5d70f300b1b6ee7cae09183b558"
    ;;
  Linux/x86_64)
    target="x86_64-unknown-linux-gnu"
    checksum="cb03bb4706dc6bd6ef080c9bbd220a6e7d10430a65e7be2ba6be27ec7e3a9118"
    ;;
  Linux/aarch64 | Linux/arm64)
    target="aarch64-unknown-linux-gnu"
    checksum="09db3428fb12fb8cf9cbb03cc5398c4a8d0234484b1dc88f10591199462068fd"
    ;;
  *)
    echo "Unsupported SpacetimeDB CLI platform: ${os}/${arch}" >&2
    exit 1
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${root}/.tools/spacetime/${version}"
if [[ -x "${install_dir}/spacetimedb-cli" && -x "${install_dir}/spacetimedb-standalone" ]] \
  && [[ "$("${install_dir}/spacetimedb-cli" --version)" == *"tool version ${version}"* ]]; then
  mkdir -p "${root}/.tools/spacetime"
  ln -sfn "${install_dir}/spacetimedb-cli" "${root}/.tools/spacetime/spacetime"
  ln -sfn "${install_dir}/spacetimedb-standalone" "${root}/.tools/spacetime/spacetimedb-standalone"
  echo "Verified existing SpacetimeDB CLI ${version} at .tools/spacetime/spacetime"
  exit 0
fi
archive="$(mktemp "${TMPDIR:-/tmp}/spacetime-${version}.XXXXXX.tar.gz")"
cleanup() { rm -f "${archive}"; }
trap cleanup EXIT

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${archive}" \
  "${release}/spacetime-${target}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${archive}" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "${archive}" | awk '{print $1}')"
fi
if [[ "${actual}" != "${checksum}" ]]; then
  echo "SpacetimeDB CLI checksum mismatch" >&2
  exit 1
fi

mkdir -p "${install_dir}"
tar -xzf "${archive}" -C "${install_dir}"
chmod 0755 "${install_dir}/spacetimedb-cli" "${install_dir}/spacetimedb-standalone"
ln -sfn "${install_dir}/spacetimedb-cli" "${root}/.tools/spacetime/spacetime"
ln -sfn "${install_dir}/spacetimedb-standalone" "${root}/.tools/spacetime/spacetimedb-standalone"

reported="$(${root}/.tools/spacetime/spacetime --version)"
if [[ "${reported}" != *"2.6.1"* ]]; then
  echo "Installed CLI did not report SpacetimeDB 2.6.1" >&2
  exit 1
fi

echo "Installed verified SpacetimeDB CLI ${version} at .tools/spacetime/spacetime"
