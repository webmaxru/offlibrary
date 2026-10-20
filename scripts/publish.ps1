<#
.SYNOPSIS
  Publish offlibrary to npm in one go: preflight, verify, pack, publish, check, tag.

.DESCRIPTION
  Runs on Windows PowerShell 5.1 and PowerShell 7+. Every npm command that talks to a registry gets
  --registry https://registry.npmjs.org explicitly, so a project or user .npmrc can never redirect it.
  On Windows it calls npm.cmd (PowerShell 5.1's execution policy can block npm.ps1).
  No token is ever read, stored or printed: npm keeps its own login.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Yes -Otp 123456
#>
[CmdletBinding()]
param(
  # Skip the "Publish? (y/N)" question.
  [switch]$Yes,
  # One-time password from your authenticator app (npm 2FA). If omitted, you are asked when npm needs it.
  [string]$Otp,
  # Run every step except publish and tag.
  [switch]$DryRun,
  # Create and push the git tag v<version> after publishing (default: on). Use -Tag:$false to skip.
  [switch]$Tag = $true,
  # Also run the browser e2e suites (downloads Chromium once, takes a few minutes; CI runs them on every PR).
  [switch]$E2E
)

$ErrorActionPreference = 'Stop'
$Registry = 'https://registry.npmjs.org'
$Package = 'offlibrary'
$Repo = 'https://github.com/webmaxru/offlibrary'
$OnWindows = ($PSVersionTable.PSVersion.Major -le 5) -or ($env:OS -eq 'Windows_NT') -or ((Get-Variable IsWindows -ErrorAction SilentlyContinue) -and $IsWindows)
$Npm = if ($OnWindows) { 'npm.cmd' } else { 'npm' }
$Npx = if ($OnWindows) { 'npx.cmd' } else { 'npx' }

function Step([string]$text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }
function Ok([string]$text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host "    XX  $text" -ForegroundColor Red; exit 1 }

# Run a native command; stop on a non-zero exit code. Returns nothing (output goes to the console).
function Run([string]$exe, [string[]]$arguments, [string]$what) {
  Write-Host "    > $exe $($arguments -join ' ')" -ForegroundColor DarkGray
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "$what failed (exit code $LASTEXITCODE)." }
}

# Run a native command and capture its output (stdout + stderr) without stopping on failure.
function Capture([string]$exe, [string[]]$arguments) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = (& $exe @arguments 2>&1 | Out-String) } finally { $ErrorActionPreference = $prev }
  return @{ Code = $LASTEXITCODE; Out = $out.Trim() }
}

# Preflight failures stop a real release; in -DryRun they are only reported.
function Check([bool]$condition, [string]$okText, [string]$failText) {
  if ($condition) { Ok $okText }
  elseif ($DryRun) { Warn "$failText (ignored in -DryRun)" }
  else { Fail $failText }
}

Set-Location (Split-Path -Parent $PSScriptRoot)
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
Write-Host "Publishing $Package@$version to $Registry$(if ($DryRun) { '  [DRY RUN]' })" -ForegroundColor White

# 1. Preflight -----------------------------------------------------------------
Step '1/9 Git preflight (main, clean, in sync with origin)'
$branch = (Capture 'git' @('rev-parse', '--abbrev-ref', 'HEAD')).Out
Check ($branch -eq 'main') "on main" "You are on '$branch', not main. Run: git checkout main"
$dirty = (Capture 'git' @('status', '--porcelain')).Out
Check ([string]::IsNullOrWhiteSpace($dirty)) 'working tree is clean' "The working tree has changes:`n$dirty"
Run 'git' @('fetch', '--quiet', 'origin') 'git fetch'
$local = (Capture 'git' @('rev-parse', 'HEAD')).Out
$remote = (Capture 'git' @('rev-parse', 'origin/main')).Out
Check ($local -eq $remote) "in sync with origin/main ($($local.Substring(0, 7)))" "Local HEAD $local differs from origin/main $remote. Run: git pull --ff-only"

# 2. Login ---------------------------------------------------------------------
Step '2/9 npm login'
$who = Capture $Npm @('whoami', '--registry', $Registry)
if ($who.Code -ne 0) {
  if ($DryRun) { Warn 'Not logged in to npm (a real run would start npm login now).' }
  else {
    Warn 'Not logged in. Starting npm login (a browser window may open).'
    Run $Npm @('login', '--registry', $Registry) 'npm login'
    $who = Capture $Npm @('whoami', '--registry', $Registry)
    if ($who.Code -ne 0) { Fail 'Still not logged in after npm login.' }
  }
}
if ($who.Code -eq 0) { Ok "logged in as $($who.Out)" }

