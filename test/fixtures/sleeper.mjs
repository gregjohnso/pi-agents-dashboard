// A process that exists and does nothing, so a reaper test has something real to signal.
// It prints its own PID so a parent that did not spawn it directly can still record it.
process.stdout.write(`${process.pid}\n`);
setTimeout(() => {}, 10 * 60_000);
