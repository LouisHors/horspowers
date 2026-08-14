# Wiki project ID entropy false positive

## Basic information
- Status: completed
- Date: 2026-08-14

## Symptom
A company docs migration returned submission_safety_blocked at project_id with high_entropy_credential.

## Root cause
Each path component passed metadata inspection, but the aggregate string without separators triggered a high-entropy window. The semantic token set did not recognize ug, ugos, and pro in the verified GitLab project path.

## Fix
Add the fixed semantic tokens and cover the real project ID through the Inbox envelope and complete Wiki mutation path. Arbitrary high-entropy IDs, separator splitting, padding, and Unicode obfuscation remain blocked.

## Verification
- RED: one Inbox submitter test and one Wiki backend path failed.
- GREEN: 53 focused tests passed.
- Regression: all 201 wiki-docs tests passed.
