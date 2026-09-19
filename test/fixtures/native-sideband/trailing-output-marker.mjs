// One spelling of the trailing-output marker, in a module with no side effects.
//
// Deliberately separate from the grandchild that writes it: that fixture installs a `disconnect` handler which
// exits the process, and importing it into the test runner - whose workers do have an IPC channel - would arm that
// handler in the wrong process. A constant needs no behaviour, so it lives on its own.
export const TRAILING_MARKER = "trailing-output-grandchild: wrote this after the helper had already exited";
