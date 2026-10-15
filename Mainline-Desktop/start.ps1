param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskPort = 5179
$taskUrl = "http://127.0.0.1:$taskPort"
$taskData = Join-Path $taskRoot 'data'
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
try {
    $taskHealth = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 2
    if ($taskHealth.app -eq 'personal-desk' -and $taskHealth.root -eq $taskRoot) {
        if (-not $NoBrowser) { Start-Process $taskUrl }
        exit 0
    }
    throw '端口已由另一个服务占用。'
} catch {
    if ($_.Exception.Message -eq '端口已由另一个服务占用。') { throw }
}
$taskPython = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $taskPython) { throw '未找到 Python。请安装 Python 3.11 或更新版本。' }
$taskServer = Join-Path $taskRoot 'server.py'
$taskLog = Join-Path $taskData 'service.log'
$taskErrorLog = Join-Path $taskData 'service-error.log'
Start-Process -FilePath $taskPython -ArgumentList @(('"' + $taskServer + '"'), '--port', "$taskPort") -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskLog -RedirectStandardError $taskErrorLog | Out-Null
for ($taskTry = 0; $taskTry -lt 30; $taskTry++) {
    Start-Sleep -Milliseconds 300
    try {
        $taskHealth = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 1
        if ($taskHealth.app -eq 'personal-desk' -and $taskHealth.root -eq $taskRoot) {
            if (-not $NoBrowser) { Start-Process $taskUrl }
            exit 0
        }
    } catch { }
}
throw '服务未能启动，请查看 personal-desk\data\service-error.log。'
