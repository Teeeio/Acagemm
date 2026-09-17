// Root verification preparation: reuse exact installed dependencies offline.
// Only writes node_modules inside a private dispatch attempt workspace.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const source = 'F:/设计/快速项目/acagemm原型/node_modules';
const expected = 'cb358cc2bb5bdcadf0f0a8de0293b8e58397a16763750a8d09ba42b23bab1bac';
function digest(root) {
  const entries = [];
  function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw Error('dependency-link');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) entries.push([
        path.relative(root, file).split(path.sep).join('/'),
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      ]);
      else throw Error('dependency-special');
    }
  }
  walk(root);
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { files: entries.length, sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
console.log('[offline-deps] checking source');
if (digest(source).sha256 !== expected) throw Error('dependency-source-changed');
console.log('[offline-deps] source verified');
const cwd = path.resolve(process.cwd());
if (!cwd.includes(path.sep + '.dispatch-data' + path.sep + 'attempts' + path.sep)
    || path.basename(cwd) !== 'workspace') throw Error('not-private-attempt-workspace');
const target = path.join(cwd, 'node_modules');
if (fs.existsSync(target)) throw Error('dependency-target-exists');
let copied = 0;
function copy(directory, destination) {
  fs.mkdirSync(destination);
  for (const name of fs.readdirSync(directory)) {
    const from = path.join(directory, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw Error('dependency-link');
    if (stat.isDirectory()) copy(from, to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      copied += 1;
    } else throw Error('dependency-special');
  }
}
console.log('[offline-deps] copying verified files');
copy(source, target);
console.log('[offline-deps] copied ' + copied + ' files; verifying destination');
const after = digest(target);
if (after.sha256 !== expected) throw Error('dependency-copy-mismatch');
console.log(JSON.stringify({ source, ...after, offline: true }));
