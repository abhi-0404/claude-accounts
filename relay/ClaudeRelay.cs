// Claude Accounts relay.
//
// The Claude VS Code extension can start Claude through a "process wrapper" (setting
// claudeCode.claudeProcessWrapper). It runs:   claude-relay.exe <path to claude.exe> <claude args...>
//
// This relay starts Claude with exactly those arguments and passes stdin, stdout and stderr through
// byte for byte. While doing so it looks at Claude's output for the one-line usage message Claude
// sends after every reply ({"type":"rate_limit_event",...}) and copies that line to
//   %LOCALAPPDATA%\claude-accounts\live\<account key>.json
// which the Claude Accounts panel watches. Nothing is changed, sent anywhere or logged otherwise.
//
// If the relay is stopped, Windows stops its Claude process too (job object), just as if Claude
// itself had been stopped; processes that Claude starts on its own are not affected.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Web.Script.Serialization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class ClaudeRelay
{
    const string Marker = "\"type\":\"rate_limit_event\"";
    const int MaxLine = 256 * 1024; // usage lines are tiny; longer lines are chat text and are skipped

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--relay-selftest")
        {
            Console.Out.Write("claude-relay ok");
            return 0;
        }
        if (args.Length >= 1 && args[0] == "--statusline") return StatusLine();
        if (args.Length == 0)
        {
            Console.Error.WriteLine("claude-relay: missing the path to Claude");
            return 2;
        }

        var psi = new ProcessStartInfo(args[0], JoinArgs(args, 1))
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };

        Process child;
        try
        {
            child = Process.Start(psi);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("claude-relay: could not start Claude: " + e.Message);
            return 1;
        }
        TieLifetime(child);

        var liveFile = LiveFilePath();
        var outThread = new Thread(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), liveFile));
        var errThread = new Thread(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError(), null));
        var inThread = new Thread(() => PumpInput(Console.OpenStandardInput(), child.StandardInput.BaseStream)) { IsBackground = true };
        outThread.Start();
        errThread.Start();
        inThread.Start();

        child.WaitForExit();
        outThread.Join();
        errThread.Join();
        return child.ExitCode;
    }

    // ---------- Pass-through ----------

    static void Pump(Stream from, Stream to, string liveFile)
    {
        var buf = new byte[65536];
        var line = new MemoryStream();
        bool skipping = false;
        try
        {
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0)
            {
                to.Write(buf, 0, n);
                to.Flush();
                if (liveFile == null) continue;

                int start = 0;
                for (int i = 0; i < n; i++)
                {
                    if (buf[i] != (byte)'\n') continue;
                    if (!skipping)
                    {
                        line.Write(buf, start, i - start);
                        Inspect(line, liveFile);
                    }
                    line.SetLength(0);
                    skipping = false;
                    start = i + 1;
                }
                if (!skipping && start < n)
                {
                    line.Write(buf, start, n - start);
                    if (line.Length > MaxLine)
                    {
                        line.SetLength(0);
                        skipping = true;
                    }
                }
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        try { to.Flush(); } catch { }
    }

    static void PumpInput(Stream from, Stream to)
    {
        var buf = new byte[65536];
        try
        {
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0)
            {
                to.Write(buf, 0, n);
                to.Flush();
            }
        }
        catch { }
        try { to.Close(); } catch { } // end of input: let Claude finish and exit as usual
    }

    // ---------- Usage copy ----------

    static void Inspect(MemoryStream line, string liveFile)
    {
        if (line.Length == 0 || line.Length > MaxLine) return;
        string text;
        try { text = Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length).Trim(); }
        catch { return; }
        if (!text.StartsWith("{") || text.IndexOf(Marker, StringComparison.Ordinal) < 0) return;
        WriteLive(liveFile, text);
    }

    static void WriteLive(string liveFile, string eventJson)
    {
        try
        {
            var dir = Path.GetDirectoryName(liveFile);
            Directory.CreateDirectory(dir);
            var tmp = liveFile + "." + Process.GetCurrentProcess().Id + ".tmp";
            var json = "{\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() +
                       ",\"configDir\":" + JsonString(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? "") +
                       ",\"event\":" + eventJson + "}";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (File.Exists(liveFile)) File.Replace(tmp, liveFile, null);
            else File.Move(tmp, liveFile);
        }
        catch { } // never let the copy affect Claude
    }

    // ---------- Status line mode (terminal chats) ----------
    // Claude runs the status line command after each reply in a terminal and passes JSON on stdin with
    // rate_limits.five_hour / seven_day { used_percentage, resets_at }. We save them in the same format
    // as the relay and print a short status line.

    static int StatusLine()
    {
        string text = "";
        try
        {
            string input;
            using (var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) input = r.ReadToEnd();
            var root = new JavaScriptSerializer().DeserializeObject(input) as Dictionary<string, object>;
            var limits = Get(root, "rate_limits");
            var parts = new List<string>();
            var windows = new List<string>();
            AddWindow("five_hour", "Session", Get(limits, "five_hour"), parts, windows);
            AddWindow("seven_day", "Weekly", Get(limits, "seven_day"), parts, windows);
            if (windows.Count > 0)
            {
                WriteLive(LiveFilePath(), "{\"type\":\"rate_limit_event\",\"source\":\"statusline\",\"rate_limit_info\":{\"unifiedWindows\":{" + string.Join(",", windows.ToArray()) + "}}}");
            }
            text = string.Join(" | ", parts.ToArray());
        }
        catch { }
        var o = Console.OpenStandardOutput();
        var b = Encoding.UTF8.GetBytes(text);
        o.Write(b, 0, b.Length);
        o.Flush();
        return 0;
    }

    static Dictionary<string, object> Get(Dictionary<string, object> d, string k)
    {
        object v;
        return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
    }

    static void AddWindow(string name, string label, Dictionary<string, object> w, List<string> parts, List<string> windows)
    {
        object p, r;
        if (w == null || !w.TryGetValue("used_percentage", out p) || p == null) return;
        double pct = Convert.ToDouble(p, CultureInfo.InvariantCulture);
        string reset = w.TryGetValue("resets_at", out r) && r != null ? Convert.ToInt64(Convert.ToDouble(r, CultureInfo.InvariantCulture)).ToString(CultureInfo.InvariantCulture) : "null";
        windows.Add("\"" + name + "\":{\"utilization\":" + (pct / 100).ToString("0.####", CultureInfo.InvariantCulture) + ",\"resetsAt\":" + reset + ",\"status\":\"allowed\"}");
        parts.Add(label + " " + Math.Round(pct).ToString(CultureInfo.InvariantCulture) + "%");
    }

    /// <summary>Same key the panel computes: login folder lower-cased, every other character a dash.</summary>
    static string LiveFilePath()
    {
        var dir = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") ?? "";
        dir = dir.Trim().Replace('/', '\\').TrimEnd('\\').ToLowerInvariant();
        var key = dir.Length == 0 ? "default" : Regex.Replace(dir, "[^a-z0-9]", "-");
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(root, "claude-accounts", "live", key + ".json");
    }

    static string JsonString(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // ---------- Arguments (Windows quoting rules, so Claude receives exactly what was passed) ----------

    static string JoinArgs(string[] args, int from)
    {
        var sb = new StringBuilder();
        for (int i = from; i < args.Length; i++)
        {
            if (i > from) sb.Append(' ');
            sb.Append(Quote(args[i]));
        }
        return sb.ToString();
    }

    static string Quote(string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        for (int i = 0; ; i++)
        {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
            if (i == arg.Length)
            {
                sb.Append('\\', slashes * 2);
                break;
            }
            if (arg[i] == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
            else sb.Append('\\', slashes).Append(arg[i]);
        }
        return sb.Append('"').ToString();
    }

    // ---------- Lifetime: stopping the relay stops its Claude process ----------

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong A, B, C, D, E, F; }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr job; // kept open for the relay's lifetime; closing it (relay exit) stops Claude

    static void TieLifetime(Process child)
    {
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            var info = new ExtendedLimits();
            // KILL_ON_JOB_CLOSE (0x2000) | SILENT_BREAKAWAY_OK (0x1000): only Claude itself is tied to the
            // relay; programs Claude starts are left alone, exactly as without the relay.
            info.Basic.LimitFlags = 0x2000 | 0x1000;
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr p = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, p, false);
                SetInformationJobObject(job, 9, p, (uint)size); // JobObjectExtendedLimitInformation
            }
            finally
            {
                Marshal.FreeHGlobal(p);
            }
            AssignProcessToJobObject(job, child.Handle);
        }
        catch { }
    }
}
