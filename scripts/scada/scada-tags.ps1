<#
  SCADA stage 2 data collection for niko — READ ONLY.

  Run on the feed mill SCADA PC (DESKTOP-CK6AQJR), as the Windows user that
  normally runs WinCC:

      powershell -ExecutionPolicy Bypass -File .\scada-tags.ps1

  Collects what the live mill screen in niko needs:
    - every WinCC tag: name, data type, PLC address, group, connection, limits
    - the PLC connection(s) and channel
    - the project's text table (what alarm and label texts say)
    - the OPC UA server's configuration, and whether it is set to start
    - the list of screens in the project, and the project folder layout
    - what is listening on the PC, by process

  It only runs SELECT statements and copies or lists files. It changes nothing
  in SQL Server, WinCC or the PLC. It writes one folder on the Desktop,
  scada_step2_<time>, and a zip of it - send the zip back.

  Password tables (PW_*) are never read; passwords in config files are masked.
#>

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$desk  = [Environment]::GetFolderPath('Desktop')
$dir   = Join-Path $desk "scada_step2_$stamp"
New-Item -ItemType Directory -Path $dir | Out-Null
$log   = New-Object System.Collections.Generic.List[string]
function Say([string]$s) { $log.Add($s); Write-Host $s }
function Section([string]$s) { Say ''; Say "===== $s =====" }
function Mask([string]$s) {
  if (-not $s) { return $s }
  $s = $s -replace '(?i)(password|pwd|passwd)(\s*[=:]\s*|"\s*:\s*"|>)([^;<"\s]*)', '$1$2***'
  return $s
}

Add-Type -AssemblyName System.Data
function Invoke-Select([string]$server, [string]$database, [string]$sql) {
  if ($sql -notmatch '^\s*(SELECT|WITH)\b') { throw "refusing a non-SELECT statement" }
  $cs = "Server=$server;Database=$database;Integrated Security=SSPI;Application Name=niko-step2;Connect Timeout=10"
  $conn = New-Object System.Data.SqlClient.SqlConnection $cs
  try {
    $conn.Open()
    $iso = $conn.CreateCommand(); $iso.CommandText = 'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED'; [void]$iso.ExecuteNonQuery()
    $cmd = $conn.CreateCommand(); $cmd.CommandTimeout = 60; $cmd.CommandText = $sql
    $da = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $dt = New-Object System.Data.DataTable
    [void]$da.Fill($dt)
    return ,$dt
  } finally { $conn.Close() }
}
function Save-Csv($dt, [string]$name) {
  $path = Join-Path $dir $name
  if (-not $dt -or $dt.Rows.Count -eq 0) { Say "  $name : (no rows)"; return }
  # Binary columns (row versions) are dropped; everything else as text.
  $cols = $dt.Columns | Where-Object { $_.DataType -ne [byte[]] } | ForEach-Object { $_.ColumnName }
  $dt.Rows | Select-Object $cols | Export-Csv -Path $path -NoTypeInformation -Encoding UTF8
  Say "  $name : $($dt.Rows.Count) rows"
}

Say "SCADA step 2 collection - $(Get-Date)"
Say "Computer: $env:COMPUTERNAME   User: $env:USERDOMAIN\$env:USERNAME"
$server = '.\WINCC'

# The project database is the newest CC_* that is not the runtime (...R) one.
Section 'PROJECT DATABASE'
$dbs = Invoke-Select $server 'master' "SELECT name, create_date FROM sys.databases WHERE name LIKE 'CC[_]%' ORDER BY create_date DESC"
$proj = ($dbs.Rows | Where-Object { $_.name -notmatch 'R$' } | Select-Object -First 1).name
$rt   = ($dbs.Rows | Where-Object { $_.name -match 'R$' } | Select-Object -First 1).name
Say "  configuration: $proj"
Say "  runtime:       $rt"

# --------------------------------------------------------------------------
Section 'TAGS'
try {
  $tags = Invoke-Select $server $proj @"
SELECT v.VARIABLEID, v.VARIABLENAME, t.*, g.*, c.*, v.ADDRESSPARAMETER, v.PLCVARIABLENAME, v.PLCBLOCKNAME,
       v.CONNECTIONID, v.VARGROUPID, v.VARIABLETYPEID, v.ASDATASIZE, v.OSDATASIZE, v.CYCLETIMEID,
       v.MAXLIMIT, v.MINLIMIT, v.STARTVALUE, v.SUBSTVALUE, v.SCALETYPE, v.SCALEPARAM1, v.SCALEPARAM2,
       v.SCALEPARAM3, v.SCALEPARAM4, v.FORMATFITTING, v.VARFLAGS, v.VARFLAGS2, v.VARPROPERTY,
       v.COMMENTS, v.LASTCHANGE
  FROM MCPTVARIABLEDESC v
  LEFT JOIN MCPTVARIABLETYPE t ON t.VARIABLETYPEID = v.VARIABLETYPEID
  LEFT JOIN MCPTVARGROUP g ON g.VARGROUPID = v.VARGROUPID
  LEFT JOIN MCPTCONNECTION c ON c.CONNECTIONID = v.CONNECTIONID
 ORDER BY v.VARIABLENAME
"@
  Save-Csv $tags 'tags.csv'
} catch {
  Say "  joined export failed ($($_.Exception.Message)); exporting the tag table alone"
  try { Save-Csv (Invoke-Select $server $proj 'SELECT * FROM MCPTVARIABLEDESC ORDER BY VARIABLENAME') 'tags.csv' } catch { Say "  $($_.Exception.Message)" }
}
foreach ($t in @('MCPTVARIABLETYPE', 'MCPTVARGROUP', 'MCPTCONNECTION', 'MCPTCHANNEL', 'MCPTCHANNELUNIT',
                 'MCPTCYCLETIME', 'MCPTSTARTUNIT', 'MCPTPROJECT', 'MCPTMACHINE', 'CC_Prj_Options', 'MCPTSYSTEMTABLES')) {
  try { Save-Csv (Invoke-Select $server $proj "SELECT * FROM [$t]") "$t.csv" } catch { Say "  $t : $($_.Exception.Message)" }
}

