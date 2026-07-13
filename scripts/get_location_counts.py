#!/usr/bin/env python3
"""
Parse an Archipelago multiworld archive and output location counts per player name.
Reads the spoiler text file inside the zip — plain text, format-independent.
Output: JSON dict {"PlayerName": locationCount, ...}
"""
import sys, json, zipfile


def parse_spoiler(text):
    """
    Extract location counts from the player info blocks in the AP spoiler header,
    in Player N order (matches the order YAMLs were fed to Generate.py).

    Format:
        Player 1: PlayerName
        Game:                 Some Game
        Location Count:       187
        ...

        Player 2: OtherName
        ...
        Location Count:       219

    Note: the spoiler's "PlayerName" is post-templating (e.g. AP resolves a YAML
    name of "Foo{NUMBER}" to "Foo1"), so it may not match the raw name from the
    submitted YAML. Callers should zip this ordered list against their own
    player list by position, not by name.
    """
    import re
    result = []  # [(resolvedName, count), ...] in Player N order
    current_player = None

    for line in text.splitlines():
        stripped = line.strip()

        # "Player N: Name" — start of a player block
        m = re.match(r'^Player \d+:\s+(.+)$', stripped)
        if m:
            current_player = m.group(1).strip()
            continue

        # "Location Count: NNN" — the count we want
        if current_player and stripped.startswith('Location Count:'):
            m2 = re.search(r'(\d+)', stripped)
            if m2:
                result.append((current_player, int(m2.group(1))))
                current_player = None  # one count per player block

    return result


def parse_solo_spoiler(text, player_name):
    """Fallback for single-player archives where there is no Player N: block."""
    import re
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('Location Count:'):
            m = re.search(r'(\d+)', stripped)
            if m:
                return {player_name: int(m.group(1))}
    return {}


def main(archive_path, player_names=None):
    if not archive_path:
        print('{}')
        return
    try:
        with zipfile.ZipFile(archive_path) as zf:
            spoiler = next((n for n in zf.namelist() if n.endswith('_Spoiler.txt')), None)
            if not spoiler:
                print('{}')
                print('no spoiler file found in archive', file=sys.stderr)
                return
            text = zf.read(spoiler).decode('utf-8', errors='replace')
            ordered = parse_spoiler(text)
            if not ordered and player_names and len(player_names) == 1:
                result = parse_solo_spoiler(text, player_names[0])
            elif ordered and player_names and len(player_names) == len(ordered):
                # Zip positionally against the caller's own names — the spoiler's
                # name is post-templating and may not match the raw YAML name.
                result = {player_names[i]: count for i, (_, count) in enumerate(ordered)}
            else:
                # Counts/names don't line up 1:1 (e.g. recovery path passed a
                # subset) — fall back to the resolved names from the spoiler.
                result = dict(ordered)
            if result:
                print(json.dumps(result))
            else:
                print('{}')
                print('spoiler parsed but no location counts found', file=sys.stderr)
    except Exception as e:
        print('{}')
        print(f'error: {e}', file=sys.stderr)


if __name__ == '__main__':
    player_names = None
    if len(sys.argv) > 2:
        try:
            player_names = json.loads(sys.argv[2])
        except Exception:
            pass
    main(sys.argv[1] if len(sys.argv) > 1 else '', player_names)
