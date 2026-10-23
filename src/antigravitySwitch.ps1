param([Parameter(Mandatory=$true)][string]$Executable, [switch]$Probe, [switch]$ProbeLogoutMenu, [string]$ProbeResult = '')
$ErrorActionPreference = 'Stop'
# Use only this newly-created console's input buffer. No SendKeys, focus changes,
# credential reads, terminal transcripts, or arbitrary prompt/command arguments.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AgySwitchConsole {
 [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public short L,T,R,B; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size,Cursor; public ushort Attributes; public Rect Window; public Coord Max; }
 [StructLayout(LayoutKind.Explicit,Size=20)] public struct Input {
  [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public int Down;
  [FieldOffset(8)] public ushort Repeat; [FieldOffset(10)] public ushort Key;
  [FieldOffset(12)] public ushort Scan; [FieldOffset(14)] public char Char;
  [FieldOffset(16)] public uint Flags;
 }
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h,out Info i);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadConsoleOutputCharacterW(IntPtr h,StringBuilder text,uint n,Coord c,out uint read);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool WriteConsoleInputW(IntPtr h,Input[] inputs,uint n,out uint written);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern short VkKeyScanW(char c);
 public static string Read() {
  Info i;var h=GetStdHandle(-11);
  if(!GetConsoleScreenBufferInfo(h,out i)) throw new Exception("A real Windows console is required.");
  var start=new Coord { X=0,Y=(short)Math.Max(0,i.Cursor.Y-55) };
  int count=Math.Min(30000,(Math.Max(i.Cursor.Y+8,i.Window.B+1)-start.Y)*i.Size.X);
  var b=new StringBuilder(count); uint read;
  if(!ReadConsoleOutputCharacterW(h,b,(uint)count,start,out read))throw new Exception("Cannot read owned console.");
  var raw=b.ToString();var text=new StringBuilder();
  for(int at=0;at<raw.Length;at+=i.Size.X)text.AppendLine(raw.Substring(at,Math.Min(i.Size.X,raw.Length-at)));
  return text.ToString();
 }
 public static void Type(string text) {
  var input=new Input[text.Length*2];
  for(int j=0;j<text.Length;j++) {
   var c=text[j];var key=(ushort)(VkKeyScanW(c)&255);
   if(c=='\r')key=13;
   input[2*j]=new Input {Type=1,Down=1,Repeat=1,Key=key,Char=c};
   input[2*j+1]=new Input {Type=1,Down=0,Repeat=1,Key=key,Char=c};
  }
  uint written;
  if(!WriteConsoleInputW(GetStdHandle(-10),input,(uint)input.Length,out written)||written!=input.Length)throw new Exception("Cannot write owned console input.");
 }
}
'@

Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
# Auto-login helper: read ONLY Brave/Chromium windows whose active tab title contains
# "Antigravity", and only the antigravity.google/oauth-callback address. The caller
# accepts a code solely when its OAuth state equals the state this CLI printed, so
# codes from other (stale or background) sign-in tabs can never be submitted.
function Get-CallbackCodes {
 $found=@()
 try {
  $root=[Windows.Automation.AutomationElement]::RootElement
  $edit=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)
  $textCond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Text)
  foreach($w in $root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)){
   $n=''; try{$n=$w.Current.Name}catch{}
   if($n -notmatch 'Antigravity'){continue}
   foreach($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants,$edit)){
    $v=''; try{$v=$e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value}catch{continue}
    if($v -notmatch 'antigravity\.google/oauth-callback\?(.*)$'){continue}
    $q=@{}; foreach($pair in ($Matches[1] -split '&')){ $kv=$pair -split '=',2; if($kv.Count -eq 2){ try{$q[$kv[0]]=[Uri]::UnescapeDataString($kv[1].Replace('+',' '))}catch{} } }
    if(-not $q['state']){continue}
    $code=$q['code']
    if(-not $code){
     foreach($t in $w.FindAll([Windows.Automation.TreeScope]::Descendants,$textCond)){ try{$x=$t.Current.Name.Trim()}catch{continue}; if($x -match '^4/[A-Za-z0-9_\-\.]{20,}$'){$code=$x;break} }
    }
    if($code -match '^4/[A-Za-z0-9_\-\.]{20,}$'){ $found+=[pscustomobject]@{State=$q['state'];Code=$code} }
   }
  }
 } catch {}
 return $found
}
function Test-SignedIn { try { & $Executable models *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false } }
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Antigravity CLI executable is missing.' }
$child = $null
try {
 [Console]::Clear()
 $child = Start-Process -FilePath $Executable -NoNewWindow -PassThru
 $deadline = [DateTime]::UtcNow.AddSeconds(35)
 $ready = $false; $signedOut = $false
 while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited) {
  $screen = [AgySwitchConsole]::Read()
  if ($screen -match 'Antigravity CLI' -and $screen -match '(?m)^\s*>\s*$') { $ready=$true; break }
  if (-not $Probe -and $screen -match '(?i)not signed in' -and $screen -match '(?i)Select login method') { $ready=$true; $signedOut=$true; break }
  Start-Sleep -Milliseconds 120
 }
 if (-not $ready) { throw 'CLI prompt was not ready. No logout command was submitted.' }
 if (-not $signedOut) {
 # Initial prompts bypass slash-command dispatch in CLI 1.4.3. Enter through
 # the real interactive input, then require the builtin completion BEFORE Enter.
 $command = if ($Probe -and -not $ProbeLogoutMenu) { '/help' } else { '/logout' }
 $expected = if ($Probe -and -not $ProbeLogoutMenu) { '(?m)^[ \t]*>[ \t]*/help[ \t]+Show available commands[^\r\n]*\r?$' } else { '(?m)^[ \t]*>[ \t]*/logout[ \t]+Log out[ \t]*\r?$' }
 $composer = '(?m)^[ \t]*>[ \t]*' + [regex]::Escape($command) + '[ \t]*\r?$'
 [AgySwitchConsole]::Type($command)
 $matched=$false
 $deadline=[DateTime]::UtcNow.AddSeconds(8)
 while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited) {
  $screen=[AgySwitchConsole]::Read()
  if ($screen -match $expected -and $screen -match $composer) { $matched=$true;break }
  Start-Sleep -Milliseconds 120
 }
 if (-not $matched) { throw 'Builtin slash command was not recognized. Nothing was sent to the model.' }
 $screen=[AgySwitchConsole]::Read()
 if($screen -notmatch $expected -or $screen -notmatch $composer){throw 'CLI input changed before submission. Nothing was sent to the model.'}
 if ($Probe -and $ProbeLogoutMenu) {
  $child.Kill();$child.WaitForExit()
  if ($ProbeResult) { [IO.File]::WriteAllText($ProbeResult, '{"ok":true,"logoutBuiltinMenuMatched":true,"logoutSubmitted":false}') }
  exit 0
 }
 [AgySwitchConsole]::Type("`r")
 if ($Probe) {
  $deadline=[DateTime]::UtcNow.AddSeconds(8);$verified=$false
  while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited) {
   $screen=[AgySwitchConsole]::Read()
   if ($screen -match 'Antigravity CLI\s+general\s+commands\s+shortcuts' -and $screen -match 'understands your codebase|Keyboard:|Version\s+\d') { $verified=$true;break }
   Start-Sleep -Milliseconds 120
  }
  if(-not $verified){throw ('Local help command result missing: general={0}, quick={1}, menu={2}, prompt={3}, quota={4}' -f ($screen -match 'general'),($screen -match 'Quick Reference'),($screen -match '/help\s+Show'),($screen -match '>\s*/help'),($screen -match 'quota reached'))}
  $child.Kill();$child.WaitForExit()
  if ($ProbeResult) { [IO.File]::WriteAllText($ProbeResult, '{"ok":true,"builtinMenuMatched":true,"localHelpResultVerified":true,"logoutSubmitted":false}') }
  Write-Output 'LOCAL_SLASH_COMMAND_VERIFIED';exit 0
 }
 }
 # Fully automatic sign-in (CLI 1.4.3 screens, observed): after logout the CLI shows
 # "Select login method: > 1. Google OAuth"; Enter opens the browser and the CLI
 # prints the OAuth URL (with state=...) and an "authorization code" input.
 $relaunches=0;$attempts=0;$selected=$false;$typedAt=$null;$tried=@()
 $end=[DateTime]::UtcNow.AddMinutes(10)
 while([DateTime]::UtcNow -lt $end){
  if($child.HasExited){
   if($typedAt -and (Test-SignedIn)){Write-Output 'LOGIN_COMPLETED';exit 0}
   if($relaunches -ge 3){throw 'Antigravity CLI exited repeatedly before sign-in finished.'}
   $child=Start-Process -FilePath $Executable -NoNewWindow -PassThru;$relaunches++;$selected=$false;$typedAt=$null;Start-Sleep -Milliseconds 800;continue
  }
  $screen=[AgySwitchConsole]::Read()
  if($typedAt){
   if($screen -match '(?i)got an error|invalid_grant|token exchange failed|press any key to go back'){
    if($attempts -ge 3){throw 'Sign-in was rejected three times. Close this window and try the account switch again.'}
    [AgySwitchConsole]::Type(' ');$typedAt=$null;$selected=$false;Start-Sleep -Milliseconds 800;continue
   }
   if(([DateTime]::UtcNow-$typedAt).TotalSeconds -gt 2 -and $screen -notmatch '(?i)authorization code' -and (Test-SignedIn)){
    $child.Kill();$child.WaitForExit();Write-Output 'LOGIN_COMPLETED';exit 0
   }
   if(([DateTime]::UtcNow-$typedAt).TotalSeconds -gt 90){throw 'Sign-in did not finish within 90 seconds after the code was entered.'}
  } elseif(-not $selected -and $screen -match '(?mi)^\s*[>\u276f]\s*1\.\s*Google OAuth\s*$'){
   Start-Sleep -Milliseconds 300
   if([AgySwitchConsole]::Read() -match '(?mi)^\s*[>\u276f]\s*1\.\s*Google OAuth\s*$'){ [AgySwitchConsole]::Type("`r");$selected=$true;$attempts++ }
  } elseif($screen -match '(?i)authorization code'){
   $selected=$true
   $flat=$screen -replace '\s',''
   foreach($c in (Get-CallbackCodes)){
    if($tried -contains $c.Code -or -not $flat.Contains('state='+$c.State)){continue}
    [AgySwitchConsole]::Type($c.Code);Start-Sleep -Milliseconds 500
    if(-not (([AgySwitchConsole]::Read() -replace '\s','').Contains($c.Code))){throw 'The authorization code was not entered completely. Nothing was submitted.'}
    [AgySwitchConsole]::Type("`r");$tried+=$c.Code;$typedAt=[DateTime]::UtcNow;break
   }
  }
  Start-Sleep -Milliseconds 600
 }
 throw 'Sign-in did not finish within 10 minutes. Nothing else was submitted.'
} catch {
 if($child -and -not $child.HasExited){$child.Kill();$child.WaitForExit()}
 if($Probe -and $ProbeResult){[IO.File]::WriteAllText($ProbeResult, (@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress))}
 Write-Error $_
 exit 1
}
