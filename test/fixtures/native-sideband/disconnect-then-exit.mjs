// Closes its own IPC channel before handing anything over.
process.channel?.unref();
process.disconnect();
setTimeout(() => process.exit(5), 0);
