# One-time GitHub repository hardening for PiFiles (idempotent: safe to run again).
#
#   winget install GitHub.cli        # once
#   gh auth login                    # once, as a repository admin
#   powershell -ExecutionPolicy Bypass -File scripts/github-setup.ps1
#
# Optional: -Repo owner/name (default Solanum-Tech/PiFiles), -Reviewer <github login> (who must
# approve release builds; default: you), -DryRun to only print what would change.
param(
  [string]$Repo = "Solanum-Tech/PiFiles",
  [string]$Reviewer = "",
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "GitHub CLI not found. Install it with: winget install GitHub.cli, then run: gh auth login" }
gh auth status 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { throw "Not logged in. Run: gh auth login" }
if (-not $Reviewer) { $Reviewer = gh api user --jq .login }
$tmp = Join-Path ([IO.Path]::GetTempPath()) "pifiles-gh-setup"; New-Item -ItemType Directory -Force $tmp | Out-Null

function Api([string]$Method, [string]$Path, $Body) {
  $ghArgs = @("api", "--method", $Method, "-H", "Accept: application/vnd.github+json", $Path)
  if ($null -ne $Body) {
    $f = Join-Path $tmp ([guid]::NewGuid().ToString() + ".json")
    $Body | ConvertTo-Json -Depth 20 | Set-Content -Path $f -Encoding ascii
    $ghArgs += @("--input", $f)
  }
  if ($DryRun) { Write-Host "[dry-run] gh $($ghArgs -join ' ')"; return $null }
  # gh's stderr must not abort the script (PowerShell 5.1 turns it into errors); the exit code decides.
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & gh @ghArgs 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { Write-Warning "$Method $Path failed: $out"; return $null }
  $text = ($out | Out-String).Trim()
  if (-not $text) { return $null } # e.g. 204 No Content
  try { return ($text | ConvertFrom-Json) } catch { return $text }
}

Write-Host "== Repository settings"
Api PATCH "repos/$Repo" @{
  delete_branch_on_merge = $true
  allow_merge_commit     = $false
  allow_squash_merge     = $true
  allow_rebase_merge     = $false
  allow_auto_merge       = $true
  security_and_analysis  = @{
    secret_scanning                 = @{ status = "enabled" }
    secret_scanning_push_protection = @{ status = "enabled" }
    dependabot_security_updates     = @{ status = "enabled" }
  }
} | Out-Null
Api PUT "repos/$Repo/vulnerability-alerts" $null | Out-Null                # Dependabot alerts
Api PUT "repos/$Repo/private-vulnerability-reporting" $null | Out-Null     # "Report a vulnerability"

Write-Host "== Actions: read-only token by default, Actions can't approve PRs"
Api PUT "repos/$Repo/actions/permissions/workflow" @{ default_workflow_permissions = "read"; can_approve_pull_request_reviews = $false } | Out-Null

Write-Host "== Rulesets"
$existing = @(); if (-not $DryRun) { $existing = gh api "repos/$Repo/rulesets" | ConvertFrom-Json }
function Upsert-Ruleset($rs) {
  $old = $existing | Where-Object { $_.name -eq $rs.name } | Select-Object -First 1
  if ($old) { Api PUT "repos/$Repo/rulesets/$($old.id)" $rs | Out-Null; Write-Host "  updated: $($rs.name)" }
  else { Api POST "repos/$Repo/rulesets" $rs | Out-Null; Write-Host "  created: $($rs.name)" }
}
# Admins (actor 5 = repository admin role) may merge their own PRs when they're the only
# maintainer; everyone else needs an approving review. Checks are required for everyone.
$adminBypassPR = @(@{ actor_id = 5; actor_type = "RepositoryRole"; bypass_mode = "pull_request" })
Upsert-Ruleset @{
  name        = "Protect main"
  target      = "branch"
  enforcement = "active"
  conditions  = @{ ref_name = @{ include = @("~DEFAULT_BRANCH", "refs/heads/main"); exclude = @() } }
  bypass_actors = $adminBypassPR
  rules = @(
    @{ type = "deletion" },
    @{ type = "non_fast_forward" },
    @{ type = "pull_request"; parameters = @{
        required_approving_review_count = 1
        dismiss_stale_reviews_on_push   = $true
        require_code_owner_review       = $true
        require_last_push_approval      = $false
        required_review_thread_resolution = $true
        allowed_merge_methods           = @("squash") } },
    @{ type = "required_status_checks"; parameters = @{
        strict_required_status_checks_policy = $true
        required_status_checks = @(
          @{ context = "CI passed" },
          @{ context = "Analyze (javascript-typescript)" },
          @{ context = "Analyze (rust)" },
          @{ context = "Analyze (actions)" },
          @{ context = "Installers (windows-latest)" }) } },
    @{ type = "code_scanning"; parameters = @{ code_scanning_tools = @(@{ tool = "CodeQL"; security_alerts_threshold = "high_or_higher"; alerts_threshold = "errors" }) } }
  )
}
Upsert-Ruleset @{
  name        = "Protect dev"
  target      = "branch"
  enforcement = "active"
  conditions  = @{ ref_name = @{ include = @("refs/heads/dev"); exclude = @() } }
  bypass_actors = $adminBypassPR
  rules = @(
    @{ type = "deletion" },
    @{ type = "non_fast_forward" },
    @{ type = "required_status_checks"; parameters = @{ strict_required_status_checks_policy = $false; required_status_checks = @(@{ context = "CI passed" }) } }
  )
}
# Only admins can create, move or delete version tags (a tag push triggers a release).
Upsert-Ruleset @{
  name        = "Release tags"
  target      = "tag"
  enforcement = "active"
  conditions  = @{ ref_name = @{ include = @("refs/tags/v*"); exclude = @() } }
  bypass_actors = @(@{ actor_id = 5; actor_type = "RepositoryRole"; bypass_mode = "always" })
  rules = @(@{ type = "creation" }, @{ type = "update" }, @{ type = "deletion" })
}

Write-Host "== Protected 'release' environment (signing secrets; needs approval; v* tags only)"
$uid = if ($DryRun) { 0 } else { [int](gh api "users/$Reviewer" --jq .id) }
Api PUT "repos/$Repo/environments/release" @{
  wait_timer = 0
  prevent_self_review = $false
  reviewers = @(@{ type = "User"; id = $uid })
  deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true }
} | Out-Null
$pols = $null; if (-not $DryRun) { $pols = gh api "repos/$Repo/environments/release/deployment-branch-policies" | ConvertFrom-Json }
if (-not ($pols.branch_policies | Where-Object { $_.name -eq "v*" -and $_.type -eq "tag" })) {
  Api POST "repos/$Repo/environments/release/deployment-branch-policies" @{ name = "v*"; type = "tag" } | Out-Null
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "Done. Remaining manual steps (secrets are never set by scripts):"
Write-Host "  1. Settings > Environments > release > Add secret:"
Write-Host "       TAURI_SIGNING_PRIVATE_KEY           = contents of %USERPROFILE%\.tauri\pifiles-updater.key"
Write-Host "       TAURI_SIGNING_PRIVATE_KEY_PASSWORD  = (print it with the command in docs/SECURITY.md)"
Write-Host "  2. Settings > Secrets and variables > Actions > New repository secret: WINGET_TOKEN (optional, see docs/RELEASING.md)"
Write-Host "  3. Settings > Code security > Code scanning: keep 'Default setup' OFF (the CodeQL workflow is the advanced setup)."

