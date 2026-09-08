/*
 * The alarm DESCRIPTION is the only prose we control in a CloudWatch email —
 * it appears near the top, above the metric dump. Lambda is denied on this
 * account, so reformatting the mail itself is not an option; making that one
 * line carry the whole answer is.
 *
 * Each says WHAT broke, WHAT it costs, and WHAT to do — and reads sensibly in
 * a recovery mail too, since the owner keeps OK notifications. "the service is
 * down" is a poor sentence to receive under the heading "entered the OK state".
 */
import { execFileSync } from 'node:child_process';

const CONSOLE = 'https://us-east-2.console.aws.amazon.com/ecs/v2/clusters/crm-prod/services';

const DESCRIPTIONS = {
  'crm-prod-directus-stopped':
    'PRODUCTION API IS DOWN. Directus serves every portal and the customer chat, so staff cannot sign in and no message is stored. ALARM = down now; OK = it came back on its own. Check the service: ' +
    CONSOLE,
  'crm-prod-socket-gateway-stopped':
    'PRODUCTION CHAT IS DOWN. The socket gateway carries live messages, so customers can open the chat but nothing sends or arrives. ALARM = down now; OK = recovered. Check the service: ' +
    CONSOLE,
  'crm-prod-workers-stopped':
    'PRODUCTION BACKGROUND JOBS STOPPED. No SLA timers, no notifications, no coupon delivery — the app looks healthy while nothing scheduled runs. ALARM = stopped now; OK = recovered. Check the service: ' +
    CONSOLE,
  'crm-prod-ai-gateway-stopped':
    'PRODUCTION AI FEATURES ARE DOWN. Reply suggestions, summaries and intent detection stop; chat and tickets keep working. ALARM = down now; OK = recovered. Check the service: ' +
    CONSOLE,
  'crm-prod-directus-cpu-high':
    'PRODUCTION API IS STRAINED. Directus CPU has been above 85% for 15 minutes, so the portals will feel slow and requests may time out. Usually means it needs a larger task. ALARM = strained now; OK = settled. ' +
    CONSOLE,
  'crm-prod-directus-memory-high':
    'PRODUCTION API IS NEAR ITS MEMORY LIMIT. Above 85% for 15 minutes; when it tops out the container is killed and restarted, which reads as random crashes to staff. ALARM = near the limit; OK = settled. ' +
    CONSOLE,
  'crm-prod-log-volume-high':
    'PRODUCTION LOGGING IS RUNNING HOT — above a 25GB/month pace. Almost always a loop writing the same error thousands of times; it reaches the bill before anyone notices. Check CloudWatch Logs for a repeating message.',
};

const apply = process.argv.includes('--apply');
for (const [name, description] of Object.entries(DESCRIPTIONS)) {
  const out = JSON.parse(
    execFileSync(
      'aws',
      [
        'cloudwatch',
        'describe-alarms',
        '--alarm-names',
        name,
        '--region',
        'us-east-2',
        '--output',
        'json',
      ],
      { encoding: 'utf8' },
    ),
  );
  const a = out.MetricAlarms[0];
  if (!a) {
    console.log(`${name}: NOT FOUND`);
    continue;
  }
  console.log(`${name}\n   ${description.slice(0, 100)}…`);
  if (!apply) continue;
  // put-metric-alarm REPLACES the alarm, so every field must be resent or it
  // is silently dropped — thresholds, actions and all.
  const args = [
    'cloudwatch',
    'put-metric-alarm',
    '--region',
    'us-east-2',
    '--alarm-name',
    a.AlarmName,
    '--alarm-description',
    description,
    '--metric-name',
    a.MetricName,
    '--namespace',
    a.Namespace,
    '--statistic',
    a.Statistic,
    '--period',
    String(a.Period),
    '--evaluation-periods',
    String(a.EvaluationPeriods),
    '--threshold',
    String(a.Threshold),
    '--comparison-operator',
    a.ComparisonOperator,
    '--treat-missing-data',
    a.TreatMissingData,
  ];
  if (a.Dimensions?.length) {
    args.push('--dimensions', ...a.Dimensions.map((d) => `Name=${d.Name},Value=${d.Value}`));
  }
  if (a.AlarmActions?.length) args.push('--alarm-actions', ...a.AlarmActions);
  if (a.OKActions?.length) args.push('--ok-actions', ...a.OKActions);
  execFileSync('aws', args, { encoding: 'utf8' });
  console.log('   updated');
}
console.log(apply ? '\nDone.' : '\nDRY RUN — re-run with --apply.');
