$ErrorActionPreference = 'Stop'
$taskMetadataPath = Join-Path $PSScriptRoot 'data\service.json'
if (-not (Test-Path -LiteralPath $taskMetadataPath)) { Write-Output '没有本机服务记录。'; exit 0 }
$taskMetadata = Get-Content -LiteralPath $taskMetadataPath -Raw | ConvertFrom-Json
$taskUrl = "http://127.0.0.1:$($taskMetadata.port)"
try { $taskHealth = Invoke-RestMethod -Uri "$taskUrl/api/health" -TimeoutSec 3 }
catch { Write-Output '服务已经停止。'; exit 0 }
if ($taskHealth.app -ne 'personal-desk' -or $taskHealth.root -ne $PSScriptRoot -or $taskHealth.instance -ne $taskMetadata.instance) { throw '服务标识不匹配，未停止任何进程。' }
$taskBody = @{ instance = $taskMetadata.instance } | ConvertTo-Json
Invoke-RestMethod -Uri "$taskUrl/api/shutdown" -Method Post -Headers @{ 'X-Personal-Desk' = '1' } -ContentType 'application/json' -Body $taskBody | Out-Null
Write-Output '个人指挥台后台已停止；任务数据保留。'
