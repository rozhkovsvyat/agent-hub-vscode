const path = require("path");

const modulePath = path.resolve(process.argv[2]);
const before = process.listenerCount("message");

try {
  require(modulePath);
  const after = process.listenerCount("message");
  process.send({ before, after });
} catch (error) {
  process.send({ error: String(error) });
}
