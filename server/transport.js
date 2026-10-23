import checks from "./operator-chain.js";
import certificates from "./operator-certificates.js";
let client;
export async function operatorFetch(url, options) {
  try {
    if (
      typeof Deno === "undefined" ||
      new URL(url).hostname !== "cabinet.cherkasyoblenergo.com"
    )
      return fetch(url, options);
    if (!client) {
      const now = Date.now(),
        bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      for (const check of checks) {
        if (Date.parse(check.fromDate) > now || Date.parse(check.toDate) < now)
          throw Error("Certificate chain expired");
        const key = await crypto.subtle.importKey(
          "spki",
          bytes(check.issuerKey),
          { name: "RSASSA-PKCS1-v1_5", hash: check.hash },
          false,
          ["verify"],
        );
        if (
          !(await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5",
            key,
            bytes(check.signature),
            bytes(check.tbs),
          ))
        )
          throw Error("Invalid certificate chain");
      }
      // Extend only this host's chain with pinned, signed public intermediates. TLS and hostname checks remain enabled.
      client = Deno.createHttpClient({ caCerts: certificates });
    }
    return await fetch(url, { ...options, client });
  } catch (error) {
    console.error(
      "Operator TLS failure:",
      String(error.message)
        .replace(/https?:\/\/\S+/g, "[source]")
        .slice(0, 180),
    );
    throw error;
  }
}
