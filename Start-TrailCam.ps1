# Start-TrailCam.ps1 - one step: sync, plan, open the dashboard.
#
# Double-click start-trailcam.cmd instead of running this directly, or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-TrailCam.ps1
#
# Your SpyPoint password is asked for once and can be saved encrypted with
# Windows DPAPI, which ties it to your Windows user account on this machine -
# nobody else's account can read it, and it never leaves the PC. Delete
# .credentials.xml to be asked again. That file is gitignored.

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }

Say ''
Say '  TrailCam' 'Green'
Say '  ---------------------------------------------' 'DarkGray'
Say ''

# --- Node present? -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say '  Node.js is not installed, or not on your PATH.' 'Red'
    Say '  Install it from https://nodejs.org (the LTS build is fine), then'
    Say '  close this window, open a new one, and run this again.'
    Say ''
    Read-Host '  Press Enter to close'
    exit 1
}
$nodeVersion = (& node --version | Out-String).Trim()

# Note the inner parentheses. [int](...)[0] would cast first and then index the
# resulting integer, which is not what this needs; the index has to happen
# inside the cast.
$major = [int]((($nodeVersion -replace '^v', '') -split '\.')[0])
if ($major -lt 20) {
    Say "  Node $nodeVersion is too old - this needs 20 or newer." 'Red'
    Say '  Update from https://nodejs.org, then run this again.'
    Read-Host '  Press Enter to close'
    exit 1
}
Say "  Node $nodeVersion" 'DarkGray'

# --- Credentials -------------------------------------------------------------
# Saved as a PSCredential, so the password is DPAPI-encrypted on disk rather
# than sitting in a batch file in plain text.
$credPath = Join-Path $PSScriptRoot '.credentials.xml'
$cred = $null

if (Test-Path -LiteralPath $credPath) {
    try {
        $cred = Import-Clixml -LiteralPath $credPath
        Say "  Signed in as $($cred.UserName)" 'DarkGray'
    } catch {
        Say '  Saved credentials could not be read - asking again.' 'Yellow'
        Remove-Item -LiteralPath $credPath -Force -ErrorAction SilentlyContinue
        $cred = $null
    }
}

if (-not $cred) {
    Say ''
    Say '  Sign in with your SpyPoint app login.' 'White'
    Say '  The password is hidden as you type - that is normal, keep typing.' 'DarkGray'
    Say ''
    $email = Read-Host '  SpyPoint email'
    $pw = Read-Host '  SpyPoint password' -AsSecureString
    if ([string]::IsNullOrWhiteSpace($email)) {
        Say '  No email entered. Nothing to do.' 'Red'
        Read-Host '  Press Enter to close'
        exit 1
    }
    $cred = New-Object System.Management.Automation.PSCredential($email, $pw)

    Say ''
    $save = Read-Host '  Save it so you are not asked next time? (y/n)'
    if ($save -match '^(y|yes)$') {
        $cred | Export-Clixml -LiteralPath $credPath
        Say '  Saved, encrypted to your Windows account.' 'DarkGray'
        Say '  Delete .credentials.xml to be asked again.' 'DarkGray'
    }
}

# Handed to the scripts as environment variables scoped to this process only,
# so they vanish when the window closes and never touch your shell profile.
$env:SPYPOINT_EMAIL = $cred.UserName
$env:SPYPOINT_PASSWORD = $cred.GetNetworkCredential().Password

# --- Sync --------------------------------------------------------------------
Say ''
Say '  [1/3] Fetching cameras and photos...' 'White'
& node --disable-warning=ExperimentalWarning spypoint-sync.mjs
if ($LASTEXITCODE -ne 0) {
    Say ''
    Say '  The sync failed - see the message above.' 'Red'
    if (Test-Path -LiteralPath $credPath) {
        Say '  If it says the login was rejected, delete .credentials.xml' 'Yellow'
        Say '  and run this again to re-enter your password.' 'Yellow'
    }
    Say ''
    Read-Host '  Press Enter to close'
    exit 1
}

# --- Plan --------------------------------------------------------------------
# A planner failure is not fatal: the weather service could be down, and the
# dashboard is still worth opening for camera locations and status.
Say ''
Say '  [2/3] Ranking the next two weeks of sits...' 'White'
& node --disable-warning=ExperimentalWarning hunt-planner.mjs --days 14 --quiet
if ($LASTEXITCODE -ne 0) {
    Say '  Could not build the hunt plan - carrying on without it.' 'Yellow'
}

# --- Serve -------------------------------------------------------------------
# The dashboard is now served from the database rather than opened as a file,
# because a static page cannot save anything - and tagging needs to save.
# -Host 0.0.0.0 also makes it reachable from a phone on the same Wi-Fi.
$port = 8787
Say ''
Say '  [3/3] Starting TrailCam...' 'White'
Say ''
Say "    On this computer:  http://127.0.0.1:$port" 'Green'
Say '    On your phone:     shown below, if on the same Wi-Fi' 'DarkGray'
Say ''
Say '  Leave this window open while you use it. Ctrl+C to stop.' 'DarkGray'
Say ''

& node --disable-warning=ExperimentalWarning serve.mjs --host 0.0.0.0 --port $port --open

Say ''
Say '  TrailCam stopped.' 'DarkGray'
Read-Host '  Press Enter to close'
