#!/usr/bin/env python3
"""Exercise the complete canonical native suite through the original SQL entrypoint."""
import os,runpy
from pathlib import Path
os.environ['C3_UAT_SQL_PACKAGE']='c3_temporary_uat_execution.sql'
runpy.run_path(str(Path(__file__).with_name('live-execution-postgres.py')),run_name='__main__')
