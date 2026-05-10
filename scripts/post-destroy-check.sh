#!/usr/bin/env bash
#
# post-destroy-check.sh — verify resources known to orphan after destroy
#
# Some AWS resources (notably Kinesis streams referenced by Firehose +
# Lambda ESM consumers) can survive `cdk destroy` even when CFN reports
# stack-deletion success. See:
#   docs/decisions/phase-03-storage-processing.md
#   "Deploy lesson #4 — CFN destroy silently leaks Kinesis streams
#    (recurring class of failure)"
#
# This script polls each known orphan candidate after a destroy and
# fails loudly if any survived, with the cleanup recipe inline so the
# next deploy isn't surprised the next morning.
#
# Wired into `npm run destroy` — runs automatically. Can also be run
# standalone any time you want to confirm a clean slate.
#
# Exit codes:
#   0 — all checked resources are gone (clean state)
#   1 — at least one orphan detected; cleanup recipe printed inline.

set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
STREAM_NAME="grid-sensor-pipeline-telemetry"

EXIT=0

heading() {
  printf '\n=== %s ===\n\n' "$1"
}

check_kinesis_orphan() {
  local stream="$1"
  local out
  if out=$(aws kinesis describe-stream-summary \
        --stream-name "$stream" \
        --region "$REGION" \
        --query 'StreamDescriptionSummary.{Name:StreamName,Status:StreamStatus}' \
        --output text 2>&1)
  then
    cat <<EOF
🛑 Kinesis stream '$stream' STILL EXISTS in $REGION.
   Status: $out

   This is the documented recurring CFN orphan. See
   docs/decisions/phase-03-storage-processing.md
   "Deploy lesson #4 — CFN destroy silently leaks Kinesis streams."

   Cleanup:
     aws kinesis delete-stream \\
       --stream-name $stream \\
       --enforce-consumer-deletion \\
       --region $REGION

   Wait for delete to complete:
     until aws kinesis describe-stream-summary \\
       --stream-name $stream --region $REGION 2>&1 \\
       | grep -q ResourceNotFoundException
     do sleep 2; done && echo "✅ stream gone"

   Then re-run:  npm run deploy
EOF
    EXIT=1
  else
    echo "✅ Kinesis stream '$stream' is gone (verified $REGION)."
  fi
}

heading "post-destroy verification (region: $REGION)"

check_kinesis_orphan "$STREAM_NAME"

echo
if [ $EXIT -eq 0 ]; then
  echo "All checked resources are gone. Safe to bootstrap a new deploy."
else
  echo "Orphan(s) detected. Run the cleanup recipe(s) above before the next deploy."
fi

exit $EXIT
