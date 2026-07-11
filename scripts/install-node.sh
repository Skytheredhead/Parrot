#!/usr/bin/env bash
set -euo pipefail

version="24.18.0"
os="$(uname -s)"
arch="$(uname -m)"

case "${os}/${arch}" in
  Darwin/arm64)
    target="darwin-arm64"
    extension="tar.gz"
    checksum="e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1"
    ;;
  Darwin/x86_64)
    target="darwin-x64"
    extension="tar.gz"
    checksum="dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080"
    ;;
  Linux/x86_64)
    target="linux-x64"
    extension="tar.xz"
    checksum="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"
    ;;
  Linux/aarch64 | Linux/arm64)
    target="linux-arm64"
    extension="tar.xz"
    checksum="58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"
    ;;
  *)
    echo "Unsupported Node.js platform: ${os}/${arch}" >&2
    exit 1
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${root}/.tools/node/${version}"
if [[ -x "${install_dir}/bin/node" ]] \
  && [[ "$("${install_dir}/bin/node" --version)" == "v${version}" ]]; then
  ln -sfn "${install_dir}" "${root}/.tools/node/current"
  echo "Verified existing Node.js ${version} at .tools/node/current"
  exit 0
fi

archive="$(mktemp "${TMPDIR:-/tmp}/node-${version}.XXXXXX.${extension}")"
extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/node-${version}.XXXXXX")"
cleanup() {
  rm -f "${archive}"
  rm -rf "${extract_dir}"
}
trap cleanup EXIT

filename="node-v${version}-${target}.${extension}"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${archive}" \
  "https://nodejs.org/dist/v${version}/${filename}"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${archive}" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "${archive}" | awk '{print $1}')"
fi
if [[ "${actual}" != "${checksum}" ]]; then
  echo "Node.js checksum mismatch" >&2
  exit 1
fi

tar -xf "${archive}" -C "${extract_dir}"
mkdir -p "$(dirname "${install_dir}")"
rm -rf "${install_dir}"
mv "${extract_dir}/node-v${version}-${target}" "${install_dir}"
ln -sfn "${install_dir}" "${root}/.tools/node/current"

"${install_dir}/bin/node" --version
echo "Installed verified Node.js ${version} at .tools/node/current"
