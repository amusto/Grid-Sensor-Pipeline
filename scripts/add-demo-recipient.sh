#!/usr/bin/env bash
#
# add-demo-recipient.sh — subscribe an email address to the alert SNS
# topic at runtime, without touching CDK.
#
# Use this when a demo viewer (colleague, interviewer, reviewer)
# should start receiving alert emails. SNS topics accept new
# subscriptions any time; CDK manages the topic, not the subscription
# list. The default subscriber comes from CDK context (`alertEmail`);
# this script adds additional ad-hoc subscribers without a redeploy.
#
# Usage:
#   ./scripts/add-demo-recipient.sh <email-address>
#
# Optional environment overrides:
#   ALERT_TOPIC_ARN=arn:...   # explicit topic ARN, skips CFN lookup
#   AWS_REGION=us-east-1      # region (default: us-east-1)
#   CFN_STACK_NAME=AlertWorkflowStack  # stack to read the output from
#
# Caveat: subscriptions added by this script aren't tracked in
# CloudFormation. They're torn down by `cdk destroy --all` and must be
# re-added after the next deploy.

set -euo pipefail

EMAIL="${1:-}"
REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${CFN_STACK_NAME:-GridSensorAlertWorkflowStack}"

if [ -z "$EMAIL" ]; then
  cat <<USAGE
Usage: $0 <email-address>

Subscribes the given email address to the alert SNS topic so the
recipient receives every alert published by the pipeline.

The recipient must click the AWS-sent confirmation link before
delivery begins (one-time per (topic, address) pair).

Examples:
  $0 demo-viewer@example.com
  ALERT_TOPIC_ARN=arn:aws:sns:us-east-1:123:gsp-alerts $0 viewer@example.com
USAGE
  exit 1
fi

# Loose validation that EMAIL looks like an email address.
if ! printf '%s' "$EMAIL" | grep -qE '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
  echo "Error: '$EMAIL' does not look like an email address." >&2
  exit 1
fi

# Resolve the topic ARN. Three lookup paths in order:
#   1. ALERT_TOPIC_ARN env var (explicit override)
#   2. CloudFormation stack output (AlertTopicArn export)
#   3. SNS list-topics name-grep fallback (resilient if CFN renamed)
if [ -z "${ALERT_TOPIC_ARN:-}" ]; then
  echo "Looking up alert topic ARN from CloudFormation (stack: $STACK_NAME)..."

  RESOLVED_ARN=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`AlertTopicArn`].OutputValue' \
    --output text 2>/dev/null || echo "")

  if [ -z "$RESOLVED_ARN" ] || [ "$RESOLVED_ARN" = "None" ]; then
    echo "(no AlertTopicArn output found; falling back to SNS list-topics name-grep)"
    RESOLVED_ARN=$(aws sns list-topics --region "$REGION" \
      --query "Topics[?contains(TopicArn, 'grid-sensor') && contains(TopicArn, 'alert')].TopicArn" \
      --output text | head -n 1)
  fi

  if [ -z "$RESOLVED_ARN" ]; then
    cat <<ERR >&2
Error: Could not resolve the alert topic ARN.

Either:
  - Deploy the alert-workflow stack first, OR
  - Set ALERT_TOPIC_ARN explicitly:
      ALERT_TOPIC_ARN=arn:... $0 $EMAIL
ERR
    exit 1
  fi

  ALERT_TOPIC_ARN="$RESOLVED_ARN"
fi

echo
echo "Topic:       $ALERT_TOPIC_ARN"
echo "Subscribing: $EMAIL"
echo

SUBSCRIPTION_ARN=$(aws sns subscribe \
  --topic-arn "$ALERT_TOPIC_ARN" \
  --protocol email \
  --notification-endpoint "$EMAIL" \
  --region "$REGION" \
  --query 'SubscriptionArn' \
  --output text)

cat <<DONE

Subscription request sent.

  Subscription ARN: $SUBSCRIPTION_ARN

Next step (for the recipient):
  1. Open the inbox at $EMAIL.
  2. Look for an email from AWS Notifications titled
     "AWS Notification - Subscription Confirmation".
  3. Click the "Confirm subscription" link in the body.
  4. From that point, every alert published to the topic will land
     in this inbox.

To unsubscribe later:
  aws sns unsubscribe --subscription-arn '$SUBSCRIPTION_ARN' --region $REGION

Note: ad-hoc subscriptions added by this script are NOT tracked in
CloudFormation. They are torn down by 'cdk destroy --all' and must
be re-added after the next deploy.
DONE
