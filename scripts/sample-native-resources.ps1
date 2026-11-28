param([Parameter(Mandatory=$true)][int]$RootProcessId,
      [Parameter(Mandatory=$true)][string]$Output,
      [int]$Seconds=1200)
# Observe only the selected runtime's process tree. No command lines, secrets,
# process termination or memory-policy changes are involved.
$deadline=(Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
  $counters=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -ErrorAction Stop)
  $selected=[System.Collections.Generic.HashSet[uint32]]::new()
  [void]$selected.Add($RootProcessId)
  do {
    $before=$selected.Count
    foreach($row in $counters) {
      if ($selected.Contains([uint32]$row.CreatingProcessID)) { [void]$selected.Add([uint32]$row.IDProcess) }
    }
  } while ($selected.Count -gt $before)
  $samples=@($counters | Where-Object {$selected.Contains([uint32]$_.IDProcess)} | ForEach-Object {
    [ordered]@{pid=$_.IDProcess;parent=$_.CreatingProcessID;name=$_.Name;workingSet=$_.WorkingSet;privateWorkingSet=$_.WorkingSetPrivate;privateBytes=$_.PrivateBytes;cpu=$_.PercentProcessorTime;threads=$_.ThreadCount}
  })
  [ordered]@{at=[DateTime]::UtcNow.ToString('o');rootPid=$RootProcessId;processes=$samples} |
    ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $Output -Encoding utf8
  if (Test-Path -LiteralPath ($Output+'.stop')) { break }
  Start-Sleep -Seconds 3
}
