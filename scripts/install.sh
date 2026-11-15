#!/usr/bin/env bash
set -euo pipefail
umask 077
platform=$(uname -s)
case "$platform" in
  Linux) platform=linux; install_home="${QQ_AGENT_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/qq-agent-bot}" ;;
  Darwin) platform=darwin; install_home="${QQ_AGENT_HOME:-$HOME/Library/Application Support/QQAgentBot}" ;;
  *) echo 'Only Linux and macOS are supported by this installer' >&2; exit 1 ;;
esac
version=latest; package=; node_path=; skip_setup=0; no_path=0; offline=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home) install_home="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --package) package="$2"; shift 2 ;;
    --node) node_path="$2"; shift 2 ;;
    --skip-setup) skip_setup=1; shift ;;
    --no-path) no_path=1; shift ;;
    --offline) offline=1; shift ;;
    --help) echo 'install.sh [--home DIR] [--version vX.Y.Z] [--package FILE.tgz] [--node PATH] [--skip-setup] [--no-path] [--offline]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$install_home" in /*) ;; *) echo '--home must be absolute' >&2; exit 1 ;; esac
mkdir -p "$install_home"
node_path="${node_path:-$(command -v node || true)}"
if [ -z "$node_path" ] || ! "$node_path" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  [ "$offline" = 0 ] || { echo 'Offline installation requires Node.js 24+' >&2; exit 1; }
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo 'Unsupported CPU architecture' >&2; exit 1 ;; esac
  mkdir -p "$install_home/runtime"
  runtime=$(mktemp -d "$install_home/runtime/node.XXXXXX")
  echo 'Downloading private Node.js runtime...'
  curl -fL --retry 2 "https://nodejs.org/dist/v24.15.0/node-v24.15.0-$platform-$arch.tar.gz" -o "$runtime/node.tar.gz"
  tar -xzf "$runtime/node.tar.gz" -C "$runtime"
  node_path="$runtime/node-v24.15.0-$platform-$arch/bin/node"
fi
export PATH="$(dirname "$node_path"):$PATH"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-./install.sh}")" && pwd)
helper="$script_dir/npm-install.mjs"
if [ ! -f "$helper" ]; then
  [ "$offline" = 0 ] || { echo 'Offline installation requires npm-install.mjs next to install.sh' >&2; exit 1; }
  helper="$install_home/npm-bootstrap-$$.mjs"
  if [ "$version" = latest ]; then
    url=https://github.com/wllevy/qq-agent-bot/releases/latest/download/npm-install.mjs
  else
    [[ "$version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version' >&2; exit 1; }
    url="https://github.com/wllevy/qq-agent-bot/releases/download/v${version#v}/npm-install.mjs"
  fi
  curl -fL --retry 2 "$url" -o "$helper"
fi
args=("$helper" --home "$install_home" --version "$version")
[ -z "$package" ] || args+=(--package "$package")
[ "$skip_setup" = 0 ] || args+=(--skip-setup)
[ "$no_path" = 0 ] || args+=(--no-path)
[ "$offline" = 0 ] || args+=(--offline)
"$node_path" "${args[@]}"
