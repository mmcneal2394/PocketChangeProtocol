$log = "$env:USERPROFILE\.pm2\logs\arb-jup-out.log"
$sniperLog = "$env:USERPROFILE\.pm2\logs\sniper-out.log"
$start = Get-Date
$end = $start.AddMinutes(5)

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  ARB-JUP 5-MINUTE LIVE TEST" -ForegroundColor Cyan
Write-Host "  Started: $($start.ToString('HH:mm:ss'))" -ForegroundColor Cyan
Write-Host "  Ends:    $($end.ToString('HH:mm:ss'))" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

# Track last lines read
$lastLine = 0

while ((Get-Date) -lt $end) {
    $remaining = [int](($end - (Get-Date)).TotalSeconds)
    $lines = Get-Content $log -ErrorAction SilentlyContinue
    if ($lines) {
        $newLines = $lines | Select-Object -Skip $lastLine
        $lastLine = $lines.Count
        foreach ($l in $newLines) {
            if ($l -match "gross|PROFIT|LOSS|Scan|Holding|ERROR|opp|USDC|SOL|fee") {
                $color = "White"
                if ($l -match "PROFIT|0x1|wins") { $color = "Green" }
                elseif ($l -match "LOSS|ERROR|❌") { $color = "Red" }
                elseif ($l -match "🟢") { $color = "Green" }
                elseif ($l -match "🟡") { $color = "Yellow" }
                elseif ($l -match "🔴") { $color = "DarkGray" }
                Write-Host "[$remaining`s] $l" -ForegroundColor $color
            }
        }
    }
    Start-Sleep 2
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  === 5 MINUTE TEST COMPLETE ===" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "--- FINAL LOG TAIL (arb-jup) ---" -ForegroundColor Yellow
Get-Content $log -Tail 30 -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "--- SNIPER STATUS ---" -ForegroundColor Yellow
Get-Content $sniperLog -Tail 5 -ErrorAction SilentlyContinue
