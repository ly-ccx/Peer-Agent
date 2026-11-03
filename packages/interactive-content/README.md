# Interactive Content

Peer's host-neutral OpenUI language policy, bounded data/state validation and deterministic result projection. This private package owns no files, permissions, network clients or task state. Hosts load it only when an interactive capability is invoked; the Desktop renderer loads it with its resource view.

The fixed upstream language implementation is MIT licensed. Installation scripts are not admitted; runtime telemetry is disabled in host evaluation workers. The React binding and all presentation components remain outside this package.

The public AST policy checks complete token coverage, bounded expansion and finite numeric semantics before evaluation. A single evaluation budget covers pure-function inputs/outputs and materialized rows; changed-state branches receive the same checks. `/values` and `/state` expose pure validation without loading the language SDK. Derived render trees are caches; hosts retain canonical programs, fixed input snapshots and catalog/state identities.
