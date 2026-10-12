param(
  [switch]$OpenBrowser
)

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = "node"
$serverScript = Join-Path $repoRoot "group-server.js"

$surfaces = @(
  [pscustomobject]@{
    Name = "pre"
    Port = 3000
    Url = "http://localhost:3000/tournament-mgmt/"
  },
  [pscustomobject]@{
    Name = "monitoring"
    Port = 3002
    Url = "http://localhost:3002/event-progress/"
  },
  [pscustomobject]@{
    Name = "adminProgress"
    Port = 3004
    Url = "http://localhost:3004/administration-progress/"
  }
)

function Start-Surface {
  param(
    [Parameter(Mandatory = $true)]$Surface
  )

  $command = @"
Set-Location '$repoRoot'
`$env:TOURNAMENT_SURFACE = '$($Surface.Name)'
Write-Host 'Starting surface: $($Surface.Name) ($($Surface.Port))'
Write-Host 'Entry URL: $($Surface.Url)'
& $nodeExe $serverScript
"@

  Start-Process -FilePath "powershell.exe" -WorkingDirectory $repoRoot -ArgumentList @(
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
  foreach ($surface in $surfaces) {
    Start-Process $surface.Url | Out-Null
  }
}
