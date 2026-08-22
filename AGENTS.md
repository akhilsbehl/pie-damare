# pie-damare project instructions

This project is a personal-use, source-only Pi extension for Damare behaviour.

## Development

- Load the extension through the machine-local Pi symlink.
- Keep the extension self-contained; do not add package or distribution metadata unless the loading method changes.

## Submodule development

This project is checked out as a Git submodule of `configs`. For normal development, switch from the parent's detached pinned commit to a named child branch before editing. Commit and push changes in this child repository. Update the parent repository's submodule pin in a separate commit only when explicitly requested. Use the detached pinned state only for read-only verification, reproduction, or testing the exact parent integration.
