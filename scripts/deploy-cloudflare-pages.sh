#!/bin/sh
set -eu

project_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
project_name="${CLOUDFLARE_PAGES_PROJECT:-crypto-funding-arbitrage}"
stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/funding-pages.XXXXXX")"

cleanup() {
  rm -rf -- "$stage_dir"
}
trap cleanup EXIT INT TERM

cp "$project_root/index.html" "$stage_dir/"
for asset_dir in assets css data js functions; do
  cp -R "$project_root/$asset_dir" "$stage_dir/"
done

cd "$project_root"
npx -y wrangler@4.113.0 pages deploy "$stage_dir" \
  --project-name "$project_name" \
  --branch main \
  --commit-dirty=true
