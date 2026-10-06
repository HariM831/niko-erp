<#
  SCADA discovery for niko - step 0. READ ONLY.

  Run on the feed mill SCADA PC (DESKTOP-CK6AQJR), as the Windows user that
  normally runs WinCC:

      powershell -ExecutionPolicy Bypass -File .\scada-discovery.ps1

  It finds where the batching report and the recipe screen keep their data,
  and how WinCC could hand out live values. It only runs SELECT statements and
  lists files and settings; it writes nothing to SQL Server, WinCC or the PLC,
  and changes no setting. The one file it creates is the report on the
  Desktop: scada_discovery_<time>.txt. Send that file back.

  Passwords in connection strings are masked, and tables that look like user
  or login tables are listed but never sampled.
#>

$ErrorActionPreference = 'Continue'
$stamp  = Get-Date -Format 'yyyyMMdd_HHmmss'
$out    = Join-Path ([Environment]::GetFolderPath('Desktop')) "scada_discovery_$stamp.txt"
$lines  = New-Object System.Collections.Generic.List[string]

function Say([string]$s) { $lines.Add($s); Write-Host $s }
function Section([string]$s) { Say ''; Say "===== $s =====" }
function Mask([string]$s) {
  if (-not $s) { return $s }
  return ($s -replace '(?i)(password|pwd)\s*=\s*[^;]*', '$1=***')
}

Say "SCADA discovery - $(Get-Date)"
Say "Computer: $env:COMPUTERNAME   User: $env:USERDOMAIN\$env:USERNAME"

# --------------------------------------------------------------------------
# SQL helpers. Windows authentication only; every query is a SELECT.
# READ UNCOMMITTED so a discovery query can never hold a lock that WinCC waits on.
# --------------------------------------------------------------------------
Add-Type -AssemblyName System.Data

function Invoke-Select([string]$server, [string]$database, [string]$sql, [int]$timeout = 30) {
  if ($sql -notmatch '^\s*(SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\s*)?(SELECT|WITH)\b') {
    throw "refusing a non-SELECT statement"
  }
  $cs = "Server=$server;Database=$database;Integrated Security=SSPI;Application Name=niko-discovery;Connect Timeout=10"
  $conn = New-Object System.Data.SqlClient.SqlConnection $cs
  try {
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandTimeout = $timeout
    $cmd.CommandText = "SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; $sql"
    $da = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $dt = New-Object System.Data.DataTable
    [void]$da.Fill($dt)
    return ,$dt
  } finally { $conn.Close() }
}

function Show-Table($dt, [int]$maxWidth = 40) {
  if (-not $dt -or $dt.Rows.Count -eq 0) { Say '    (no rows)'; return }
  $cols = $dt.Columns | ForEach-Object { $_.ColumnName }
  Say ('    ' + ($cols -join ' | '))
  foreach ($r in $dt.Rows) {
    $vals = foreach ($c in $cols) {
      $v = $r[$c]
      if ($v -is [byte[]]) { "<$($v.Length) bytes>" }
      elseif ($v -is [DateTime]) { $v.ToString('yyyy-MM-dd HH:mm:ss.fff') }
      else {
        $t = [string]$v
        if ($t.Length -gt $maxWidth) { $t.Substring(0, $maxWidth) + '...' } else { $t }
      }
    }
    Say ('    ' + ($vals -join ' | '))
  }
}

# --------------------------------------------------------------------------
Section 'SQL SERVER INSTANCES'
$instances = @()
try {
  $reg = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL' -ErrorAction Stop
  $instances += $reg.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name }
} catch {}
try {
  $reg32 = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Microsoft SQL Server\Instance Names\SQL' -ErrorAction Stop
  $instances += $reg32.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $_.Name }
} catch {}
$instances = $instances | Sort-Object -Unique
if (-not $instances) { $instances = @('WINCC', 'WINCCPLUSMIG2014') }
Say ("Instances: " + ($instances -join ', '))

$candidates = New-Object System.Collections.Generic.List[object]