# 3. Version not yet published -------------------------------------------------
Step "3/9 Is $Package@$version already on npm?"
$view = Capture $Npm @('view', "$Package@$version", 'version', '--registry', $Registry)
if ($view.Code -eq 0 -and $view.Out -match [regex]::Escape($version)) {
  Fail "$Package@$version is already published. Bump the version in package.json (npm.cmd version x.y.z --no-git-tag-version) first."
}
Ok "$version is not published yet"

# 4. Install and verify --------------------------------------------------------
Step '4/9 Install (npm ci) and verify: typecheck, unit tests, build, size budget, package check'
Run $Npm @('ci', '--registry', $Registry) 'npm ci'
Run $Npm @('run', 'typecheck') 'typecheck'
Run $Npm @('test') 'unit tests'
Run $Npm @('run', 'build') 'build'
Run $Npm @('run', 'size') 'size budget'
Run $Npm @('run', 'check:package') 'package check (installs the packed tarball offline and type-checks it)'
if ($E2E) {
  Run $Npx @('--registry', $Registry, 'playwright-core', 'install', 'chromium') 'Chromium download'
  Run $Npm @('run', 'test:e2e') 'browser e2e tests'
} else { Warn 'browser e2e suites skipped (add -E2E to run them here; CI runs them on every PR)' }
Ok 'all checks passed'

# 5. Pack preview and confirmation ---------------------------------------------
Step '5/9 What will be published (npm pack --dry-run)'
Run $Npm @('pack', '--dry-run', '--registry', $Registry) 'npm pack --dry-run'
if ($DryRun) { Warn 'Dry run: stopping before publish and tag.'; Write-Host ''; Write-Host "Dry run complete for $Package@$version." -ForegroundColor Green; exit 0 }
if (-not $Yes) {
  $answer = Read-Host "Publish $Package@$version to npm? (y/N)"
  if ($answer -notmatch '^(y|yes)$') { Fail 'Cancelled. Nothing was published.' }
}

# 6. Publish -------------------------------------------------------------------
Step "6/9 npm publish $Package@$version"
$publishArgs = @('publish', '--access', 'public', '--registry', $Registry)
if ($Otp) {
  Run $Npm ($publishArgs + @('--otp', $Otp)) 'npm publish'
} else {
  & $Npm @publishArgs   # npm asks for the OTP itself (or opens the browser) when 2FA needs it
  if ($LASTEXITCODE -ne 0) {
    $code = Read-Host 'npm publish failed. If it asked for a one-time password, enter it now (blank = abort)'
    if ([string]::IsNullOrWhiteSpace($code)) { Fail 'npm publish failed. Nothing was published.' }
    Run $Npm ($publishArgs + @('--otp', $code.Trim())) 'npm publish (with OTP)'
  }
}
Ok 'published'

# 7. Verify --------------------------------------------------------------------
Step "7/9 Verify $Package@$version on the registry"
$seen = $false
foreach ($i in 1..6) {
  $check = Capture $Npm @('view', "$Package@$version", 'version', '--registry', $Registry)
  if ($check.Code -eq 0 -and $check.Out -match [regex]::Escape($version)) { $seen = $true; break }
  Write-Host "    waiting for the registry ($i/6)..." -ForegroundColor DarkGray
  Start-Sleep -Seconds 10
}
if ($seen) { Ok "npm view reports $version" } else { Warn "npm does not report $version yet; check again in a minute: $Npm view $Package version --registry $Registry" }

# 8. Tag -----------------------------------------------------------------------
Step "8/9 Git tag v$version"
if ($Tag) {
  $exists = (Capture 'git' @('tag', '--list', "v$version")).Out
  if ($exists) { Warn "tag v$version already exists locally; not creating it again" }
  else { Run 'git' @('tag', "v$version") 'git tag' }
  Run 'git' @('push', 'origin', "v$version") 'git push tag'
  Ok "tag v$version pushed"
} else { Warn 'tag skipped (-Tag:$false)' }

# 9. Links ---------------------------------------------------------------------
Step '9/9 Done'
Write-Host "    npm:     https://www.npmjs.com/package/$Package/v/$version"
Write-Host "    release: $Repo/releases/new?tag=v$version  (paste the CHANGELOG section)"
Write-Host "    docs:    https://salnikov.no/offlibrary/ (deploys from main on its own)"
