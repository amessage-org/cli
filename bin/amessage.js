#!/usr/bin/env node
import { NODE_NEEDED, nodeTooOld } from "../src/node-version.js";

// Encrypted chats need ML-KEM, SHA-3 and ChaCha20-Poly1305 from node:crypto, which Node 24.7
// first has. Checked before anything else loads, so older Node says so plainly.
if (nodeTooOld(process.versions.node)) {
  process.stderr.write(`aMessage needs Node.js ${NODE_NEEDED} or later, and this is Node.js ${process.versions.node}. Update Node.js, then run the command again.\n`);
  process.exit(1);
}
const { main } = await import("../src/main.js");

// Piping into `head` closes the pipe early. That is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  });
}

process.exitCode = await main(process.argv.slice(2));
