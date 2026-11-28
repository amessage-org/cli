// The oldest Node.js the CLI runs on. Kept apart from everything else so this check loads on any
// Node: main.js imports what only newer versions have.

export const NODE_NEEDED = "24.7";

/** Whether this Node.js version is older than the CLI needs. @param {string} version Like "24.6.1" */
export function nodeTooOld(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = NODE_NEEDED.split(".").map(Number);
  return major < needMajor || (major === needMajor && minor < needMinor);
}
