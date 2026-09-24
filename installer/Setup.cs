// Greg-Setup.exe - puts Greg on this PC as one program, and takes him off again.
//
// Built by installer\build.ps1 with the C# compiler that is part of Windows
// (.NET Framework 4), exactly as Greg.exe is, so it is C# 5: no string
// interpolation, no ?. and no nameof. ASCII ONLY, for the reason Greg.cs gives.
//
// The same source builds two programs:
//   Greg-Setup.exe  carries the payload as an embedded zip: Greg's files, his
//                   node_modules, the Node.js runtime and a built Greg.exe.
//   uninstall.exe   is built without one. It travels inside the payload, lands
//                   in Greg's folder, and is what Settings > Apps runs.
//
// Installing:
//   - copies the payload into %LOCALAPPDATA%\Programs\Greg. Per user, so there
//     is no administrator prompt - and there cannot be one, because Greg keeps
//     his settings and memory beside his program files, and Program Files is
//     not writable by the program that has to write them.
//   - writes .greg-install, the list of files it put there. An update deletes
//     what the old list names and the new payload does not have; the
//     uninstaller deletes what the list names. Nothing else in the folder is
//     ever touched by either.
//   - makes a Start menu shortcut, a desktop one if asked, and an entry in
//     Settings > Apps (HKCU: this user only).
//
// WHAT IS NEVER TOUCHED is what Greg makes as he runs: config.json, .env,
// memory.json, reminders.json, personality.json, conversations.jsonl,
// phones.json, spotify-tokens.json, voices\, engines\, cache\, screenshots\.
// None of them can be in the payload - build.ps1 refuses to build one that has
// them, and test/installer.test.js fails if git ever tracks them - so no
// install list can name them. The uninstaller deletes them only when the box
// that says so, in those words, is ticked. Deleting needs the user's own words.
//
// It downloads nothing. Greg's own setup screen does that on his first start,
// with every size shown, and asks first.
//
// For testing and for scripts, both programs take:
//   /quiet           no windows; the exit code says what happened (0 done,
//                    1 failed part-way, 2 refused before starting)
//   /log=FILE        append what happened to FILE
// Greg-Setup.exe also takes /dir=FOLDER, /noshortcuts, /nodesktop, /noapps (no
// Settings > Apps entry) and /nolaunch; uninstall.exe takes /deletedata.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace GregSetup
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Options options = Options.Parse(args);
            Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
            if (payload == null) return Uninstall(options);
            using (payload) return Install(payload, options);
        }

        static int Install(Stream payload, Options o)
        {
            string dir = Folder.Normalise(o.Dir ?? Folder.Default());
            if (!o.Quiet)
            {
                Application.Run(new InstallForm(payload, dir, o));
                return 0;
            }

            Log log = new Log(o.LogFile);
            string refusal = Installer.Refusal(dir);
            if (refusal != null) { log.Line("refused: " + refusal); return 2; }
            try
            {
                Installer.Install(payload, dir, o, null);
                log.Line("installed " + BuildInfo.Label + " in " + dir);
                return 0;
            }
            catch (Exception err)
            {
                log.Line("failed: " + err.Message);
                return 1;
            }
        }

        static int Uninstall(Options o)
        {
            string dir = Folder.Normalise(o.Dir ?? AppDomain.CurrentDomain.BaseDirectory);
            Record record = Record.Read(dir);
            Log log = new Log(o.LogFile);
            if (record == null || record.Uninstalled)
            {
                string none = "Greg was not installed in this folder by Greg-Setup, so there is nothing here this can remove:\n" + dir;
                if (o.Quiet) log.Line("refused: " + none);
                else MessageBox.Show(none, "Uninstall Greg", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 2;
            }
            if (!o.Quiet)
            {
                Application.Run(new UninstallForm(dir, record));
                return 0;
            }

            List<string> running = Folder.Running(dir);
            if (running.Count > 0) { log.Line("refused: still running: " + string.Join(", ", running.ToArray())); return 2; }
            Uninstaller.Result result = Uninstaller.Run(dir, record, o.DeleteData);
            log.Line("uninstalled from " + dir + "; kept: " + string.Join(", ", result.Kept.ToArray())
                + (result.Failed.Count > 0 ? "; could not delete: " + string.Join(", ", result.Failed.ToArray()) : ""));
            return result.Failed.Count > 0 ? 1 : 0;
        }

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
    }

    sealed class Options
    {
        public bool Quiet;
        public string Dir;
        public bool StartMenu = true;
        public bool Desktop = true;
        public bool AppsEntry = true;
        public bool Launch = true;
        public bool DeleteData;
        public string LogFile;

        public static Options Parse(string[] args)
        {
            Options o = new Options();
            foreach (string raw in args)
            {
                string a = raw.Trim();
                string lower = a.ToLowerInvariant();
                if (lower == "/quiet") o.Quiet = true;
                else if (lower.StartsWith("/dir=")) o.Dir = a.Substring(5).Trim('"');
                else if (lower == "/noshortcuts") { o.StartMenu = false; o.Desktop = false; }
                else if (lower == "/nodesktop") o.Desktop = false;
                else if (lower == "/noapps") o.AppsEntry = false;
                else if (lower == "/nolaunch") o.Launch = false;
                else if (lower == "/deletedata") o.DeleteData = true;
                else if (lower.StartsWith("/log=")) o.LogFile = a.Substring(5).Trim('"');
            }
            // Nobody is watching a quiet install, so nobody asked for a window.
            if (o.Quiet) o.Launch = false;
            return o;
        }
    }

    /// <summary>What a quiet run says, for whoever ran it.</summary>
    sealed class Log
    {
        readonly string file;
        public Log(string file) { this.file = file; }
        public void Line(string text)
        {
            if (string.IsNullOrEmpty(file)) return;
            try { File.AppendAllText(file, DateTime.Now.ToString("s") + " " + text.Replace("\n", " ") + "\r\n"); } catch (Exception) { }
        }
    }

    /// <summary>Where Greg goes, and whether anything is in the way.</summary>
    static class Folder
    {
        public static string Default()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs\\Greg");
        }

        public static string Normalise(string dir)
        {
            string full = Path.GetFullPath(dir);
            string root = Path.GetPathRoot(full);
            return full.Length > root.Length ? full.TrimEnd('\\', '/') : full;
        }

        /// <summary>A path from an install list, made absolute - or null if it would land outside the folder.</summary>
        public static string Inside(string dir, string relative)
        {
            if (string.IsNullOrEmpty(relative) || Path.IsPathRooted(relative)) return null;
            string full;
            try { full = Path.GetFullPath(Path.Combine(dir, relative)); }
            catch (Exception) { return null; }
            return full.StartsWith(dir + "\\", StringComparison.OrdinalIgnoreCase) ? full : null;
        }

        /// <summary>
        /// Programs running from inside the folder: Greg.exe, his node.exe, the
        /// whisper.cpp server in engines\. Their files cannot be replaced while
        /// they run, and a Greg half-replaced under himself is worse than one
        /// that was asked to stop first.
        /// </summary>
        public static List<string> Running(string dir)
        {
            List<string> names = new List<string>();
            string prefix = dir + "\\";
            int self = Process.GetCurrentProcess().Id;
            try
            {
                using (ManagementObjectSearcher search = new ManagementObjectSearcher("SELECT ProcessId, Name, ExecutablePath FROM Win32_Process"))
                {
                    foreach (ManagementBaseObject p in search.Get())
                    {
                        string exe = p["ExecutablePath"] as string;
                        if (exe == null || !exe.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue;
                        if (Convert.ToInt32(p["ProcessId"]) == self) continue;
                        string name = Convert.ToString(p["Name"]);
                        if (!names.Contains(name)) names.Add(name);
                    }
                }
            }
            catch (Exception)
            {
                // WMI unavailable. Replacing a running file fails loudly on its
                // own, so this check is a kindness, not the only guard.
            }
            return names;
        }

        public static bool IsEmpty(string dir)
        {
            using (IEnumerator<string> e = Directory.EnumerateFileSystemEntries(dir).GetEnumerator()) return !e.MoveNext();
        }

        public static bool IsLink(string path)
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }

        /// <summary>Delete empty folders under dir, deepest first. Never follows a link out of it.</summary>
        public static void PruneEmpty(string dir)
        {
            foreach (string sub in Directory.GetDirectories(dir))
            {
                try
                {
                    if (IsLink(sub)) continue;
                    PruneEmpty(sub);
                    if (IsEmpty(sub)) Directory.Delete(sub);
                }
                catch (Exception) { }
            }
        }

        public static long Size(string dir)
        {
            long total = 0;
            try
            {
                foreach (string file in Directory.GetFiles(dir)) { try { total += new FileInfo(file).Length; } catch (Exception) { } }
                foreach (string sub in Directory.GetDirectories(dir)) { if (!IsLink(sub)) total += Size(sub); }
            }
            catch (Exception) { }
            return total;
        }

        public static string Megabytes(long bytes)
        {
            if (bytes >= 1000L * 1000 * 1000) return (bytes / 1e9).ToString("0.0") + " GB";
            return Math.Max(1, (long)Math.Round(bytes / 1e6)) + " MB";
        }
    }

    /// <summary>
    /// .greg-install: what this installer put in the folder. Plain text, so a
    /// person can read exactly what an update or the uninstaller will remove.
    /// </summary>
    sealed class Record
    {
        public const string FileName = ".greg-install";
        public string Version = "";
        public List<string> Files = new List<string>();
        public List<string> Shortcuts = new List<string>();
        public bool AppsEntry;
        // Set by the uninstaller when it kept the user's files: the folder is
        // still Greg's, so installing into it again is an update, not a refusal.
        public bool Uninstalled;

        public static string PathIn(string dir) { return Path.Combine(dir, FileName); }

        public static Record Read(string dir)
        {
            string path = PathIn(dir);
            if (!File.Exists(path)) return null;
            Record r = new Record();
            foreach (string line in File.ReadAllLines(path, Encoding.UTF8))
            {
                int eq = line.IndexOf('=');
                if (line.StartsWith("#") || eq < 1) continue;
                string key = line.Substring(0, eq);
                string value = line.Substring(eq + 1);
                if (key == "version") r.Version = value;
                else if (key == "file") r.Files.Add(value);
                else if (key == "shortcut") r.Shortcuts.Add(value);
                else if (key == "apps") r.AppsEntry = value == "1";
                else if (key == "uninstalled") r.Uninstalled = value == "1";
            }
            return r;
        }

        public void Write(string dir)
        {
            StringBuilder s = new StringBuilder();
            if (Uninstalled)
            {
                s.Append("# Written by Greg's uninstaller. His program is gone; what is left in this\r\n");
                s.Append("# folder is what he made - your settings, memory and downloads - and was kept\r\n");
                s.Append("# on purpose. Installing Greg into this folder again picks it back up.\r\n");
                s.Append("uninstalled=1\r\n");
                s.Append("version=").Append(Version).Append("\r\n");
                File.WriteAllText(PathIn(dir), s.ToString(), new UTF8Encoding(false));
                return;
            }
            s.Append("# Written by Greg-Setup.exe: the files it put in this folder. Updating removes\r\n");
            s.Append("# the ones a newer Greg no longer has, and uninstall.exe removes these and only\r\n");
            s.Append("# these. What Greg made himself - your settings, memory, reminders, log,\r\n");
            s.Append("# voices and engines - is not listed, so neither of them touches it.\r\n");
            s.Append("version=").Append(Version).Append("\r\n");
            s.Append("apps=").Append(AppsEntry ? "1" : "0").Append("\r\n");
            foreach (string lnk in Shortcuts) s.Append("shortcut=").Append(lnk).Append("\r\n");
            foreach (string f in Files) s.Append("file=").Append(f).Append("\r\n");
            string path = PathIn(dir);
            if (File.Exists(path)) File.SetAttributes(path, FileAttributes.Normal);
            File.WriteAllText(path, s.ToString(), new UTF8Encoding(false));
        }
    }

    /// <summary>Start menu and desktop shortcuts, through the COM object Windows itself uses for them.</summary>
    static class Shortcut
    {
        static object Call(object target, string name, BindingFlags how, params object[] args)
        {
            return target.GetType().InvokeMember(name, how, null, target, args);
        }

        static object Open(string path)
        {
            object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            return Call(shell, "CreateShortcut", BindingFlags.InvokeMethod, path);
        }

        public static string Make(Environment.SpecialFolder place, string dir)
        {
            string folder = Environment.GetFolderPath(place);
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return null;
            string path = Path.Combine(folder, "Greg.lnk");
            string exe = Path.Combine(dir, "Greg.exe");
            object lnk = Open(path);
            Call(lnk, "TargetPath", BindingFlags.SetProperty, exe);
            Call(lnk, "WorkingDirectory", BindingFlags.SetProperty, dir);
            Call(lnk, "IconLocation", BindingFlags.SetProperty, exe + ",0");
            Call(lnk, "Description", BindingFlags.SetProperty, "Greg, the voice assistant that runs on this PC");
            Call(lnk, "Save", BindingFlags.InvokeMethod);
            return path;
        }

        /// <summary>Does this shortcut still start the Greg in dir? Another Greg's is not ours to delete.</summary>
        public static bool PointsInto(string path, string dir)
        {
            if (!File.Exists(path)) return false;
            try
            {
                string target = Convert.ToString(Call(Open(path), "TargetPath", BindingFlags.GetProperty));
                return string.Equals(target, Path.Combine(dir, "Greg.exe"), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    static class Installer
    {
        public const string AppsKey = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Greg";

        /// <summary>Why Greg cannot go in this folder, or null if he can.</summary>
        public static string Refusal(string dir)
        {
            if (Path.GetPathRoot(dir) == dir)
                return "Choose a folder for Greg rather than the whole of " + dir;
            if (File.Exists(dir))
                return "There is a file where Greg's folder would go:\n" + dir;
            if (Directory.Exists(Path.Combine(dir, ".git")))
                return "This folder is a git checkout of Greg:\n" + dir + "\n\nUpdate it with git instead. Installing over it would mix two copies of him.";
            if (Directory.Exists(dir) && !File.Exists(Record.PathIn(dir)) && !Folder.IsEmpty(dir))
                return "This folder already has files in it that this installer did not put there:\n" + dir + "\n\nChoose an empty folder, or one Greg was installed into before.";

            List<string> running = Folder.Running(dir);
            if (running.Count > 0)
                return "Greg is running from this folder. Stop him from his tray icon (right-click it, then Stop Greg) and try again.\n\nStill running: " + string.Join(", ", running.ToArray());

            try
            {
                DriveInfo drive = new DriveInfo(Path.GetPathRoot(dir));
                long need = BuildInfo.PayloadBytes + 64L * 1000 * 1000;
                if (drive.IsReady && drive.AvailableFreeSpace < need)
                    return "There is not enough room on " + drive.Name + " - Greg needs " + Folder.Megabytes(need) + " and " + Folder.Megabytes(drive.AvailableFreeSpace) + " is free.";
            }
            catch (Exception)
            {
                // A network folder, or a drive Windows will not describe. Try anyway.
            }
            return null;
        }

        /// <summary>Copy the payload in, then tidy what the last version left behind.</summary>
        public static void Install(Stream payload, string dir, Options o, Action<long, long> progress)
        {
            Directory.CreateDirectory(dir);
            Record old = Record.Read(dir);
            Record now = new Record();
            now.Version = BuildInfo.Label;

            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                List<ZipArchiveEntry> files = new List<ZipArchiveEntry>();
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string name = entry.FullName.Replace('/', '\\');
                    if (name.EndsWith("\\")) continue; // a folder, made as its files are
                    if (Folder.Inside(dir, name) == null) throw new InvalidDataException("The payload names a file outside Greg's folder: " + entry.FullName);
                    files.Add(entry);
                    now.Files.Add(name);
                }

                // Before a byte is copied, the list on disk covers everything this
                // run might write as well as what the last one did. If it stops
                // part-way - a full disk, a locked file - running it again, or
                // uninstalling, still knows every file that is ours.
                Record interim = new Record();
                interim.Version = now.Version;
                interim.Files.AddRange(now.Files);
                if (old != null)
                {
                    foreach (string f in old.Files) if (!interim.Files.Contains(f)) interim.Files.Add(f);
                    interim.Shortcuts.AddRange(old.Shortcuts);
                    interim.AppsEntry = old.AppsEntry;
                }
                interim.Write(dir);

                byte[] buffer = new byte[1 << 16];
                long done = 0;
                foreach (ZipArchiveEntry entry in files)
                {
                    string target = Folder.Inside(dir, entry.FullName.Replace('/', '\\'));
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    if (File.Exists(target)) File.SetAttributes(target, FileAttributes.Normal);
                    using (Stream from = entry.Open())
                    using (FileStream to = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        int n;
                        while ((n = from.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            to.Write(buffer, 0, n);
                            done += n;
                            if (progress != null) progress(done, BuildInfo.PayloadBytes);
                        }
                    }
                }
            }

            // Files the last version had and this one does not. Only ever names
            // from the old list, which only ever held payload files.
            if (old != null)
            {
                HashSet<string> keep = new HashSet<string>(now.Files, StringComparer.OrdinalIgnoreCase);
                foreach (string f in old.Files)
                {
                    if (keep.Contains(f)) continue;
                    string path = Folder.Inside(dir, f);
                    try { if (path != null && File.Exists(path)) { File.SetAttributes(path, FileAttributes.Normal); File.Delete(path); } }
                    catch (Exception) { }
                }
                Folder.PruneEmpty(dir);
            }

            // Shortcuts made last time and still ours, plus the ones asked for now.
            if (old != null)
                foreach (string lnk in old.Shortcuts)
                    if (Shortcut.PointsInto(lnk, dir) && !now.Shortcuts.Contains(lnk)) now.Shortcuts.Add(lnk);
            if (o.StartMenu) AddShortcut(now, Environment.SpecialFolder.Programs, dir);
            if (o.Desktop) AddShortcut(now, Environment.SpecialFolder.DesktopDirectory, dir);

            if (o.AppsEntry) { Register(dir); now.AppsEntry = true; }
            else now.AppsEntry = old != null && old.AppsEntry;

            now.Write(dir);
        }

        static void AddShortcut(Record record, Environment.SpecialFolder place, string dir)
        {
            try
            {
                string lnk = Shortcut.Make(place, dir);
                if (lnk != null && !record.Shortcuts.Contains(lnk)) record.Shortcuts.Add(lnk);
            }
            catch (Exception)
            {
                // Greg works without a shortcut; the finish screen says where he is.
            }
        }

        static void Register(string dir)
        {
            string uninstall = "\"" + Path.Combine(dir, "uninstall.exe") + "\"";
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(AppsKey))
            {
                key.SetValue("DisplayName", "Greg");
                key.SetValue("DisplayVersion", BuildInfo.Label);
                key.SetValue("Publisher", BuildInfo.Publisher);
                key.SetValue("DisplayIcon", Path.Combine(dir, "Greg.exe") + ",0");
                key.SetValue("InstallLocation", dir);
                key.SetValue("UninstallString", uninstall);
                key.SetValue("QuietUninstallString", uninstall + " /quiet");
                key.SetValue("URLInfoAbout", BuildInfo.Homepage);
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("EstimatedSize", (int)(BuildInfo.PayloadBytes / 1024), RegistryValueKind.DWord);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        /// <summary>Remove the Settings > Apps entry - only if it is this folder's.</summary>
        public static void Unregister(string dir)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(AppsKey))
            {
                if (key == null) return;
                string location = Convert.ToString(key.GetValue("InstallLocation", ""));
                if (!string.Equals(location, dir, StringComparison.OrdinalIgnoreCase)) return;
            }
            Registry.CurrentUser.DeleteSubKeyTree(AppsKey, false);
        }

        public static void Launch(string dir)
        {
            ProcessStartInfo info = new ProcessStartInfo(Path.Combine(dir, "Greg.exe"));
            info.WorkingDirectory = dir;
            info.UseShellExecute = true;
            Process.Start(info);
        }
    }

    static class Uninstaller
    {
        public sealed class Result
        {
            public List<string> Kept = new List<string>();
            public List<string> Failed = new List<string>();
        }

        public static Result Run(string dir, Record record, bool deleteData)
        {
            Result result = new Result();
            string self = Path.GetFullPath(Application.ExecutablePath);

            foreach (string lnk in record.Shortcuts)
            {
                try { if (Shortcut.PointsInto(lnk, dir)) File.Delete(lnk); } catch (Exception) { }
            }
            if (record.AppsEntry)
            {
                try { Installer.Unregister(dir); } catch (Exception) { }
            }

            foreach (string f in record.Files)
            {
                string path = Folder.Inside(dir, f);
                if (path == null || string.Equals(path, self, StringComparison.OrdinalIgnoreCase)) continue;
                Delete(path, result);
            }
            Delete(Record.PathIn(dir), result);

            // Only with the box ticked: everything else in the folder, which is
            // what Greg made as he ran. Links are removed, never followed.
            if (deleteData) DeleteAllBut(dir, self, result);

            Folder.PruneEmpty(dir);
            foreach (string entry in Directory.GetFileSystemEntries(dir))
            {
                if (string.Equals(entry, self, StringComparison.OrdinalIgnoreCase)) continue;
                result.Kept.Add(Path.GetFileName(entry));
            }

            // What was kept is still Greg's, so leave a list that says so, with
            // no files in it: installing here again is then an update.
            if (result.Kept.Count > 0)
            {
                Record left = new Record();
                left.Version = record.Version;
                left.Uninstalled = true;
                try { left.Write(dir); } catch (Exception) { }
            }

            if (self.StartsWith(dir + "\\", StringComparison.OrdinalIgnoreCase)) DeleteAfterExit(self, dir);
            return result;
        }

        static void Delete(string path, Result result)
        {
            if (!File.Exists(path)) return;
            try
            {
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(path);
            }
            catch (Exception)
            {
                result.Failed.Add(path);
            }
        }

        static void DeleteAllBut(string dir, string self, Result result)
        {
            foreach (string file in Directory.GetFiles(dir))
                if (!string.Equals(file, self, StringComparison.OrdinalIgnoreCase)) Delete(file, result);
            foreach (string sub in Directory.GetDirectories(dir))
            {
                try
                {
                    if (Folder.IsLink(sub)) { Directory.Delete(sub); continue; }
                    DeleteAllBut(sub, self, result);
                    if (Folder.IsEmpty(sub)) Directory.Delete(sub);
                }
                catch (Exception)
                {
                    result.Failed.Add(sub);
                }
            }
        }

        /// <summary>
        /// A running program cannot delete itself, so cmd does it once this one
        /// has exited - then removes the folder only if it is empty. rmdir
        /// without /s cannot take anything that was kept.
        /// </summary>
        static void DeleteAfterExit(string self, string dir)
        {
            string command = "/d /s /c \"ping -n 3 127.0.0.1 >nul & del /f /q \"" + self + "\" & rmdir \"" + dir + "\"\"";
            ProcessStartInfo info = new ProcessStartInfo("cmd.exe", command);
            info.CreateNoWindow = true;
            info.UseShellExecute = false;
            info.WorkingDirectory = Path.GetTempPath();
            try { Process.Start(info); } catch (Exception) { }
        }
    }

    /// <summary>Layout in 96-DPI pixels, scaled once for this screen.</summary>
    class Dialog : Form
    {
        protected readonly float scale;
        protected readonly TableLayoutPanel column;
        protected readonly FlowLayoutPanel buttons;
        protected const int Width96 = 460;

        protected Dialog(string title)
        {
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
            Text = title;
            Font = SystemFonts.MessageBoxFont;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            AutoSize = true;
            AutoSizeMode = AutoSizeMode.GrowAndShrink;
            BackColor = SystemColors.Window;
            try
            {
                using (Stream ico = Assembly.GetExecutingAssembly().GetManifestResourceStream("greg.ico"))
                    if (ico != null) Icon = new Icon(ico);
            }
            catch (Exception) { }

            column = new TableLayoutPanel();
            column.ColumnCount = 1;
            column.AutoSize = true;
            column.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            column.Padding = new Padding(S(20), S(18), S(20), S(8));

            buttons = new FlowLayoutPanel();
            buttons.FlowDirection = FlowDirection.RightToLeft;
            buttons.AutoSize = true;
            buttons.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            buttons.Anchor = AnchorStyles.Right;
            buttons.Margin = new Padding(0, S(12), 0, S(8));
        }

        protected int S(int px) { return (int)Math.Round(px * scale); }

        protected Label Words(string text, float points, FontStyle style)
        {
            Label l = new Label();
            l.Text = text;
            l.AutoSize = true;
            l.MaximumSize = new Size(S(Width96), 0);
            l.Margin = new Padding(0, 0, 0, S(10));
            if (points > 0 || style != FontStyle.Regular) l.Font = new Font(Font.FontFamily, points > 0 ? points : Font.SizeInPoints, style);
            return l;
        }

        protected Button MakeButton(string text)
        {
            Button b = new Button();
            b.Text = text;
            b.AutoSize = true;
            b.MinimumSize = new Size(S(88), S(28));
            b.Margin = new Padding(S(8), 0, 0, 0);
            buttons.Controls.Add(b);
            return b;
        }

        protected void Add(Control c)
        {
            column.Controls.Add(c);
        }

        protected void Finish()
        {
            Add(buttons);
            Controls.Add(column);
        }

        /// <summary>
        /// The frame of greg.ico nearest the size wanted, as a picture. Every
        /// frame in it is a PNG, which Icon.ToBitmap cannot draw on .NET
        /// Framework (it drew nothing), so the file is read directly.
        /// </summary>
        static Image IconFrame(int size)
        {
            byte[] ico;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("greg.ico"))
            {
                if (s == null) return null;
                using (MemoryStream copy = new MemoryStream()) { s.CopyTo(copy); ico = copy.ToArray(); }
            }
            int count = BitConverter.ToUInt16(ico, 4);
            int best = -1;
            int bestWidth = 0;
            for (int i = 0; i < count; i++)
            {
                int width = ico[6 + i * 16] == 0 ? 256 : ico[6 + i * 16];
                // The smallest frame at least as big as wanted; failing that, the biggest.
                bool better = best < 0
                    || (width >= size && (bestWidth < size || width < bestWidth))
                    || (bestWidth < size && width > bestWidth);
                if (better) { best = i; bestWidth = width; }
            }
            if (best < 0) return null;
            int length = BitConverter.ToInt32(ico, 6 + best * 16 + 8);
            int offset = BitConverter.ToInt32(ico, 6 + best * 16 + 12);
            // Not disposed: an Image keeps reading the stream it came from.
            return Image.FromStream(new MemoryStream(ico, offset, length));
        }

        /// <summary>Greg's face and name, top left, as in his own title bar.</summary>
        protected Control Header(string title, string subtitle)
        {
            TableLayoutPanel row = new TableLayoutPanel();
            row.ColumnCount = 2;
            row.AutoSize = true;
            row.Margin = new Padding(0, 0, 0, S(14));
            PictureBox face = new PictureBox();
            face.Size = new Size(S(48), S(48));
            face.SizeMode = PictureBoxSizeMode.Zoom;
            face.Margin = new Padding(0, 0, S(12), 0);
            try { face.Image = IconFrame(S(48)); } catch (Exception) { }
            row.Controls.Add(face, 0, 0);
            FlowLayoutPanel words = new FlowLayoutPanel();
            words.FlowDirection = FlowDirection.TopDown;
            words.AutoSize = true;
            words.Margin = new Padding(0, S(2), 0, 0);
            Label big = Words(title, 15f, FontStyle.Bold);
            big.Margin = new Padding(0);
            Label small = Words(subtitle, 0, FontStyle.Regular);
            small.ForeColor = SystemColors.GrayText;
            small.Margin = new Padding(S(2), 0, 0, 0);
            words.Controls.Add(big);
            words.Controls.Add(small);
            row.Controls.Add(words, 1, 0);
            return row;
        }
    }

    sealed class InstallForm : Dialog
    {
        readonly Stream payload;
        readonly Options options;
        string dir;
        readonly Label body;
        readonly Label whereLabel;
        readonly TableLayoutPanel whereRow;
        readonly TextBox where;
        readonly Button change;
        readonly CheckBox desktop;
        readonly CheckBox open;
        readonly ProgressBar bar;
        readonly Label status;
        readonly Button go;
        readonly Button cancel;
        Thread worker;
        bool installed;
        DateTime lastTick = DateTime.MinValue;

        public InstallForm(Stream payload, string dir, Options options) : base("Install Greg")
        {
            this.payload = payload;
            this.options = options;
            this.dir = dir;

            Add(Header("Greg", "A voice assistant that runs on this PC"));
            body = Words("", 0, FontStyle.Regular);
            Add(body);

            whereLabel = Words("Install to:", 0, FontStyle.Regular);
            whereLabel.Margin = new Padding(0, 0, 0, S(4));
            Add(whereLabel);
            whereRow = new TableLayoutPanel();
            whereRow.ColumnCount = 2;
            whereRow.AutoSize = true;
            whereRow.Margin = new Padding(0, 0, 0, S(10));
            where = new TextBox();
            where.ReadOnly = true;
            where.TabStop = false;
            where.Width = S(Width96 - 100);
            where.Margin = new Padding(0, S(1), S(8), 0);
            change = new Button();
            change.Text = "Change...";
            change.AutoSize = true;
            change.MinimumSize = new Size(S(88), S(26));
            change.Margin = new Padding(0);
            change.Click += delegate { ChooseFolder(); };
            whereRow.Controls.Add(where, 0, 0);
            whereRow.Controls.Add(change, 1, 0);
            Add(whereRow);

            desktop = new CheckBox();
            desktop.Text = "Put Greg on the desktop too (he always goes in the Start menu)";
            desktop.AutoSize = true;
            desktop.Checked = options.Desktop;
            desktop.Visible = options.StartMenu;
            desktop.Margin = new Padding(0, 0, 0, S(4));
            Add(desktop);
            open = new CheckBox();
            open.Text = "Open Greg when this is done";
            open.AutoSize = true;
            open.Checked = options.Launch;
            open.Margin = new Padding(0, 0, 0, S(8));
            Add(open);

            bar = new ProgressBar();
            bar.Width = S(Width96);
            bar.Height = S(16);
            bar.Maximum = 1000;
            bar.Visible = false;
            bar.Margin = new Padding(0, S(4), 0, S(6));
            Add(bar);
            status = Words("", 0, FontStyle.Regular);
            Add(status);

            cancel = MakeButton("Cancel");
            cancel.Click += delegate { Close(); };
            go = MakeButton("Install");
            go.Click += delegate { if (installed) Done(); else Begin(); };
            AcceptButton = go;
            CancelButton = cancel;
            Finish();
            Describe();
            ActiveControl = go;

            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                // Stopping half-way leaves half a Greg. Let it finish.
                if (worker != null && worker.IsAlive) e.Cancel = true;
            };
        }

        void Describe()
        {
            where.Text = dir;
            Record existing = File.Exists(Record.PathIn(dir)) ? Record.Read(dir) : null;
            if (existing == null || existing.Uninstalled)
            {
                Text = "Install Greg";
                go.Text = "Install";
                body.Text =
                    "This puts Greg, and the Node.js he runs on, in the folder below. It takes " + Folder.Megabytes(BuildInfo.PayloadBytes) +
                    ", needs no administrator rights, and downloads nothing.\n\n" +
                    "The first time he opens, Greg shows what else he can use - his brain, his hearing " +
                    "and his voice, about 10 GB between them, most of it the brain - and asks before he downloads any of it.";
                if (existing != null)
                    body.Text += "\n\nWhat he kept here last time - his settings, memory and downloads - is still in this folder, and he picks it back up.";
            }
            else
            {
                Text = "Update Greg";
                go.Text = "Update";
                body.Text =
                    "Greg " + existing.Version + " is installed in this folder. This replaces his program files with " + BuildInfo.Label + ".\n\n" +
                    "Your settings, memory, reminders, conversation log, voices and downloaded engines stay as they are: " +
                    "an update only ever replaces files the installer put there.";
            }
            status.Text = "";
        }

        void ChooseFolder()
        {
            using (FolderBrowserDialog pick = new FolderBrowserDialog())
            {
                pick.Description = "Choose where Greg goes. A folder called Greg is made inside the one you pick.";
                pick.SelectedPath = Directory.Exists(dir) ? dir : Path.GetDirectoryName(dir);
                if (pick.ShowDialog(this) != DialogResult.OK) return;
                string chosen = Folder.Normalise(pick.SelectedPath);
                bool isGreg = string.Equals(Path.GetFileName(chosen), "Greg", StringComparison.OrdinalIgnoreCase)
                    || File.Exists(Record.PathIn(chosen));
                dir = isGreg ? chosen : Path.Combine(chosen, "Greg");
                Describe();
            }
        }

        void Say(string text, bool bad)
        {
            status.ForeColor = bad ? Color.Firebrick : SystemColors.ControlText;
            status.Text = text;
        }

        void Begin()
        {
            Say("Checking the folder...", false);
            Refresh();
            string refusal = Installer.Refusal(dir);
            if (refusal != null) { Say(refusal, true); return; }

            options.Desktop = desktop.Checked;
            go.Enabled = false;
            cancel.Enabled = false;
            change.Enabled = false;
            desktop.Enabled = false;
            bar.Visible = true;
            Say("Copying Greg's files...", false);

            worker = new Thread(delegate()
            {
                Exception failure = null;
                try
                {
                    Installer.Install(payload, dir, options, delegate(long done, long total)
                    {
                        DateTime now = DateTime.UtcNow;
                        if ((now - lastTick).TotalMilliseconds < 80) return;
                        lastTick = now;
                        int value = total > 0 ? (int)Math.Min(1000, done * 1000 / total) : 0;
                        BeginInvoke((MethodInvoker)delegate { bar.Value = value; });
                    });
                }
                catch (Exception err)
                {
                    failure = err;
                }
                BeginInvoke((MethodInvoker)delegate { Ended(failure); });
            });
            worker.IsBackground = true;
            worker.Start();
        }

        void Ended(Exception failure)
        {
            cancel.Enabled = true;
            if (failure != null)
            {
                bar.Visible = false;
                go.Enabled = true;
                go.Text = "Try again";
                Say("Installing stopped part-way: " + failure.Message + "\n\nNothing of yours was touched. Running this again finishes the job.", true);
                return;
            }

            installed = true;
            bar.Visible = false;
            whereLabel.Visible = false;
            whereRow.Visible = false;
            open.Text = "Open Greg now";
            go.Enabled = true;
            go.Text = "Finish";
            cancel.Visible = false;
            Text = "Greg is installed";
            bool shortcut = options.StartMenu;
            body.Text = "Greg is installed" + (shortcut ? " and in your Start menu" + (options.Desktop ? " and on your desktop." : ".") : ", in " + dir + ".") +
                "\n\nHe lives in the tray while he runs, beside the clock. Closing his window stops him. " +
                (options.AppsEntry ? "To remove him, use Settings > Apps." : "To remove him, run uninstall.exe in his folder.");
            Say("", false);
        }

        void Done()
        {
            if (open.Checked)
            {
                try { Installer.Launch(dir); }
                catch (Exception err) { MessageBox.Show(this, "Greg is installed, but he could not be started: " + err.Message, "Greg", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            }
            Close();
        }
    }

    sealed class UninstallForm : Dialog
    {
        readonly string dir;
        readonly Record record;
        readonly CheckBox data;
        readonly Label status;
        readonly Button go;

        public UninstallForm(string dir, Record record) : base("Uninstall Greg")
        {
            this.dir = dir;
            this.record = record;

            Add(Header("Uninstall Greg", record.Version));
            Add(Words("This removes Greg's program files from " + dir + ", his shortcuts, and his entry in Settings > Apps.", 0, FontStyle.Regular));

            long ours = 0;
            foreach (string f in record.Files)
            {
                string path = Folder.Inside(dir, f);
                try { if (path != null && File.Exists(path)) ours += new FileInfo(path).Length; } catch (Exception) { }
            }
            long theirs = Math.Max(0, Folder.Size(dir) - ours);

            // A CheckBox does not wrap its text, and this is the sentence that
            // has to be read whole before anything of theirs is deleted - so
            // the box says what, and the words under it say all of it.
            data = new CheckBox();
            data.Text = "Also delete what Greg keeps in this folder (" + Folder.Megabytes(theirs) + ")";
            data.AutoSize = true;
            data.Margin = new Padding(0, 0, 0, S(2));
            Add(data);
            Label what = Words("His settings, what he remembers about you, your reminders, the log of what was said to him, " +
                "paired phones, voices, and the hearing and voice he downloaded. Left unticked, all of it stays.", 0, FontStyle.Regular);
            what.MaximumSize = new Size(S(Width96 - 18), 0);
            what.Margin = new Padding(S(18), 0, 0, S(12));
            what.ForeColor = SystemColors.GrayText;
            Add(what);
            Add(Words("His brain is not in this folder. Ollama and the models it downloaded are a separate program: remove Ollama from Settings > Apps if you want that space back too.", 0, FontStyle.Regular));
            status = Words("", 0, FontStyle.Regular);
            status.ForeColor = Color.Firebrick;
            Add(status);

            Button cancel = MakeButton("Cancel");
            cancel.Click += delegate { Close(); };
            go = MakeButton("Uninstall");
            go.Click += delegate { Remove(); };
            CancelButton = cancel;
            Finish();
            // Not the box: a stray space bar must not be what deletes his memory.
            ActiveControl = go;
        }

        void Remove()
        {
            List<string> running = Folder.Running(dir);
            if (running.Count > 0)
            {
                status.Text = "Greg is running. Stop him from his tray icon (right-click it, then Stop Greg) and try again.\n\nStill running: " + string.Join(", ", running.ToArray());
                return;
            }
            go.Enabled = false;
            Cursor = Cursors.WaitCursor;
            Uninstaller.Result result = Uninstaller.Run(dir, record, data.Checked);
            Cursor = Cursors.Default;

            string text = "Greg has been removed.";
            if (result.Kept.Count > 0)
                text += "\n\nKept, in " + dir + ":\n  " + string.Join(", ", result.Kept.ToArray()) +
                    "\n\nInstalling Greg into the same folder again picks all of it back up. Delete the folder yourself when you no longer want it.";
            if (result.Failed.Count > 0)
                text += "\n\nThese could not be deleted, probably because something has them open:\n  " + string.Join("\n  ", result.Failed.ToArray());
            MessageBox.Show(this, text, "Uninstall Greg", MessageBoxButtons.OK, result.Failed.Count > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);
            Close();
        }
    }
}
