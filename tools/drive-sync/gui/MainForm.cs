using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DriveSync.Gui;

internal sealed class MainForm : Form
{
    private readonly TextBox _panelUrl = new();
    private readonly TextBox _projectId = new();
    private readonly TextBox _bucket = new();
    private readonly TextBox _apiKey = new();
    private readonly TextBox _folder = new();
    private readonly ListBox _files = new();
    private readonly TextBox _prefix = new();
    private readonly TextBox _stateFile = new();
    private readonly TextBox _python = new();
    private readonly CheckBox _contentsOnly = new();
    private readonly CheckBox _preserveEmpty = new();
    private readonly NumericUpDown _workers = new();
    private readonly NumericUpDown _partWorkers = new();
    private readonly NumericUpDown _retries = new();
    private readonly ProgressBar _progress = new();
    private readonly Label _status = new();
    private readonly RichTextBox _log = new();
    private readonly Button _start = new();
    private readonly Button _stop = new();

    private Process? _process;
    private bool _stopRequested;
    private readonly object _streamLock = new();
    private readonly StringBuilder _stdoutBuffer = new();
    private readonly StringBuilder _stderrBuffer = new();

    private static readonly Regex ProgressPattern = new(
        @"Sync\s+(?<percent>\d+(?:\.\d+)?)%\s+(?<moved>.*?)\s+/\s+(?<total>.+)$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    public MainForm()
    {
        Text = "Drive Sync";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(900, 650);
        Size = new Size(1080, 820);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9F);
        BackColor = Color.FromArgb(248, 249, 251);

        ConfigureControls();
        BuildLayout();
        FormClosing += OnFormClosing;
    }

    private void ConfigureControls()
    {
        ConfigureTextBox(_panelUrl, "https://drive.nadith.pro");
        ConfigureTextBox(_projectId);
        ConfigureTextBox(_bucket);
        ConfigureTextBox(_apiKey);
        _apiKey.UseSystemPasswordChar = true;
        _apiKey.PlaceholderText = "Enter the project API key";

        ConfigureTextBox(_folder);
        ConfigureTextBox(_prefix);
        ConfigureTextBox(_stateFile);
        ConfigureTextBox(_python, "python");

        _files.Dock = DockStyle.Fill;
        _files.HorizontalScrollbar = true;
        _files.IntegralHeight = false;
        _files.SelectionMode = SelectionMode.MultiExtended;

        _contentsOnly.Text = "Contents only (omit selected folder name)";
        _contentsOnly.AutoSize = true;
        _preserveEmpty.Text = "Preserve empty folders";
        _preserveEmpty.Checked = true;
        _preserveEmpty.AutoSize = true;

        ConfigureNumeric(_workers, 3);
        ConfigureNumeric(_partWorkers, 4);
        ConfigureNumeric(_retries, 5, 1, 20);

        _progress.Dock = DockStyle.Fill;
        _progress.Minimum = 0;
        _progress.Maximum = 1000;
        _progress.Style = ProgressBarStyle.Continuous;

        _status.Text = "Ready";
        _status.AutoEllipsis = true;
        _status.Dock = DockStyle.Fill;
        _status.TextAlign = ContentAlignment.MiddleLeft;

        _log.Dock = DockStyle.Fill;
        _log.ReadOnly = true;
        _log.BackColor = Color.FromArgb(24, 27, 32);
        _log.ForeColor = Color.FromArgb(225, 230, 238);
        _log.BorderStyle = BorderStyle.None;
        _log.Font = new Font("Consolas", 9F);
        _log.DetectUrls = true;
        _log.WordWrap = false;

        _start.Text = "Start sync";
        _start.AutoSize = true;
        _start.Padding = new Padding(12, 4, 12, 4);
        _start.Click += async (_, _) => await StartSyncAsync();

        _stop.Text = "Stop";
        _stop.AutoSize = true;
        _stop.Padding = new Padding(12, 4, 12, 4);
        _stop.Enabled = false;
        _stop.Click += (_, _) => StopSync();
    }

