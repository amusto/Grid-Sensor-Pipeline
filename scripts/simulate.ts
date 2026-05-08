#!/usr/bin/env node
/**
 * scripts/simulate.ts — invoke the simulator Lambda from the local machine.
 *
 * Usage:
 *   npx ts-node scripts/simulate.ts --count 50
 *   npx ts-node scripts/simulate.ts --count 10 --breach
 *   npx ts-node scripts/simulate.ts --count 5 --function my-other-fn
 *
 * Args:
 *   --count <N>        Number of records to publish (default: 1)
 *   --breach           Force out-of-range voltage/frequency values
 *   --function <name>  Override the simulator function name
 *                      (default: grid-sensor-pipeline-simulator)
 *   --region <region>  AWS region (default: $AWS_REGION or us-east-1)
 */

/* eslint-disable no-console -- this is a CLI tool, console is intentional */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const args = process.argv.slice(2);

const getArg = (name: string, fallback?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);

const count = Number(getArg('count', '1'));
const breach = hasFlag('breach');
const functionName = getArg('function', 'grid-sensor-pipeline-simulator')!;
const region = getArg('region', process.env.AWS_REGION ?? 'us-east-1')!;

if (!Number.isInteger(count) || count < 1) {
  console.error('--count must be a positive integer');
  process.exit(1);
}

const lambda = new LambdaClient({ region });

const main = async (): Promise<void> => {
  console.log(
    `Invoking ${functionName} (region=${region}, count=${count}, breach=${breach})`,
  );
  const start = Date.now();

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ count, breach })),
    }),
  );

  const elapsed = Date.now() - start;
  const payload = result.Payload
    ? new TextDecoder().decode(result.Payload)
    : '<no payload>';

  console.log(`Status: ${result.StatusCode}`);
  console.log(`Payload: ${payload}`);
  console.log(`Elapsed: ${elapsed}ms`);

  if (result.FunctionError) {
    console.error(`Function error: ${result.FunctionError}`);
    process.exit(1);
  }
};

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('Simulator invocation failed:', msg);
  process.exit(1);
});
