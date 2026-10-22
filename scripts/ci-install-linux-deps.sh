#!/usr/bin/env bash
set -euo pipefail

# CI-only source copies keep mirror recovery out of the runner's global config.
apt_source_root="${1:-/etc/apt}"
apt_temp_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/peer-ci-apt.XXXXXX")
trap 'rm -rf "$apt_temp_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$apt_temp_dir/sources.list.d"
touch "$apt_temp_dir/sources.list"
if [[ -f "$apt_source_root/sources.list" ]]; then
  cp "$apt_source_root/sources.list" "$apt_temp_dir/sources.list"
fi
for source_file in "$apt_source_root"/sources.list.d/*.list "$apt_source_root"/sources.list.d/*.sources; do
  [[ -f "$source_file" ]] || continue
  cp "$source_file" "$apt_temp_dir/sources.list.d/"
done
if [[ ! -s "$apt_temp_dir/sources.list" && -z "$(ls -A "$apt_temp_dir/sources.list.d")" ]]; then
  echo '::error::No APT sources found for Linux CI dependency installation.' >&2
  exit 1
fi

apt_options=(
  -o "Dir::Etc::sourcelist=$apt_temp_dir/sources.list"
  -o "Dir::Etc::sourceparts=$apt_temp_dir/sources.list.d"
  -o Acquire::http::Timeout=15
  -o Acquire::https::Timeout=15
  -o Acquire::Retries=0
  -o DPkg::Lock::Timeout=20
)

use_official_mirrors() {
  node --input-type=module - "$apt_temp_dir" <<'JS'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const parts = join(root, 'sources.list.d');
for (const file of [join(root, 'sources.list'), ...readdirSync(parts).map(name => join(parts, name))]) {
  const source = readFileSync(file, 'utf8');
  const rewritten = source
    .replace(/mirror\+file:\/etc\/apt\/apt-(security-)?mirrors\.txt/g,
      (_, security) => `https://${security ? 'security' : 'archive'}.ubuntu.com/ubuntu/`)
    .replace(/https?:\/\/(?:[\w-]+\.)?archive\.ubuntu\.com\/ubuntu\/?(?=\s|$)/gm,
      'https://archive.ubuntu.com/ubuntu/')
    .replace(/https?:\/\/security\.ubuntu\.com\/ubuntu\/?(?=\s|$)/gm,
      'https://security.ubuntu.com/ubuntu/');
  writeFileSync(file, rewritten);
}
JS
}

status=1
for attempt in 1 2 3; do
  echo "Linux dependencies: attempt $attempt/3"
  # Error-on-any rejects partial index refreshes; a stale cache is not success.
  if timeout --signal=TERM --kill-after=5s 90s sudo -n env DEBIAN_FRONTEND=noninteractive \
    apt-get "${apt_options[@]}" update --error-on=any; then
    if timeout --signal=TERM --kill-after=5s 120s sudo -n env DEBIAN_FRONTEND=noninteractive \
      apt-get "${apt_options[@]}" install -y libdbus-1-dev pkg-config xvfb libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64; then
      exit 0
    else
      status=$?
    fi
  else
    status=$?
  fi
  if [[ "$status" == 130 || "$status" == 143 ]]; then exit "$status"; fi
  if [[ "$attempt" == 3 ]]; then break; fi
  echo "::warning::Linux dependency attempt $attempt exited $status; retrying with official Ubuntu HTTPS mirrors."
  if [[ "$attempt" == 1 ]]; then use_official_mirrors; fi
  sleep "$((attempt * 2))"
done
echo "::error::Linux dependency installation failed after 3 attempts (exit $status)." >&2
exit "$status"
