/*
 * The alarm DESCRIPTION is the only prose we control in a CloudWatch email -
 * it appears near the top, above the metric dump. Lambda is denied on this
 * account, so reformatting the mail itself is not an option; making that one
 * line carry the whole answer is.
 *
 * Each says WHAT broke, WHAT it costs, and WHAT to do - and reads sensibly in
 * a recovery mail too, since the owner keeps OK notifications. "the service is
 * down" is a poor sentence to receive under the heading "entered the OK state".
 *
 * ASCII ONLY, deliberately. These reached CloudWatch as Windows-1252 through
 * the CLI and arrived as a replacement glyph in the middle of a sentence: an
 * em-dash became a black diamond in the one line the reader is meant to trust.
 * Nothing warns you - the alarm is created, the API returns the mangled bytes
 * back, and only the email shows it. Use a hyphen.
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
    'PRODUCTION BACKGROUND JOBS STOPPED. No SLA timers, no notifications, no coupon delivery - the app looks healthy while nothing scheduled runs. ALARM = stopped now; OK = recovered. Check the service: ' +
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
    'PRODUCTION LOGGING IS RUNNING HOT - above a 25GB/month pace. Almost always a loop writing the same error thousands of times; it reaches the bill before anyone notices. Check CloudWatch Logs for a repeating message.',

  /*
   * RUNNING but not SERVING. The -stopped alarms above watch the task count,
   * which stays at 1 while a container answers nothing: it started, so ECS is
   * satisfied and will not replace it. That gap is where an outage hides, and
   * it is the exact shape of the staging AI gateway that ran for days on a
   * placeholder key while reporting healthy.
   */
  'crm-prod-directus-unhealthy':
    'PRODUCTION API IS RUNNING BUT NOT SERVING. Directus fails the load balancer health check, so portals and chat get errors even though the task did not crash - ECS will not replace it on its own. Usually a dependency it cannot reach (database, Redis). ALARM = failing now; OK = serving again. ' +
    CONSOLE,
  'crm-prod-socket-gateway-unhealthy':
    'PRODUCTION CHAT IS RUNNING BUT NOT SERVING. The socket gateway fails its health check, so messages stop moving while the task stays up and ECS leaves it alone. ALARM = failing now; OK = serving again. ' +
    CONSOLE,
  'crm-prod-socketio-unhealthy':
    'PRODUCTION LIVE CHAT TRANSPORT IS FAILING. The Socket.IO path fails its health check: customers can load the chat but messages will not arrive in real time. ALARM = failing now; OK = serving again. ' +
    CONSOLE,
  'crm-prod-ai-gateway-unhealthy':
    'PRODUCTION AI IS RUNNING BUT NOT SERVING. The AI gateway fails its health check; suggestions and summaries stop while chat and tickets keep working. ALARM = failing now; OK = serving again. ' +
    CONSOLE,
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
  // is silently dropped - thresholds, actions and all.
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
console.log(apply ? '\nDone.' : '\nDRY RUN - re-run with --apply.');
