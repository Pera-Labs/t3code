#!/usr/bin/env bash
# Bring upstream (pingdotgg/t3code) into this fork.
#
# Branch model
#   main    pristine mirror of upstream/main, fast-forward only, never commit here
#   vision  integration branch: main + fork commits; upstream lands via merge
#
# Usage: scripts/fork/sync-upstream.sh [--check] [--push]
#   --check  run `vp i` and `vp run check:changed` after the merge; abort on failure
#   --push   push main and the integration branch to origin when everything passed
#
# Exit codes: 0 ok / already current, 2 merge conflict (merge aborted, tree clean),
#             3 checks failed (merge kept locally, nothing pushed), 64 bad usage,
#             65 dirty working tree.
#
# Environment overrides: UPSTREAM_REMOTE, UPSTREAM_URL, MIRROR_BRANCH, INTEGRATION_BRANCH.
set -euo pipefail

UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}
MIRROR_BRANCH=${MIRROR_BRANCH:-main}
INTEGRATION_BRANCH=${INTEGRATION_BRANCH:-vision}
CHECK=0
PUSH=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 64 ;;
  esac
done

root=$(git rev-parse --show-toplevel)
cd "$root"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "working tree is dirty; commit or stash first" >&2
  exit 65
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  git remote set-url --push "$UPSTREAM_REMOTE" DISABLED
fi

git fetch --quiet "$UPSTREAM_REMOTE" "$MIRROR_BRANCH"
git fetch --quiet origin

start_branch=$(git rev-parse --abbrev-ref HEAD)

# 1. Mirror branch: fast-forward only. A non-ff here means someone committed to main; stop.
git checkout --quiet "$MIRROR_BRANCH"
git merge --ff-only --quiet "$UPSTREAM_REMOTE/$MIRROR_BRANCH"
upstream_sha=$(git rev-parse --short "$MIRROR_BRANCH")

# 2. Integration branch: merge the mirror in.
git checkout --quiet "$INTEGRATION_BRANCH"
if git merge-base --is-ancestor "$MIRROR_BRANCH" "$INTEGRATION_BRANCH"; then
  echo "$INTEGRATION_BRANCH already contains upstream $upstream_sha"
  [ "$PUSH" = 1 ] && git push --quiet origin "$MIRROR_BRANCH"
  git checkout --quiet "$start_branch"
  exit 0
fi

if ! git merge --no-edit -m "chore(fork): merge upstream/main $upstream_sha" "$MIRROR_BRANCH"; then
  conflicts=$(git diff --name-only --diff-filter=U)
  if [ "$conflicts" = "pnpm-lock.yaml" ]; then
    # Lockfile-only conflict: take upstream's lockfile and let the package manager
    # re-add the fork's own workspace packages.
    echo "lockfile-only conflict; regenerating pnpm-lock.yaml"
    git checkout --theirs pnpm-lock.yaml
    vp i --no-frozen-lockfile
    git add pnpm-lock.yaml
    git commit --quiet --no-edit
  else
    echo "merge conflict with upstream $upstream_sha in:" >&2
    echo "$conflicts" >&2
    git merge --abort
    git checkout --quiet "$start_branch"
    exit 2
  fi
fi

if [ "$CHECK" = 1 ]; then
  if ! (vp i --frozen-lockfile && vp run check:changed); then
    echo "checks failed after merging upstream $upstream_sha; merge kept on $INTEGRATION_BRANCH, nothing pushed" >&2
    exit 3
  fi
fi

if [ "$PUSH" = 1 ]; then
  git push --quiet origin "$MIRROR_BRANCH" "$INTEGRATION_BRANCH"
  echo "pushed $MIRROR_BRANCH and $INTEGRATION_BRANCH (upstream $upstream_sha)"
else
  echo "merged upstream $upstream_sha into $INTEGRATION_BRANCH locally; rerun with --push to publish"
fi
