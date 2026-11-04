import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({stdin:{contents:"import QR from 'qrcode'; export default QR;",resolveDir:process.cwd(),sourcefile:'qrcode-entry.js'},bundle:true,platform:'browser',format:'esm',minify:true,legalComments:'eof',outfile:'pwa/vendor/qrcode.js'});
await copyFile('node_modules/qrcode/license','pwa/vendor/qrcode-LICENSE.txt');
