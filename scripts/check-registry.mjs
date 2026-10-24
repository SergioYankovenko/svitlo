import fs from "node:fs/promises";
import { MemoryDatabase } from "../server/memory.js";
import { syncRegistry, registryMatch } from "../server/queue-registry.js";
import { pdfPages } from "../server/pdf-pages.js";
const db = new MemoryDatabase(),
  result = await syncRegistry({ db, pdfPages });
console.log(result);
const registry = await db.registry();
for (const address of [
  { city: "м. Христинівка", street: "вул. Флорештська", house: "10а/51" },
  { city: "с. Сичівка", street: "вул. Грушевського", house: "1" },
])
  console.log(address, registryMatch(registry, address));
if (registry)
  await fs.writeFile(
    "../work/diagnostics-pwa-review-20261024/local-registry.json",
    JSON.stringify(registry, null, 2),
  );
else console.log(await db.registryState());
