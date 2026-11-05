param(
  [switch]$OpenBrowser,
  [string]$HttpsConfig = "C:\TournamentPrivate\https\server.json",
  [switch]$HttpOnly
)

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = "node"
$serverScript = Join-Path $repoRoot "server-launcher.js"
$scheme = "http"
$entryHost = "localhost"
if (!$HttpOnly) {
  if (!(Test-Path -LiteralPath $HttpsConfig -PathType Leaf)) { throw "HTTPS configuration not found. Run setup-https.ps1 first, or explicitly use -HttpOnly for the unsecured legacy service." }
  $HttpsConfig = (Resolve-Path -LiteralPath $HttpsConfig -ErrorAction Stop).Path
  & $nodeExe -e "require(process.argv[1]).loadHttpsConfig(process.argv[2])" (Join-Path $repoRoot "backend\httpsConfig.js") $HttpsConfig
  if ($LASTEXITCODE -ne 0) { throw "Invalid HTTPS installation. No surface processes were launched." }
  $httpsSettings = Get-Content -LiteralPath $HttpsConfig -Raw | ConvertFrom-Json
  $entryHost = $httpsSettings.hostname
  $scheme = "https"
}

$surfaces = @(
  [pscustomobject]@{
    Name = "pre"
    Port = 3000
    Url = "${scheme}://${entryHost}:$(if ($HttpOnly) { 3000 } else { 3443 })/tournament-management/"
  },
  [pscustomobject]@{
    Name = "monitoring"
    Port = 3002
    Url = "${scheme}://${entryHost}:$(if ($HttpOnly) { 3002 } else { 3445 })/event-progress/"
  },
  [pscustomobject]@{
    Name = "adminProgress"
    Port = 3004
    Url = "${scheme}://${entryHost}:$(if ($HttpOnly) { 3004 } else { 3447 })/administration-progress/"
  }
)

function Start-Surface {
  param(
    [Parameter(Mandatory = $true)]$Surface
  )

  $command = @"
Set-Location '$repoRoot'
`$env:TOURNAMENT_SURFACE = '$($Surface.Name)'
`$env:TOURNAMENT_HTTPS_CONFIG = '$(if ($HttpOnly) { '' } else { $HttpsConfig.Replace("'", "''") })'
Write-Host 'Starting surface: $($Surface.Name) ($($Surface.Port))'
Write-Host 'Entry URL: $($Surface.Url)'
& $nodeExe $serverScript
"@

  Start-Process -FilePath "powershell.exe" -WindowStyle Minimized -WorkingDirectory $repoRoot -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    $command
  ) | Out-Null
}

foreach ($surface in $surfaces) {
  Start-Surface -Surface $surface
}

if ($OpenBrowser) {
  Start-Sleep -Seconds 2
  Start-Process $surfaces[0].Url | Out-Null
}
