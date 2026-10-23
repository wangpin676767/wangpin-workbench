param([Parameter(Mandatory=$true)][ValidateSet('Info','Save','Load','Delete')][string]$Action, [string]$File = '')
# Windows Credential Manager helper for the Antigravity CLI login (target gemini:antigravity).
# Secrets never go to stdout: Info prints only identity claims; Save/Load use a DPAPI (CurrentUser) file.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class AgyCred{
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct C{public uint Flags;public uint Type;public string TargetName;public string Comment;public long LastWritten;public uint BlobSize;public IntPtr Blob;public uint Persist;public uint AttrCount;public IntPtr Attrs;public string Alias;public string User;}
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CredReadW(string t,uint ty,uint f,out IntPtr p);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CredWriteW(ref C c,uint f);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CredDeleteW(string t,uint ty,uint f);
[DllImport("advapi32.dll")]static extern void CredFree(IntPtr p);
public static byte[] Read(string target){IntPtr p;if(!CredReadW(target,1,0,out p))return null;try{C c=(C)Marshal.PtrToStructure(p,typeof(C));byte[] b=new byte[c.BlobSize];Marshal.Copy(c.Blob,b,0,(int)c.BlobSize);return b;}finally{CredFree(p);}}
public static string ReadUser(string target){IntPtr p;if(!CredReadW(target,1,0,out p))return null;try{C c=(C)Marshal.PtrToStructure(p,typeof(C));return c.User;}finally{CredFree(p);}}
public static void Write(string target,string user,byte[] blob){IntPtr m=Marshal.AllocHGlobal(blob.Length);try{Marshal.Copy(blob,0,m,blob.Length);C c=new C();c.Type=1;c.TargetName=target;c.BlobSize=(uint)blob.Length;c.Blob=m;c.Persist=2;c.User=user;if(!CredWriteW(ref c,0))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}finally{Marshal.FreeHGlobal(m);}}
public static bool Delete(string target){return CredDeleteW(target,1,0);}
}
'@
$target = 'gemini:antigravity'
function Get-Claims([byte[]]$blob) {
  try {
    $j = [Text.Encoding]::UTF8.GetString($blob) | ConvertFrom-Json
    $part = ([string]$j.id_token).Split('.')[1]
    if (-not $part) { return @{} }
    $part = $part.Replace('-', '+').Replace('_', '/'); while ($part.Length % 4) { $part += '=' }
    $c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
    return @{ email = [string]$c.email; name = [string]$c.name; sub = [string]$c.sub }
  } catch { return @{} }
}
switch ($Action) {
  'Info' {
    $b = [AgyCred]::Read($target)
    if ($null -eq $b) { Write-Output '{"exists":false}'; break }
    $c = Get-Claims $b
    @{ exists = $true; email = [string]$c.email; name = [string]$c.name; sub = [string]$c.sub } | ConvertTo-Json -Compress
  }
  'Save' {
    if (-not $File) { throw 'File is required.' }
    $b = [AgyCred]::Read($target)
    if ($null -eq $b) { throw 'No Antigravity login to save.' }
    $payload = @{ user = [string][AgyCred]::ReadUser($target); blob = [Convert]::ToBase64String($b) } | ConvertTo-Json -Compress
    $enc = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($payload), $null, 'CurrentUser')
    $tmp = "$File.$PID.tmp"
    [IO.File]::WriteAllBytes($tmp, $enc)
    Move-Item -LiteralPath $tmp -Destination $File -Force
    Write-Output '{"ok":true}'
  }
  'Load' {
    if (-not $File -or -not (Test-Path -LiteralPath $File)) { throw 'Saved login is missing.' }
    $p = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($File), $null, 'CurrentUser')) | ConvertFrom-Json
    [AgyCred]::Write($target, [string]$p.user, [Convert]::FromBase64String([string]$p.blob))
    Write-Output '{"ok":true}'
  }
  'Delete' {
    [void][AgyCred]::Delete($target)
    Write-Output '{"ok":true}'
  }
}
