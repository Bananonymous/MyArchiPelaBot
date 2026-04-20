#!/usr/bin/env python3
"""Generate a YAML template for a given Archipelago game."""
import sys
import types

# Must be first: bypass ModuleUpdate's interactive version-check
_mu = types.ModuleType("ModuleUpdate")
_mu.update = lambda: None
_mu.update_ran = True
sys.modules["ModuleUpdate"] = _mu

import os
import yaml
from pathlib import Path


def normalize(s):
    return s.lower().replace("_", " ").replace("-", " ")


def option_to_yaml_value(opt_type):
    """Convert an Archipelago option class to a YAML-friendly weighted value."""
    # OptionDict / OptionList — use default directly
    from Options import OptionDict, OptionList, OptionSet  # noqa: PLC0415
    if isinstance(opt_type, type) and issubclass(opt_type, (OptionDict, OptionList, OptionSet)):
        return getattr(opt_type, 'default', {})

    # Named choices (Toggle, Choice, DeathLink, etc.) — list all options with weights
    name_lookup = getattr(opt_type, 'name_lookup', None)
    options_map  = getattr(opt_type, 'options', None)
    default      = getattr(opt_type, 'default', 0)

    if options_map and isinstance(options_map, dict):
        result = {}
        for name, val in options_map.items():
            result[name] = 50 if val == default else 0
        return result

    if name_lookup and isinstance(name_lookup, dict):
        result = {}
        for val, name in name_lookup.items():
            result[name] = 50 if val == default else 0
        return result

    # Range options — emit the default with a comment stub
    range_start = getattr(opt_type, 'range_start', None)
    range_end   = getattr(opt_type, 'range_end', None)
    if range_start is not None and range_end is not None:
        return default  # just the number; caller can add range comment

    # Fallback
    return default


def write_basic_template(world_type, game_name, output_dir):
    """Fallback: build a proper weighted YAML from the world's option definitions."""
    template = {
        "name": "YourName",
        "game": game_name,
        "description": f"Template for {game_name}",
    }

    game_options = {}

    def process_options_cls(options_cls):
        fields = getattr(options_cls, '__dataclass_fields__', None)
        if fields:
            for field_name, field in fields.items():
                opt_type = field.type if isinstance(field.type, type) else None
                if opt_type:
                    try:
                        game_options[field_name] = option_to_yaml_value(opt_type)
                    except Exception:
                        default = getattr(opt_type, 'default', 0)
                        game_options[field_name] = default

    # Modern Archipelago: options_dataclass
    options_cls = getattr(world_type, 'options_dataclass', None)
    if options_cls and hasattr(options_cls, '__dataclass_fields__'):
        process_options_cls(options_cls)

    # Older Archipelago: option_definitions dict
    elif hasattr(world_type, 'option_definitions'):
        for opt_name, opt_type in world_type.option_definitions.items():
            try:
                game_options[opt_name] = option_to_yaml_value(opt_type)
            except Exception:
                game_options[opt_name] = getattr(opt_type, 'default', 0)

    if game_options:
        template[game_name] = game_options

    safe_name = game_name.replace(" ", "_").replace("/", "_")
    out = Path(output_dir) / f"{safe_name}.yaml"
    with open(str(out), "w", encoding="utf-8") as f:
        yaml.dump(template, f, default_flow_style=False, allow_unicode=True)
    print(f"[template] Wrote weighted template for {game_name} (Options API fallback)")


def set_username_in_template(output_dir, username):
    """Replace the name field in every generated YAML file."""
    import re
    for fname in os.listdir(output_dir):
        if not (fname.endswith('.yaml') or fname.endswith('.yml')):
            continue
        fpath = os.path.join(output_dir, fname)
        with open(fpath, 'r', encoding='utf-8') as f:
            content = f.read()
        # Replace 'name: <anything>' at the start of a line
        content = re.sub(r'^name:.*$', f'name: {username}', content, flags=re.MULTILINE)
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(content)


def generate_template_for(world_type, game_name, output_dir, username=None):
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    # 1. Standard classmethod (Archipelago < ~0.5)
    method = getattr(world_type, 'generate_yaml_templates', None)
    if callable(method):
        try:
            method(out)
            if username:
                set_username_in_template(out, username)
            return
        except Exception as e:
            print(f"[template] generate_yaml_templates classmethod failed: {e}", file=sys.stderr)

    # 2. Via WebWorld instance
    web = getattr(world_type, 'web', None)
    if web:
        web_method = getattr(web, 'generate_yaml_templates', None)
        if callable(web_method):
            try:
                web_method(out)
                if username:
                    set_username_in_template(out, username)
                return
            except Exception as e:
                print(f"[template] WebWorld.generate_yaml_templates failed: {e}", file=sys.stderr)

    # 3. Standalone Options module helper (Archipelago 0.4+)
    try:
        from Options import generate_yaml_templates as opt_gen  # noqa: PLC0415
        opt_gen(world_type, out)
        if username:
            set_username_in_template(out, username)
        return
    except ImportError:
        pass
    except Exception as e:
        print(f"[template] Options.generate_yaml_templates failed: {e}", file=sys.stderr)

    # 4. Weighted fallback using option class introspection
    write_basic_template(world_type, game_name, out)
    if username:
        set_username_in_template(out, username)


def main():
    if len(sys.argv) < 3:
        print("Usage: generate_template.py <game_name> <output_dir>", file=sys.stderr)
        sys.exit(1)

    game_name   = sys.argv[1]
    output_dir  = sys.argv[2]
    username    = sys.argv[3] if len(sys.argv) > 3 else None

    from worlds import AutoWorldRegister

    available = AutoWorldRegister.world_types
    matched = next((k for k in available if normalize(k) == normalize(game_name)), None)
    if not matched:
        names = "\n".join(sorted(available.keys()))
        print(f"Game '{game_name}' not found.\nAvailable games:\n{names}", file=sys.stderr)
        sys.exit(1)

    generate_template_for(available[matched], matched, output_dir, username)


if __name__ == "__main__":
    main()
