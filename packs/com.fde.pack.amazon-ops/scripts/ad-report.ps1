param(
  [string]$DataFile = "",
  [double]$AcosLine = 25
)

$ErrorActionPreference = 'SilentlyContinue'
Write-Output ("=== 广告花费日报 " + (Get-Date -Format 'yyyy-MM-dd HH:mm') + " ===")

if (-not $DataFile -or -not (Test-Path $DataFile)) {
  Write-Output "未接入广告数据文件，先给出今日手工核对清单："
  Write-Output ("  - ACOS 红线：" + $AcosLine + "%")
  Write-Output "  - 检查每个广告组是否有花费无订单的 SKU"
  Write-Output "  - 检查预算是否在中午前烧完（烧完说明出价偏高或词太宽）"
  Write-Output ""
  Write-Output "接入方式：项目设置 → 功能/脚本 → 给本脚本加参数 -DataFile <广告报表.csv>"
  Write-Output "报表需要字段：SKU,花费,销售额"
  exit 0
}

$rows = Import-Csv -Path $DataFile
if (-not $rows) {
  Write-Output "报表为空或格式不对（需要 SKU,花费,销售额 三列）"
  exit 1
}

$totalCost = 0.0
$totalSales = 0.0
$bad = @()

foreach ($r in $rows) {
  $cost = 0.0
  $sales = 0.0
  [void][double]::TryParse([string]$r.花费, [ref]$cost)
  [void][double]::TryParse([string]$r.销售额, [ref]$sales)
  $totalCost += $cost
  $totalSales += $sales
  $acos = if ($sales -gt 0) { [math]::Round($cost / $sales * 100, 1) } else { 999 }
  if ($acos -gt $AcosLine) {
    $bad += [pscustomobject]@{ SKU = $r.SKU; 花费 = $cost; 销售额 = $sales; ACOS = $acos }
  }
}

$totalAcos = if ($totalSales -gt 0) { [math]::Round($totalCost / $totalSales * 100, 1) } else { 0 }
Write-Output ("总花费：" + $totalCost + "   总销售额：" + $totalSales + "   整体 ACOS：" + $totalAcos + "%")
$roi = if ($totalCost -gt 0) { [math]::Round($totalSales / $totalCost, 2) } else { 0 }
Write-Output ("ROI：" + $roi)

if ($bad.Count -eq 0) {
  Write-Output ("所有 SKU 都在 " + $AcosLine + "% 红线内，保持当前出价。")
} else {
  Write-Output ("超红线 SKU 共 " + $bad.Count + " 个：")
  $bad | Sort-Object -Property ACOS -Descending | ForEach-Object {
    Write-Output ("  " + $_.SKU + "  ACOS " + $_.ACOS + "%  花费 " + $_.花费 + "  销售额 " + $_.销售额)
  }
  Write-Output "处理建议：先降 20% 出价观察 3 天，仍无自然单则关停。"
}
