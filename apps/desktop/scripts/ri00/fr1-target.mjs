import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

const hash = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => {
  const h = createHash('sha256'), buffer = Buffer.allocUnsafe(1048576), fd = fs.openSync(file,'r');
  try { let n; while ((n=fs.readSync(fd,buffer,0,buffer.length,null))) h.update(buffer.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
};
const stamp = file => {
  const s = fs.lstatSync(file, {bigint:true});
  if (!s.isFile() || s.isSymbolicLink()) throw Error('fr1_target_regular_file');
  return ['dev','ino','size','mtimeNs','ctimeNs'].map(k => String(s[k]));
};

/** Immutable source epoch; renewal checks metadata only, never rereads business data. */
export function snapshotFr1TargetFiles(root, directories, files = []) {
  const names = [...files];
  function walk(relative) {
    for (const e of fs.readdirSync(path.join(root,relative), {withFileTypes:true})) {
      const name = path.join(relative,e.name);
      if (e.isSymbolicLink()) throw Error('fr1_target_source_symlink');
      if (e.isDirectory()) walk(name); else if (e.isFile()) names.push(name);
    }
  }
  for (const d of directories) walk(d);
  return [...new Set(names)].sort().map(relative => {
    const file = path.join(root,relative), before = stamp(file), sha256 = fileHash(file);
    if (JSON.stringify(stamp(file)) !== JSON.stringify(before)) throw Error('fr1_target_changed_during_binding');
    return {relative,stamp:before,sha256};
  });
}

export function assertFr1Target(config, target) {
  const command = execFileSync('ps',['-p',String(config.pid),'-o','comm='],{encoding:'utf8'}).trim();
  if (command !== target.executable) throw Error('fr1_target_executable_changed');
  for (const file of target.files) {
    if (JSON.stringify(stamp(path.join(target.root,file.relative))) !== JSON.stringify(file.stamp))
      throw Error('fr1_target_source_epoch_changed:'+file.relative);
  }
  return true;
}

export function bindFr1Target(config, preLaunchProduction) {
  if (config.targetKind !== 'development') {
    const root = '/Applications/Peer Agent.app/Contents/Resources';
    const target = {kind:'packaged',root,executable:'/Applications/Peer Agent.app/Contents/MacOS/Peer Agent',
      files:snapshotFr1TargetFiles(root,[],['app.asar'])};
    assertFr1Target(config,target);return target;
  }
  const root = fs.realpathSync(config.moduleRoot), launchBytes = fs.readFileSync(config.launchReceipt), launch = JSON.parse(launchBytes);
  if (launch.electronPid !== config.pid || launch.fr1Enabled !== false || launch.port !== 5173)
    throw Error('fr1_development_launch_receipt');
  const head = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  if (head !== launch.sourceHeadAfterBuild) throw Error('fr1_development_head_changed');
  const electron = createRequire(path.join(root,'apps/desktop/package.json'))('electron');
  const cwd = execFileSync('lsof',['-a','-p',String(config.pid),'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').find(x=>x.startsWith('n'))?.slice(1);
  if (!cwd || fs.realpathSync(cwd) !== path.join(root,'apps/desktop')) throw Error('fr1_development_cwd');
  const main = snapshotFr1TargetFiles(root,['apps/desktop/electron','packages/runtime-node/dist','packages/conversation-store/dist'],['apps/desktop/package.json']);
  const birthText = execFileSync('ps',['-p',String(config.pid),'-o','lstart='],{encoding:'utf8'}).trim(), birthUpperMs = Date.parse(birthText)+1000;
  const late = main.filter(x=>Number(x.stamp[4])/1e6>birthUpperMs);
  // A rebuild may rewrite byte-identical dist files. Only the already-sealed pre-launch
  // production identity can bridge that epoch; a fresh current hash cannot prove loaded bytes.
  const covered = file => preLaunchProduction?.roots.some(r=>file.relative.startsWith(r.relative+'/'));
  if (!Number.isFinite(birthUpperMs) || late.some(x=>!covered(x)) ||
      (late.length && !(preLaunchProduction?.recordedBeforeMs<birthUpperMs)))
    throw Error('fr1_development_source_modified_after_start_without_prelaunch_proof');
  const renderer = snapshotFr1TargetFiles(root,['apps/desktop/renderer/src'],['apps/desktop/index.html','apps/desktop/vite.config.ts']);
  const target = {kind:'development',root,executable:electron,head,launchReceiptSha256:hash(launchBytes),
    birthText,files:[...main,...renderer],sourceSha256:hash(JSON.stringify(main)),rendererSourceSha256:hash(JSON.stringify(renderer)),preLaunchProduction,
    sourceProof:'known manual launch and unchanged head; main ctime predates birth except byte-identical dist covered by sealed pre-launch production receipt; renewal stamps',
    rendererProof:'current dirty renderer source; Vite transformed bytes and prior HMR history not reconstructed'};
  assertFr1Target(config,target);return target;
}
