using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace PumpV
{
    internal class CompanionOfflineException : Exception
    {
        public CompanionOfflineException(string message) : base(message) { }
    }

    /// <summary>Nothing is listening, so nothing was done and starting one is safe.</summary>
    internal sealed class CompanionNotRunningException : CompanionOfflineException
    {
        public CompanionNotRunningException(string message) : base(message) { }
    }

    /// <summary>
    /// Talks to the companion on 127.0.0.1, starting it first if it isn't running.
    /// The port and the per-run token come from connection.json, which the
    /// companion rewrites on every start; on a 401 (companion restarted) it is
    /// simply read again. Runs on background threads only - never call game
    /// natives from here.
    /// </summary>
    internal sealed class CompanionClient : IDisposable
    {
        private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(30);

        private readonly string _dir;
        private readonly string _exePath;
        private readonly TimeSpan _timeout;
        private readonly object _lock = new object();
        private HttpClient _http;
        private string _imagesDir;
        private Task _starting;

        public CompanionClient(string dir, string exePath, int timeoutSeconds)
        {
            _dir = dir;
            _exePath = exePath;
            _timeout = TimeSpan.FromSeconds(Math.Max(10, timeoutSeconds));
        }

        public string ConnectionFile => Path.Combine(_dir, "connection.json");

        public string ImagesDir
        {
            get { lock (_lock) return _imagesDir ?? Path.Combine(_dir, "images"); }
        }

        public static string DefaultDir()
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "PumpV");
        }

        private HttpClient Connect(bool forceReload)
        {
            lock (_lock)
            {
                if (_http != null && !forceReload) return _http;
                if (!File.Exists(ConnectionFile))
                    throw new CompanionNotRunningException("Companion not running.");

                Dictionary<string, object> info;
                try { info = UiJson.Object(File.ReadAllText(ConnectionFile)); }
                catch (Exception e) { throw new CompanionOfflineException("Can't read connection.json: " + e.Message); }

                int port = info.TryGetValue("port", out var p) ? Convert.ToInt32(p) : 0;
                string token = info.TryGetValue("token", out var t) ? t as string : null;
                if (port <= 0 || string.IsNullOrEmpty(token))
                    throw new CompanionOfflineException("connection.json is incomplete.");
                if (info.TryGetValue("imagesDir", out var d) && d is string dir && dir.Length > 0)
                    _imagesDir = dir;

                _http?.Dispose();
                var handler = new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false };
                _http = new HttpClient(handler)
                {
                    BaseAddress = new Uri("http://127.0.0.1:" + port + "/"),
                    Timeout = _timeout,
                };
                _http.DefaultRequestHeaders.Add("X-PumpV-Token", token);
                return _http;
            }
        }

        public Task<UiResponse> GetAsync(string path) => SendAsync(HttpMethod.Get, path, null);

        public Task<UiResponse> PostAsync(string path, Dictionary<string, object> body) => SendAsync(HttpMethod.Post, path, body);

        private async Task<UiResponse> SendAsync(HttpMethod method, string path, Dictionary<string, object> body)
        {
            try
            {
                return await SendOnceAsync(method, path, body).ConfigureAwait(false);
            }
            catch (CompanionNotRunningException)
            {
                await EnsureStartedAsync().ConfigureAwait(false);
            }
            return await SendOnceAsync(method, path, body).ConfigureAwait(false);
        }

        private async Task<UiResponse> SendOnceAsync(HttpMethod method, string path, Dictionary<string, object> body)
        {
            if (string.IsNullOrEmpty(path) || !path.StartsWith("/ui/", StringComparison.Ordinal))
                throw new InvalidOperationException("Refusing non-UI path: " + path);

            for (int attempt = 0; attempt < 2; attempt++)
            {
                HttpClient http = Connect(forceReload: attempt > 0);
                var req = new HttpRequestMessage(method, path.TrimStart('/'));
                if (method == HttpMethod.Post)
                    req.Content = new StringContent(UiJson.Serialize(body ?? new Dictionary<string, object>()), Encoding.UTF8, "application/json");

                HttpResponseMessage res;
                try
                {
                    res = await http.SendAsync(req).ConfigureAwait(false);
                }
                catch (TaskCanceledException)
                {
                    throw new CompanionOfflineException("Companion timed out.");
                }
                catch (HttpRequestException)
                {
                    if (attempt == 0) continue; // maybe restarted on a new port
                    throw new CompanionNotRunningException("Companion not reachable.");
                }

                using (res)
                {
                    if (res.StatusCode == HttpStatusCode.Unauthorized && attempt == 0)
                        continue; // restarted with a new token
                    string text = await res.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!res.IsSuccessStatusCode)
                        throw new CompanionOfflineException("Companion error " + (int)res.StatusCode);
                    return UiJson.ParseResponse(text);
                }
            }
            throw new CompanionNotRunningException("Companion not reachable.");
        }

        /// <summary>Several requests can find it missing at once; they all wait for one start.</summary>
        private Task EnsureStartedAsync()
        {
            lock (_lock)
            {
                if (_starting == null || _starting.IsCompleted)
                    _starting = Task.Run(StartAsync);
                return _starting;
            }
        }

        private async Task StartAsync()
        {
            if (!File.Exists(_exePath))
                throw new CompanionOfflineException("Companion is missing. Reinstall PUMP.");

            Directory.CreateDirectory(_dir);
            File.Delete(ConnectionFile); // left by one that crashed; the new one writes its own
            var start = new ProcessStartInfo(_exePath, "start --parent-pid " + Process.GetCurrentProcess().Id)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = _dir,
            };
            start.EnvironmentVariables["PUMPV_HOME"] = _dir;

            using (Process process = Process.Start(start))
            {
                Stopwatch waited = Stopwatch.StartNew();
                while (!File.Exists(ConnectionFile))
                {
                    if (process.HasExited)
                        throw new CompanionOfflineException("Companion stopped. See companion.log.");
                    if (waited.Elapsed > StartTimeout)
                        throw new CompanionOfflineException("Companion took too long to start.");
                    await Task.Delay(100).ConfigureAwait(false);
                }
            }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                _http?.Dispose();
                _http = null;
            }
        }
    }
}
