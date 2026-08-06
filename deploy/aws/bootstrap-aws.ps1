# Provisions the AWS Directus with the CRM schema, roles, permissions and flows.
#
# Prompts for the RDS password so it is never written to disk or shell history.
# Idempotent: safe to re-run — every step tolerates "already exists".
#
#   pwsh deploy/aws/bootstrap-aws.ps1

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$secure = Read-Host 'RDS password for user yijicrm' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

$env:DIRECTUS_INTERNAL_URL = 'http://yiji-crm-alb-1204214335.us-east-2.elb.amazonaws.com'
$env:DIRECTUS_ADMIN_EMAIL = 'e.habibi@anan.sa'
$env:DIRECTUS_ADMIN_PASSWORD = '0uKQ6DIjiRdznnxUR56Aa1!'

$env:DB_HOST = 'test-yiji.ctqnuieahhb8.us-east-2.rds.amazonaws.com'
$env:DB_PORT = '5432'
$env:DB_DATABASE = 'afcoCrm'
$env:DB_USER = 'yijicrm'          # lowercase — Postgres is case-sensitive on connect
$env:DB_PASSWORD = $plain
$env:DB_SSL = 'true'              # RDS refuses plaintext; the constraints step is direct SQL

# Compensation lives in a SEPARATE Directus, so its collections are not provisioned here.
$env:PROVISION_COMPENSATION = 'false'

Write-Output "`n=== applying schema to $($env:DIRECTUS_INTERNAL_URL) ===`n"
pnpm --filter @yiji/directus-bootstrap apply
if ($LASTEXITCODE -ne 0) { throw "apply failed with exit code $LASTEXITCODE" }

Write-Output "`n=== verifying ===`n"
pnpm --filter @yiji/directus-bootstrap verify
if ($LASTEXITCODE -ne 0) { throw "verify failed with exit code $LASTEXITCODE" }

Write-Output "`nDone. Schema, roles, permissions and service users are provisioned."
