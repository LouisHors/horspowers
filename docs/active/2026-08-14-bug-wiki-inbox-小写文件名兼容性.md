# Wiki Inbox lowercase filename compatibility

## Status
Completed on 2026-08-14.

## Symptom
The jump host runtime reached ready / wiki, but docs submission returned inbox_process_exit because the receiver accepts lowercase Markdown filenames only.

## Root cause and fix
filenameForSubmission used uppercase T and Z in its UTC timestamp. The generator now emits lowercase t and z without changing the UUID, extension, safety checks, or receiver configuration.

## Verification
- Target test: 5 passed, 0 failed.
- Local Wiki docs regression: 201 passed, 0 failed.
- Jump-host Wiki docs regression with Node 24.18.0: 201 passed, 0 failed.
- A real runtime update created lowercase Inbox file 20260814t031628347z-4341510e-c090-4bc1-a892-b96166adc3f7.md.
- The reviewed migration inventory is readable as ug-system-cli-context revision 2 with a matching manifest hash.

## Remaining scope
The revision records three active documents, seven plans, and five context guides at directory level. Per-document safe summaries remain future migration work; every project docs file remains in place.
