param(
  [string]$DataFile = "",
  [double]$MaxDailyLossPct = 2
)

$ErrorActionPreference = 'SilentlyContinue'
Write-Output ("=== 交易复盘 " + (Get-Date -Format 'yyyy-MM-dd HH:mm') + " ===")

if (-not $DataFile -or -not (Test-Path $DataFile)) {
  Write-Output "未接入交易记录，先回答四个复盘问题："
  Write-Output "  1) 今天做的单，是否都在盘前计划内？"
  Write-Output "  2) 有没有违反纪律（追单 / 无止损 / 亏损加仓 / 移动止损）？"
  Write-Output "  3) 亏损单的共同点是什么？"
  Write-Output "  4) 明天只改哪一条具体动作？"
  Write-Output ""
  Write-Output "接入方式：项目设置 → 功能/脚本 → 参数 -DataFile <交易记录.csv>"
  Write-Output "记录需要字段：合约,方向,开仓价,平仓价,手数,盈亏,是否计划内"
  exit 0
}

$rows = Import-Csv -Path $DataFile
if (-not $rows) {
  Write-Output "记录为空或格式不对（需要 合约,方向,开仓价,平仓价,手数,盈亏,是否计划内 七列）"
  exit 1
}

$win = 0; $loss = 0; $pnl = 0.0; $offPlan = 0; $noStop = 0

foreach ($r in $rows) {
  $v = 0.0
  [void][double]::TryParse([string]$r.盈亏, [ref]$v)
  $pnl += $v
  if ($v -ge 0) { $win++ } else { $loss++ }
  if ([string]$r.是否计划内 -match '^(否|no|N|0)$') { $offPlan++ }
  if ([string]$r.是否计划内 -match '无止损') { $noStop++ }
}

$total = $win + $loss
$rate = if ($total -gt 0) { [math]::Round($win / $total * 100, 1) } else { 0 }
$avgWin = 0.0; $avgLoss = 0.0
if ($win -gt 0) { $avgWin = [math]::Round(($rows | Where-Object { [double]$_.盈亏 -ge 0 } | Measure-Object -Property 盈亏 -Average).Average, 1) }
if ($loss -gt 0) { $avgLoss = [math]::Round(($rows | Where-Object { [double]$_.盈亏 -lt 0 } | Measure-Object -Property 盈亏 -Average).Average, 1) }

Write-Output ("共 " + $total + " 笔   盈 " + $win + " / 亏 " + $loss + "   胜率 " + $rate + "%")
Write-Output ("当日盈亏：" + [math]::Round($pnl, 1) + "   平均盈利：" + $avgWin + "   平均亏损：" + $avgLoss)
if ($avgLoss -ne 0) { Write-Output ("盈亏比：" + [math]::Round([math]::Abs($avgWin / $avgLoss), 2)) }

if ($offPlan -gt 0) {
  Write-Output ("!! 计划外交易 " + $offPlan + " 笔 —— 这是当前最大的问题，比选错方向更伤账户")
}
if ($noStop -gt 0) {
  Write-Output ("!! 无止损交易 " + $noStop + " 笔 —— 一次就能抵掉十次盈利")
}
if ($offPlan -eq 0 -and $noStop -eq 0) {
  Write-Output "全部交易在计划内且有止损，纪律执行合格。"
}