foreach ($inst in $instances) {
  $server = ".\$inst"
  Section "INSTANCE $server - databases"
  try {
    $dbs = Invoke-Select $server 'master' @"
SELECT d.name, d.create_date, d.state_desc,
       CAST(SUM(mf.size) * 8 / 1024 AS int) AS size_mb
  FROM sys.databases d JOIN sys.master_files mf ON mf.database_id = d.database_id
 WHERE d.database_id > 4
 GROUP BY d.name, d.create_date, d.state_desc
 ORDER BY d.create_date
"@
    Show-Table $dbs
  } catch {
    Say "    cannot connect: $($_.Exception.Message)"
    continue
  }

  foreach ($db in $dbs.Rows) {
    $dbName = [string]$db.name
    if ($db.state_desc -ne 'ONLINE') { continue }
    Section "DATABASE $server / $dbName - tables (rows)"
    try {
      $tables = Invoke-Select $server $dbName @"
SELECT s.name AS [schema], t.name AS [table], SUM(p.rows) AS [rows],
       t.modify_date
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
 GROUP BY s.name, t.name, t.modify_date
 ORDER BY SUM(p.rows) DESC, t.name
"@
      Show-Table $tables
    } catch { Say "    cannot list tables: $($_.Exception.Message)"; continue }

    # Tables that look like the batching report or the recipe screen:
    # columns named like BIN..., SET/ACT, RECIPE, BATCH, or table names to match.
    try {
      $cols = Invoke-Select $server $dbName @"
SELECT s.name AS [schema], t.name AS [table], c.name AS [column], ty.name AS [type], c.column_id
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.columns c ON c.object_id = t.object_id
  JOIN sys.types ty ON ty.user_type_id = c.user_type_id
 ORDER BY s.name, t.name, c.column_id
"@
    } catch { Say "    cannot list columns: $($_.Exception.Message)"; continue }

    # Scored, because WinCC's own databases are full of columns called
    # something-set or something-act: a BIN_n column or a recipe/batch table
    # name is the strong signal, the rest only breaks ties.
    $rowsOf = @{}
    foreach ($t in $tables.Rows) { $rowsOf["$($t.schema).$($t.table)"] = [int64]$t.rows }
    $byTable = $cols.Rows | Group-Object { "$($_.schema).$($_.table)" }
    foreach ($g in $byTable) {
      $names = $g.Group | ForEach-Object { [string]$_.column }
      $tname = $g.Name
      $score = 0
      if (@($names | Where-Object { $_ -match '(?i)^bin_?\d|bin\s*\d' }).Count -gt 0) { $score += 5 }
      if ($tname -match '(?i)recipe|batch|report|formula') { $score += 4 }
      if ($tname -match '(?i)bin|prod|weigh|mix|silo') { $score += 2 }
      if (@($names | Where-Object { $_ -match '(?i)recipe|batch|formula|weigh|qty' }).Count -gt 0) { $score += 2 }
      if (@($names | Where-Object { $_ -match '(?i)^set|^act|_set$|_act$' }).Count -gt 0) { $score += 1 }
      if ($score -gt 0) {
        $candidates.Add([pscustomobject]@{
          Server = $server; Db = $dbName; Table = $tname; Columns = $g.Group
          Score = $score; Rows = $rowsOf[$tname]
        })
      }
    }
  }
}

