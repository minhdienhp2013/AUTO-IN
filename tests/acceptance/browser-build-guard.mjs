import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
export function requireAi4Build(root,exists=existsSync){
 const lock=resolve(root,'web/package-lock.json'),html=resolve(root,'web/dist/index.html');
 if(!exists(lock))throw Error('AI4 web/package-lock.json missing; browser NOT RUN');
 if(!exists(html))throw Error('AI4 web/dist/index.html missing; npm ci and build required');
 return {lock,html};
}
