import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRegistry } from "./adapters/registry.js";
import { createPropertyService } from "./application/property-service.js";
import { createAppServer, listen } from "./server/create-server.js";

const root = dirname(fileURLToPath(import.meta.url));

const flags = (args) => {
  const parsed = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next == null || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
};

const help = `Open Property Comps

  node src/cli.js serve [--port 4317] [--host 127.0.0.1]
  node src/cli.js search --source sample --query "maple"
  node src/cli.js record --source sample --id sample:maple-100
  node src/cli.js comps --source sample --subject sample:maple-100 [--radius 0.5]
      [--type Residential] [--min-sqft 1400] [--max-sqft 2200]
      [--sold-after YYYY-MM-DD] [--sold-before YYYY-MM-DD] [--csv file.csv]

Sources: sample (fictional Sampleton, Arizona, offline), maricopa, pinal.
Public sources call free Arizona assessor ArcGIS services. No API key is required.
`;

const printError = (error) => {
  console.error(error?.message ?? "Request failed.");
};

const compParams = (parsed) => ({
  subjectId: parsed.subject,
  radiusMiles: parsed.radius,
  propertyType: parsed.type,
  minSqft: parsed["min-sqft"],
  maxSqft: parsed["max-sqft"],
  soldAfter: parsed["sold-after"],
  soldBefore: parsed["sold-before"],
});

const main = async () => {
  const parsed = flags(process.argv.slice(2));
  const [command] = parsed._;
  if (!command || command === "help" || parsed.help) {
    console.log(help);
    return;
  }
  const service = createPropertyService(createRegistry());
  if (command === "serve") {
    const port = parsed.port == null ? 4317 : Number(parsed.port);
    const host = typeof parsed.host === "string" ? parsed.host : "127.0.0.1";
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Port must be an integer from 1 to 65535.");
    const server = createAppServer({
      service,
      publicDir: join(root, "../public"),
      moduleDir: join(root, "domain"),
    });
    const address = await listen(server, { port, host });
    console.log(`Open Property Comps at http://${address.host}:${address.port}`);
    return;
  }
  if (command === "search") {
    console.log(JSON.stringify(await service.search(parsed.source, parsed.query), null, 2));
    return;
  }
  if (command === "record") {
    console.log(JSON.stringify(await service.getProperty(parsed.source, parsed.id), null, 2));
    return;
  }
  if (command === "comps") {
    const params = compParams(parsed);
    if (typeof parsed.csv === "string") {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(parsed.csv, await service.compsCsv(parsed.source, params));
      console.log(`Wrote ${parsed.csv}`);
      return;
    }
    console.log(JSON.stringify(await service.comps(parsed.source, params), null, 2));
    return;
  }
  throw new Error(`Unknown command "${command}".\n\n${help}`);
};

main().catch((error) => {
  printError(error);
  process.exitCode = 1;
});
