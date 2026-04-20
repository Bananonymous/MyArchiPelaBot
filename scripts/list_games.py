#!/usr/bin/env python3
"""Print available Archipelago game names, one per line."""
import sys
import types

# Must be first: bypass ModuleUpdate's interactive version-check
_mu = types.ModuleType("ModuleUpdate")
_mu.update = lambda: None
_mu.update_ran = True
sys.modules["ModuleUpdate"] = _mu


def main():
    from worlds import AutoWorldRegister
    for name in sorted(AutoWorldRegister.world_types.keys()):
        print(name)


if __name__ == "__main__":
    main()
