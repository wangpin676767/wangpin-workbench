using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
[assembly: AssemblyTitle("wangpin Setup OpenSource")]
[assembly: AssemblyCompany("Wangpin")]
[assembly: AssemblyProduct("wangpin 多模型工作台 開源版本")]
[assembly: AssemblyCopyright("Copyright © Wangpin")]
[assembly: AssemblyVersion("@APP_VERSION@.0")]
[assembly: AssemblyFileVersion("@APP_VERSION@.0")]
class Setup {
  const string AppVersion = "@APP_VERSION@";
  const string AppName = "wangpin 多模型工作台 開源版本";
  const string ExeName = "WangpinMultiOpenSource.exe";
  static string Destination { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "WangpinMultiOpenSource"); } }
  const string RegistryKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\WangpinMultiOpenSource";
  // Authenticode appends its certificate after the overlay, with up to seven
  // alignment bytes. The security directory uses a file offset, not an RVA.
  static long PayloadEnd(Stream stream) {
    var reader = new BinaryReader(stream);
    if (stream.Length < 64) throw new InvalidDataException("Invalid installer header");
    stream.Position = 0;
    if (reader.ReadUInt16() != 0x5a4d) throw new InvalidDataException("Invalid DOS header");
    stream.Position = 0x3c; long pe = reader.ReadUInt32();
    if (pe < 64 || pe > stream.Length - 24) throw new InvalidDataException("Invalid PE offset");
    stream.Position = pe;
    if (reader.ReadUInt32() != 0x4550) throw new InvalidDataException("Invalid PE header");
    stream.Position = pe + 20; int optionalSize = reader.ReadUInt16();
    long optional = pe + 24;
    if (optionalSize < 2 || optional > stream.Length - optionalSize) throw new InvalidDataException("Invalid optional header");
    stream.Position = optional; int magic = reader.ReadUInt16();
    int directory = magic == 0x20b ? 112 : magic == 0x10b ? 96 : -1;
    if (directory < 0 || optionalSize < directory + 40) throw new InvalidDataException("Invalid PE directory");
    stream.Position = optional + directory - 4;
    if (reader.ReadUInt32() < 5) throw new InvalidDataException("Missing security directory");
    stream.Position = optional + directory + 32;
    long certificate = reader.ReadUInt32(); long size = reader.ReadUInt32();
    if (certificate == 0 && size == 0) return stream.Length;
    if (certificate < optional + optionalSize || (certificate & 7) != 0 || size < 8 || certificate > stream.Length - size || certificate + size != stream.Length)
      throw new InvalidDataException("Invalid certificate bounds");
    long cursor = certificate;
    while (cursor < stream.Length) {
      if (stream.Length - cursor < 8) throw new InvalidDataException("Invalid certificate entry");
      stream.Position = cursor; long length = reader.ReadUInt32();
      if (length < 8 || length > stream.Length - cursor || reader.ReadUInt16() != 0x200 || reader.ReadUInt16() != 2)
        throw new InvalidDataException("Invalid certificate entry");
      cursor += (length + 7) & ~7L;
    }
    if (cursor != stream.Length) throw new InvalidDataException("Invalid certificate alignment");
    return certificate;
  }
  static long[] PayloadBounds(Stream stream) {
    long end = PayloadEnd(stream);
    var reader = new BinaryReader(stream);
    for (int padding = 0; padding <= 7 && end - padding >= 16; padding++) {
      long trailer = end - padding - 16;
      stream.Position = trailer + 8;
      if (Encoding.ASCII.GetString(reader.ReadBytes(8)) != "CMZIP170") continue;
      stream.Position = trailer; long offset = reader.ReadInt64();
      if (offset < 1 || offset >= trailer) throw new InvalidDataException("Invalid payload offset");
      stream.Position = end - padding;
      for (int i = 0; i < padding; i++) if (reader.ReadByte() != 0) throw new InvalidDataException("Invalid signing padding");
      return new long[] { offset, trailer };
    }
    throw new InvalidDataException("Missing installer payload trailer");
  }
  static void Extract(string dest) {
    using (var stream = File.OpenRead(Application.ExecutablePath)) {
      long[] bounds = PayloadBounds(stream);
      long offset = bounds[0];
      stream.Position = offset;
      using (var payload = new MemoryStream()) {
        var buffer = new byte[1024 * 1024]; long remaining = bounds[1] - offset;
        while (remaining > 0) { int n = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining)); if (n == 0) throw new EndOfStreamException(); payload.Write(buffer, 0, n); remaining -= n; }
        payload.Position = 0;
        using (var zip = new ZipArchive(payload, ZipArchiveMode.Read)) {
          var prefix = Path.GetFullPath(dest).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
          foreach (var entry in zip.Entries) {
            var file = Path.GetFullPath(Path.Combine(dest, entry.FullName));
            if (!file.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new Exception("無效的安裝檔案路徑。");
            if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(file); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            using (var input = entry.Open()) using (var output = File.Create(file)) input.CopyTo(output);
          }
        }
      }
    }
  }
  static void Shortcut(string location) {
    dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
    dynamic shortcut = shell.CreateShortcut(location);
    shortcut.TargetPath = Path.Combine(Destination, ExeName); shortcut.WorkingDirectory = Destination;
    shortcut.IconLocation = shortcut.TargetPath + ",0"; shortcut.Save();
  }
  static bool RequireClosed() {
    while (Process.GetProcessesByName("WangpinMultiOpenSource").Length > 0) {
      if (MessageBox.Show("多模型工作台仍在執行。請儲存進度並自行關閉 app，再按重試。安裝程式不會強制結束你的任務。", "請先關閉 app", MessageBoxButtons.RetryCancel, MessageBoxIcon.Information) != DialogResult.Retry) return false;
    }
    return true;
  }
  static void RemoveShortcut(string location) {
    if (!File.Exists(location)) return;
    dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
    dynamic shortcut = shell.CreateShortcut(location);
    string target = shortcut.TargetPath;
    if (String.Equals(target, Path.Combine(Destination, ExeName), StringComparison.OrdinalIgnoreCase)) File.Delete(location);
  }
  [STAThread] static int Main(string[] args) {
    Application.EnableVisualStyles();
    try {
      if (args.Length == 2 && args[0] == "--extract") { Extract(Path.GetFullPath(args[1])); return 0; }
      if (args.Length == 1 && args[0] == "--cleanup") {
        Thread.Sleep(3000);
        // The deletion target is a fixed, versioned install directory under this user's LocalAppData.
        if (Directory.Exists(Destination)) Directory.Delete(Destination, true);
        return 0;
      }
      if (args.Length == 1 && args[0] == "--uninstall") {
        if (!String.Equals(Path.GetDirectoryName(Application.ExecutablePath), Destination, StringComparison.OrdinalIgnoreCase)) throw new Exception("請從已安裝的資料夾執行解除安裝。");
        if (MessageBox.Show("解除安裝 " + AppName + " " + AppVersion + "？對話與設定會保留。", AppName, MessageBoxButtons.OKCancel) != DialogResult.OK) return 0;
        if (!RequireClosed()) return 0;
        RemoveShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"));
        RemoveShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"));
        Registry.CurrentUser.DeleteSubKeyTree(RegistryKey, false);
        var temp = Path.Combine(Path.GetTempPath(), "CodexMulti-Uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
        File.Copy(Application.ExecutablePath, temp);
        Process.Start(new ProcessStartInfo(temp, "--cleanup") { UseShellExecute = false, CreateNoWindow = true });
        return 0;
      }
      if (MessageBox.Show("安裝 " + AppName + " " + AppVersion + "\n\n" + Destination + "\n\n保留現有對話與設定，並更新桌面捷徑。請先關閉多模型工作台。", AppName + " 安裝程式", MessageBoxButtons.OKCancel, MessageBoxIcon.Information) != DialogResult.OK) return 0;
      if (!RequireClosed()) return 0;
      var form = new Form { Text = "安裝 " + AppName + " " + AppVersion, Width = 430, Height = 130, StartPosition = FormStartPosition.CenterScreen, ControlBox = false };
      form.Controls.Add(new Label { Text = "正在解壓縮安裝檔，請稍候…", AutoSize = true, Left = 25, Top = 25 }); form.Show(); Application.DoEvents();
      string staging = Destination + ".staging-" + Guid.NewGuid().ToString("N");
      try { Extract(staging); }
      catch { try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { } throw; }
      string backup = Destination + ".backup-" + Guid.NewGuid().ToString("N");
      bool hadPrevious = Directory.Exists(Destination);
      if (hadPrevious) Directory.Move(Destination, backup);
      try { Directory.Move(staging, Destination); }
      catch { if (hadPrevious && !Directory.Exists(Destination)) Directory.Move(backup, Destination); throw; }
      if (hadPrevious) { try { Directory.Delete(backup, true); } catch { /* 舊檔被占用時留著，不影響新版 */ } }
      Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"));
      var startMenu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); Shortcut(startMenu);
      using (var key = Registry.CurrentUser.CreateSubKey(RegistryKey)) {
        key.SetValue("DisplayName", AppName); key.SetValue("DisplayVersion", AppVersion); key.SetValue("Publisher", "Wangpin"); key.SetValue("InstallLocation", Destination);
        key.SetValue("UninstallString", "\"" + Path.Combine(Destination, "Uninstall.exe") + "\" --uninstall"); key.SetValue("DisplayIcon", Path.Combine(Destination, ExeName));
      }
      form.Close();
      if (MessageBox.Show("安裝完成。現在啟動？", AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information) == DialogResult.Yes) Process.Start(Path.Combine(Destination, ExeName));
      return 0;
    } catch (Exception e) {
      if (args.Length > 0 && args[0] == "--extract") { File.WriteAllText(Application.ExecutablePath + ".error.txt", e.ToString()); return 1; }
      MessageBox.Show(e.Message, AppName + " 安裝失敗", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1;
    }
  }
}
