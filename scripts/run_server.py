#!/usr/bin/env python3
"""Wrapper for ArchipelagoServer that bypasses the interactive ModuleUpdate check."""
import sys
import types

_mu = types.ModuleType("ModuleUpdate")
_mu.update = lambda: None
_mu.update_ran = True
sys.modules["ModuleUpdate"] = _mu

import runpy
runpy.run_path("/opt/archipelago/MultiServer.py", run_name="__main__")
