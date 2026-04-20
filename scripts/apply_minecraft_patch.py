#!/usr/bin/env python3
"""
Extract APData from a .apmc/.apmcdig patch file into the Minecraft Forge server directory,
and sync the mod jar from the installed apworld.

Usage:
  apply_minecraft_patch.py <archive_or_patch_file> <server_path>

  archive_or_patch_file — multiworld .zip containing the .apmc, or the .apmc/.apmcdig directly
  server_path           — path to the Minecraft Forge server directory
"""
import os
import sys
import types
import zipfile
import shutil
import tempfile

# Prevent ModuleUpdate from calling input() before any Archipelago imports
_mu = types.ModuleType("ModuleUpdate")
_mu.update = lambda: None
sys.modules["ModuleUpdate"] = _mu

sys.path.insert(0, "/opt/archipelago")


def extract_patch_from_zip(zip_path):
    """Return (tmp_file_path, original_name) for the first .apmc/.apmcdig in the zip."""
    with zipfile.ZipFile(zip_path, "r") as z:
        patch_name = next(
            (f for f in z.namelist() if f.endswith(".apmc") or f.endswith(".apmcdig")),
            None,
        )
        if not patch_name:
            return None, None
        suffix = os.path.splitext(patch_name)[1]
        fd, tmp = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        with z.open(patch_name) as src, open(tmp, "wb") as dst:
            dst.write(src.read())
        return tmp, patch_name


def apply_via_archipelago(patch_file, server_path):
    """Delegate to Archipelago's AutoPatchRegister — the most correct approach."""
    try:
        from Patch import AutoPatchRegister  # noqa: PLC0415

        ext = os.path.splitext(patch_file)[1].lower()
        handler_cls = AutoPatchRegister.patch_types.get(ext)
        if handler_cls is None:
            return False, f"no registered handler for '{ext}'"
        patch = handler_cls(patch_file)
        patch.patch(server_path)
        return True, None
    except Exception as exc:
        return False, str(exc)


def apply_via_extraction(patch_file, server_path, ap_server=""):
    """
    Manually replicate what Archipelago's apply_minecraft_data procedure does:
      1. Extract archipelago.json → APData/archipelago.json
      2. Read data.json from the patch zip, base64-encode it, write as
         APData/AP_{seed_name}_P{player_id}_{player_name}.apmc
    This matches the exact APData layout the Minecraft Dig mod expects.
    """
    import base64
    import json

    apdata_dir = os.path.join(server_path, "APData")
    if os.path.exists(apdata_dir):
        shutil.rmtree(apdata_dir)
    os.makedirs(apdata_dir, exist_ok=True)

    with zipfile.ZipFile(patch_file, "r") as z:
        members = z.namelist()

        # Extract archipelago.json, injecting the AP server address so the mod auto-connects
        if "archipelago.json" in members:
            with z.open("archipelago.json") as src:
                ap_meta = json.loads(src.read())
        else:
            return False, "archipelago.json not found in patch"

        if ap_server:
            ap_meta["server"] = ap_server
            print(f"[mc-setup] Set AP server to {ap_server} in archipelago.json", file=sys.stderr)

        with open(os.path.join(apdata_dir, "archipelago.json"), "w") as dst:
            json.dump(ap_meta, dst)

        # Find the data file referenced by the procedure
        proc = ap_meta.get("procedure", [])
        data_filename = None
        for step_name, step_args in proc:
            if step_name == "apply_minecraft_data" and step_args:
                data_filename = step_args[0]
                break
        if not data_filename:
            data_filename = "data.json"

        if data_filename not in members:
            return False, f"{data_filename} not found in patch"

        with z.open(data_filename) as src:
            raw_data = src.read()

        # Parse to extract naming fields, then base64-encode for the .apmc file
        try:
            game_data = json.loads(raw_data)
        except json.JSONDecodeError:
            return False, f"Could not parse {data_filename} as JSON"

        seed_name   = game_data.get("seed_name",   ap_meta.get("seed_name",   "unknown"))
        player_id   = game_data.get("player_id",   ap_meta.get("player",      1))
        player_name = game_data.get("player_name", ap_meta.get("player_name", "Player"))

        apmc_name = f"AP_{seed_name}_P{player_id}_{player_name}.apmc"
        apmc_content = base64.b64encode(raw_data)

        with open(os.path.join(apdata_dir, apmc_name), "wb") as dst:
            dst.write(apmc_content)

        print(f"[mc-setup] Wrote {apmc_name} and archipelago.json to APData", file=sys.stderr)

    return True, None


def sync_mod_jar(server_path, is_dig=False):
    """Copy the mod jar from the installed apworld into the Forge server's mods/ dir."""
    game_key = "minecraft_dig" if is_dig else "minecraft"
    data_dir = f"/opt/archipelago/worlds/{game_key}/data"
    mods_dir = os.path.join(server_path, "mods")

    if not os.path.isdir(mods_dir) or not os.path.isdir(data_dir):
        return

    for fname in os.listdir(data_dir):
        if fname.endswith(".jar"):
            src = os.path.join(data_dir, fname)
            dst = os.path.join(mods_dir, fname)
            # Only copy if the source is newer (avoids redundant writes)
            if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
                shutil.copy2(src, dst)
                print(f"[mc-setup] Synced mod jar: {fname}", file=sys.stderr)
            else:
                print(f"[mc-setup] Mod jar already up-to-date: {fname}", file=sys.stderr)
            return  # only one jar expected

    print(f"[mc-setup] No mod jar found in {data_dir}", file=sys.stderr)


def main():
    if len(sys.argv) < 3:
        print("Usage: apply_minecraft_patch.py <archive_or_patch> <server_path> [host:port]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    server_path = sys.argv[2]
    ap_server   = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.exists(input_path):
        print(f"[mc-setup] Input not found: {input_path}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isdir(server_path):
        print(f"[mc-setup] Server path not found: {server_path}", file=sys.stderr)
        sys.exit(1)

    patch_file = input_path
    tmp_file = None
    is_dig = input_path.endswith(".apmcdig")

    # If given a multiworld zip, pull the patch file out of it first
    if input_path.endswith(".zip"):
        tmp_file, patch_name = extract_patch_from_zip(input_path)
        if not tmp_file:
            print("[mc-setup] No .apmc or .apmcdig found in archive", file=sys.stderr)
            sys.exit(1)
        patch_file = tmp_file
        is_dig = patch_name.endswith(".apmcdig")
        print(f"[mc-setup] Extracted {patch_name} from archive", file=sys.stderr)

    try:
        # Prefer Archipelago's own patch system (handles mod jar install + APData correctly)
        ok, err = apply_via_archipelago(patch_file, server_path)
        if not ok:
            print(f"[mc-setup] Archipelago patch system unavailable ({err}), falling back to direct extraction", file=sys.stderr)
            ok, err = apply_via_extraction(patch_file, server_path, ap_server)
            if not ok:
                print(f"[mc-setup] Direct extraction failed: {err}", file=sys.stderr)
                sys.exit(1)
            # Manual extraction doesn't sync the mod — do it separately
            sync_mod_jar(server_path, is_dig=is_dig)
        else:
            # Archipelago's patch system handles mod sync, but also run ours as a safety net
            sync_mod_jar(server_path, is_dig=is_dig)

        print(f"[mc-setup] Patch applied to {server_path}")
    finally:
        if tmp_file and os.path.exists(tmp_file):
            os.unlink(tmp_file)


if __name__ == "__main__":
    main()
