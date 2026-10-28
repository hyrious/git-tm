#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

case "${1:-}" in
  --remove|--uninstall|-r)
    npm uninstall -g "$(node -p "require('./package.json').name")"
    exit
    ;;
  '') ;;
  *)
    echo "Usage: $0 [--remove|--uninstall|-r]" >&2
    exit 1
    ;;
esac

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT

package=$(npm pack --silent --pack-destination "$temp_dir")
npm install -g "$temp_dir/$package"
