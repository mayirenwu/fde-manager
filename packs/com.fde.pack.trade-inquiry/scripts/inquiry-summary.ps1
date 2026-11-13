param(
  [string]$DataFile = "",
  [int]$OverdueHours = 4
)

$ErrorActionPreference = 'SilentlyContinue'
Write-Output ("=== 询盘跟进汇总 " + (Get-Date -Format 'yyyy-MM-dd HH:mm') + " ===")

if (-not $DataFile -or -not (Test-Path $DataFile)) {
  Write-Output "未接入询盘台账，先按节奏自查："
  Write-Output ("  - 超过 " + $OverdueHours + " 小时未首次回复的询盘，今天必须全部清掉")
  Write-Output "  - 今天该跟进的（D3 报价 / D7 二次触达）有没有漏"
  Write-Output "  - A 级客户是否都给了样品方案"
  Write-Output ""
  Write-Output "接入方式：项目设置 → 功能/脚本 → 参数 -DataFile <询盘台账.csv>"
  Write-Output "台账需要字段：客户,等级,收到时间,状态"
  exit 0
}

$rows = Import-Csv -Path $DataFile
if (-not $rows) {
  Write-Output "台账为空或格式不对（需要 客户,等级,收到时间,状态 四列）"
  exit 1
}

$now = Get-Date
$waiting = @()
$overdue = @()
$aLevel = @()

foreach ($r in $rows) {
  $status = [string]$r.状态
  if ($status -eq '已成交' -or $status -eq '已关闭') { continue }
  if ([string]$r.等级 -eq 'A') { $aLevel += $r }
  if ($status -eq '待回复' -or $status -eq '新询盘') {
    $waiting += $r
    $t = [datetime]::MinValue
    if ([datetime]::TryParse([string]$r.收到时间, [ref]$t)) {
      $hours = ($now - $t).TotalHours
      if ($hours -gt $OverdueHours) { $overdue += [pscustomobject]@{ 客户 = $r.客户; 等级 = $r.等级; 已等待小时 = [math]::Round($hours, 1) } }
    }
  }
}

Write-Output ("待回复询盘：" + $waiting.Count + " 个（A 级 " + $aLevel.Count + " 个）")

if ($overdue.Count -gt 0) {
  Write-Output ("超时未回：" + $overdue.Count + " 个 —— 今天就清")
  $overdue | Sort-Object -Property 已等待小时 -Descending | ForEach-Object {
    Write-Output ("  " + $_.客户 + "  [" + $_.等级 + "]  已等 " + $_.已等待小时 + " 小时")
  }
} else {
  Write-Output "没有超时询盘，节奏正常。"
}

if ($aLevel.Count -gt 0) {
  Write-Output "A 级客户名单（优先处理）："
  $aLevel | ForEach-Object { Write-Output ("  " + $_.客户 + "  状态：" + $_.状态) }
}
