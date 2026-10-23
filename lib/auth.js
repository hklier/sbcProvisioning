import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';

const hash=(password,salt)=>scryptSync(password,salt,64);
const record=(username,password)=>{const salt=randomBytes(32).toString('hex');return {username,salt,hash:hash(password,salt).toString('hex')};};
export class AppAuth {
  constructor({username='admin',password='',file=''}) {
    this.file=file;
    if(file && fs.existsSync(file)) {
      this.record=JSON.parse(fs.readFileSync(file,'utf8'));
      if(typeof this.record.username!=='string' || !/^[a-f0-9]{64}$/.test(this.record.salt || '') || !/^[a-f0-9]{128}$/.test(this.record.hash || ''))throw new Error('Invalid application password file');
    }else this.record=password?record(username,password):null;
  }
  get canChange(){return Boolean(this.file && this.record);}
  matches(password){return typeof password==='string' && Buffer.byteLength(password)<=1024 && Boolean(this.record) && timingSafeEqual(hash(password,this.record.salt),Buffer.from(this.record.hash,'hex'));}
  accepts(header='') {
    if(!this.record)return true;
    if(!header.startsWith('Basic ') || header.length>4096)return false;
    const decoded=Buffer.from(header.slice(6),'base64').toString('utf8'),colon=decoded.indexOf(':');
    return colon>=0 && decoded.slice(0,colon)===this.record.username && this.matches(decoded.slice(colon+1));
  }
  change({currentPassword,newPassword,confirmPassword}) {
    if(!this.canChange)throw new Error('Password changes require authentication and persistent password storage');
    if(!this.matches(currentPassword))throw new Error('Current password is incorrect');
    if(typeof newPassword!=='string' || newPassword.length<12 || newPassword.length>256)throw new Error('New password must contain 12 to 256 characters');
    if(newPassword!==confirmPassword)throw new Error('New passwords do not match');
    if(this.matches(newPassword))throw new Error('Choose a password different from the current password');
    const next=record(this.record.username,newPassword),temp=this.file+'.'+randomBytes(8).toString('hex')+'.tmp';
    fs.mkdirSync(path.dirname(this.file),{recursive:true});
    try{fs.writeFileSync(temp,JSON.stringify(next)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,this.file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
    this.record=next;
  }
}