# --------------------------------------------------------------------------
Section 'CANDIDATE TABLES (batch / recipe / report) - columns and newest rows'
$sensitive = '(?i)user|login|pass|pwd|account|password|credential|security'
$ranked = $candidates | Sort-Object -Property @{ Expression = 'Score'; Descending = $true }, @{ Expression = 'Rows'; Descending = $true }
Say "  $(@($ranked).Count) candidate tables; the 40 strongest are sampled, the rest listed by name."
foreach ($c in ($ranked | Select-Object -Skip 40)) { Say "  (not sampled) $($c.Server) / $($c.Db) / $($c.Table)  score $($c.Score), $($c.Rows) rows" }
foreach ($c in ($ranked | Select-Object -First 40)) {
  Say ''
  Say "--- $($c.Server) / $($c.Db) / $($c.Table)   score $($c.Score), $($c.Rows) rows"
  $colList = ($c.Columns | ForEach-Object { "$($_.column):$($_.type)" }) -join ', '
  Say "    columns: $colList"
  if ($c.Table -match $sensitive) { Say '    (looks like a user/login table - not sampled)'; continue }

  $schema, $tbl = $c.Table.Split('.', 2)
  $dateCol = $c.Columns | Where-Object { $_.type -match 'date|time' } | Select-Object -First 1
  $idCol   = $c.Columns | Where-Object { $_.column -match '(?i)^(id|.*_id|sno|si_?no|s_?no)$' -and $_.type -match 'int' } | Select-Object -First 1
  $order = if ($dateCol) { "ORDER BY [$($dateCol.column)] DESC" } elseif ($idCol) { "ORDER BY [$($idCol.column)] DESC" } else { '' }
  try {
    $rows = Invoke-Select $c.Server $c.Db "SELECT TOP 5 * FROM [$schema].[$tbl] $order"
    Show-Table $rows 24
    if ($dateCol) {
      $span = Invoke-Select $c.Server $c.Db "SELECT MIN([$($dateCol.column)]) AS first_row, MAX([$($dateCol.column)]) AS last_row, COUNT(*) AS total FROM [$schema].[$tbl]"
      Show-Table $span
    }
  } catch { Say "    cannot sample: $($_.Exception.Message)" }
}

# --------------------------------------------------------------------------
# The batching report is a Reporting Services report. Its definition names the
# exact table and query behind it - the surest way to find the batch data.
Section 'REPORTING SERVICES - report definitions (data source + query)'
foreach ($inst in $instances) {
  $server = ".\$inst"
  foreach ($rsDb in @("ReportServer`$$inst", 'ReportServer')) {
    try {
      $reports = Invoke-Select $server 'master' "SELECT name FROM sys.databases WHERE name = '$rsDb'"
      if ($reports.Rows.Count -eq 0) { continue }
      $cat = Invoke-Select $server $rsDb @"
SELECT Path, Name, Type, ModifiedDate, CONVERT(varbinary(max), Content) AS Content
  FROM dbo.Catalog
 WHERE Type IN (2, 5, 8)
 ORDER BY Path
"@ 60
      foreach ($r in $cat.Rows) {
        Say ''
        Say "--- [$server/$rsDb] $($r.Path)  (type $($r.Type), modified $($r.ModifiedDate))"
        if ($r.Content -isnot [byte[]]) { continue }
        $text = [System.Text.Encoding]::UTF8.GetString($r.Content).TrimStart([char]0xFEFF)
        foreach ($m in [regex]::Matches($text, '(?is)<ConnectString>(.*?)</ConnectString>')) { Say ('    connect: ' + (Mask $m.Groups[1].Value)) }
        foreach ($m in [regex]::Matches($text, '(?is)<DataSourceReference>(.*?)</DataSourceReference>')) { Say ('    data source ref: ' + $m.Groups[1].Value) }
        foreach ($m in [regex]::Matches($text, '(?is)<CommandType>(.*?)</CommandType>')) { Say ('    command type: ' + $m.Groups[1].Value) }
        foreach ($m in [regex]::Matches($text, '(?is)<CommandText>(.*?)</CommandText>')) {
          $q = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
          Say '    query:'
          foreach ($ql in ($q -split "`n")) { Say ('      ' + $ql.TrimEnd()) }
        }
        foreach ($m in [regex]::Matches($text, '(?is)<ReportParameter Name="(.*?)"')) { Say ('    parameter: ' + $m.Groups[1].Value) }
      }
    } catch { Say "    $server/$rsDb : $($_.Exception.Message)" }
  }
}

# --------------------------------------------------------------------------
Section 'ODBC DATA SOURCES (32 and 64 bit)'
foreach ($k in @('HKLM:\SOFTWARE\ODBC\ODBC.INI', 'HKLM:\SOFTWARE\WOW6432Node\ODBC\ODBC.INI', 'HKCU:\Software\ODBC\ODBC.INI')) {
  try {
    Get-ChildItem $k -ErrorAction Stop | Where-Object { $_.PSChildName -ne 'ODBC Data Sources' } | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath
      Say ("  [$k] $($_.PSChildName): server=$($p.Server) database=$($p.Database) driver=$($p.Driver)")
    }
  } catch {}
}

