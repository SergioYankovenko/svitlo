// query-string7 expects a callable CommonJS export. The maintained fixed
// decoder0.5.1 is ESM; preserve that call contract in the browser bundle.
module.exports = require('../node_modules/decode-uri-component/index.js').default;
