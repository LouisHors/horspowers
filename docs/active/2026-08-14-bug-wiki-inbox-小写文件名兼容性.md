# Wiki Inbox lowercase filename compatibility

## Status
Completed on 2026-08-14.

## Symptom
The jump host runtime reached ready / wiki, but docs submission returned inbox_process_exit because the receiver accepts lowercase Markdown filenames only.

## Root cause and fix
filenameForSubmission used uppercase T and Z in its UTC timestamp. The generator now emits lowercase t and z without changing the UUID, extension, safety checks, or receiver configuration.

## Verification
- Target test: 5 passed, 0 failed.
- Wiki docs regression: 201 passed, 0 failed.
- Jump-host sync and real docs migration remain pending until the PR is available.