    private static void ConfigureTextBox(TextBox box, string? text = null)
    {
        box.Dock = DockStyle.Fill;
        box.Margin = new Padding(3);
        if (text is not null) box.Text = text;
    }

    private static void ConfigureNumeric(NumericUpDown control, int value, int minimum = 1, int maximum = 16)
    {
        control.Minimum = minimum;
        control.Maximum = maximum;
        control.Value = value;
        control.Width = 78;
        control.Anchor = AnchorStyles.Left;
    }

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(14),
            ColumnCount = 1,
            RowCount = 7,
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 154));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 126));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 42));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        root.Controls.Add(CreateHeader(), 0, 0);
        root.Controls.Add(CreateConnectionGroup(), 0, 1);
        root.Controls.Add(CreateSourceGroup(), 0, 2);
        root.Controls.Add(CreateOptionsGroup(), 0, 3);
        root.Controls.Add(CreateActionBar(), 0, 4);
        root.Controls.Add(CreateProgressBar(), 0, 5);
        root.Controls.Add(CreateLogGroup(), 0, 6);
    }

    private Control CreateHeader()
    {
        var panel = new Panel { Dock = DockStyle.Fill };
        var title = new Label
        {
            Text = "Drive Sync",
            Font = new Font("Segoe UI Semibold", 19F),
            AutoSize = true,
            Location = new Point(0, 0),
        };
        var subtitle = new Label
        {
            Text = "Resumable uploads with bounded workers and exact verification",
            ForeColor = Color.FromArgb(90, 98, 110),
            AutoSize = true,
            Location = new Point(2, 34),
        };
        panel.Controls.Add(title);
        panel.Controls.Add(subtitle);
        return panel;
    }

    private GroupBox CreateConnectionGroup()
    {
        var group = new GroupBox { Text = "Drive connection", Dock = DockStyle.Fill, Padding = new Padding(10) };
        var grid = CreateFieldGrid(4);
        AddField(grid, 0, "Panel URL", _panelUrl);
        AddField(grid, 1, "Project ID", _projectId);
        AddField(grid, 2, "Bucket", _bucket);
        AddField(grid, 3, "API key", _apiKey);
        group.Controls.Add(grid);
        return group;
    }

    private GroupBox CreateSourceGroup()
    {
        var group = new GroupBox { Text = "Source", Dock = DockStyle.Fill, Padding = new Padding(10) };
        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 3,
            RowCount = 2,
            Padding = new Padding(0),
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 116));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
        grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        grid.Controls.Add(FieldLabel("Folder"), 0, 0);
        grid.Controls.Add(_folder, 1, 0);
        grid.Controls.Add(MakeButton("Choose folder", ChooseFolder), 2, 0);

        grid.Controls.Add(FieldLabel("Files"), 0, 1);
        grid.Controls.Add(_files, 1, 1);
        var fileButtons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false };
        fileButtons.Controls.Add(MakeButton("Add files", ChooseFiles, 108));
        fileButtons.Controls.Add(MakeButton("Clear source", ClearSource, 108));
        grid.Controls.Add(fileButtons, 2, 1);

        group.Controls.Add(grid);
        return group;
    }

    private GroupBox CreateOptionsGroup()
    {
        var group = new GroupBox { Text = "Resume and transfer options", Dock = DockStyle.Fill, Padding = new Padding(10) };
        var grid = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 3,
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 105));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 105));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        grid.Controls.Add(FieldLabel("Prefix"), 0, 0);
        grid.Controls.Add(_prefix, 1, 0);
        grid.Controls.Add(FieldLabel("File workers"), 2, 0);
        grid.Controls.Add(_workers, 3, 0);

        grid.Controls.Add(FieldLabel("State JSON"), 0, 1);
        grid.Controls.Add(_stateFile, 1, 1);
        grid.Controls.Add(MakeButton("Browse", BrowseState, 96), 2, 1);
        grid.Controls.Add(MakeButton("Load state", LoadState, 96), 3, 1);

        var checks = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = true, AutoSize = true };
        checks.Controls.Add(_contentsOnly);
        checks.Controls.Add(_preserveEmpty);
        checks.Controls.Add(new Label { Text = "  Part workers", AutoSize = true, Padding = new Padding(8, 5, 0, 0) });
        checks.Controls.Add(_partWorkers);
        checks.Controls.Add(new Label { Text = "  Retries", AutoSize = true, Padding = new Padding(8, 5, 0, 0) });
        checks.Controls.Add(_retries);
        grid.Controls.Add(checks, 0, 2);
        grid.SetColumnSpan(checks, 4);

        group.Controls.Add(grid);
        return group;
    }

    private Control CreateActionBar()
    {
        var bar = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 5, RowCount = 1 };
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        bar.Controls.Add(FieldLabel("Python"), 0, 0);
        bar.Controls.Add(_python, 1, 0);
        bar.Controls.Add(MakeButton("Browse", BrowsePython, 96), 2, 0);
        bar.Controls.Add(_start, 3, 0);
        bar.Controls.Add(_stop, 4, 0);
        return bar;
    }

    private Control CreateProgressBar()
    {
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 1 };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 260));
        panel.Controls.Add(_progress, 0, 0);
        panel.Controls.Add(_status, 1, 0);
        return panel;
    }

    private Control CreateLogGroup()
    {
        var group = new GroupBox { Text = "Activity", Dock = DockStyle.Fill, Padding = new Padding(8) };
        group.Controls.Add(_log);
        return group;
    }

    private static TableLayoutPanel CreateFieldGrid(int rows)
    {
        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = rows };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 95));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < rows; i++) grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 30));
        return grid;
    }

    private static void AddField(TableLayoutPanel grid, int row, string label, Control control)
    {
        grid.Controls.Add(FieldLabel(label), 0, row);
        grid.Controls.Add(control, 1, row);
    }

    private static Label FieldLabel(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Anchor = AnchorStyles.Left,
        Padding = new Padding(2, 6, 0, 0),
    };

    private static Button MakeButton(string text, Action action, int width = 110)
    {
        var button = new Button { Text = text, Width = width, Height = 27, Margin = new Padding(3) };
        button.Click += (_, _) => action();
        return button;
    }

    private void ChooseFolder()
    {
        using var dialog = new FolderBrowserDialog { Description = "Choose the folder to sync" };
        if (Directory.Exists(_folder.Text)) dialog.SelectedPath = _folder.Text;
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        _folder.Text = dialog.SelectedPath;
        _files.Items.Clear();
    }

    private void ChooseFiles()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose files to sync",
            Multiselect = true,
            CheckFileExists = true,
            RestoreDirectory = true,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        _folder.Clear();
        _files.Items.Clear();
        foreach (var file in dialog.FileNames) _files.Items.Add(file);
    }

    private void ClearSource()
    {
        _folder.Clear();
        _files.Items.Clear();
    }

    private void BrowseState()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose a Drive Sync state JSON",
            Filter = "Drive Sync state (*.json)|*.json|All files (*.*)|*.*",
            CheckFileExists = true,
            RestoreDirectory = true,
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) _stateFile.Text = dialog.FileName;
    }

    private void BrowsePython()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Choose python.exe",
            Filter = "Python executable (python.exe)|python.exe|All files (*.*)|*.*",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) _python.Text = dialog.FileName;
    }

    private void LoadState()
    {
        var path = _stateFile.Text.Trim();
        if (string.IsNullOrWhiteSpace(path))
        {
            BrowseState();
            path = _stateFile.Text.Trim();
        }
        if (string.IsNullOrWhiteSpace(path)) return;

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            var identity = root.GetProperty("identity");
            SetJsonText(identity, "panelUrl", _panelUrl);
            SetJsonText(identity, "projectId", _projectId);
            SetJsonText(identity, "bucket", _bucket);
            SetJsonText(identity, "prefix", _prefix);

            if (identity.TryGetProperty("source", out var source))
            {
                _folder.Clear();
                _files.Items.Clear();
                if (source.TryGetProperty("folder", out var folder) && folder.ValueKind == JsonValueKind.String)
                {
                    _folder.Text = folder.GetString() ?? "";
                }
                else if (source.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array)
                {
                    foreach (var file in files.EnumerateArray())
                    {
                        if (file.ValueKind == JsonValueKind.String && file.GetString() is { } filePath)
                            _files.Items.Add(filePath);
                    }
                }

                if (source.TryGetProperty("includeRoot", out var includeRoot) && includeRoot.ValueKind == JsonValueKind.False)
                    _contentsOnly.Checked = true;
                else
                    _contentsOnly.Checked = false;

                if (source.TryGetProperty("preserveEmptyFolders", out var preserve) && preserve.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    _preserveEmpty.Checked = preserve.GetBoolean();
            }

            var statuses = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            if (root.TryGetProperty("files", out var stateFiles) && stateFiles.ValueKind == JsonValueKind.Object)
            {
                foreach (var file in stateFiles.EnumerateObject())
                {
                    if (!file.Value.TryGetProperty("status", out var status) || status.ValueKind != JsonValueKind.String) continue;
                    var value = status.GetString() ?? "unknown";
                    statuses[value] = statuses.TryGetValue(value, out var count) ? count + 1 : 1;
                }
            }

            SetStatus($"Loaded state: {string.Join(", ", statuses.Select(item => $"{item.Key}={item.Value}"))}");
            AppendLog($"Loaded resume state: {path}");
            AppendLog("The API key is never read from or written to the state JSON; enter it above.");
        }
        catch (Exception exception)
        {
            ShowError($"Could not load the state JSON:\n{exception.Message}");
        }
    }

    private static void SetJsonText(JsonElement parent, string property, TextBox target)
    {
        if (parent.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String)
            target.Text = value.GetString() ?? "";
    }

    private async Task StartSyncAsync()
    {
        if (_process is not null) return;
        if (!ValidateInputs(out var folder, out var files)) return;

        var script = Path.Combine(AppContext.BaseDirectory, "drive_sync.py");
        if (!File.Exists(script))
        {
            ShowError($"The sync engine was not found beside the GUI:\n{script}\n\nBuild the GUI project so drive_sync.py is copied next to it.");
            return;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = _python.Text.Trim(),
            WorkingDirectory = Path.GetDirectoryName(script)!,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-u");
        startInfo.ArgumentList.Add(script);
        startInfo.ArgumentList.Add("--non-interactive");
        startInfo.ArgumentList.Add("--panel-url");
        startInfo.ArgumentList.Add(_panelUrl.Text.Trim());
        startInfo.ArgumentList.Add("--project-id");
        startInfo.ArgumentList.Add(_projectId.Text.Trim());
        startInfo.ArgumentList.Add("--bucket");
        startInfo.ArgumentList.Add(_bucket.Text.Trim());
        if (!string.IsNullOrWhiteSpace(folder))
        {
            startInfo.ArgumentList.Add("--folder");
            startInfo.ArgumentList.Add(folder);
        }
        else
        {
            foreach (var file in files)
            {
                startInfo.ArgumentList.Add("--file");
                startInfo.ArgumentList.Add(file);
            }
        }
        if (!string.IsNullOrWhiteSpace(_prefix.Text))
        {
            startInfo.ArgumentList.Add("--prefix");
            startInfo.ArgumentList.Add(_prefix.Text.Trim());
        }
        if (_contentsOnly.Checked) startInfo.ArgumentList.Add("--contents-only");
        startInfo.ArgumentList.Add(_preserveEmpty.Checked ? "--preserve-empty-folders" : "--no-preserve-empty-folders");
        startInfo.ArgumentList.Add("--workers");
        startInfo.ArgumentList.Add(((int)_workers.Value).ToString());
        startInfo.ArgumentList.Add("--part-workers");
        startInfo.ArgumentList.Add(((int)_partWorkers.Value).ToString());
        startInfo.ArgumentList.Add("--retries");
        startInfo.ArgumentList.Add(((int)_retries.Value).ToString());
        if (!string.IsNullOrWhiteSpace(_stateFile.Text))
        {
            startInfo.ArgumentList.Add("--state-file");
            startInfo.ArgumentList.Add(_stateFile.Text.Trim());
        }

        // The secret is supplied only through the child process environment,
        // never through the command line or the saved state file.
        startInfo.Environment["DRIVE_API_KEY"] = _apiKey.Text.Trim();

        var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        try
        {
            if (!process.Start())
            {
                process.Dispose();
                ShowError("Python could not be started.");
                return;
            }
        }
        catch (Exception exception)
        {
            process.Dispose();
            ShowError($"Could not start Python:\n{exception.Message}");
            return;
        }

        _process = process;
        _stopRequested = false;
        _start.Enabled = false;
        _stop.Enabled = true;
        _apiKey.Enabled = false;
        SetStatus("Sync running");
        AppendLog("Started sync engine. The API key is kept out of the command line.");

        try
        {
            await MonitorProcessAsync(process);
        }
        catch (Exception exception)
        {
            AppendLog($"GUI monitor error: {exception.Message}", true);
        }
    }

    private bool ValidateInputs(out string? folder, out List<string> files)
    {
        folder = string.IsNullOrWhiteSpace(_folder.Text) ? null : _folder.Text.Trim();
        files = _files.Items.Cast<string>().Where(File.Exists).ToList();

        if (string.IsNullOrWhiteSpace(_panelUrl.Text) || string.IsNullOrWhiteSpace(_projectId.Text) || string.IsNullOrWhiteSpace(_bucket.Text) || string.IsNullOrWhiteSpace(_apiKey.Text))
        {
            ShowError("Panel URL, project ID, bucket, and API key are required.");
            return false;
        }
        if (folder is not null && !Directory.Exists(folder))
        {
            ShowError($"Folder does not exist:\n{folder}");
            return false;
        }
        if (folder is null && files.Count == 0)
        {
            ShowError("Choose one folder or at least one existing file.");
            return false;
        }
        if (folder is not null && _files.Items.Count > 0)
        {
            ShowError("Choose either a folder or files, not both.");
            return false;
        }
        if (!Uri.TryCreate(_panelUrl.Text.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            ShowError("Panel URL must be an http:// or https:// URL.");
            return false;
        }
        if (!string.IsNullOrWhiteSpace(_stateFile.Text) && !Directory.Exists(Path.GetDirectoryName(Path.GetFullPath(_stateFile.Text))!))
        {
            ShowError("The state file parent folder does not exist.");
            return false;
        }
        return true;
    }

    private async Task MonitorProcessAsync(Process process)
    {
        var stdoutTask = ReadStreamAsync(process.StandardOutput, false);
        var stderrTask = ReadStreamAsync(process.StandardError, true);
        var waitTask = process.WaitForExitAsync();
        await Task.WhenAll(stdoutTask, stderrTask, waitTask);
        FlushStream(false);
        FlushStream(true);

        var exitCode = process.ExitCode;
        var stopped = _stopRequested;
        process.Dispose();
        _process = null;
        Ui(() =>
        {
            _start.Enabled = true;
            _stop.Enabled = false;
            _apiKey.Enabled = true;
            if (stopped)
            {
                SetStatus("Stopped; resume state preserved");
                AppendLog("Stopped. Completed files and saved multipart parts remain in the JSON state.");
            }
            else if (exitCode == 0)
            {
                SetStatus("Completed");
                AppendLog("Sync completed successfully.");
            }
            else
            {
                SetStatus($"Finished with failures (exit {exitCode})");
                AppendLog($"Sync finished with failures (exit {exitCode}). Review the state JSON and log above.", true);
            }
        });
    }

    private async Task ReadStreamAsync(StreamReader reader, bool error)
    {
        var buffer = new char[2048];
        while (true)
        {
            var count = await reader.ReadAsync(buffer, 0, buffer.Length);
            if (count == 0) break;
            lock (_streamLock)
            {
                var target = error ? _stderrBuffer : _stdoutBuffer;
                target.Append(buffer, 0, count);
                DrainStream(target, error, false);
            }
        }
    }

    private void FlushStream(bool error)
    {
        lock (_streamLock)
        {
            DrainStream(error ? _stderrBuffer : _stdoutBuffer, error, true);
        }
    }

    private void DrainStream(StringBuilder buffer, bool error, bool flush)
    {
        while (true)
        {
            var index = FindLineBreak(buffer);
            if (index < 0)
            {
                if (flush && buffer.Length > 0)
                {
                    var remainder = buffer.ToString();
                    buffer.Clear();
                    EmitOutput(remainder, error);
                }
                return;
            }

            var line = buffer.ToString(0, index);
            var breakLength = buffer[index] == '\r' && index + 1 < buffer.Length && buffer[index + 1] == '\n' ? 2 : 1;
            buffer.Remove(0, index + breakLength);
            if (line.Length > 0) EmitOutput(line, error);
        }
    }

    private static int FindLineBreak(StringBuilder buffer)
    {
        for (var index = 0; index < buffer.Length; index++)
            if (buffer[index] is '\r' or '\n') return index;
        return -1;
    }

    private void EmitOutput(string raw, bool error)
    {
        var line = raw.TrimEnd();
        if (line.Length == 0) return;
        var match = ProgressPattern.Match(line);
        if (match.Success && double.TryParse(match.Groups["percent"].Value, out var percent))
        {
            Ui(() =>
            {
                _progress.Value = Math.Clamp((int)Math.Round(percent * 10), 0, 1000);
                SetStatus($"{percent:0.00}%  {match.Groups["moved"].Value.Trim()} / {match.Groups["total"].Value.Trim()}");
            });
            return;
        }

        Ui(() => AppendLog(line, error));
    }

    private void StopSync()
    {
        var process = _process;
        if (process is null || process.HasExited) return;
        _stopRequested = true;
        SetStatus("Stopping...");
        AppendLog("Stopping the sync engine. The state file is designed to resume safely.");
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception exception)
        {
            AppendLog($"Could not stop the process: {exception.Message}", true);
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_process is null || _process.HasExited) return;
        var result = MessageBox.Show(this, "A sync is running. Stop it and keep its resume state?", "Drive Sync", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (result == DialogResult.No)
        {
            e.Cancel = true;
            return;
        }
        StopSync();
    }

    private void SetStatus(string value)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetStatus(value));
            return;
        }
        _status.Text = value;
    }

    private void AppendLog(string value, bool error = false)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendLog(value, error));
            return;
        }
        _log.SelectionColor = error ? Color.FromArgb(255, 145, 145) : Color.FromArgb(225, 230, 238);
        _log.AppendText($"{(error ? "[error] " : "")}{value}{Environment.NewLine}");
        _log.SelectionStart = _log.TextLength;
        _log.ScrollToCaret();
    }

    private void Ui(Action action)
    {
        if (IsDisposed || Disposing) return;
        if (InvokeRequired) BeginInvoke(action);
        else action();
    }

    private void ShowError(string message)
    {
        MessageBox.Show(this, message, "Drive Sync", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
