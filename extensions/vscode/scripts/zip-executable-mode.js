const fs = require("fs");

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UNIX_HOST_ID = 3;
const UNIX_EXECUTABLE_MODE = 0o100755;

const UNIX_EXECUTABLE_ENTRIES = Object.freeze([
  "extension/out/node_modules/@vscode/ripgrep/bin/rg",
  "extension/out/runtime/ffmpeg",
]);

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

/**
 * Set Unix executable metadata on an already-built VSIX.
 *
 * On Windows, chmod() cannot make stat() expose Unix execute bits. vsce therefore
 * writes regular files as 0100666 even when the downloaded target binary is
 * executable. VS Code's Unix extractor honors the mode in the ZIP central
 * directory, so rg/ffmpeg otherwise install as non-executable files.
 */
function patchExecutableModesInBuffer(
  buffer,
  executableEntries = UNIX_EXECUTABLE_ENTRIES,
) {
  const wanted = new Set(executableEntries);
  const patched = new Set();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(
        `Invalid ZIP central-directory entry at offset ${offset}`,
      );
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    if (wanted.has(name)) {
      const madeBy = buffer.readUInt16LE(offset + 4);
      buffer.writeUInt16LE((UNIX_HOST_ID << 8) | (madeBy & 0xff), offset + 4);
      const previousAttributes = buffer.readUInt32LE(offset + 38);
      const executableAttributes =
        ((UNIX_EXECUTABLE_MODE << 16) | (previousAttributes & 0xffff)) >>> 0;
      buffer.writeUInt32LE(executableAttributes, offset + 38);
      patched.add(name);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  const missing = [...wanted].filter((entry) => !patched.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `Executable entries missing from VSIX central directory: ${missing.join(", ")}`,
    );
  }
  return [...patched].sort();
}

function patchVsixExecutableModes(
  vsixPath,
  { fileSystem = fs, executableEntries = UNIX_EXECUTABLE_ENTRIES } = {},
) {
  const buffer = fileSystem.readFileSync(vsixPath);
  const patched = patchExecutableModesInBuffer(buffer, executableEntries);
  fileSystem.writeFileSync(vsixPath, buffer);
  return patched;
}

module.exports = {
  CENTRAL_DIRECTORY_SIGNATURE,
  END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  UNIX_EXECUTABLE_ENTRIES,
  UNIX_EXECUTABLE_MODE,
  findEndOfCentralDirectory,
  patchExecutableModesInBuffer,
  patchVsixExecutableModes,
};
