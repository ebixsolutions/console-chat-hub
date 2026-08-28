#!/usr/bin/env python3
"""Task 3.3 login feedback contract."""
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
login = (root / 'src/routes/login.tsx').read_text()
app_root = (root / 'src/routes/__root.tsx').read_text()

assert 'toast.error(' in login, 'login route no longer surfaces auth errors through toast'
assert 'from "sonner"' in app_root, 'root must import sonner Toaster'
assert '<Toaster' in app_root, 'root must mount Toaster so login failures are visible'
assert '<Outlet />' in app_root, 'root route outlet must remain mounted'

print('PASS Task 3.3 login feedback contract')
