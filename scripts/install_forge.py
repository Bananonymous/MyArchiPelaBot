#!/usr/bin/env python3
"""
One-time Forge server installation for Minecraft / Minecraft Dig.

Reads the required Forge/NeoForge version from the installed apworld,
downloads the installer, runs it, and accepts the EULA.

Usage (from inside the container):
  python3 /app/scripts/install_forge.py <server_path> [minecraft|minecraft_dig]

Example:
  python3 /app/scripts/install_forge.py /opt/minecraft minecraft_dig
"""
import os
import re
import sys
import types
import zipfile
import tempfile
import subprocess
import urllib.request

# Prevent ModuleUpdate from calling input()
_mu = types.ModuleType("ModuleUpdate")
_mu.update = lambda: None
sys.modules["ModuleUpdate"] = _mu

sys.path.insert(0, "/opt/archipelago")

# Fallback versions if we can't read them from the apworld
FALLBACK = {
    "minecraft_dig": {"mc": "1.19.4", "forge": "47.2.0", "loader": "forge"},
    "minecraft":     {"mc": "1.20.4", "forge": "20.4.237", "loader": "neoforge"},
}

FORGE_MAVEN   = "https://maven.minecraftforge.net/net/minecraftforge/forge"
NEOFORGE_URL  = "https://maven.neoforged.net/releases/net/neoforged/neoforge"


def read_version_from_apworld(game_key):
    """Open the .apworld zip and scan for version constants in Python source."""
    apworld = f"/opt/archipelago/worlds/{game_key}.apworld"
    if not os.path.exists(apworld):
        return None

    version_patterns = {
        "mc":    re.compile(r'(?:MC_VERSION|mc_version|minecraft_version)\s*[=:]\s*["\']([0-9.]+)["\']', re.I),
        "forge": re.compile(r'(?:FORGE_VERSION|forge_version|neoforge_version|NEOFORGE_VERSION)\s*[=:]\s*["\']([0-9.]+)["\']', re.I),
        "loader": re.compile(r'(?:LOADER|loader)\s*[=:]\s*["\']([a-z]+)["\']', re.I),
    }
    found = {}

    with zipfile.ZipFile(apworld, "r") as z:
        for name in z.namelist():
            if not name.endswith(".py"):
                continue
            try:
                text = z.read(name).decode("utf-8", errors="ignore")
            except Exception:
                continue
            for key, pat in version_patterns.items():
                if key not in found:
                    m = pat.search(text)
                    if m:
                        found[key] = m.group(1)
        if len(found) >= 2:
            found.setdefault("loader", "neoforge" if found.get("mc", "0") >= "1.20" else "forge")
            return found
    return None


def installer_url(loader, mc, forge):
    if loader == "neoforge":
        return f"{NEOFORGE_URL}/{forge}/neoforge-{forge}-installer.jar"
    return f"{FORGE_MAVEN}/{mc}-{forge}/forge-{mc}-{forge}-installer.jar"


def jar_name(loader, mc, forge):
    if loader == "neoforge":
        return f"neoforge-{forge}"
    return f"forge-{mc}-{forge}"


def find_server_jar(server_path):
    if not os.path.isdir(server_path):
        return None
    for f in os.listdir(server_path):
        if re.match(r"(forge|neoforge)-.*\.(jar|sh)$", f) and "installer" not in f:
            return os.path.join(server_path, f)
    return None


def main():
    server_path = sys.argv[1] if len(sys.argv) > 1 else "/opt/minecraft"
    game_key    = sys.argv[2] if len(sys.argv) > 2 else "minecraft_dig"

    os.makedirs(server_path, exist_ok=True)

    # Check if already installed
    if find_server_jar(server_path):
        print(f"Forge already installed in {server_path}. Nothing to do.")
        return

    # Try to read version from apworld
    info = read_version_from_apworld(game_key)
    if info:
        print(f"Detected from apworld: loader={info['loader']} mc={info['mc']} forge={info['forge']}")
    else:
        info = FALLBACK.get(game_key, FALLBACK["minecraft_dig"])
        print(f"Could not read version from apworld, using fallback: {info}")

    url = installer_url(info["loader"], info["mc"], info["forge"])
    print(f"Downloading installer: {url}")

    fd, installer_path = tempfile.mkstemp(suffix=".jar")
    os.close(fd)
    try:
        urllib.request.urlretrieve(url, installer_path)
    except Exception as e:
        print(f"Download failed: {e}", file=sys.stderr)
        print("Try downloading the installer manually and placing it in:", server_path, file=sys.stderr)
        os.unlink(installer_path)
        sys.exit(1)

    print("Running installer (this may take a minute)…")
    result = subprocess.run(
        ["java", "-jar", installer_path, "--installServer"],
        cwd=server_path,
    )
    os.unlink(installer_path)

    if result.returncode != 0:
        print(f"Installer exited {result.returncode} — check output above.", file=sys.stderr)
        sys.exit(1)

    # Accept EULA
    eula = os.path.join(server_path, "eula.txt")
    with open(eula, "w") as f:
        f.write("# Auto-accepted by ArchipelaBot install script\neula=true\n")

    # Verify
    if find_server_jar(server_path):
        print(f"\nForge server installed successfully in {server_path}")
        print("EULA accepted. You can now start games with Minecraft Dig.")
    else:
        print("Installer ran but no Forge JAR found — check logs above.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
