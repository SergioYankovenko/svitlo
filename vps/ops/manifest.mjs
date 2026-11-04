import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const dir=process.argv[2];if(!dir)throw Error('Artifact directory required');
const sha=async f=>createHash('sha256').update(await readFile(dir+'/'+f)).digest('hex');
await writeFile(dir+'/manifest.json',JSON.stringify({version:1,scope:'isolated-staging',sourceCommit:process.env.GITHUB_SHA,image:process.env.IMAGE_ID,sourceSha256:await sha('source.tar.gz'),imageSha256:await sha('image.tar.gz'),builtOutsideVps:true,workerCycleContract:1,delivery:'disabled'},null,2));
