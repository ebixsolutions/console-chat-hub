# sql/ce-task1/ — Source verification

All files in this directory are exact copies from the Lovable project
`4dbf593e-577e-4af4-a553-460441c34473` at HEAD `4e60145c`.

To verify any file matches the Lovable source:
```
Lovable:read_file { path: "<file>", project_id: "4dbf593e-577e-4af4-a553-460441c34473" }
```

The forward migration (`20260805012800_task1_ce_grounding_replay.sql`) was
validated on disposable PostgreSQL 17.9 with all 9 scenario gates and
25 runtime assertions passing. It was frozen by Director ruling and must
not be modified.