# Texts: alarm texts and labels that say what a tag or a bit means.
Section 'TEXTS'
try { Save-Csv (Invoke-Select $server $proj 'SELECT * FROM TXTTable') 'TXTTable.csv' } catch { Say "  $($_.Exception.Message)" }
foreach ($t in @('MSMsgs', 'MSClass', 'MSType', 'MSBlock', 'MSMsgGroup', 'MSInfotext', 'CC_Step7Text')) {
  try { Save-Csv (Invoke-Select $server $proj "SELECT * FROM [$t]") "$t.csv" } catch { Say "  $t : $($_.Exception.Message)" }
}

# The tables the runtime database holds, and their sizes, for the record.
Section 'RUNTIME DATABASE TABLES'
try {
  Save-Csv (Invoke-Select $server $rt @"
SELECT t.name AS [table], SUM(p.rows) AS [rows]
  FROM sys.tables t JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
 GROUP BY t.name ORDER BY t.name
"@) 'runtime_tables.csv'
} catch { Say "  $($_.Exception.Message)" }

# --------------------------------------------------------------------------
Section 'OPC UA SERVER CONFIGURATION'
$opcFiles = @(
  'D:\HMI_5TG9\OPC\UASERVER\OPCUASERVERWINCCPRO.XML',
  'C:\Program Files (x86)\Siemens\Automation\SCADA-RT_V11\WinCC\bin\OpcUaServerWinCC.xml'
)
Get-ChildItem 'D:\HMI_5TG9\OPC' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $opcFiles += $_.FullName }
$opcDir = Join-Path $dir 'opcua'
New-Item -ItemType Directory -Path $opcDir | Out-Null
foreach ($f in ($opcFiles | Sort-Object -Unique)) {
  if (-not (Test-Path $f)) { Say "  missing: $f"; continue }
  $item = Get-Item $f
  if ($item.Length -gt 2MB -or $item.Extension -notmatch '(?i)\.(xml|config|ini|txt|json)$') { Say "  listed only: $f ($($item.Length) bytes)"; continue }
  $text = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
  $name = ($f -replace '[:\\ ]', '_')
  Set-Content -LiteralPath (Join-Path $opcDir $name) -Value (Mask $text) -Encoding UTF8
  Say "  copied: $f  (modified $($item.LastWriteTime))"
  foreach ($m in [regex]::Matches($text, '(?i)opc\.tcp://[^<"\s]+|<Port>\s*\d+\s*</Port>|port\s*=\s*"?\d+')) { Say "    endpoint/port: $($m.Value)" }
}
Say ''
Say '  OPC UA processes running now:'
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '(?i)opcua|opc_ua|uaserver' } |
  ForEach-Object { Say "    $($_.ProcessName) pid $($_.Id)" }
Say '  Listening TCP ports, with process:'
try {
  Get-NetTCPConnection -State Listen -ErrorAction Stop | Sort-Object LocalPort -Unique | ForEach-Object {
    $p = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Say ("    {0,-6} {1,-16} {2}" -f $_.LocalPort, $_.LocalAddress, $p)
  }
} catch { Say "    $($_.Exception.Message)" }

# --------------------------------------------------------------------------
Section 'SCREENS AND PROJECT FOLDER'
$projDir = 'D:\HMI_5TG9'
if (Test-Path $projDir) {
  Get-ChildItem $projDir -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Where-Object { $_.PSIsContainer } |
    ForEach-Object { Say "  [dir] $($_.FullName)" }
  Say ''
  Say '  Screens (.pdl):'
  Get-ChildItem $projDir -Recurse -Include *.pdl -ErrorAction SilentlyContinue | Sort-Object Name |
    ForEach-Object { Say ("    {0,-40} {1,10} bytes  {2}" -f $_.Name, $_.Length, $_.LastWriteTime) }
  Say ''
  Say '  Scripts (.fct, .h, .bmo, .bac):'
  Get-ChildItem $projDir -Recurse -Include *.fct, *.h, *.bmo, *.bac -ErrorAction SilentlyContinue | Sort-Object FullName |
    Select-Object -First 80 | ForEach-Object { Say "    $($_.FullName)" }
} else { Say "  $projDir not found" }

# --------------------------------------------------------------------------
Section 'LICENCES (names only)'
foreach ($k in @('HKLM:\SOFTWARE\WOW6432Node\Siemens\AUTSW\LicenseManager', 'HKLM:\SOFTWARE\Siemens\AUTSW\LicenseManager')) {
  if (Test-Path $k) { Get-ChildItem $k -Recurse -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { Say "  $($_.Name)" } }
}
$alm = Get-ChildItem 'C:\Program Files*\Common Files\Siemens\sws' -Recurse -Filter 'almcmd*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($alm) {
  Say "  $($alm.FullName) /list:"
  try { & $alm.FullName /list 2>&1 | Select-Object -First 60 | ForEach-Object { Say "    $_" } } catch { Say "    $($_.Exception.Message)" }
} else { Say '  almcmd not found - licence list must come from the Automation License Manager window' }

# --------------------------------------------------------------------------
Section 'DONE'
$log | Out-File -FilePath (Join-Path $dir 'report.txt') -Encoding UTF8
$zip = "$dir.zip"
Compress-Archive -Path "$dir\*" -DestinationPath $zip -Force
Write-Host ''
Write-Host "Saved: $zip" -ForegroundColor Green
