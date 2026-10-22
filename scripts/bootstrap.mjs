// Called only during local installation; never prints the generated passphrase.
import { mkdir,writeFile,access,chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hashPassphrase } from '../server.mjs';
const [state,loginFile]=process.argv.slice(2);
if(!state||!loginFile)throw new Error('Supply private state directory and login file path');
await mkdir(state,{recursive:true,mode:0o700});
try{await access(state+'/auth.json');console.log('Existing authentication preserved');}
catch{
 const passphrase=randomBytes(30).toString('base64url');
 const auth=await hashPassphrase(passphrase,true);
 await writeFile(state+'/auth.json',JSON.stringify(auth),{flag:'wx',mode:0o600});
 await writeFile(loginFile,'Meter initial login\n\n'+passphrase+'\n\nSign in and choose your own passphrase. This initial value becomes invalid after replacement.\n',{flag:'wx',mode:0o600});
 await chmod(loginFile,0o600);
 console.log('Initial login written to private owner file; passphrase was not printed');
}
