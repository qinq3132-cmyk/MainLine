$ErrorActionPreference = 'Stop'
$installerRoot = $PSScriptRoot
$setup = Join-Path (Split-Path $installerRoot -Parent) 'downloads\Mainline-Setup-1.0.exe'
$payload = Join-Path $installerRoot '.build\1.0\dist\Mainline'
$reportDir = Join-Path $installerRoot '.qa'
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
$status = Get-MpComputerStatus
if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled -or -not $status.BehaviorMonitorEnabled) {
    throw 'Defender antivirus, realtime protection and behavior monitoring must all be enabled for this check.'
}
$scanTool = Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
$platform = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
if (Test-Path -LiteralPath $platform) {
    $latest = Get-ChildItem -LiteralPath $platform -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($latest -and (Test-Path -LiteralPath (Join-Path $latest.FullName 'MpCmdRun.exe'))) {
        $scanTool = Join-Path $latest.FullName 'MpCmdRun.exe'
    }
}
$lines = @('Mainline Installed Edition 1.0 - local Defender check',
    ('Signature version: ' + $status.AntivirusSignatureVersion),
    ('Signature updated: ' + $status.AntivirusSignatureLastUpdated.ToString('o')),
    'Realtime protection: enabled', 'Behavior monitoring: enabled')
foreach ($target in @($setup, $payload)) {
    if (-not (Test-Path -LiteralPath $target)) { throw 'Expected test artifact is missing.' }
    $output = & $scanTool -Scan -ScanType 3 -File $target 2>&1
    $code = $LASTEXITCODE
    $output | Out-File -LiteralPath (Join-Path $reportDir ('scan-' + (Split-Path $target -Leaf) + '.txt')) -Encoding utf8
    $lines += ('Custom scan exit code for ' + (Split-Path $target -Leaf) + ': ' + $code)
    if ($code -ne 0) { throw 'Defender scan did not finish cleanly; inspect the local scan log.' }
}
$since = (Get-Date).Date
$matching = @(Get-MpThreatDetection | Where-Object {
    $_.InitialDetectionTime -ge $since -and @($_.Resources | Where-Object {
        $_ -like ('*' + $installerRoot + '*') -or $_ -like ('*' + $setup + '*')
    }).Count -gt 0
})
$events = @(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational';Id=1116,1117;StartTime=$since} -ErrorAction SilentlyContinue | Where-Object {
    $_.Message -like ('*' + $installerRoot + '*') -or $_.Message -like ('*' + $setup + '*')
})
$lines += ('Matching threat detection records: ' + $matching.Count)
$lines += ('Matching detection/remediation events: ' + $events.Count)
$lines += ('Setup SHA256: ' + (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash)
$lines += ('Setup signature: ' + (Get-AuthenticodeSignature -LiteralPath $setup).Status)
$lines += 'Scope: this Windows host only; no VM, browser-download SmartScreen or other-device verdict is claimed.'
$lines | Set-Content -LiteralPath (Join-Path $reportDir 'defender-latest.txt') -Encoding utf8
$lines | ForEach-Object { Write-Output $_ }
if ($matching.Count -gt 0 -or $events.Count -gt 0) { throw 'Defender detected a related artifact; do not publish until reviewed.' }
