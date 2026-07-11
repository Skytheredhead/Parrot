#!/usr/bin/env bash
set -euo pipefail

version="130"
os="$(uname -s)"
arch="$(uname -m)"

case "${os}/${arch}" in
  Darwin/arm64)
    target="arm64-macos"
    checksum="79d3ab9f417d9e215f15f598f523d001a7d9ac1e59367e5c869fbdabd1cba72e"
    ;;
  Darwin/x86_64)
    target="x86_64-macos"
    checksum="d3e2d1235b70c93c54b52eabc1625ea960965152218754f1f4eeb0f873c48e03"
    ;;
  Linux/x86_64)
    target="x86_64-linux"
    checksum="0a18362361ad05465118cd8eeb72edaeec89de6894bc283576ef4e07aa3babcc"
    ;;
  Linux/aarch64 | Linux/arm64)
    target="aarch64-linux"
    checksum="e6ae6e09ac40f4e14bc5be6f687c58e2995c84170013975fa641809dd3b480a0"
    ;;
  *)
    echo "Unsupported Binaryen platform: ${os}/${arch}" >&2
    exit 1
    ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_dir="${root}/.tools/binaryen/version_${version}"
if [[ -x "${install_dir}/bin/wasm-opt" ]] \
  && [[ "$("${install_dir}/bin/wasm-opt" --version)" == *"version ${version}"* ]]; then
  echo "Verified existing Binaryen ${version} at .tools/binaryen/version_${version}"
  exit 0
fi

archive="$(mktemp "${TMPDIR:-/tmp}/binaryen-${version}.XXXXXX.tar.gz")"
extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/binaryen-${version}.XXXXXX")"
cleanup() {
  rm -f "${archive}"
  rm -rf "${extract_dir}"
}
trap cleanup EXIT

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${archive}" \
  "https://github.com/WebAssembly/binaryen/releases/download/version_${version}/binaryen-version_${version}-${target}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${archive}" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "${archive}" | awk '{print $1}')"
fi
if [[ "${actual}" != "${checksum}" ]]; then
  echo "Binaryen checksum mismatch" >&2
  exit 1
fi

tar -xzf "${archive}" -C "${extract_dir}"
mkdir -p "$(dirname "${install_dir}")"
rm -rf "${install_dir}"
mv "${extract_dir}/binaryen-version_${version}" "${install_dir}"
"${install_dir}/bin/wasm-opt" --version

echo "Installed verified Binaryen ${version} at .tools/binaryen/version_${version}"
