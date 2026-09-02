# Drive Sync native GUI

This is a low-memory Windows GUI for the existing `drive_sync.py` engine. It uses native .NET WinForms controls instead of Electron/Chromium, keeps the transfer work in a separate Python process, and never puts the API key in the child command line or state JSON.

## Run from the repository

From the repository root:

```powershell
dotnet run --project tools/drive-sync/gui/DriveSync.Gui.csproj
```

Choose a folder or files, enter the panel URL/project/bucket/API key, and press **Start sync**. Use **Load state** to select an existing `DriveSync` JSON; it restores the target and source identity, then reuses completed files and known multipart parts. Enter the API key again because it is intentionally not stored in the JSON.

## Publish a Windows executable

Framework-dependent publish (requires the .NET 7 desktop runtime):

```powershell
dotnet publish tools/drive-sync/gui/DriveSync.Gui.csproj -c Release -r win-x64 --self-contained false
```

For a portable single-file build that includes the .NET runtime:

```powershell
dotnet publish tools/drive-sync/gui/DriveSync.Gui.csproj -c Release -r win-x64 --self-contained true /p:PublishSingleFile=true
```

Python must be installed and available as `python`, or select `python.exe` in the GUI. The executable copies `drive_sync.py` beside itself during publish.
