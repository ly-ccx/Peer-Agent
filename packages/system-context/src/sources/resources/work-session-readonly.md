Read-only constraint:
This task was opened read-only. Do not write files, change git state, or run commands that modify the workspace.
The local write gate is what blocks those actions. This text does not replace that gate.
Use git_query for local repository identity, status and log observations. Its output includes the observation time, completeness and consistency; do not replace status with .git/index hashes or claim old observations are current. General bash remains unavailable in read-only work. Report projection/role/permission/execution failures with the actual tool reason and evidence; a missing capability is a technical blocker, not a request to reduce the user's acceptance criteria.