# --------------------------------------------------------------------------
Section 'WINCC PROJECT FILES'
$roots = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -gt 0 } | ForEach-Object { $_.Root }
foreach ($root in $roots) {
  Get-ChildItem -Path $root -Recurse -Depth 6 -Include *.mcp, *.ap15_1, *.ap15, *.al15_1 -ErrorAction SilentlyContinue |
    Select-Object -First 30 |
    ForEach-Object { Say ("  $($_.FullName)   $($_.Length) bytes   modified $($_.LastWriteTime)") }
}
Say ''
Say 'Recipe / batch exports (csv, xlsx, xml, rdl) changed in the last 120 days:'
foreach ($root in $roots) {
  Get-ChildItem -Path $root -Recurse -Depth 6 -Include *.csv, *.xlsx, *.xml, *.rdl -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-120) -and $_.FullName -match '(?i)recipe|batch|report|wincc|siemens|amino|scada' -and $_.FullName -notmatch '(?i)\\Windows\\|\\Program Files|\\ProgramData\\Microsoft|AppData\\Local\\Microsoft' } |
    Select-Object -First 40 |
    ForEach-Object { Say ("  $($_.FullName)   modified $($_.LastWriteTime)") }
}

# --------------------------------------------------------------------------
Section 'LIVE VALUES - OPC servers registered and listening'
$progIds = Get-ChildItem 'Registry::HKEY_CLASSES_ROOT' -ErrorAction SilentlyContinue |
  Where-Object { $_.PSChildName -match '(?i)^OPCServer\.WinCC|^OPC\.WinCC|WinCC.*OPC|OPCUA|OpcUa|^OPC\.SimaticNET|^OPC\.SimaticHMI' } |
  ForEach-Object { $_.PSChildName }
Say ("  OPC ProgIDs: " + (($progIds | Sort-Object -Unique) -join ', '))
Say '  Listening ports that OPC UA commonly uses (4840-4870):'
try {
  Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -ge 4840 -and $_.LocalPort -le 4870 } |
    ForEach-Object { Say ("    $($_.LocalAddress):$($_.LocalPort) pid $($_.OwningProcess) $((Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName)") }
} catch { Say "    $($_.Exception.Message)" }
foreach ($f in @('C:\Program Files (x86)\Siemens\Automation\SCADA-RT_V11\WinCC\opc', 'C:\Program Files\Siemens\Automation\SCADA-RT_V11\WinCC\opc', 'C:\Program Files (x86)\Siemens\Automation\SCADA-RT_V11\WinCC\bin')) {
  if (Test-Path $f) {
    Get-ChildItem $f -Recurse -Depth 2 -Include *OpcUa*.xml, *OpcUa*.config, OpcUaServer*.exe -ErrorAction SilentlyContinue |
      Select-Object -First 10 | ForEach-Object { Say ("    $($_.FullName)") }
  }
}

# --------------------------------------------------------------------------
Section 'WHAT THE HELPER WOULD RUN ON'
try { Say ('  python: ' + (& python --version 2>&1)) } catch { Say '  python: not on PATH' }
try { Say ('  pip packages (pyodbc/opcua): ' + ((& python -m pip list 2>$null) -match '(?i)pyodbc|opcua|asyncua|requests' -join '; ')) } catch {}
Say ('  PowerShell: ' + $PSVersionTable.PSVersion)
try {
  $t = Test-NetConnection aminofarms.com -Port 443 -WarningAction SilentlyContinue
  Say ("  aminofarms.com:443 reachable: $($t.TcpTestSucceeded) via $($t.InterfaceAlias) ($($t.SourceAddress.IPAddress))")
} catch { Say "  aminofarms.com test failed: $($_.Exception.Message)" }

# --------------------------------------------------------------------------
Section 'DONE'
$lines | Out-File -FilePath $out -Encoding UTF8
Write-Host ''
Write-Host "Saved: $out" -ForegroundColor Green
