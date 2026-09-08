# Get-CameraShape.ps1 - produce a shareable dump of what your cameras send.
#
# Double-click camera-shape.cmd instead of running this directly, or run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\Get-CameraShape.ps1
#
# WHY THIS EXISTS. When a camera model this tool has never met comes through
# with blank fields, the fix needs its field SHAPE - which keys it sends and
# what they look like. Getting that by hand went wrong four ways in one
# sitting: run from the wrong directory (an old copy of the script answered),
# paste the example credentials from the instructions (a rejected login writes
# no dump at all), redirect into the repo root (not gitignored, and this
# repository is public), and then have no way to tell those apart afterwards,
# because all three produce a file with no dump in it.
#
# So this script does the whole thing and then CHECKS ITS OWN OUTPUT, and says
# in one line whether the file is safe to send.
#
# There is deliberately no -Raw switch. The point of this script is a dump you
# can hand to someone; a raw dump is the location of your cameras and wants a
# different, more deliberate act. Run the sync directly if you need one:
#   node --disable-warning=ExperimentalWarning spypoint-sync.mjs --inspect --raw

$ErrorActionPreference = 'Stop'
# Not the caller's directory: running this from anywhere else is how an old
# loose copy of spypoint-sync.mjs elsewhere on the disk gets to answer instead.
Set-Location -LiteralPath $PSScriptRoot

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }

Say ''
Say '  TrailCam - camera shape' 'Green'
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

# --- Are we on code that can redact? -----------------------------------------
# The redaction is what makes the output sendable. On an older checkout
# --inspect prints the real GPS fix, and the only sign is a missing line at the
# bottom of a file you have already pasted somewhere.
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'camera-shape.mjs'))) {
    Say '  This checkout is too old: camera-shape.mjs is missing, so --inspect' 'Red'
    Say '  here would print your real GPS coordinates.' 'Red'
    Say ''
    Say '  Update first:   git pull origin main' 'Yellow'
    Say ''
    Read-Host '  Press Enter to close'
    exit 1
}

# --- Credentials -------------------------------------------------------------
# The same .credentials.xml Start-TrailCam.ps1 writes, so signing in once
# covers both. DPAPI-encrypted to this Windows account; gitignored.
$credPath = Join-Path $PSScriptRoot '.credentials.xml'
$cred = $null

if (Test-Path -LiteralPath $credPath) {
    try {
        $cred = Import-Clixml -LiteralPath $credPath
        Say "  Signed in as $($cred.UserName)" 'DarkGray'
    } catch {
        Say '  Saved credentials could not be read - asking again.' 'Yellow'
        $cred = $null
    }
}

if (-not $cred) {
    Say ''
    Say '  Sign in with your SpyPoint app login.' 'White'
    Say '  Your REAL email and password - not an example from any instructions.' 'Yellow'
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
}

$env:SPYPOINT_EMAIL = $cred.UserName
$env:SPYPOINT_PASSWORD = $cred.GetNetworkCredential().Password

# --- Where it goes -----------------------------------------------------------
# spypoint-data/ is gitignored WHOLESALE, which is the rule that also covers a
# filename nobody has thought of yet. --inspect returns before the sync creates
# this directory, so on a fresh clone it will not exist and the write would
# fail before node ever ran.
$outDir = Join-Path $PSScriptRoot 'spypoint-data'
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
$out = Join-Path $outDir 'shape.txt'

Say ''
Say '  Asking SpyPoint what your cameras look like...' 'White'

# Captured rather than redirected with *>, so the marker below can be checked
# in memory and the file written once. ErrorActionPreference is relaxed for
# exactly this call: with it set to Stop, a native command writing to stderr
# can raise NativeCommandError, and this sync writes real notes there - quota
# warnings, stale cameras, and the blank-field report this dump is FOR.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$lines = & node --disable-warning=ExperimentalWarning spypoint-sync.mjs --inspect 2>&1 |
    ForEach-Object { $_.ToString() }
$code = $LASTEXITCODE
$ErrorActionPreference = $prev

if ($code -ne 0) {
    Say ''
    Say '  The sync failed, so there is no dump. What it said:' 'Red'
    Say ''
    $lines | Select-Object -Last 12 | ForEach-Object { Say "    $_" 'DarkGray' }
    Say ''
    if (Test-Path -LiteralPath $credPath) {
        Say '  If it says the login was rejected, delete .credentials.xml and' 'Yellow'
        Say '  run this again to re-enter your password.' 'Yellow'
    } else {
        Say '  If it says the login was rejected, check the email and password.' 'Yellow'
    }
    Say ''
    Read-Host '  Press Enter to close'
    exit 1
}

Set-Content -LiteralPath $out -Value $lines -Encoding UTF8

# --- Did it actually redact? -------------------------------------------------
# The check the person should not have to remember, done here against the text
# that was just written. A missing marker means the dump did not run or came
# from older code, and either way the file must not be sent.
$redacted = $lines | Where-Object { $_ -match 'Values are redacted' }
$models = $lines | Where-Object { $_ -match 'models on this account:' }

Say ''
if ($redacted) {
    Say '  Done. This file is safe to send:' 'Green'
    Say "    $out" 'White'
    # Computed first, not written as "...".Trim() inline: a function's arguments
    # are parsed in argument mode, where a method call on a quoted string is not
    # called at all - it is appended as literal text, and the line would print
    # with ".Trim()" stuck on the end.
    if ($models) {
        $modelLine = ($models -join ' ').Trim()
        Say "  $modelLine" 'DarkGray'
    }
    Say ''
    Say '  Coordinates, ids, SIMs and serials are replaced by their type and' 'DarkGray'
    Say '  format. Camera names are kept so the lines can be told apart.' 'DarkGray'
} else {
    Say '  The dump ran but is NOT redacted - do not send it.' 'Red'
    Say "    $out" 'White'
    Say ''
    Say '  That marker is printed by current code, so this is either an older' 'Yellow'
    Say '  checkout or an interrupted run. Update and try again:' 'Yellow'
    Say '    git pull origin main' 'Yellow'
}
Say ''
Read-Host '  Press Enter to close'
