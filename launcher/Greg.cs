// Greg.exe - starts Greg with no console window, and gives him a tray icon.
//
// Built on your own machine by launcher\build.ps1, with the C# compiler that is
// part of Windows itself (.NET Framework 4), so no binary is ever committed and
// nothing is downloaded to make it. That compiler stops at C# 5, which is why
// there is no string interpolation, no ?. and no nameof anywhere below.
//
// ASCII ONLY, for the same reason setup-greg.ps1 is: this file is read by tools
// that guess its encoding.
//
// What it does, in order:
//   1. If Greg is already running, bring his window forward and exit. Two
//      servers cannot share the port, and two windows means two microphones.
//   2. Find Node, and install the npm dependencies on the first run, exactly as
//      start-greg.bat does.
//   3. Start "node server.js" with no console, keeping its output in memory so
//      "Show console" can show the startup banner - the first thing to read
//      whenever something is wrong.
//   4. Sit in the tray. Closing Greg's window stops Greg: with GREG_LAUNCHER=1
//      the server notices the page has gone and shuts down cleanly on its own
//      (lib/lifetime.js). "Stop Greg" asks it to, and only forces it if asked
//      twice over.
//
// NOTHING IS WRITTEN TO DISK. The console carries what was said to him, so it
// lives in memory and dies with the launcher. A log file would be a second
// transcript, and one that "clear the conversation history" does not reach.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Greg
{
    static class Program
    {
        [STAThread]
        static int Main()
        {
            try { SetProcessDPIAware(); } catch (Exception) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            ServicePointManager.Expect100Continue = false;

            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            if (!File.Exists(Path.Combine(root, "server.js")))
            {
                MessageBox.Show(
                    "Greg.exe has to live in the Greg folder, next to server.js.\n\nIt is running from:\n" + root,
                    "Greg", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            Settings settings = Settings.Read(root);

            bool first;
            using (Mutex mutex = new Mutex(true, "Local\\Greg-" + Settings.Hash(root), out first))
            {
                if (!first)
                {
                    // This launcher is already running him: just show him.
                    Server.BringForward(settings, true);
                    return 0;
                }

                // Running, but started some other way - start-greg.bat, a
                // terminal. Show that one rather than start a second server,
                // which could only fail on the port.
                if (Server.IsUp(settings.Port))
                {
                    Server.BringForward(settings, false);
                    return 0;
                }

                Application.Run(new Tray(root, settings));
            }
            return 0;
        }

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
    }

    /// <summary>The two things the launcher needs from config.json.</summary>
    sealed class Settings
    {
        public int Port = 4747;

        // The page's own <title>, which is what Chrome and Edge give an --app
        // window. Not config.name: renaming him changes the text in his title
        // bar, not the document title.
        public string WindowTitle = "Greg";

        public static Settings Read(string root)
        {
            Settings s = new Settings();

            // config.json is created from the example on the first run, so until
            // then the example is what the server will use.
            foreach (string name in new string[] { "config.json", "config.example.json" })
            {
                string path = Path.Combine(root, name);
                if (!File.Exists(path)) continue;
                try
                {
                    JavaScriptSerializer json = new JavaScriptSerializer();
                    Dictionary<string, object> config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                    object value;
                    int port;
                    if (config != null && config.TryGetValue("port", out value) && value != null
                        && int.TryParse(Convert.ToString(value), out port) && port > 0 && port < 65536)
                    {
                        s.Port = port;
                    }
                }
                catch (Exception)
                {
                    // Unreadable: keep the default. The server reads the same file
                    // and says exactly what is wrong with it, in the console.
                }
                break;
            }

            // The server lets PORT override config.json, so this must too.
            int envPort;
            string env = Environment.GetEnvironmentVariable("PORT");
            if (!string.IsNullOrEmpty(env) && int.TryParse(env, out envPort) && envPort > 0 && envPort < 65536) s.Port = envPort;
            return s;
        }

        /// <summary>A stable name for this Greg folder, for the single-instance lock.</summary>
        public static string Hash(string text)
        {
            // FNV-1a, because string.GetHashCode is not promised to be stable.
            uint h = 2166136261;
            foreach (char c in text.ToLowerInvariant())
            {
                h ^= c;
                h *= 16777619;
            }
            return h.ToString("x8");
        }
    }

    /// <summary>Talking to Greg's own server on localhost.</summary>
    static class Server
    {
        public static string Url(int port, string path)
        {
            return "http://127.0.0.1:" + port + path;
        }

        public static string Request(string method, string url, int timeoutMs)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = method;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            // Never through a system proxy: this is a request to this machine.
            req.Proxy = null;
            if (method == "POST")
            {
                byte[] body = Encoding.ASCII.GetBytes("{}");
                req.ContentType = "application/json";
                req.ContentLength = body.Length;
                using (Stream stream = req.GetRequestStream()) stream.Write(body, 0, body.Length);
            }
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        public static bool IsUp(int port)
        {
            try
            {
                return Request("GET", Url(port, "/api/health"), 1500).Contains("\"ok\"");
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Show his window: raise it if it exists, ask the server to open one if
        /// not. `mayBeStarting` is for the case where the server is not answering
        /// yet, which during a first run can last minutes.
        /// </summary>
        public static void BringForward(Settings settings, bool mayBeStarting)
        {
            if (Windows.Raise(settings.WindowTitle)) return;
            try
            {
                Request("POST", Url(settings.Port, "/api/open"), 4000);
                return;
            }
            catch (Exception)
            {
            }
            if (mayBeStarting)
            {
                MessageBox.Show(
                    "Greg is still starting up. His window opens by itself when he is ready.",
                    "Greg", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
    }

    /// <summary>Finding Greg's browser window and bringing it to the front.</summary>
    static class Windows
    {
        delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);

        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);

        const int SW_RESTORE = 9;

        /// <summary>
        /// Raise the Chrome or Edge window whose title is exactly `title`.
        ///
        /// Exact, and Chromium's window class only. Other programs use that class
        /// too - VS Code shows "Greg - Visual Studio Code" with this folder open -
        /// and a prefix match would raise the editor instead of him.
        /// </summary>
        public static bool Raise(string title)
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hwnd)) return true;
                StringBuilder cls = new StringBuilder(64);
                GetClassName(hwnd, cls, cls.Capacity);
                if (cls.ToString() != "Chrome_WidgetWin_1") return true;
                StringBuilder text = new StringBuilder(256);
                GetWindowText(hwnd, text, text.Capacity);
                if (text.ToString() != title) return true;
                found = hwnd;
                return false;
            }, IntPtr.Zero);

            if (found == IntPtr.Zero) return false;
            if (IsIconic(found)) ShowWindow(found, SW_RESTORE);
            SetForegroundWindow(found);
            return true;
        }
    }

    /// <summary>Finding Node, including one installed since you last signed in.</summary>
    static class Find
    {
        /// <summary>
        /// PATH as the registry has it now, ahead of the one this process was
        /// given.
        ///
        /// Explorer hands every program the PATH it had when you signed in, so a
        /// Node or Python installed by setup-greg a minute ago is invisible to
        /// anything started from a desktop icon until you sign out. start-greg.bat
        /// has the same blind spot. Reading the registry closes it, and the
        /// result is also handed to the server, whose Whisper and Piper sidecars
        /// need Python on it for exactly the same reason.
        /// </summary>
        public static string FreshPath()
        {
            List<string> parts = new List<string>();
            AddParts(parts, ReadRegistryPath(Registry.LocalMachine, @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"));
            AddParts(parts, ReadRegistryPath(Registry.CurrentUser, @"Environment"));
            AddParts(parts, Environment.GetEnvironmentVariable("PATH"));
            return string.Join(";", parts.ToArray());
        }

        static string ReadRegistryPath(RegistryKey hive, string key)
        {
            try
            {
                using (RegistryKey k = hive.OpenSubKey(key))
                {
                    if (k == null) return null;
                    object value = k.GetValue("Path", null, RegistryValueOptions.None);
                    return value == null ? null : Environment.ExpandEnvironmentVariables(Convert.ToString(value));
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        static void AddParts(List<string> parts, string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            foreach (string raw in path.Split(';'))
            {
                string part = raw.Trim().Trim('"');
                if (part.Length == 0) continue;
                bool seen = false;
                foreach (string existing in parts)
                {
                    if (string.Equals(existing.TrimEnd('\\'), part.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) { seen = true; break; }
                }
                if (!seen) parts.Add(part);
            }
        }

        public static string OnPath(string exe, string path)
        {
            foreach (string dir in path.Split(';'))
            {
                if (dir.Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(dir, exe);
                    if (File.Exists(candidate)) return candidate;
                }
                catch (Exception)
                {
                    // A malformed PATH entry. Skip it rather than give up.
                }
            }
            return null;
        }

        public static string Node(string path)
        {
            string found = OnPath("node.exe", path);
            if (found != null) return found;
            string standard = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe");
            return File.Exists(standard) ? standard : null;
        }
    }

    /// <summary>The tray icon, and the one Node process behind it.</summary>
    sealed class Tray : ApplicationContext
    {
        readonly string root;
        readonly Settings settings;
        readonly string path;
        readonly NotifyIcon icon;
        readonly ConsoleWindow console;

        Process current;          // npm on a first run, then node
        volatile bool stopping;
        bool exiting;

        public Tray(string root, Settings settings)
        {
            this.root = root;
            this.settings = settings;
            this.path = Find.FreshPath();

            Icon picture = LoadIcon(root);
            console = new ConsoleWindow(picture);
            console.FormClosed += delegate { if (console.ExitWhenClosed) Quit(); };
            // Create the handle now, so output can be marshalled onto this
            // thread before the window has ever been shown.
            IntPtr unused = console.Handle;

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripItem open = menu.Items.Add("Open Greg", null, delegate { Server.BringForward(settings, true); });
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add("Show console", null, delegate { console.ShowAndRaise(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Stop Greg", null, delegate { Stop(); });

            icon = new NotifyIcon();
            icon.Icon = picture;
            icon.Text = "Greg - starting...";
            icon.ContextMenuStrip = menu;
            icon.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) Server.BringForward(settings, true);
            };
            icon.Visible = true;

            Thread start = new Thread(StartUp);
            start.IsBackground = true;
            start.Start();
        }

        static Icon LoadIcon(string root)
        {
            try { return new Icon(Path.Combine(root, "launcher\\greg.ico"), SystemInformation.SmallIconSize); } catch (Exception) { }
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }
            return SystemIcons.Application;
        }

        void OnUi(MethodInvoker action)
        {
            try
            {
                if (console.IsHandleCreated && !console.IsDisposed) console.BeginInvoke(action);
            }
            catch (Exception)
            {
                // Shutting down; the window has gone.
            }
        }

        void Log(string line)
        {
            if (line == null) return;
            OnUi(delegate { console.Append(line); });
            // The banner's first line. Until then the tooltip says he is starting,
            // which on a first run can mean several minutes of model downloads.
            if (line.Contains(" is awake.")) OnUi(delegate { icon.Text = "Greg"; });
        }

        void Balloon(string title, string text)
        {
            OnUi(delegate { icon.ShowBalloonTip(10000, title, text, ToolTipIcon.Info); });
        }

        void StartUp()
        {
            string node = Find.Node(path);
            if (node == null)
            {
                OnUi(delegate
                {
                    DialogResult answer = MessageBox.Show(
                        "Greg needs Node.js 20 or newer, and it is not installed - or it is not where Windows looks for it.\n\n" +
                        "Open nodejs.org to get it? Then open Greg again.",
                        "Greg", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                    if (answer == DialogResult.Yes)
                    {
                        try { Process.Start("https://nodejs.org"); } catch (Exception) { }
                    }
                    Quit();
                });
                return;
            }

            // The first run, the same test and the same words as start-greg.bat.
            if (!Directory.Exists(Path.Combine(root, "node_modules")))
            {
                Balloon("First run", "Installing Greg's dependencies. This takes about a minute.");
                Log("First run - installing Greg's dependencies. This takes about a minute...");
                string npm = Path.Combine(Path.GetDirectoryName(node), "npm.cmd");
                if (!File.Exists(npm)) npm = Find.OnPath("npm.cmd", path) ?? "npm.cmd";

                // /d skips AutoRun, /s keeps the quoting below intact.
                int code = Run("cmd.exe", "/d /s /c \"\"" + npm + "\" install --no-fund\"");
                if (stopping) { OnUi(delegate { Quit(); }); return; }
                if (code != 0)
                {
                    Fail("Greg's dependencies did not install, so he cannot start.\n\nCheck your internet connection and open Greg again. The console shows what npm said.");
                    return;
                }
                Log("Dependencies installed.");
                Balloon("Starting Greg for the first time",
                    "He downloads his voice and his hearing now - a few hundred megabytes, once. His window opens when he is ready.");
            }

            ProcessStartInfo info = Hidden(node, "server.js");
            // What tells the server it has no console, and should stop when its
            // window closes. See lib/lifetime.js.
            info.EnvironmentVariables["GREG_LAUNCHER"] = "1";
            Process server = new Process();
            server.StartInfo = info;
            server.EnableRaisingEvents = true;
            server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
            server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
            server.Exited += delegate { OnServerExit(server); };

            if (stopping) { OnUi(delegate { Quit(); }); return; }
            try
            {
                server.Start();
            }
            catch (Exception err)
            {
                Fail("Greg could not be started: " + err.Message);
                return;
            }
            current = server;
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
        }

        ProcessStartInfo Hidden(string file, string args)
        {
            ProcessStartInfo info = new ProcessStartInfo(file, args);
            info.WorkingDirectory = root;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8;
            info.StandardErrorEncoding = Encoding.UTF8;
            info.EnvironmentVariables["PATH"] = path;
            return info;
        }

        int Run(string file, string args)
        {
            try
            {
                Process p = new Process();
                p.StartInfo = Hidden(file, args);
                p.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
                p.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Log(e.Data); };
                p.Start();
                current = p;
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                p.WaitForExit();
                return p.ExitCode;
            }
            catch (Exception err)
            {
                Log(err.Message);
                return -1;
            }
        }

        void OnServerExit(Process server)
        {
            // The parameterless wait is the one that also waits for the output
            // handlers to finish, so the last lines are in the console.
            try { server.WaitForExit(); } catch (Exception) { }
            int code = 0;
            try { code = server.ExitCode; } catch (Exception) { }

            // Zero is a clean stop: his window closed, or Stop Greg. Anything
            // else he did not choose, and the reason is in the console.
            if (stopping || code == 0)
            {
                OnUi(delegate { Quit(); });
                return;
            }
            Fail("Greg stopped unexpectedly (exit code " + code + ").\n\nThe console shows why - the last few lines are usually the reason.");
        }

        void Fail(string message)
        {
            OnUi(delegate
            {
                icon.Text = "Greg - stopped";
                console.ExitWhenClosed = true;
                console.ShowAndRaise();
                MessageBox.Show(console, message, "Greg", MessageBoxButtons.OK, MessageBoxIcon.Error);
            });
        }

        void Stop()
        {
            if (stopping) return;
            stopping = true;
            icon.Text = "Greg - stopping...";

            Thread t = new Thread(delegate()
            {
                Process p = current;
                bool running = false;
                try { running = p != null && !p.HasExited; } catch (Exception) { }

                if (running)
                {
                    // Ask first. The server stops its sidecars by name and gives
                    // the graphics card back; a forced kill cannot do either.
                    try { Server.Request("POST", Server.Url(settings.Port, "/api/quit"), 3000); } catch (Exception) { }
                    bool gone = false;
                    try { gone = p.WaitForExit(10000); } catch (Exception) { gone = true; }
                    if (!gone) Force.StopGreg(p);
                }
                // If it was running, its Exited handler quits; if not, nothing will.
                if (!running) OnUi(delegate { Quit(); });
            });
            t.IsBackground = true;
            t.Start();
        }

        void Quit()
        {
            if (exiting) return;
            exiting = true;
            icon.Visible = false;
            icon.Dispose();
            console.ExitWhenClosed = false;
            console.AllowClose = true;
            console.Close();
            ExitThread();
        }
    }

    /// <summary>The last resort, when asking Greg to stop did not work.</summary>
    static class Force
    {
        // Named rather than taken as a process tree. If Greg's server was the one
        // that started Chrome, Chrome is its child, and a tree kill would close
        // every tab you have open along with him.
        static readonly string[] Sidecars = { "whisper_server.py", "piper_server.py", "clone_server.py", "media-session.ps1", "cursor-watch.ps1" };

        public static void StopGreg(Process node)
        {
            try { node.Kill(); } catch (Exception) { }
            try
            {
                string query = "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='python.exe' OR Name='pythonw.exe' OR Name='py.exe' OR Name='powershell.exe'";
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(query))
                {
                    foreach (ManagementObject found in searcher.Get())
                    {
                        string command = Convert.ToString(found["CommandLine"]);
                        foreach (string name in Sidecars)
                        {
                            if (command.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                            try { Process.GetProcessById(Convert.ToInt32(found["ProcessId"])).Kill(); } catch (Exception) { }
                            break;
                        }
                    }
                }
            }
            catch (Exception)
            {
                // WMI unavailable. The node process is gone, which is the part
                // that holds the port.
            }
        }
    }

    /// <summary>What start-greg.bat's window used to show, shown only when asked.</summary>
    sealed class ConsoleWindow : Form
    {
        const int KeepChars = 300000;
        readonly TextBox text;
        public bool ExitWhenClosed;
        // Set only when the launcher itself is exiting. Form.Close() called from
        // code reports UserClosing too, so the reason alone cannot tell them apart.
        public bool AllowClose;

        public ConsoleWindow(Icon picture)
        {
            Text = "Greg - console";
            Icon = picture;
            Width = 960;
            Height = 580;
            StartPosition = FormStartPosition.CenterScreen;

            text = new TextBox();
            text.Multiline = true;
            text.ReadOnly = true;
            text.WordWrap = false;
            text.ScrollBars = ScrollBars.Both;
            text.Dock = DockStyle.Fill;
            text.Font = new Font("Consolas", 10f);
            text.BackColor = Color.Black;
            text.ForeColor = Color.Gainsboro;
            text.MaxLength = 0;
            Controls.Add(text);
        }

        public void Append(string line)
        {
            // Bounded, so a week-long session does not grow without limit. The
            // banner is at the top and the reason for a failure is at the bottom,
            // and it is the middle that goes.
            if (text.TextLength > KeepChars)
            {
                string kept = text.Text;
                text.Text = kept.Substring(kept.Length - KeepChars / 2);
            }
            text.AppendText(line + "\r\n");
        }

        public void ShowAndRaise()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Closing the console hides it; Greg carries on. Only after a failure
            // does closing it mean "I have read that, you can go".
            if (!ExitWhenClosed && !AllowClose && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
            base.OnFormClosing(e);
        }
    }
}
