import fs from 'fs';
import path from 'path';
import { generateLlmsTxt, generateLlmsFullTxt, generateGeoNeedsTxt } from '../../apps/web/server/llmsGenerator.mjs';

const clientDir = path.resolve('apps/web/client');
fs.writeFileSync(path.join(clientDir, 'llms.txt'), generateLlmsTxt(), 'utf8');
fs.writeFileSync(path.join(clientDir, 'llms-full.txt'), generateLlmsFullTxt(), 'utf8');
fs.writeFileSync(path.join(clientDir, 'geo-needs.txt'), generateGeoNeedsTxt(), 'utf8');
console.log('Successfully regenerated llms.txt, llms-full.txt and geo-needs.txt!');

