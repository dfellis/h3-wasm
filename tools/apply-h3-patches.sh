#!/bin/sh
# Apply the committed H3 performance patch to the gitignored ./h3/
# working copy, idempotently.
#
# The build consumes ./h3/ (H3 v4.5.0) in place, but the working copy is
# ephemeral: CI re-extracts the v4.5.0 tarball on every run and a local
# checkout can be re-cloned, re-extracted, or `git checkout`-reset at any
# time. The optimizations therefore live in patches/ and this script
# re-applies them after any such reset. It converges from pristine,
# partially patched, and fully patched states; it is a no-op when the
# patch is already applied.
#
# NOTE: when the patch is extended with new hunks, add a marker string for
# each newly touched file to the fast-path check below.
#
# Exit codes: 0 = h3/ is patched (or was already), 1 = failure.
set -eu

cd "$(dirname "$0")/.."

PATCH=patches/h3-v4.5.0-optimizations.patch
COORDIJK=h3/src/h3lib/include/coordijk.h
FACEIJK=h3/src/h3lib/lib/faceijk.c
AREAC=h3/src/h3lib/lib/area.c

if [ ! -f "$COORDIJK" ] || [ ! -f "$FACEIJK" ] || [ ! -f "$AREAC" ]; then
    echo "error: $COORDIJK / $FACEIJK / $AREAC not found." >&2
    echo "       Extract H3 v4.5.0 into ./h3/ first (see README)." >&2
    exit 1
fi

# Fast path: already fully applied? Marker strings introduced by the patch,
# one per file it touches.
if grep -q '_roundDiv7' "$COORDIJK" && grep -q 'faceTangentNorth' "$FACEIJK" &&
    grep -q 'cur_sin' "$AREAC"; then
    exit 0
fi

# Pristine or partially applied: -N applies the missing hunks and silently
# skips the already-applied ones without prompting. Exit 0 = everything was
# missing (pristine); exit 1 = some hunks already applied; exit 2 = a hunk
# failed (corrupted or foreign state).
rc=0
patch -p1 -N < "$PATCH" || rc=$?
if [ "$rc" -gt 1 ]; then
    echo "error: failed to apply $PATCH (state of ./h3/ is neither pristine" >&2
    echo "       nor patched). Remove ./h3/ and extract H3 v4.5.0 again" >&2
    echo "       (see README), then re-run make." >&2
    exit 1
fi

# Convergence check: every marker must be present after the apply.
if ! grep -q '_roundDiv7' "$COORDIJK" || ! grep -q 'faceTangentNorth' "$FACEIJK" ||
    ! grep -q 'cur_sin' "$AREAC"; then
    echo "error: $PATCH did not fully apply to ./h3/ (partial state)." >&2
    echo "       Remove ./h3/ and extract H3 v4.5.0 again (see README)," >&2
    echo "       then re-run make." >&2
    exit 1
fi

# Clean up rejects/origs from skipped hunks (partial-state re-apply).
rm -f "$COORDIJK.rej" "$FACEIJK.rej" "$AREAC.rej" \
      "$COORDIJK.orig" "$FACEIJK.orig" "$AREAC.orig"
