#!/usr/bin/env python3
"""
Parse an Archipelago multiworld archive and output location counts per player name.
Reads the spoiler text file inside the zip — plain text, format-independent.
Output: JSON dict {"PlayerName": locationCount, ...}
"""
import sys, json, zipfile


def parse_spoiler(text):
    """
    Extract location counts from the player info blocks in the AP spoiler header.

    Format:
        Player 1: PlayerName
        Game:                 Some Game
        Location Count:       187
        ...

        Player 2: OtherName
        ...
        Location Count:       219
    """
    import re
    result = {}
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
                result[current_player] = int(m2.group(1))
                current_player = None  # one count per player block

    return result


def main(archive_path):
    if not archive_path:
        print('{}')
        return
    try:
        with zipfile.ZipFile(archive_path) as zf:
            spoiler = next((n for n in zf.namelist() if n.endswith('_Spoiler.txt')), None)
            if not spoiler:
                print('{}')
                print('[locationCounts] no spoiler file found in archive', file=sys.stderr)
                return
            text = zf.read(spoiler).decode('utf-8', errors='replace')
            result = parse_spoiler(text)
            if result:
                print(json.dumps(result))
            else:
                print('{}')
                print('[locationCounts] spoiler parsed but no location counts found', file=sys.stderr)
    except Exception as e:
        print('{}')
        print(f'[locationCounts] error: {e}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '')
